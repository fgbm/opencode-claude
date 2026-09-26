/**
 * The Claude Code preset replaces OpenCode's system prompt. Most of that
 * prompt is harness boilerplate Claude Code has its own version of, but part
 * of it is user configuration nothing else delivers: a custom agent's prompt,
 * `instructions` files and AGENTS.md, the Code Mode tool catalog and the
 * skills list. This recovers those parts so they can ride the preset append.
 */
import { extractTextContent } from "./prompt.js";

type MessageLike = { role?: string; content?: unknown };

/** OpenCode 2's stock base prompt; an agent prompt takes its place. */
const STOCK_BASE_PROMPT = /^You are an AI agent running in OpenCode\b/;
/** First harness section after the base prompt (model, then env, then date). */
const HARNESS_START = /^# Your Model$|^Here is some useful information about the environment/m;
const ENV_END = "</env>";
const DATE_LINE = /^\s*Today's date:[^\n]*\n?/;

/** OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT=0 turns forwarding off. */
export function systemContextForwardingEnabled(): boolean {
  const raw = (process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * Split OpenCode's leading system message around its harness block: the text
 * before it is the agent prompt (dropped when it is the stock one), the text
 * after `<env>` and the date line is user configuration. Later system
 * messages are context updates, not the prompt, so only the first is read.
 * Unrecognized layouts forward nothing rather than OpenCode's whole prompt.
 */
export function openCodeSystemContext(messages: MessageLike[]): string {
  const first = messages.find((m) => m.role === "system");
  const system = first ? extractTextContent(first.content).trim() : "";
  if (!system) return "";

  const harness = HARNESS_START.exec(system);
  const envEnd = system.indexOf(ENV_END);
  if (!harness || envEnd < harness.index) return "";

  const head = system.slice(0, harness.index).trim();
  const agentPrompt = STOCK_BASE_PROMPT.test(head) ? "" : head;
  const config = system
    .slice(envEnd + ENV_END.length)
    .replace(DATE_LINE, "")
    .trim();

  const parts: string[] = [];
  if (agentPrompt) {
    parts.push(
      `# Agent role\n\nThe OpenCode agent for this session is defined below. It takes precedence over the generic role above.\n\n${agentPrompt}`,
    );
  }
  if (config) {
    parts.push(`# OpenCode context\n\n${config}`);
  }
  return parts.join("\n\n");
}
