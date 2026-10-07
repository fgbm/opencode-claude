/**
 * Regression: a hop that fails without an assistant event of its own (seen
 * live as a session limit hit mid-query) falls back to the SDK `result`
 * usage, which is cumulative for the whole query. The journal took it as
 * that hop's usage and counted every earlier hop again: one line of a 1M
 * chat showed 33M cache-read tokens. The hop may claim only what the result
 * holds beyond the calls the query already reported.
 *
 * Run: bun test/result-share-usage-regression.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, bashTool, callTool, mockHandle, startMockedProxy } from "./helpers.ts";

async function main() {
  const { tmp, post, proxy } = await startMockedProxy("result-share");
  const session = "ses_result_share";

  proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "share-sess" };
        yield {
          type: "assistant",
          message: {
            id: "msg_1",
            role: "assistant",
            content: [],
            usage: { input_tokens: 2, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 300, output_tokens: 100 },
          },
        };
        await callTool(params, "bash", { command: "true" });
        yield { type: "user", message: { role: "user", content: [] } };
        // The query fails before any new assistant event; its usage is the
        // query's running total: msg_1 plus one call never seen as an event.
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["API Error: 500 boom"],
          modelUsage: {
            "claude-sonnet-5": {
              inputTokens: 2 + 1,
              outputTokens: 100 + 50,
              cacheReadInputTokens: 10_000 + 10_300,
              cacheCreationInputTokens: 300 + 40,
              costUSD: 0.12,
            },
          },
        };
      })(),
    ),
  );

  const history: Array<Record<string, unknown>> = [{ role: "user", content: "run it" }];
  try {
    const first = await post(session, { tools: [bashTool], messages: history });
    assert.equal(first.status, 200);
    const call = (await first.json()).choices[0].message.tool_calls[0];
    history.push({ role: "assistant", content: null, tool_calls: [call] });
    history.push({ role: "tool", tool_call_id: call.id, content: "ok" });
    await (await post(session, { tools: [bashTool], messages: history })).text();

    const lines = readFileSync(join(tmp, "opencode-claude", "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].cache_read, 10_000);
    assert.equal(lines[0].output, 100);

    // The failed hop: only the call the earlier line did not have.
    assert.match(lines[1].error, /boom/);
    assert.equal(lines[1].cache_read, 10_300);
    assert.equal(lines[1].cache_write, 40);
    assert.equal(lines[1].input, 1);
    assert.equal(lines[1].output, 50);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — result share usage regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
