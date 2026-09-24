/**
 * Large tool outputs are cut to a short head/tail with a note on how much was
 * dropped. Inlining them in full is re-read on every later turn. When an
 * output store is passed, the full text stays in memory for a while and the
 * note tells the model how to read the middle with `output_slice`. Nothing is
 * written to disk. Disable with OPENCODE_CLAUDE_SPILL_CHARS=0.
 */
import type { OutputStore } from "./output-store.js";

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

export type PresentedOutput = {
  text: string;
  /** Characters of the original output that were not inlined. */
  spilledChars: number;
};

/**
 * Tools whose result is a file that is already on disk. Cutting such a
 * result hides the part the model asked for; it can re-read the source with
 * offset/limit instead.
 */
const FILE_READ_TOOLS = new Set(["read"]);

export function isFileReadTool(name: string | undefined): boolean {
  if (!name) return false;
  return FILE_READ_TOOLS.has(name.replace(/^mcp__opencode__/, "").toLowerCase());
}

function readPathOf(argumentsJson: string | undefined): string | undefined {
  if (!argumentsJson) return undefined;
  try {
    const args = JSON.parse(argumentsJson) as Record<string, unknown>;
    const path = args.path ?? args.filePath ?? args.file_path;
    return typeof path === "string" && path ? path : undefined;
  } catch {
    // Unparseable arguments only lose the source hint, not the result.
    return undefined;
  }
}

/** A live tool result as Claude receives it on this turn. */
export function presentToolResult(
  name: string | undefined,
  text: string,
  store?: OutputStore,
): PresentedOutput {
  if (isFileReadTool(name)) return { text, spilledChars: 0 };
  return presentLargeOutput(text, { store });
}

/**
 * A file read replayed in transferred history. Over the threshold it becomes
 * a pointer back to the source file.
 */
export function presentHistoricalRead(
  text: string,
  argumentsJson: string | undefined,
  threshold: number = spillThreshold(),
): string {
  if (threshold <= 0 || text.length <= threshold) return text;
  const source = readPathOf(argumentsJson);
  return [
    `[file read elided from history; ${text.length} chars]`,
    ...(source ? [`source: ${source}`] : []),
    "head:",
    text.slice(0, SPILL_HEAD),
    "Re-read the source with offset/limit if the content matters.",
  ].join("\n");
}

/**
 * Return `text` unchanged when it is under the threshold or cutting is off;
 * otherwise keep the head and tail and say how much of the middle was dropped.
 */
export function presentLargeOutput(
  text: string,
  options?: { threshold?: number; store?: OutputStore },
): PresentedOutput {
  const threshold = options?.threshold ?? spillThreshold();
  // The note is head + tail plus a few lines. Cutting something that already
  // fits in that window would add tokens, not remove them.
  if (
    threshold <= 0 ||
    text.length <= threshold ||
    text.length <= SPILL_HEAD + SPILL_TAIL
  ) {
    return { text, spilledChars: 0 };
  }
  const omitted = text.length - SPILL_HEAD - SPILL_TAIL;
  const id = options?.store?.put(text);
  const note = [
    `[output cut; ${text.length} chars, ${omitted} chars of the middle dropped]`,
    ...(id ? [`output id: ${id}`] : []),
    "head:",
    text.slice(0, SPILL_HEAD),
    "tail:",
    text.slice(-SPILL_TAIL),
    id
      ? `To read the middle, call output_slice(id="${id}", offset=${SPILL_HEAD}). It is kept in memory for about 30 minutes; after that, re-run the command narrowed (grep, head, sed -n).`
      : "The middle is not saved anywhere. To see it, re-run the command narrowed (grep, head, sed -n).",
  ].join("\n");
  if (note.length >= text.length) return { text, spilledChars: 0 };
  return { text: note, spilledChars: text.length - note.length };
}
