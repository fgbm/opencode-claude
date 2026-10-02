/**
 * Regression: a chat whose Claude session file holds two branches resumes
 * its own branch through a fork, instead of failing every turn.
 *
 * Seen live (CLI 2.1.285): another claude process on the same session wrote
 * a side branch off a common ancestor, interleaved with our turn, and then
 * the last `last-prompt` entry, which names its leaf. The CLI resumes that
 * chain; resumeSessionAt with our leaf searched only there and failed with
 * "No message found with message.uuid of", so every message errored and
 * OpenCode retried in a loop. The fixture below has the same shape.
 *
 * Run: bun test/branched-session-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-branched";
const FORK = "sess-branched-fork";

const entry = (type: string, uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, uuid, parentUuid, sessionId: SESSION, isSidechain: false, ...extra });
const meta = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, sessionId: SESSION, ...extra });

// Rows 936-967 of the real file, uuids renamed. `common` is where the
// branches split; ours ends at `leaf`, the other one at `side-3`.
const BRANCHED = [
  entry("user", "u-root", null),
  entry("assistant", "a-prev", "u-root"),
  entry("user", "u-prompt", "a-prev"),
  entry("attachment", "common", "u-prompt"),
  meta("last-prompt", { leafUuid: "common" }),
  meta("ai-title", { aiTitle: "t" }),
  entry("assistant", "ours-1", "common"),
  entry("assistant", "ours-2", "ours-1"),
  meta("last-prompt", { leafUuid: "ours-2" }),
  entry("assistant", "side-1", "common"),
  entry("assistant", "side-2", "side-1"),
  entry("assistant", "side-3", "side-2"),
  entry("user", "ours-3", "ours-2"),
  entry("attachment", "ours-4", "ours-3"),
  entry("assistant", "ours-5", "ours-4"),
  entry("assistant", "leaf", "ours-5"),
  entry("system", "hook", "leaf", { subtype: "stop_hook_summary" }),
  meta("last-prompt", { leafUuid: "hook" }),
  meta("cost-state"),
  meta("last-prompt", { leafUuid: "side-3" }),
  meta("cost-state"),
  "",
].join("\n");

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-branched-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION}.jsonl`);
  writeFileSync(sessionFile, BRANCHED);

  const { post, proxy } = await startMockedProxy("branched");
  const { getForeignSessionId, getSessionLeafUuid, sessionChainAfterLeaf, setForeignSessionId } = await import(
    "../src/session-store.ts"
  );

  // The decision itself, whatever the chunk size.
  for (const chunk of [16, 64, 256 * 1024]) {
    assert.equal(sessionChainAfterLeaf(sessionFile, "leaf", chunk), "branched");
    assert.equal(sessionChainAfterLeaf(sessionFile, "missing-uuid", chunk), "missing");
  }
  const clean = join(projectDir, "clean.jsonl");
  writeFileSync(clean, BRANCHED.replace(/.*"leafUuid":"side-3".*\n/, ""));
  assert.equal(sessionChainAfterLeaf(clean, "leaf"), "clean");
  // A message after the leaf off another parent is a branch too.
  writeFileSync(clean, BRANCHED.replace(/.*"leafUuid":"side-3".*\n/, "") + entry("user", "late", "side-3") + "\n");
  assert.equal(sessionChainAfterLeaf(clean, "leaf"), "branched");
  // A compaction continues the chain through logicalParentUuid.
  writeFileSync(
    clean,
    [entry("assistant", "leaf", "x"), JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "cb", parentUuid: null, logicalParentUuid: "leaf" }), entry("user", "summary", "cb"), ""].join("\n"),
  );
  assert.equal(sessionChainAfterLeaf(clean, "leaf"), "clean");

  try {
    const forks: string[] = [];
    proxy.setClaudeSessionForker(async (id, at) => {
      forks.push(`${id}@${at}`);
      writeFileSync(
        join(projectDir, `${FORK}.jsonl`),
        [entry("user", "f-root", null), entry("assistant", "f-leaf", "f-root"), meta("last-prompt", { leafUuid: "f-leaf" }), ""].join("\n"),
      );
      return FORK;
    });
    let seen: Record<string, unknown> = {};
    const answering = (session: string) =>
      proxy.setClaudeQueryStarter(async (params) => {
        seen = params as unknown as Record<string, unknown>;
        return mockHandle(
          (async function* () {
            yield { type: "system", subtype: "init", session_id: session };
            yield { type: "assistant", uuid: "next", session_id: session, parent_tool_use_id: null, message: { content: [] } };
            yield textDelta("ok");
            yield { type: "result", is_error: false, usage: {}, session_id: session };
          })(),
        );
      });

    // A chat bound before this fix, stuck on the branched file: the next
    // message heals it through a fork cut at its leaf.
    setForeignSessionId("stuck-chat", SESSION, { leafUuid: "leaf" });
    answering(FORK);
    const res = await post("stuck-chat", {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(forks, [`${SESSION}@leaf`]);
    assert.equal(seen.resume, FORK);
    assert.equal("resumeSessionAt" in seen, false);
    assert.doesNotMatch(String(seen.prompt), /<conversation_history>/);
    assert.equal(getForeignSessionId("stuck-chat"), FORK);
    assert.equal(getSessionLeafUuid("stuck-chat"), "next");

    // Should the CLI still say it can't find a message, the binding goes, so
    // OpenCode's retry transfers the history instead of failing again.
    setForeignSessionId("nomsg-chat", SESSION, { leafUuid: "hook" });
    writeFileSync(sessionFile, BRANCHED.replace(/.*"leafUuid":"side-3".*\n/, ""));
    proxy.setClaudeQueryStarter(async () =>
      mockHandle(
        (async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["No message found with message.uuid of: hook"],
          };
          throw new Error("Claude Code returned an error result: No message found with message.uuid of: hook");
        })(),
      ),
    );
    const failed = await post("nomsg-chat", { stream: true, messages: [{ role: "user", content: "hi" }] });
    await failed.text();
    assert.equal(getForeignSessionId("nomsg-chat"), undefined);
    assert.equal(forks.length, 1);
  } finally {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
  }
  console.log("ok — branched session regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
