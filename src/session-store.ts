/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string; leafUuid?: string },
): void {
  const store = readStore();
  const previous = store[conversationKey];
  // A new session id starts a new chain; the old leaf means nothing there.
  const keptLeaf =
    previous?.foreignSessionId === foreignSessionId ? previous.leafUuid : undefined;
  store[conversationKey] = {
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    leafUuid: meta?.leafUuid ?? keptLeaf,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/** Whether a Claude Code transcript still holds the entry with this uuid. */
export function sessionFileHasEntry(file: string, uuid: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(`"uuid":"${uuid}"`);
  } catch {
    return false;
  }
}

export function clearForeignSessionId(conversationKey: string): void {
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
