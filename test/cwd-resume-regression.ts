/**
 * Regression: a chat whose directory changed keeps resuming its Claude
 * session instead of falling back to a text transcript.
 *
 * The CLI stores a session under ~/.claude/projects/<slug of the cwd>/, but
 * `--resume <id>` finds it from any cwd. Checked live on CLI 2.1.224 and
 * 2.1.284: resuming from another directory loaded the full history and
 * appended to the original file. Transferring history as text there would
 * only lose tool-level context and the prompt cache.
 *
 * Run: bun test/cwd-resume-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-moved";

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-cwd-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const oldCwd = mkdtempSync(join(tmpdir(), "opencode-claude-cwd-old-"));
  const newCwd = mkdtempSync(join(tmpdir(), "opencode-claude-cwd-new-"));
  const oldSlug = oldCwd.replace(/[^a-zA-Z0-9]/g, "-");
  mkdirSync(join(claudeConfig, "projects", oldSlug), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", oldSlug, `${SESSION}.jsonl`), '{"uuid":"leaf-1"}\n');

  const { port, proxy } = await startMockedProxy("cwd-resume");
  const { setForeignSessionId } = await import("../src/session-store.ts");
  try {
    setForeignSessionId("moved-chat", SESSION, { cwd: oldCwd, leafUuid: "leaf-1" });
    let seen: Record<string, unknown> = {};
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return mockHandle(
        (async function* () {
          yield textDelta("ok");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": "moved-chat",
        "x-opencode-claude-directory": newCwd,
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "second" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(seen.cwd, newCwd);
    assert.equal(seen.resume, SESSION);
    assert.equal(seen.resumeSessionAt, "leaf-1");
    assert.doesNotMatch(String(seen.prompt), /<conversation_history>/);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — cwd resume regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
