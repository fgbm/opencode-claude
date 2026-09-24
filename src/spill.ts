/**
 * Large tool outputs are written to a file and replaced with a path, size,
 * and a short head/tail. Inlining them is re-read on every later turn;
 * truncating them drops the middle. Disable with OPENCODE_CLAUDE_SPILL_CHARS=0.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

/** Shell dumps in measured sessions clustered around 11–20k chars. */
export const DEFAULT_SPILL_CHARS = 8_000;
const SPILL_HEAD = 400;
const SPILL_TAIL = 2_000;

export function spillThreshold(): number {
  const raw = process.env.OPENCODE_CLAUDE_SPILL_CHARS;
  if (raw === undefined || raw === "") return DEFAULT_SPILL_CHARS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SPILL_CHARS;
}

export function spillDirectory(): string {
  const override = process.env.OPENCODE_CLAUDE_SPILL_DIR;
  if (override && override.trim()) return override.trim();
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "spills");
}

/**
 * True when a tool call is fetching a file this harness already spilled.
 * Spilling that result again hides the middle the model just asked for.
 */
export function referencesSpillFile(argumentsJson: string): boolean {
  if (!argumentsJson) return false;
  const dir = spillDirectory();
  return argumentsJson.includes(dir) || argumentsJson.includes("opencode-claude/spills/");
}

export type PresentedOutput = {
  text: string;
  spilledChars: number;
};

/**
 * Return `text` unchanged when it is under the threshold or spilling is off.
 * On a write failure, return the original text — never drop the middle.
 */
export function presentLargeOutput(
  text: string,
  options?: { directory?: string; threshold?: number },
): PresentedOutput {
  const threshold = options?.threshold ?? spillThreshold();
  // A spill note is head + tail plus a few lines. Spilling something that
  // already fits in that window would add tokens, not remove them.
  if (
    threshold <= 0 ||
    text.length <= threshold ||
    text.length <= SPILL_HEAD + SPILL_TAIL
  ) {
    return { text, spilledChars: 0 };
  }
  const directory = options?.directory ?? spillDirectory();
  try {
    mkdirSync(directory, { recursive: true });
    const hash = createHash("sha1").update(text).digest("hex").slice(0, 16);
    const path = join(directory, `spill-${hash}.txt`);
    if (!existsSync(path)) writeFileSync(path, text, "utf8");
    const omitted = text.length - SPILL_HEAD - SPILL_TAIL;
    const note = [
      `[output spilled; ${text.length} chars, ${omitted} chars not inlined]`,
      `path: ${path}`,
      `size: ${text.length}`,
      "head:",
      text.slice(0, SPILL_HEAD),
      "tail:",
      text.slice(-SPILL_TAIL),
      "Read the file only if the omitted middle matters.",
    ].join("\n");
    if (note.length >= text.length) return { text, spilledChars: 0 };
    return { text: note, spilledChars: text.length - note.length };
  } catch (err) {
    log.warn(
      "[opencode-claude] failed to spill large output; inlining",
      err instanceof Error ? err.message : err,
    );
    return { text, spilledChars: 0 };
  }
}
