/**
 * Convert Claude Agent SDK result usage into OpenAI-compatible usage objects.
 *
 * Prefer `modelUsage` for totals (includes compact / auxiliary pipeline calls).
 * Fall back to per-turn `usage` (main agent loop only).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /**
   * Split of cache_write_tokens by Anthropic TTL. Not part of the OpenAI
   * usage object sent back to OpenCode — stripped by {@link clientUsage}.
   * A 1-hour write costs 2× input; a 5-minute write costs 1.25×.
   */
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
  /** Estimated USD from the Agent SDK (not a billing statement). */
  cost_usd?: number;
  /** Per-model breakdown when the SDK provides modelUsage. */
  model_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      cost_usd: number;
      context_window?: number;
    }
  >;
};

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cacheWriteSplit(usage: Record<string, unknown>): {
  write5m: number;
  write1h: number;
} {
  const creation = usage.cache_creation;
  if (!creation || typeof creation !== "object") {
    return { write5m: 0, write1h: 0 };
  }
  const c = creation as Record<string, unknown>;
  return {
    write5m: asNumber(c.ephemeral_5m_input_tokens),
    write1h: asNumber(c.ephemeral_1h_input_tokens),
  };
}

function fromAnthropicUsage(usage: Record<string, unknown>): OpenAIUsage {
  const input = asNumber(usage.input_tokens);
  const completion = asNumber(usage.output_tokens);
  const cached = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  // OpenAI contract: prompt_tokens is the INCLUSIVE prompt total and
  // prompt_tokens_details.cached_tokens is a subset of it. Anthropic reports
  // input_tokens excluding cached tokens, so sum them back in — consumers
  // (OpenCode) derive the non-cached count by subtracting the details.
  const prompt = input + cached + cacheWrite;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  const split = cacheWriteSplit(usage);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(split.write5m > 0 ? { cache_write_5m_tokens: split.write5m } : {}),
    ...(split.write1h > 0 ? { cache_write_1h_tokens: split.write1h } : {}),
  };
}

function fromModelUsage(
  modelUsage: Record<string, unknown>,
): OpenAIUsage | null {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  let cost = 0;
  const breakdown: NonNullable<OpenAIUsage["model_usage"]> = {};
  let any = false;

  for (const [modelId, raw] of Object.entries(modelUsage)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    any = true;
    const input = asNumber(entry.inputTokens);
    const output = asNumber(entry.outputTokens);
    const cacheRead = asNumber(entry.cacheReadInputTokens);
    const cacheCreate = asNumber(entry.cacheCreationInputTokens);
    const costUSD = asNumber(entry.costUSD);
    prompt += input + cacheRead + cacheCreate;
    completion += output;
    cached += cacheRead;
    cacheWrite += cacheCreate;
    cost += costUSD;
    breakdown[modelId] = {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      cost_usd: costUSD,
      ...(typeof entry.contextWindow === "number"
        ? { context_window: entry.contextWindow }
        : {}),
    };
  }

  if (!any) return null;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(cost > 0 ? { cost_usd: cost } : {}),
    ...(Object.keys(breakdown).length ? { model_usage: breakdown } : {}),
  };
}

/**
 * Extract OpenAI-compatible usage from an Agent SDK `result` event.
 */
export function usageFromSdkResult(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "result") return null;

  if (e.modelUsage && typeof e.modelUsage === "object") {
    const fromModels = fromModelUsage(
      e.modelUsage as Record<string, unknown>,
    );
    if (fromModels) {
      if (
        typeof e.total_cost_usd === "number" &&
        Number.isFinite(e.total_cost_usd) &&
        fromModels.cost_usd === undefined
      ) {
        fromModels.cost_usd = e.total_cost_usd;
      }
      return fromModels;
    }
  }

  if (e.usage && typeof e.usage === "object") {
    const usage = fromAnthropicUsage(e.usage as Record<string, unknown>);
    if (
      typeof e.total_cost_usd === "number" &&
      Number.isFinite(e.total_cost_usd)
    ) {
      usage.cost_usd = e.total_cost_usd;
    }
    return usage;
  }

  return null;
}

/**
 * Extract per-API-call usage from an Agent SDK `assistant` event
 * (`message.usage`). Each assistant event carries the usage of exactly one
 * Anthropic API call — including parked (tool-call) turns, where no `result`
 * event exists yet because the query is still alive.
 */
export function usageFromAssistantEvent(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "assistant") return null;
  const message = e.message;
  if (!message || typeof message !== "object") return null;
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  return fromAnthropicUsage(usage as Record<string, unknown>);
}

export type UsageSections = {
  kind?: string;
  resumed?: boolean;
  history_chars?: number;
  tool_schema_chars?: number;
  system_append_chars?: number;
  user_chars?: number;
  tools_offered?: number;
  tool_names?: string[];
  tool_errors?: string[];
  spilled_chars?: number;
  hop?: "query" | "continuation" | "replay";
};

export type UsageLogEntry = {
  conversationKey: string;
  model: string;
  usage: OpenAIUsage | null;
  toolCalls: number;
  error?: string;
  sections?: UsageSections;
};

function usageLogEnabled(): boolean {
  const value = (process.env.OPENCODE_CLAUDE_USAGE_LOG ?? "").toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

export function usageLogPath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "usage.jsonl");
}

/**
 * Append one line per HTTP response with usage split by billing type.
 * OpenCode's openai-compatible path drops cache-write tokens into plain
 * input, so this file is the only place the split survives. Disable with
 * OPENCODE_CLAUDE_USAGE_LOG=0.
 */
export function recordUsage(entry: UsageLogEntry): void {
  if (!usageLogEnabled()) return;
  const u = entry.usage;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const write5m = u?.cache_write_5m_tokens ?? 0;
  const write1h = u?.cache_write_1h_tokens ?? 0;
  const turnCost = estimateTurnCostUsd(entry.model, u);
  const line = {
    ts: new Date().toISOString(),
    conversationKey: entry.conversationKey,
    model: entry.model,
    input: u ? u.prompt_tokens - cacheRead - cacheWrite : 0,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    ...(write5m > 0 ? { cache_write_5m: write5m } : {}),
    ...(write1h > 0 ? { cache_write_1h: write1h } : {}),
    output: u?.completion_tokens ?? 0,
    tool_calls: entry.toolCalls,
    // cost_usd is the SDK figure and is cumulative for the resumed query,
    // not this hop. turn_cost_usd is the price of the tokens on this line.
    ...(u?.cost_usd !== undefined ? { cost_usd: u.cost_usd } : {}),
    ...(turnCost !== null ? { turn_cost_usd: turnCost } : {}),
    ...(entry.sections ? { sections: entry.sections } : {}),
    ...(entry.error ? { error: entry.error.slice(0, 200) } : {}),
  };
  try {
    const path = usageLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // telemetry must never break a turn
  }
}

/**
 * Accumulate per-call usage deltas into a per-response total.
 */
export function addOpenAIUsage(
  acc: OpenAIUsage | null,
  delta: OpenAIUsage,
): OpenAIUsage {
  if (!acc) return { ...delta };
  const cached =
    (acc.prompt_tokens_details?.cached_tokens ?? 0) +
    (delta.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheWrite =
    (acc.prompt_tokens_details?.cache_write_tokens ?? 0) +
    (delta.prompt_tokens_details?.cache_write_tokens ?? 0);
  const reasoning =
    (acc.completion_tokens_details?.reasoning_tokens ?? 0) +
    (delta.completion_tokens_details?.reasoning_tokens ?? 0);
  const write5m =
    (acc.cache_write_5m_tokens ?? 0) + (delta.cache_write_5m_tokens ?? 0);
  const write1h =
    (acc.cache_write_1h_tokens ?? 0) + (delta.cache_write_1h_tokens ?? 0);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: acc.prompt_tokens + delta.prompt_tokens,
    completion_tokens: acc.completion_tokens + delta.completion_tokens,
    total_tokens: acc.total_tokens + delta.total_tokens,
    ...(Object.keys(promptDetails).length
      ? { prompt_tokens_details: promptDetails }
      : {}),
    ...(reasoning > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
    ...(write5m > 0 ? { cache_write_5m_tokens: write5m } : {}),
    ...(write1h > 0 ? { cache_write_1h_tokens: write1h } : {}),
  };
}

/**
 * Usage object safe to put on the OpenAI response. Drops harness-only
 * cache-TTL fields so OpenCode's parser sees the same shape as before.
 */
export function clientUsage(usage: OpenAIUsage): OpenAIUsage {
  const { cache_write_5m_tokens: _write5m, cache_write_1h_tokens: _write1h, ...rest } =
    usage;
  return rest;
}

/**
 * Published API rates, USD per million tokens, checked 2026-09-24.
 * Opus 5.5 cache read is $0.20 (0.05×), not the usual 0.1×. A 1-hour cache
 * write is 2× input; a 5-minute write is 1.25×. The `opus` alias is priced
 * as claude-opus-5-5 because that is the id the local CLI billed on this date.
 * Unknown cache writes (no TTL split) are priced as 1-hour writes — the TTL
 * the measured CLI sessions actually used.
 */
const MODEL_PRICES: Record<
  string,
  {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  }
> = {
  "claude-opus-5-5": {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
  },
  "claude-opus-5": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  "claude-sonnet-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
  },
  "claude-fable-5-1": {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
  },
};

const PRICE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
};

export function estimateTurnCostUsd(
  model: string,
  usage: OpenAIUsage | null,
): number | null {
  if (!usage) return null;
  const id = model.split("/").pop() ?? model;
  const price = MODEL_PRICES[id] ?? MODEL_PRICES[PRICE_ALIASES[id] ?? ""];
  if (!price) return null;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const write5m = usage.cache_write_5m_tokens ?? 0;
  const write1h = usage.cache_write_1h_tokens ?? 0;
  const writeUnknown = Math.max(0, cacheWrite - write5m - write1h);
  const input = usage.prompt_tokens - cacheRead - cacheWrite;
  const usd =
    (input * price.input +
      usage.completion_tokens * price.output +
      cacheRead * price.cacheRead +
      write5m * price.cacheWrite5m +
      (write1h + writeUnknown) * price.cacheWrite1h) /
    1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}

/** Count a replayed SDK assistant message only once across tool continuations. */
export function addUniqueAssistantUsage(
  acc: OpenAIUsage | null,
  delta: OpenAIUsage,
  messageId: string | null,
  seen: Set<string>,
): OpenAIUsage | null {
  if (messageId) {
    if (seen.has(messageId)) return acc;
    seen.add(messageId);
  }
  return addOpenAIUsage(acc, delta);
}

/**
 * Raise one API call's counted output tokens to `outputTokens`.
 *
 * `assistant` events are emitted per content block while the call is still
 * streaming, so their `output_tokens` is an early snapshot (often single
 * digits). The final cumulative count arrives in the `message_delta` stream
 * event. Counting per message id with max-merge makes the result independent
 * of which of the two arrives first.
 */
export function settleOutputTokens(
  acc: OpenAIUsage | null,
  messageId: string | null,
  outputTokens: number,
  counted: Map<string, number>,
): OpenAIUsage | null {
  if (!messageId || !(outputTokens > 0)) return acc;
  const prev = counted.get(messageId) ?? 0;
  if (outputTokens <= prev) return acc;
  counted.set(messageId, outputTokens);
  const add = outputTokens - prev;
  return addOpenAIUsage(acc, {
    prompt_tokens: 0,
    completion_tokens: add,
    total_tokens: add,
  });
}

/**
 * Count an `assistant` event's usage: prompt/cache tokens once per message
 * id, output tokens via {@link settleOutputTokens}.
 */
export function addAssistantUsageSnapshot(
  acc: OpenAIUsage | null,
  delta: OpenAIUsage,
  messageId: string | null,
  seen: Set<string>,
  outputById: Map<string, number>,
): OpenAIUsage | null {
  if (!messageId) return addOpenAIUsage(acc, delta);
  const promptOnly: OpenAIUsage = {
    ...delta,
    completion_tokens: 0,
    total_tokens: delta.prompt_tokens,
  };
  const withPrompt = addUniqueAssistantUsage(acc, promptOnly, messageId, seen);
  return settleOutputTokens(
    withPrompt,
    messageId,
    delta.completion_tokens,
    outputById,
  );
}

/**
 * Combine the per-response accumulated usage (one entry per Anthropic API
 * call seen during this HTTP response) with the SDK `result` snapshot.
 *
 * The accumulated value is the correct per-response accounting; the result
 * snapshot is cumulative for the whole Claude query (all prior turns of a
 * resumed/continued session included) and would double-count. It is only a
 * fallback for turns where no assistant events were observed, plus a donor
 * for cost/model breakdown metadata.
 */
export function resolveTurnUsage(
  accumulated: OpenAIUsage | null,
  result: OpenAIUsage | null,
): OpenAIUsage | null {
  if (!accumulated) return result;
  if (!result) return accumulated;
  return {
    ...accumulated,
    ...(accumulated.cost_usd === undefined && result.cost_usd !== undefined
      ? { cost_usd: result.cost_usd }
      : {}),
    ...(accumulated.model_usage === undefined && result.model_usage !== undefined
      ? { model_usage: result.model_usage }
      : {}),
  };
}

export function formatCompactNote(meta: unknown): string {
  if (!meta || typeof meta !== "object") {
    return "[compact] Conversation compacted.\n";
  }
  const m = meta as Record<string, unknown>;
  const trigger = typeof m.trigger === "string" ? m.trigger : "auto";
  const pre = asNumber(m.pre_tokens);
  const post =
    typeof m.post_tokens === "number" && Number.isFinite(m.post_tokens)
      ? m.post_tokens
      : null;
  const duration =
    typeof m.duration_ms === "number" && Number.isFinite(m.duration_ms)
      ? m.duration_ms
      : null;
  const parts = [`[compact] Conversation compacted (${trigger})`];
  if (pre > 0) {
    parts.push(
      post !== null
        ? `tokens ${pre} → ${post}`
        : `pre_tokens ${pre}`,
    );
  }
  if (duration !== null) parts.push(`${duration}ms`);
  return `${parts.join("; ")}.\n`;
}
