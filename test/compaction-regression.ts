/**
 * Regression: OpenCode compaction must free the context for real.
 * OpenCode compacts between steps, usually while the turn is parked on a
 * tool. That live Claude query holds the full uncompacted context; resuming
 * it after the summary made compaction a no-op (the next request continued
 * at the same ~800k tokens). The summary request now closes the parked turn
 * and drops the session binding, so the next turn starts fresh from the
 * compacted history.
 *
 * Run: bun test/compaction-regression.ts
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, callTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { port, post, proxy } = await startMockedProxy("compaction");
  const { getForeignSessionId } = await import("../src/session-store.ts");
  const session = "ses_compact";

  try {
    // A primary turn parks on a bash call.
    let closed = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "old-full-context" };
          callTool(params, "bash", { command: "ls" }).catch(() => {});
          await released;
          yield { type: "system", subtype: "init", session_id: "old-full-context" };
        })(),
        () => {
          closed = true;
          release();
        },
      ),
    );
    const parked = await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "ORIGINAL-ASK" }],
    });
    assert.equal(parked.status, 200);
    const call = ((await parked.json()) as any).choices[0].message.tool_calls?.[0];
    assert.equal(call?.function.name, "bash");
    assert.equal(getForeignSessionId(session), "old-full-context");

    // OpenCode compacts the chat while the turn is parked.
    proxy.setClaudeQueryStarter(async () =>
      mockHandle(
        (async function* () {
          yield textDelta("SUMMARY");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
    );
    const summary = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
        "x-opencode-claude-kind": "compaction",
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "Summarize the conversation." }],
      }),
    });
    assert.equal(summary.status, 200);
    await summary.text();
    await sleep(50);
    assert.equal(closed, true, "compaction closes the parked turn");
    assert.equal(getForeignSessionId(session), undefined, "compaction drops the binding");

    // The next turn starts a fresh Claude session from the compacted history.
    let next: StartClaudeQueryParams | undefined;
    proxy.setClaudeQueryStarter(async (params) => {
      next = params;
      return mockHandle(
        (async function* () {
          yield textDelta("FRESH");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });
    const after = await post(session, {
      tools: [bashTool],
      messages: [
        { role: "user", content: "COMPACTED-SUMMARY" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Continue." },
      ],
    });
    assert.equal(after.status, 200);
    assert.match(String(((await after.json()) as any).choices[0].message.content), /FRESH/);
    assert.equal(next?.resume, undefined, "the old full-context session is not resumed");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — compaction regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
