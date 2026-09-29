/**
 * Regression: reverting or editing in OpenCode rewinds the Claude session
 * instead of resuming a history OpenCode no longer has.
 * - History back at an earlier turn → resumeSessionAt that turn's leaf.
 * - History that matches no turn → binding dropped, history transferred.
 * - Normal flows never misfire: follow-ups, a retried request, a model
 *   switch, tool-result continuations, steering, a rebuilt tool step, Plan
 *   mode reminders moving around, title requests.
 *
 * Run: bun test/revert-edit-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userHistoryFingerprints } from "../src/prompt.ts";
import { matchTurnHistory } from "../src/session-store.ts";
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, bashTool, callTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-revert";

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

async function promptText(prompt: StartClaudeQueryParams["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  let text = "";
  for await (const part of prompt) {
    const content = (part as { message?: { content?: unknown } }).message?.content;
    text += typeof content === "string" ? content : JSON.stringify(content);
  }
  return text;
}

async function main() {
  // Fingerprints: user messages only, reminders and promoted media skipped.
  {
    const reminder = user("<system-reminder>\nYou are in Plan mode.\n</system-reminder>");
    const a = userHistoryFingerprints([user("one"), assistant("x"), reminder, user("two")]);
    const b = userHistoryFingerprints([user("one"), assistant("y"), user("two"), reminder]);
    assert.equal(a.length, 2);
    assert.deepEqual(a, b);
    assert.deepEqual(
      userHistoryFingerprints([user([{ type: "text", text: "one" }])]),
      userHistoryFingerprints([user("  one ")]),
    );
    assert.equal(
      userHistoryFingerprints([
        user("ask"),
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as any,
        { role: "tool", tool_call_id: "c1", content: "r" },
        user("Attached media from tool result:"),
      ]).length,
      1,
    );
    const turns = [
      { count: 1, hash: "h1", leafUuid: "L1" },
      { count: 2, hash: "h2", leafUuid: "L2" },
    ];
    assert.deepEqual(matchTurnHistory([], ["h1"]), { kind: "untracked" });
    assert.deepEqual(matchTurnHistory(turns, ["h1", "h2"]), { kind: "latest" });
    assert.deepEqual(matchTurnHistory(turns, ["h1", "h2", "h3"]), { kind: "latest" });
    assert.deepEqual(matchTurnHistory(turns, ["h1"]), { kind: "rewind", index: 0, leafUuid: "L1" });
    assert.deepEqual(matchTurnHistory(turns, []), { kind: "diverged" });
    assert.deepEqual(matchTurnHistory(turns, ["hx", "h2x"]), { kind: "diverged" });
  }

  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-revert-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION}.jsonl`);
  const leaves: string[] = [];
  const writeTranscript = () =>
    writeFileSync(sessionFile, leaves.map((uuid) => JSON.stringify({ uuid })).join("\n") + "\n");
  writeTranscript();

  const { post, port, proxy } = await startMockedProxy("revert-edit");
  const { getForeignSessionId, getSessionTurns } = await import("../src/session-store.ts");

  let spawns = 0;
  let seen: StartClaudeQueryParams | null = null;
  // A turn that answers and moves the session's leaf to `leaf`.
  const answering = (leaf: string) =>
    proxy.setClaudeQueryStarter(async (params) => {
      spawns += 1;
      seen = params;
      leaves.push(leaf);
      writeTranscript();
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: SESSION };
          yield { type: "assistant", uuid: leaf, session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
          yield textDelta(`answer ${leaf}`);
          yield { type: "result", is_error: false, usage: {}, session_id: SESSION };
        })(),
      );
    });
  const turn = async (leaf: string, messages: unknown[], extra: Record<string, unknown> = {}) => {
    answering(leaf);
    const res = await post("chat", { messages, ...extra });
    assert.equal(res.status, 200, `turn ${leaf}`);
    await res.text();
    return {
      resume: seen!.resume,
      at: seen!.resumeSessionAt,
      transferred: /<conversation_history>/.test(await promptText(seen!.prompt)),
    };
  };

  try {
    // Three turns build the session.
    let r = await turn("L1", [user("u1")]);
    assert.equal(r.resume, undefined);
    r = await turn("L2", [user("u1"), assistant("a1"), user("u2")]);
    assert.deepEqual(r, { resume: SESSION, at: "L1", transferred: false });
    r = await turn("L3", [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]);
    assert.deepEqual(r, { resume: SESSION, at: "L2", transferred: false });
    assert.deepEqual(getSessionTurns("chat").map((t) => t.leafUuid), ["L1", "L2", "L3"]);

    // Revert of the last turn, new prompt → rewind to L2.
    r = await turn("L3b", [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3 edited")]);
    assert.deepEqual(r, { resume: SESSION, at: "L2", transferred: false });
    assert.deepEqual(getSessionTurns("chat").map((t) => t.leafUuid), ["L1", "L2", "L3b"]);

    // Normal follow-up after the rewind resumes the new branch.
    const afterRewind = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3 edited"), assistant("a3b")];
    r = await turn("L4", [...afterRewind, user("u4")]);
    assert.deepEqual(r, { resume: SESSION, at: "L3b", transferred: false });

    // Edit of an earlier message: back two turns → rewind to L1.
    r = await turn("L2b", [user("u1"), assistant("a1"), user("u2 edited")]);
    assert.deepEqual(r, { resume: SESSION, at: "L1", transferred: false });

    // OpenCode retries the same request (the first attempt failed): the
    // retry goes back to where that attempt started, not after its prompt.
    r = await turn("L2c", [user("u1"), assistant("a1"), user("u2 edited")]);
    assert.deepEqual(r, { resume: SESSION, at: "L1", transferred: false });

    // A model switch changes nothing.
    r = await turn("L3c", [user("u1"), assistant("a1"), user("u2 edited"), assistant("a2c"), user("u3")], {
      model: "opus",
    });
    assert.deepEqual(r, { resume: SESSION, at: "L2c", transferred: false });

    // Plan mode reminder spliced before the prompt, stored after it later.
    const reminder = user("<system-reminder>\nYou are in Plan mode.\n</system-reminder>");
    const base = [user("u1"), assistant("a1"), user("u2 edited"), assistant("a2c"), user("u3"), assistant("a3c")];
    r = await turn("L4c", [...base, reminder, user("plan it")]);
    assert.deepEqual(r, { resume: SESSION, at: "L3c", transferred: false });
    r = await turn("L5c", [...base, user("plan it"), reminder, assistant("plan"), user("go")]);
    assert.deepEqual(r, { resume: SESSION, at: "L4c", transferred: false });
    const planned = [...base, user("plan it"), reminder, assistant("plan"), user("go"), assistant("done")];

    // A title request leaves the boundaries alone.
    const before = JSON.stringify(getSessionTurns("chat"));
    answering("title-leaf");
    const title = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": "chat",
        "x-opencode-claude-kind": "title",
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages: [user("u1")] }),
    });
    await title.text();
    assert.equal(JSON.stringify(getSessionTurns("chat")), before);

    // Tool-result continuation, steering and a later follow-up.
    proxy.setClaudeQueryStarter(async (params) => {
      spawns += 1;
      seen = params;
      leaves.push("L6-tool");
      writeTranscript();
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: SESSION };
          yield { type: "assistant", uuid: "L6-tool", session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
          await callTool(params, "bash", { command: "ls" });
          yield { type: "user", uuid: "L6-result", session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
          yield { type: "assistant", uuid: "L6", session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
          yield textDelta("listed");
          yield { type: "result", is_error: false, usage: {}, session_id: SESSION };
        })(),
      );
    });
    const askTool = [...planned, user("list files")];
    const parked = await post("chat", { tools: [bashTool], messages: askTool });
    const call = ((await parked.json()) as any).choices[0].message.tool_calls[0];
    assert.equal(seen!.resumeSessionAt, "L5c");
    const spawnsBefore = spawns;
    leaves.push("L6-result", "L6");
    writeTranscript();
    const toolStep = [
      ...askTool,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "a.txt" },
      user("also count them"),
    ];
    const resumed = await post("chat", { tools: [bashTool], messages: toolStep });
    assert.equal(resumed.status, 200);
    await resumed.text();
    assert.equal(spawns, spawnsBefore, "continuation reuses the parked turn");
    assert.equal(getSessionTurns("chat").at(-1)!.leafUuid, "L6");
    r = await turn("L7", [...toolStep, assistant("2 files"), user("thanks")]);
    assert.deepEqual(r, { resume: SESSION, at: "L6", transferred: false });

    // Tool results with no parked turn (reaped): rebuilt, still resumed.
    const orphanCall = { id: "call_orphan", type: "function", function: { name: "bash", arguments: "{}" } };
    const rebuiltHistory = [
      ...toolStep,
      assistant("2 files"),
      user("thanks"),
      assistant("welcome"),
      user("run it"),
      { role: "assistant", content: null, tool_calls: [orphanCall] },
      { role: "tool", tool_call_id: "call_orphan", content: "late" },
    ];
    r = await turn("L8", rebuiltHistory, { tools: [bashTool] });
    assert.deepEqual(r, { resume: SESSION, at: "L7", transferred: false });

    // A history that matches no turn: an early message changed.
    r = await turn("N1", [user("something else entirely"), assistant("a1"), user("u2")]);
    assert.equal(r.resume, undefined);
    assert.equal(r.transferred, true);
    assert.equal(getForeignSessionId("chat"), SESSION, "the new turn binds again");
    assert.deepEqual(getSessionTurns("chat").map((t) => t.leafUuid), ["N1"]);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — revert/edit regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
