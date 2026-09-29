/**
 * Regression: a turn stopped while parked on a tool call leaves the Claude
 * session at the CLI's interruption entries, not at the unanswered tool_use.
 *
 * Checked live (CLI 2.1.224 and 2.1.284): interrupting a parked MCP call
 * makes the CLI append a rejected tool_result and "[Request interrupted by
 * user for tool use]" and emit both as user events. Resuming with
 * resumeSessionAt on the dangling tool_use itself also works (the CLI pairs
 * it before calling the API), so this only keeps the resumed history
 * faithful: Claude sees that the call was interrupted.
 *
 * Run: bun test/interrupted-leaf-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  bashTool,
  callTool,
  interruptibleTurn,
  sleep,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

const SESSION = "sess-interrupted";

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-leaf-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${SESSION}.jsonl`),
    ['{"uuid":"a-tooluse"}', '{"uuid":"t1-reject"}', '{"uuid":"t1-marker"}', ""].join("\n"),
  );

  const { post, proxy } = await startMockedProxy("interrupted-leaf");
  const { getSessionLeafUuid } = await import("../src/session-store.ts");
  const { closeSessionBridges } = await import("../src/bridge-pool.ts");
  try {
    const log: string[] = [];
    let seen: Record<string, unknown> = {};
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return interruptibleTurn(
        log,
        "t1",
        async function* () {
          yield { type: "system", subtype: "init", session_id: SESSION };
          yield {
            type: "assistant",
            uuid: "a-tooluse",
            session_id: SESSION,
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use" }] },
          };
          callTool(params, "bash", { command: "sleep 100" }).catch(() => {});
          await new Promise(() => {});
        },
        { sessionId: SESSION },
      );
    });
    const first = await post("leaf-chat", {
      tools: [bashTool],
      messages: [{ role: "user", content: "run it" }],
    });
    assert.equal(((await first.json()) as any).choices[0].finish_reason, "tool_calls");
    assert.equal(getSessionLeafUuid("leaf-chat"), "a-tooluse");

    // The user stops the session while the tool runs.
    assert.equal(closeSessionBridges("leaf-chat"), 1);
    await sleep(50);
    assert.deepEqual(log, ["t1:interrupt", "t1:close"]);
    assert.equal(getSessionLeafUuid("leaf-chat"), "t1-marker");

    // The next message resumes after the interruption.
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return interruptibleTurn(log, "t2", async function* () {
        yield textDelta("ok");
        yield { type: "result", is_error: false, usage: {} };
      });
    });
    const next = await post("leaf-chat", {
      tools: [bashTool],
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_x", content: "Tool execution aborted" },
        { role: "user", content: "do something else" },
      ],
    });
    assert.equal(next.status, 200);
    await next.text();
    assert.equal(seen.resume, SESSION);
    assert.equal(seen.resumeSessionAt, "t1-marker");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
    clearInterval(keepAlive);
  }
  console.log("ok — interrupted leaf regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
