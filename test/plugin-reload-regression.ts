/**
 * Regression: OpenCode reloads a plugin by importing a fresh copy of it and
 * unloading the old one (dist rebuilt, config changed, idle location torn
 * down). The old copy's unload stopped every parked turn: the CLI recorded
 * the pending tool calls as rejected by the user, and Claude stopped working
 * while the command was still running. Turns now live in the process, so the
 * reloaded copy resumes a turn parked by the old one; only the last plugin
 * instance of any copy stops them.
 *
 * Run: bun test/plugin-reload-regression.ts
 */
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, bashTool, callTool, interruptibleTurn, sleep, textDelta } from "./helpers.ts";

const repo = join(import.meta.dir, "..");

/** A separate copy of the plugin's modules, as OpenCode loads on reload. */
async function loadCopy(root: string, name: string) {
  const dir = join(root, name);
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  const { setAuthStatusProbe } = await import(join(dir, "src", "detect.ts"));
  setAuthStatusProbe(() => ({ loggedIn: true, detail: "auth-status-oauth" }));
  return (await import(join(dir, "src", "proxy.ts"))) as typeof import("../src/proxy.ts");
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-reload-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "50";
  process.env.OPENCODE_CLAUDE_RELOAD_GRACE_MS = "300";
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const oldCopy = await loadCopy(tmp, "old");
    const newCopy = await loadCopy(tmp, "new");
    assert.notEqual(oldCopy, newCopy, "two module copies");

    const post = (port: number, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-claude-session": "reload" },
        body: JSON.stringify({ model: "sonnet", stream: false, ...body }),
      });

    const log: string[] = [];
    oldCopy.setClaudeQueryStarter(async (params) => {
      log.push("turn:spawn");
      return interruptibleTurn(log, "turn", async function* () {
        yield { type: "system", subtype: "init", session_id: "reload-sess" };
        const result = await callTool(params, "bash", { command: "sleep 300" });
        yield textDelta(`done: ${result.content.map((c) => c.text).join("")}`);
        yield { type: "result", is_error: false, usage: {}, session_id: "reload-sess" };
      });
    });
    newCopy.setClaudeQueryStarter(async () => {
      log.push("new:spawn");
      throw new Error("the reloaded copy must resume the parked turn, not start one");
    });

    const oldPort = await oldCopy.acquireProxy();
    const messages = [{ role: "user", content: "run the long command" }];
    const first = (await (await post(oldPort, { tools: [bashTool], messages })).json()) as any;
    assert.equal(first.choices[0].finish_reason, "tool_calls");
    const call = first.choices[0].message.tool_calls[0];

    // Reload, in OpenCode's order: the old copy unloads, then the fresh one
    // loads. Its tool results arrive later than the grace period.
    await oldCopy.releaseProxy();
    await sleep(100);
    const newPort = await newCopy.acquireProxy();
    assert.notEqual(newPort, oldPort);
    await sleep(500);
    assert.ok(!log.includes("turn:interrupt"), "unloading the old copy left the parked turn alone");

    const resumed = (await (
      await post(newPort, {
        tools: [bashTool],
        messages: [
          ...messages,
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "finished" },
        ],
      })
    ).json()) as any;
    assert.equal(resumed.choices[0].finish_reason, "stop");
    assert.match(resumed.choices[0].message.content, /done: finished/);
    assert.ok(!log.includes("new:spawn"), "resumed, not rebuilt");

    // The last instance going away still stops what is left.
    oldCopy.setClaudeQueryStarter(async (params) => {
      return interruptibleTurn(log, "late", async function* () {
        yield { type: "system", subtype: "init", session_id: "reload-sess" };
        callTool(params, "bash", { command: "ls" }).catch(() => {});
        await new Promise(() => {});
      });
    });
    newCopy.setClaudeQueryStarter(async (params) => {
      return interruptibleTurn(log, "late", async function* () {
        yield { type: "system", subtype: "init", session_id: "reload-sess" };
        callTool(params, "bash", { command: "ls" }).catch(() => {});
        await new Promise(() => {});
      });
    });
    const late = (await (
      await post(newPort, { tools: [bashTool], messages: [{ role: "user", content: "again" }] })
    ).json()) as any;
    assert.equal(late.choices[0].finish_reason, "tool_calls");
    await newCopy.releaseProxy();
    assert.ok(!log.includes("late:interrupt"), "a reload's grace period first");
    await sleep(500);
    assert.ok(log.includes("late:interrupt"), "last release stops parked turns after the grace period");
    console.log("plugin-reload regression ok");
  } finally {
    clearInterval(keepAlive);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
