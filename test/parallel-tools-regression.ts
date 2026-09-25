/**
 * Regression: every tool call of one assistant message reaches OpenCode in
 * one tool_calls response (the park is held until message_stop or a quiet
 * period), and read-only tools, subagents included, carry readOnlyHint in the
 * tools/list Claude Code reads. (Ported from the fork's 1c66cb8.)
 *
 * Run: bun test/parallel-tools-regression.ts
 */
import { assert, mcpExtra, mcpHandlers, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

type RegisteredTool = {
  annotations?: { readOnlyHint?: boolean };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toolSchema = (name: string) => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
  },
});

async function readSse(res: Response) {
  const text = await res.text();
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let content = "";
  let finish: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const choice = JSON.parse(line.slice(6)).choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) content += choice.delta.content;
    for (const tc of choice.delta?.tool_calls ?? []) {
      calls.set(tc.index, { id: tc.id, name: tc.function.name, args: tc.function.arguments });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return { content, calls: [...calls.values()], finish };
}

async function main() {
  const { post, proxy } = await startMockedProxy("parallel");
  const tools = [toolSchema("read"), toolSchema("edit"), toolSchema("task"), toolSchema("subagent")];
  const postTools = (messages: unknown[]) =>
    post("parallel-tools", { stream: true, tools, messages });

  let registered: Record<string, RegisteredTool> = {};
  let listed: Array<Record<string, any>> = [];
  let quiet = false;
  proxy.setClaudeQueryStarter(async (params) => {
    registered = (params.mcpServers as any).opencode.instance._registeredTools;
    listed = (await mcpHandlers(params).get("tools/list")!({ method: "tools/list", params: {} }, mcpExtra)).tools;
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "par-sess" };
        yield { type: "stream_event", event: { type: "message_start" } };
        yield textDelta("reading two files");
        // The CLI starts read-only calls while the message still streams:
        // the second one arrives after the first has already parked.
        const first = registered.read!.handler({ filePath: "a.txt" }, mcpExtra);
        // The CLI emits an `assistant` event per completed content block;
        // it must not be taken for the end of the message.
        yield { type: "assistant", message: { role: "assistant", content: [] } };
        await sleep(150);
        const second = registered.read!.handler({ filePath: "b.txt" }, mcpExtra);
        await sleep(50);
        // Without message_stop the quiet period has to release the park.
        if (!quiet) yield { type: "stream_event", event: { type: "message_stop" } };
        const results = await Promise.all([first, second]);
        yield textDelta(`GOT ${results.map((r) => r.content[0]!.text).join("+")}`);
        yield { type: "result", is_error: false, result: "" };
      })(),
    );
  });

  async function roundTrip() {
    const userTurn = [{ role: "user", content: "read a.txt and b.txt" }];
    const first = await readSse(await postTools(userTurn));
    assert.equal(first.finish, "tool_calls");
    assert.match(first.content, /reading two files/);
    assert.equal(first.calls.length, 2, "both calls of the message in one response");
    assert.deepEqual(first.calls.map((c) => JSON.parse(c.args).filePath), ["a.txt", "b.txt"]);
    const second = await readSse(
      await postTools([
        ...userTurn,
        {
          role: "assistant",
          content: first.content,
          tool_calls: first.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
          })),
        },
        { role: "tool", tool_call_id: first.calls[0]!.id, content: "A" },
        { role: "tool", tool_call_id: first.calls[1]!.id, content: "B" },
      ]),
    );
    assert.equal(second.finish, "stop");
    assert.match(second.content, /GOT A\+B/);
  }

  try {
    await roundTrip();
    // Annotation: only read-only tools (and task) may run side by side, in
    // the served tools/list as well as the SDK registration.
    const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
    assert.equal(byName.read.annotations?.readOnlyHint, true);
    assert.equal(byName.task.annotations?.readOnlyHint, true);
    assert.equal(byName.subagent.annotations?.readOnlyHint, true);
    assert.equal(byName.edit.annotations, undefined);
    assert.equal(byName.edit._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(registered.read!.annotations?.readOnlyHint, true);
    assert.equal(registered.edit!.annotations?.readOnlyHint, undefined);

    quiet = true;
    const started = Date.now();
    await roundTrip();
    assert.ok(Date.now() - started >= 2_500, "quiet period released the park");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — parallel tools regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
