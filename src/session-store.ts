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
  updatedAt: number;
};

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

function sameBinding(
  a: Omit<ClaudeSessionBinding, "updatedAt"> | undefined,
  b: Omit<ClaudeSessionBinding, "updatedAt">,
): boolean {
  return (
    !!a &&
    a.foreignSessionId === b.foreignSessionId &&
    a.leafUuid === b.leafUuid &&
    a.modelId === b.modelId &&
    a.cwd === b.cwd
  );
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string; leafUuid?: string },
): void {
  const binding = (previous: Omit<ClaudeSessionBinding, "updatedAt"> | undefined) => ({
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    // A new session id starts a new chain; the old leaf means nothing there.
    leafUuid:
      meta?.leafUuid ??
      (previous?.foreignSessionId === foreignSessionId ? previous.leafUuid : undefined),
  });
  const cached = written.get(conversationKey);
  if (cached && sameBinding(cached, binding(cached))) return;
  const store = readStore();
  const previous = store[conversationKey];
  const next = binding(previous);
  written.set(conversationKey, next);
  if (sameBinding(previous, next)) return;
  store[conversationKey] = { ...next, updatedAt: Date.now() };
  writeStore(store);
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
