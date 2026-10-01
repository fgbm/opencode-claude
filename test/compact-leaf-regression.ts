/**
 * Regression: a turn that compacts and then fails resumes after the compact
 * summary, never before the compaction and never at the bare boundary.
 *
 * Checked live (CLI 2.1.284, manual /compact): the CLI emits
 * system/compact_boundary, then the summary as a user event with
 * isSynthetic (not isReplay), then a replayed "Compacted" stdout entry.
 * Cutting the chain at the boundary uuid starts the compacted chain
 * without its summary and Claude remembered nothing. The summary entry is
 * the right leaf; the transcript after it descends from it, so the next
 * turn is a plain resume.
 *
 * Run: bun test/compact-leaf-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-compacted";

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-compact-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${SESSION}.jsonl`),
    ['{"uuid":"pre-compact"}', '{"uuid":"boundary"}', '{"uuid":"summary"}', ""].join("\n"),
  );

  const { post, proxy } = await startMockedProxy("compact-leaf");
  const { getSessionLeafUuid } = await import("../src/session-store.ts");
  try {
    let seen: Record<string, unknown> = {};
    const forks: string[] = [];
    proxy.setClaudeSessionForker(async (id, at) => {
      forks.push(`${id}@${at}`);
      return "unexpected-fork";
    });
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: SESSION };
          yield { type: "assistant", uuid: "pre-compact", session_id: SESSION, parent_tool_use_id: null, message: { content: [] } };
          yield { type: "system", subtype: "compact_boundary", uuid: "boundary", session_id: SESSION, compact_metadata: { trigger: "auto", pre_tokens: 190000 } };
          yield { type: "user", uuid: "summary", isSynthetic: true, session_id: SESSION, parent_tool_use_id: null, message: { content: "This session is being continued..." } };
          yield { type: "user", uuid: "stdout", isReplay: true, session_id: SESSION, parent_tool_use_id: null, message: { content: "<local-command-stdout>Compacted</local-command-stdout>" } };
          yield textDelta("partial");
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 500 boom"], session_id: SESSION };
        })(),
      );
    });
    const first = await post("compact-chat", { messages: [{ role: "user", content: "long work" }] });
    await first.text();
    assert.equal(getSessionLeafUuid("compact-chat"), "summary");

    const next = await post("compact-chat", {
      messages: [
        { role: "user", content: "long work" },
        { role: "assistant", content: "partial" },
        { role: "user", content: "go on" },
      ],
    });
    await next.text();
    assert.equal(seen.resume, SESSION);
    assert.equal("resumeSessionAt" in seen, false);
    assert.deepEqual(forks, []);
  } finally {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
  }
  console.log("ok — compact leaf regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
