/**
 * Regression: a turn parked on a tool when the user aborts has no open
 * request left to cancel. `session.idle` closes it through
 * teardownSessionBridges, from any location's copy of the module, without
 * touching other sessions' parks.
 *
 * Run: bun test/idle-teardown-regression.ts
 */
import { assert, bashTool, callTool, mockHandle, startMockedProxy } from "./helpers.ts";

async function main() {
  const { post, proxy } = await startMockedProxy("idle-teardown");

  async function parkOnBash(session: string) {
    let closed = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          callTool(params, "bash", { command: "sleep 40" }).catch(() => {});
          await released;
        })(),
        () => {
          closed = true;
          release();
        },
      ),
    );
    const res = await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "go" }],
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.choices[0].message.tool_calls?.[0]?.function.name, "bash");
    return { closed: () => closed };
  }

  try {
    const aborted = await parkOnBash("idle-aborted");
    const other = await parkOnBash("idle-other");

    // Another location's module copy routes to the pool that owns the park.
    const sibling = await import("../src/proxy.ts?location=b");
    assert.deepEqual(sibling.teardownSessionBridges("idle-aborted"), ["idle-aborted"]);
    assert.equal(aborted.closed(), true, "idle closes the parked turn");
    assert.equal(other.closed(), false, "other sessions keep their park");
    assert.deepEqual(proxy.teardownSessionBridges("idle-aborted"), [], "idempotent");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — idle teardown regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
