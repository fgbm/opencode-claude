/**
 * Regression: a turn is stopped the way Claude Code's own Esc stops it.
 * - stop() interrupts first, reads the stream until the CLI reports the
 *   turn's result, then closes; a CLI that ignores the interrupt is closed
 *   after the grace period.
 * - A new turn for a chat whose earlier turn is still parked waits until
 *   that turn is interrupted and closed before spawning, and the parked tool
 *   call is rejected only after the interrupt.
 * - Two requests for one chat never spawn claude processes concurrently.
 *
 * Run: bun test/graceful-stop-regression.ts
 */
process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "1000";
import { closeSessionBridges } from "../src/bridge-pool.ts";
import { withGracefulStop } from "../src/query.ts";
import { assert, bashTool, callTool, startMockedProxy, textDelta } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mock SDK turn: runs `body`, and on interrupt() yields what the CLI emits
 * for an interrupted tool call (the rejection, the marker, an aborted_tools
 * result) and ends, like the real CLI does.
 */
function interruptibleTurn(
  log: string[],
  name: string,
  body: () => AsyncGenerator<unknown>,
  settleMs = 0,
) {
  let interrupted!: () => void;
  const interruptSignal = new Promise<"interrupt">((r) => (interrupted = () => r("interrupt")));
  const stream = (async function* () {
    const inner = body();
    while (true) {
      const next = await Promise.race([inner.next(), interruptSignal]);
      if (next === "interrupt") break;
      if (next.done) return;
      yield next.value;
    }
    if (settleMs > 0) await sleep(settleMs);
    yield { type: "user", uuid: `${name}-reject`, parent_tool_use_id: null, message: { content: [] } };
    yield { type: "user", uuid: `${name}-marker`, parent_tool_use_id: null, message: { content: [] } };
    yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_tools" };
  })();
  return {
    stream,
    interrupt: async () => {
      log.push(`${name}:interrupt`);
      interrupted();
    },
    close: () => log.push(`${name}:close`),
    getPid: () => null,
  };
}

async function main() {
  // stop()'s grace timer is unref'd; keep the loop alive like a server does.
  const keepAlive = setInterval(() => {}, 1000);
  // stop() settles on the interrupt's result, well inside the grace.
  {
    const log: string[] = [];
    const seen: string[] = [];
    const handle = withGracefulStop(
      interruptibleTurn(log, "a", async function* () {
        yield { type: "system", subtype: "init" };
        await new Promise(() => {});
      }),
    );
    handle.onEvent((e) => seen.push(String((e as { uuid?: string }).uuid ?? (e as { type: string }).type)));
    const it = handle.stream[Symbol.asyncIterator]();
    await it.next();
    const started = Date.now();
    await handle.stop();
    assert.ok(Date.now() - started < 500, "settled without waiting the grace");
    assert.deepEqual(log, ["a:interrupt", "a:close"]);
    assert.deepEqual(seen, ["system", "a-reject", "a-marker", "result"]);
    // Idempotent.
    await handle.stop();
    assert.deepEqual(log, ["a:interrupt", "a:close"]);
  }

  // A CLI that ignores the interrupt is closed after the grace.
  {
    const log: string[] = [];
    const handle = withGracefulStop({
      stream: (async function* () {
        await new Promise(() => {});
      })(),
      interrupt: async () => {
        log.push("interrupt");
      },
      close: () => log.push("close"),
      getPid: () => null,
    });
    const started = Date.now();
    await handle.stop(200);
    const took = Date.now() - started;
    assert.ok(took >= 190 && took < 800, `closed after the grace (${took}ms)`);
    assert.deepEqual(log, ["interrupt", "close"]);
  }

  const { post, proxy } = await startMockedProxy("graceful-stop");
  try {
    // A stopped session's parked turn: interrupted first, tool rejected after.
    {
      const log: string[] = [];
      proxy.setClaudeQueryStarter(async (params) => {
        log.push("p1:spawn");
        return interruptibleTurn(log, "p1", async function* () {
          yield { type: "system", subtype: "init", session_id: "stop-sess" };
          // The MCP server answers a rejected call with an error result.
          callTool(params, "bash", { command: "sleep 100" }).then(
            (r: any) => log.push(r.isError ? "p1:tool-rejected" : "p1:tool-resolved"),
            () => log.push("p1:tool-rejected"),
          );
          await new Promise(() => {});
        }, 300);
      });
      const first = await post("stop-parked", {
        tools: [bashTool],
        messages: [{ role: "user", content: "run it" }],
      });
      assert.equal(((await first.json()) as any).choices[0].finish_reason, "tool_calls");
      // The CLI takes a moment to settle; a new message sent right after the
      // stop must wait for it, although the turn already left the pool.
      proxy.setClaudeQueryStarter(async () => {
        log.push("p2:spawn");
        return interruptibleTurn(log, "p2", async function* () {
          yield textDelta("next");
          yield { type: "result", is_error: false, usage: {} };
        });
      });
      assert.equal(closeSessionBridges("stop-parked"), 1);
      const next = await post("stop-parked", {
        messages: [{ role: "user", content: "run it" }, { role: "user", content: "next" }],
      });
      assert.equal(next.status, 200);
      await next.text();
      assert.deepEqual(log.slice(0, 3), ["p1:spawn", "p1:interrupt", "p1:close"]);
      assert.deepEqual(
        log.filter((e) => e.startsWith("p1:") || e === "p2:spawn").sort(),
        ["p1:close", "p1:interrupt", "p1:spawn", "p1:tool-rejected", "p2:spawn"],
      );
      assert.ok(log.indexOf("p1:close") < log.indexOf("p2:spawn"), "spawned only after the close");
    }

    // A new turn waits for the earlier, still running one to stop.
    {
      const log: string[] = [];
      let turn = 0;
      proxy.setClaudeQueryStarter(async () => {
        turn += 1;
        const name = `r${turn}`;
        log.push(`${name}:spawn`);
        return interruptibleTurn(log, name, async function* () {
          yield textDelta(name);
          if (name === "r1") await new Promise(() => {});
          yield { type: "result", is_error: false, usage: {} };
        });
      });
      const first = await post("stop-running", {
        stream: true,
        messages: [{ role: "user", content: "long task" }],
      });
      assert.equal(first.status, 200);
      const second = await post("stop-running", {
        messages: [
          { role: "user", content: "long task" },
          { role: "user", content: "something else" },
        ],
      });
      assert.equal(second.status, 200);
      assert.match(String(((await second.json()) as any).choices[0].message.content), /r2/);
      await first.text();
      assert.deepEqual(log.slice(0, 4), ["r1:spawn", "r1:interrupt", "r1:close", "r2:spawn"]);
    }

    // Two requests for one chat: spawns never overlap, the second stops the first.
    {
      const log: string[] = [];
      let active = 0;
      let maxActive = 0;
      let turn = 0;
      proxy.setClaudeQueryStarter(async () => {
        turn += 1;
        const name = `c${turn}`;
        active += 1;
        maxActive = Math.max(maxActive, active);
        log.push(`${name}:spawn`);
        await sleep(100);
        active -= 1;
        return interruptibleTurn(log, name, async function* () {
          yield textDelta(name);
          await sleep(300);
          yield { type: "result", is_error: false, usage: {} };
        });
      });
      const body = { messages: [{ role: "user", content: "hello" }] };
      const [a, b] = await Promise.all([post("lock-chat", body), post("lock-chat", body)]);
      await Promise.all([a.text(), b.text()]);
      assert.equal(maxActive, 1, "spawns for one chat are serialized");
      assert.deepEqual(log.slice(0, 4), ["c1:spawn", "c1:interrupt", "c1:close", "c2:spawn"]);
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
    clearInterval(keepAlive);
  }
  console.log("ok — graceful stop regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
