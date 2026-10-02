/**
 * Regression: CLI API retries are visible and never mistaken for a dead or
 * a successful turn.
 * - system/api_retry becomes a short reasoning note.
 * - Retries do not commit the response head: a turn whose retries run out
 *   still answers with a real HTTP error.
 * - The stall watchdog allows for the delay a retry announces.
 *
 * Run: bun test/api-retry-regression.ts
 */
process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "1000";
import { apiRetryNote } from "../src/proxy.ts";
import { assert, mockHandle, sleep, startMockedProxy, textDelta } from "./helpers.ts";

const retry = (attempt: number, error_status: number | null, retry_delay_ms: number) => ({
  type: "system",
  subtype: "api_retry",
  attempt,
  max_retries: 10,
  retry_delay_ms,
  error_status,
  error: "server_error",
  uuid: `r${attempt}`,
  session_id: "s",
});

async function main() {
  assert.equal(apiRetryNote(retry(2, 529, 4000)), "\n[api] Anthropic returned 529, retrying in 4s (attempt 2/10)\n");
  assert.equal(apiRetryNote(retry(1, null, 500)), "\n[api] Connection to Anthropic failed, retrying (attempt 1/10)\n");

  const { post, proxy } = await startMockedProxy("api-retry");
  const turn = (body: () => AsyncGenerator<unknown>) =>
    proxy.setClaudeQueryStarter(async () => mockHandle(body()));
  try {
    // Notes reach the reasoning stream once the answer arrives.
    turn(async function* () {
      yield retry(1, 529, 10);
      yield retry(2, 529, 10);
      yield textDelta("answer");
      yield { type: "result", is_error: false, usage: {} };
    });
    {
      const res = await post("retried", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const sse = await res.text();
      assert.match(sse, /Anthropic returned 529, retrying \(attempt 1\/10\)/);
      assert.match(sse, /attempt 2\/10/);
      assert.match(sse, /answer/);
    }

    // Retries that run out still fail before content → real HTTP error.
    turn(async function* () {
      yield retry(1, 529, 10);
      yield {
        type: "assistant",
        error: "server_error",
        message: { content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "API Error: 529 Overloaded" };
    });
    {
      const res = await post("gave-up", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.notEqual(res.status, 200);
      assert.match(((await res.json()) as any).error.message, /529/);
    }

    // A retry waits 1.5s on a 1s stall window: the turn is not killed.
    turn(async function* () {
      yield retry(1, 529, 1500);
      await sleep(1800);
      yield textDelta("after the wait");
      yield { type: "result", is_error: false, usage: {} };
    });
    {
      const res = await post("slow-retry", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const sse = await res.text();
      assert.match(sse, /after the wait/);
      assert.doesNotMatch(sse, /produced no output/);
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — api retry regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
