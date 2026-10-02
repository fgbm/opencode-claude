/**
 * Regression: the user sees why Claude refused, and CLI warnings worth
 * seeing reach the reasoning stream once.
 * - system/model_refusal_no_fallback shows its api_refusal_explanation as a
 *   note (replacing the generic "declined" note); a turn that then fails
 *   answers 400 "refusal" with that explanation instead of a retryable 500.
 * - High-priority notifications and warning-level informational messages
 *   become notes, once per key; lower levels stay hidden.
 *
 * Run: bun test/refusal-notices-regression.ts
 */
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const refusal = {
  type: "system",
  subtype: "model_refusal_no_fallback",
  original_model: "claude-opus-5",
  request_id: "req_1",
  api_refusal_category: "cyber",
  api_refusal_explanation: "This looks like malware development.",
  content: "Claude Code is unable to respond to this request.",
};

function reasoningOf(sse: string): { reasoning: string; finish: string | null } {
  let reasoning = "";
  let finish: string | null = null;
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const choice = JSON.parse(line.slice(6)).choices?.[0];
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  return { reasoning, finish };
}

async function main() {
  const { post, proxy } = await startMockedProxy("refusal-notices");
  const turn = (events: unknown[]) =>
    proxy.setClaudeQueryStarter(async () =>
      mockHandle(
        (async function* () {
          yield* events;
        })(),
      ),
    );
  try {
    // Refusal ending the turn normally: explanation note, content_filter, no generic note.
    turn([refusal, { type: "result", subtype: "success", is_error: false, stop_reason: "refusal", result: "", usage: {} }]);
    {
      const res = await post("refused", { stream: true, messages: [{ role: "user", content: "x" }] });
      assert.equal(res.status, 200);
      const { reasoning, finish } = reasoningOf(await res.text());
      assert.equal(finish, "content_filter");
      assert.match(reasoning, /Claude declined this request \(cyber\): This looks like malware development\./);
      assert.doesNotMatch(reasoning, /declined to answer/);
    }

    // Refusal followed by a failed turn: a non-retryable 400 with the reason.
    for (const stream of [true, false]) {
      turn([
        refusal,
        {
          type: "assistant",
          error: "invalid_request",
          message: { content: [{ type: "text", text: "API Error: Claude Code is unable to respond to this request." }] },
        },
        { type: "result", subtype: "success", is_error: true, result: "API Error: Claude Code is unable to respond to this request." },
      ]);
      const res = await post(`refused-failed-${stream}`, { stream, messages: [{ role: "user", content: "x" }] });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, "refusal");
      assert.match(body.error.message, /This looks like malware development/);
    }

    // CLI notices: once per key, only the levels worth seeing.
    const notification = (key: string, priority: string, text: string) => ({ type: "system", subtype: "notification", key, priority, text });
    turn([
      notification("ctx", "high", "Context is 95% full"),
      notification("ctx", "high", "Context is 95% full"),
      notification("tip", "low", "Tip: try /agents"),
      { type: "system", subtype: "informational", level: "warning", content: "Stop hook prevented continuation" },
      { type: "system", subtype: "informational", level: "info", content: "Loaded 3 skills" },
      textDelta("answer"),
      { type: "result", is_error: false, usage: {} },
    ]);
    {
      const res = await post("notices", { stream: true, messages: [{ role: "user", content: "x" }] });
      const { reasoning } = reasoningOf(await res.text());
      assert.equal(reasoning.match(/Context is 95% full/g)?.length, 1);
      assert.match(reasoning, /Stop hook prevented continuation/);
      assert.doesNotMatch(reasoning, /try \/agents|Loaded 3 skills/);
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — refusal and notices regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
