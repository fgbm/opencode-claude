/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  /**
   * Last transcript entry this plugin saw on the conversation's main chain.
   * Resume pins to it: another claude process writing to the same session
   * file (a turn orphaned by an OpenCode restart, closed by the TTL reaper
   * an hour later) appends a branch, and a plain resume follows whichever
   * branch was written last.
   */
  leafUuid?: string;
  /**
   * Where each OpenCode history this session answered ends in the Claude
   * transcript, oldest first. A revert or edit in OpenCode shortens the
   * history; the matching boundary says where to resume from.
   */
  turns?: TurnBoundary[];
  updatedAt: number;
};

/**
 * One point of a conversation: the OpenCode history held `count` user
 * messages (see userHistoryFingerprints), the last one hashing to `hash`,
 * and the Claude session's main chain ended at `leafUuid`.
 */
export type TurnBoundary = { count: number; hash: string; leafUuid?: string };

/** Boundaries kept per binding; older ones can no longer be rewound to. */
const MAX_TURN_BOUNDARIES = 100;

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

function readStore(): Record<string, ClaudeSessionBinding> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      ClaudeSessionBinding
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getForeignSessionId(
  conversationKey: string,
): string | undefined {
  const entry = readStore()[conversationKey];
  return entry?.foreignSessionId;
}

export function getSessionLeafUuid(conversationKey: string): string | undefined {
  return readStore()[conversationKey]?.leafUuid;
}

/**
 * What this process last wrote per conversation. Every streamed event of a
 * turn reports the session id, and most carry no new leaf: comparing with
 * this skips the read-modify-write of sessions.json for them.
 */
const written = new Map<string, Omit<ClaudeSessionBinding, "updatedAt">>();

/**
 * Boundary of a turn that started without a binding (first turn, history
 * transferred after a revert). It joins the binding the turn creates.
 */
const pendingTurns = new Map<string, TurnBoundary[]>();

type StoredBinding = Omit<ClaudeSessionBinding, "updatedAt">;

function sameBinding(a: StoredBinding | undefined, b: StoredBinding): boolean {
  return (
    !!a &&
    a.foreignSessionId === b.foreignSessionId &&
    a.leafUuid === b.leafUuid &&
    a.modelId === b.modelId &&
    a.cwd === b.cwd &&
    JSON.stringify(a.turns ?? []) === JSON.stringify(b.turns ?? [])
  );
}

function sameBoundary(a: Omit<TurnBoundary, "leafUuid"> | undefined, b: Omit<TurnBoundary, "leafUuid">): boolean {
  return !!a && a.count === b.count && a.hash === b.hash;
}

function save(
  store: Record<string, ClaudeSessionBinding>,
  binding: StoredBinding,
): void {
  written.set(binding.conversationKey, binding);
  store[binding.conversationKey] = { ...binding, updatedAt: Date.now() };
  writeStore(store);
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string; leafUuid?: string },
): void {
  const cached = written.get(conversationKey);
  if (
    cached &&
    !pendingTurns.has(conversationKey) &&
    cached.foreignSessionId === foreignSessionId &&
    cached.modelId === meta?.modelId &&
    cached.cwd === meta?.cwd &&
    (meta?.leafUuid === undefined || meta.leafUuid === cached.leafUuid)
  ) {
    return;
  }
  const store = readStore();
  const previous = store[conversationKey];
  const sameSession = previous?.foreignSessionId === foreignSessionId;
  // A new session id starts a new chain; the old leaf means nothing there.
  const leafUuid = meta?.leafUuid ?? (sameSession ? previous?.leafUuid : undefined);
  // So do the old boundaries. The new chain holds at most the current turn.
  let turns: TurnBoundary[] = sameSession
    ? [...(previous?.turns ?? [])]
    : previous?.turns?.length
      ? [previous.turns.at(-1)!]
      : [];
  for (const pending of pendingTurns.get(conversationKey) ?? []) {
    if (!sameBoundary(turns.at(-1), pending)) turns.push({ ...pending });
  }
  pendingTurns.delete(conversationKey);
  if (turns.length > 0 && leafUuid) {
    turns[turns.length - 1] = { ...turns.at(-1)!, leafUuid };
  }
  turns = turns.slice(-MAX_TURN_BOUNDARIES);
  const next: StoredBinding = {
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    leafUuid,
    ...(turns.length > 0 ? { turns } : {}),
  };
  if (sameBinding(previous, next)) {
    written.set(conversationKey, next);
    return;
  }
  save(store, next);
}

export function getSessionTurns(conversationKey: string): TurnBoundary[] {
  return readStore()[conversationKey]?.turns ?? [];
}

/**
 * A turn starts for an OpenCode history of `boundary.count` user messages.
 * The history the same turn continues (a retry, a rebuilt tool step) keeps
 * its boundary; a new one is appended and follows the leaf from now on.
 * Without a binding yet, the boundary waits for the one the turn creates.
 *
 * `before` is the history before the turn's prompt. When an existing
 * binding has no boundaries yet, it is recorded first at the current leaf,
 * so a retry of this very request can go back to it.
 */
export function recordTurnStart(
  conversationKey: string,
  boundary: Omit<TurnBoundary, "leafUuid">,
  before?: Omit<TurnBoundary, "leafUuid">,
): void {
  const store = readStore();
  const binding = store[conversationKey];
  const turns = [...(binding?.turns ?? [])];
  if (binding && turns.length === 0 && before && before.count > 0 && !sameBoundary(before, boundary)) {
    turns.push({ ...before, leafUuid: binding?.leafUuid });
  }
  if (!sameBoundary(turns.at(-1), boundary)) {
    turns.push({ ...boundary, leafUuid: binding?.leafUuid });
  }
  if (!binding) {
    pendingTurns.set(conversationKey, turns);
    return;
  }
  pendingTurns.delete(conversationKey);
  if (turns.length === (binding.turns ?? []).length) return;
  const { updatedAt: _updatedAt, ...stored } = binding;
  save(store, { ...stored, turns: turns.slice(-MAX_TURN_BOUNDARIES) });
}

/**
 * OpenCode's history went back to boundary `index` (revert, edit): resume
 * from its leaf and forget the turns after it.
 */
export function rewindSessionTurns(conversationKey: string, index: number): void {
  const store = readStore();
  const binding = store[conversationKey];
  const target = binding?.turns?.[index];
  if (!binding || !target) return;
  const { updatedAt: _updatedAt, ...stored } = binding;
  save(store, {
    ...stored,
    leafUuid: target.leafUuid,
    turns: binding.turns!.slice(0, index + 1),
  });
}

export type TurnHistoryMatch =
  | { kind: "untracked" }
  | { kind: "latest" }
  | { kind: "rewind"; index: number; leafUuid?: string }
  | { kind: "diverged" };

/**
 * Compare the OpenCode history before a new prompt (as fingerprints) with
 * the boundaries a binding recorded.
 * - latest: the history still holds the newest boundary's user messages
 *   (more may follow: the prompt of a turn that failed before Claude ran,
 *   a steering message). Resume as usual.
 * - rewind: the history ends exactly at an earlier boundary, so the turns
 *   after it were reverted or edited away.
 * - diverged: nothing lines up; the session holds a history OpenCode no
 *   longer has.
 * - untracked: a binding from before boundaries were recorded.
 */
export function matchTurnHistory(
  turns: TurnBoundary[],
  prints: string[],
): TurnHistoryMatch {
  const latest = turns.at(-1);
  if (!latest) return { kind: "untracked" };
  const n = prints.length;
  if (n >= latest.count && prints[latest.count - 1] === latest.hash) {
    return { kind: "latest" };
  }
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.count === n && prints[n - 1] === turn.hash) {
      return { kind: "rewind", index: i, leafUuid: turn.leafUuid };
    }
  }
  return { kind: "diverged" };
}

/**
 * Whether a Claude Code transcript still holds the entry with this uuid.
 * The entry is almost always the resume leaf, near the end of a file that
 * can reach tens of megabytes, so the file is read backwards in chunks and
 * the search stops at the first hit.
 */
export function sessionFileHasEntry(
  file: string,
  uuid: string,
  chunkBytes = 256 * 1024,
): boolean {
  const needle = Buffer.from(`"uuid":"${uuid}"`, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    // Leading bytes of what was read so far (the part after this chunk in
    // the file), so a match split across a chunk border is still found.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const window = Buffer.concat([chunk, carry]);
      if (window.includes(needle)) return true;
      carry = window.subarray(0, Math.min(window.length, needle.length - 1));
      end = start;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function clearForeignSessionId(conversationKey: string): void {
  written.delete(conversationKey);
  const store = readStore();
  if (!(conversationKey in store)) return;
  delete store[conversationKey];
  writeStore(store);
}

/**
 * Stable key from OpenAI messages so follow-ups resume the same Claude session.
 * Hashes the first user message only — including the message count made the key
 * change on every turn, which defeated resume entirely when the session header
 * is absent.
 */
export function conversationKeyFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const seed =
    typeof firstUser?.content === "string"
      ? firstUser.content.slice(0, 200)
      : JSON.stringify(firstUser?.content ?? "").slice(0, 200);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `conv_${hash.toString(16)}`;
}

/**
 * Locate the Claude Code transcript for a foreign session id. A missing file
 * means resume silently starts (or errors into) a context-free session, so
 * callers must fall back to history injection instead.
 *
 * Every project folder is searched on purpose. The CLI writes a session
 * under ~/.claude/projects/<slug of the realpath cwd>/, but `--resume <id>`
 * finds it from any cwd: checked live on CLI 2.1.224 and 2.1.284, a resume
 * from another directory loaded the full history and appended to the
 * original file. A chat whose directory changed keeps resuming.
 */
export function findClaudeSessionFile(
  foreignSessionId: string,
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
