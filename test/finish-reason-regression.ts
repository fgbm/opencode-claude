/**
 * Regression: finish_reason follows Claude's stop_reason.
 * - max_tokens → "length", refusal → "content_filter" plus a short note that
 *   Claude declined; anything else → "stop".
 * - Only the main conversation counts: a subagent's stop_reason does not.
 * - A parked turn still ends its response with "tool_calls".
 *
 * Run: bun test/finish-reason-regression.ts
 */
import { assert, bashTool, callTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const messageDelta = (stop_reason: string, parent_tool_use_id: string | null = null) => ({
  type: "stream_event",
  parent_tool_use_id,
  event: { type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 1 } },
});

function finishOf(sse: string): { finish: string | null; reasoning: string } {
  let finish: string | null = null;
  let reasoning = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const chunk = JSON.parse(line.slice(6));
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
  }
  return { finish, reasoning };
}

async function main() {
  const { post, proxy } = await startMockedProxy("finish-reason");
  const turn = (events: unknown[]) =>
    proxy.setClaudeQueryStarter(async () =>
      mockHandle(
        (async function* () {
          yield* events;
        })(),
      ),
    );
  const ask = async (session: string, stream: boolean) => {
    const res = await post(session, { stream, messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    if (stream) return finishOf(await res.text());
    const json = (await res.json()) as any;
    return {
      finish: json.choices[0].finish_reason as string,
      reasoning: String(json.choices[0].message.reasoning_content ?? ""),
    };
  };
  try {
    for (const stream of [true, false]) {
      turn([textDelta("long answer"), messageDelta("max_tokens"), { type: "result", is_error: false, stop_reason: "max_tokens", usage: {} }]);
      assert.equal((await ask(`length-${stream}`, stream)).finish, "length");

      turn([textDelta("I can't"), messageDelta("refusal"), { type: "result", is_error: false, stop_reason: "refusal", usage: {} }]);
      const refused = await ask(`refusal-${stream}`, stream);
      assert.equal(refused.finish, "content_filter");
      assert.match(refused.reasoning, /Claude declined to answer/);

      // The main turn's stop_reason, not a subagent's, and result wins.
      turn([textDelta("done"), messageDelta("max_tokens", "toolu_sub"), messageDelta("end_turn"), { type: "result", is_error: false, stop_reason: "end_turn", usage: {} }]);
      assert.equal((await ask(`stop-${stream}`, stream)).finish, "stop");
    }

    // Parked tool calls are still "tool_calls".
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield messageDelta("tool_use");
          callTool(params, "bash", { command: "ls" }).catch(() => {});
          await new Promise(() => {});
        })(),
      ),
    );
    const res = await post("parked", { stream: true, tools: [bashTool], messages: [{ role: "user", content: "hi" }] });
    assert.equal(finishOf(await res.text()).finish, "tool_calls");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — finish reason regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
