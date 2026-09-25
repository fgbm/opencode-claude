/**
 * Regression: a user message sent while a bridged tool is running (OpenCode
 * puts it after the tool result in the resume request) must reach Claude
 * with that tool result instead of being dropped. OpenCode's promoted-media
 * marker message is not steering. (Ported from the fork's 4ca2338.)
 *
 * Run: bun test/steering-regression.ts
 */
import {
  assert,
  bashTool,
  callTool,
  mockHandle,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

async function main() {
  const { collectSteering, SYNTHETIC_TOOL_MEDIA_PROMPT } = await import(
    "../src/prompt.ts"
  );
  const texts = (messages: unknown[]) =>
    collectSteering(messages as any).map((b) => (b.type === "text" ? b.text : b.type));
  assert.deepEqual(texts([{ role: "user", content: "hi" }]), []);
  assert.deepEqual(texts([{ role: "user", content: "old" }, { role: "tool", content: "r" }]), []);
  assert.deepEqual(
    texts([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: [{ type: "text", text: "use port 8080" }] },
      { role: "user", content: "and skip tests" },
    ]),
    ["use port 8080", "and skip tests"],
  );
  assert.deepEqual(
    texts([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: SYNTHETIC_TOOL_MEDIA_PROMPT },
    ]),
    [],
  );

  const { post, proxy } = await startMockedProxy("steer");

  async function run(session: string, afterResult: unknown[]) {
    let received: string | null = null;
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await callTool(params, "bash", { command: "sleep 40" });
          received = res.content.map((b) => b.text ?? "").join("\n");
          // Like the real SDK, the tool result comes back as a user message
          // before the next assistant output.
          yield { type: "user", message: { role: "user", content: [] } };
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
    );
    const first = (await (await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "run it" }],
    })).json()) as any;
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "bash");
    const resume = (await (await post(session, {
      tools: [bashTool],
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "exit 0" },
        ...afterResult,
      ],
    })).json()) as any;
    assert.match(String(resume.choices[0].message.content), /DONE/);
    return received as string | null;
  }

  try {
    const steered = await run("steer-yes", [
      { role: "user", content: "Actually, the secret word is PINEAPPLE." },
    ]);
    assert.ok(steered, "tool result delivered");
    assert.ok(steered!.startsWith("exit 0"));
    assert.match(steered!, /<system-reminder>[\s\S]*PINEAPPLE[\s\S]*<\/system-reminder>/);

    const plain = await run("steer-no", []);
    assert.equal(plain, "exit 0");

    // Results of one park arriving over two resume requests: the queued
    // message rides the first resolved result only, never both.
    const got: string[] = [];
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "steer-split-sess" };
          yield { type: "stream_event", event: { type: "message_start" } };
          const a = callTool(params, "bash", { command: "a" });
          const b = callTool(params, "bash", { command: "b" });
          yield { type: "stream_event", event: { type: "message_stop" } };
          for (const res of await Promise.all([a, b])) {
            got.push(res.content.map((c) => c.text ?? "").join("\n"));
          }
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
    );
    const turn = [{ role: "user", content: "run both" }];
    const parked = (await (await post("steer-split", { tools: [bashTool], messages: turn })).json()) as any;
    const calls = parked.choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    const asst = { role: "assistant", content: null, tool_calls: calls };
    const steer = { role: "user", content: "Use MANGO instead." };
    const partial = (await (await post("steer-split", {
      tools: [bashTool],
      messages: [...turn, asst, { role: "tool", tool_call_id: calls[0].id, content: "ra" }, steer],
    })).json()) as any;
    assert.equal(partial.choices[0].finish_reason, "tool_calls");
    const done = (await (await post("steer-split", {
      tools: [bashTool],
      messages: [
        ...turn,
        asst,
        { role: "tool", tool_call_id: calls[0].id, content: "ra" },
        { role: "tool", tool_call_id: calls[1].id, content: "rb" },
        steer,
      ],
    })).json()) as any;
    assert.match(String(done.choices[0].message.content), /DONE/);
    assert.equal(got.join("\n").match(/MANGO/g)?.length, 1, "steering forwarded once");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — steering regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
