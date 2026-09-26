/**
 * Regression: the Claude Code preset replaces OpenCode's system prompt, so a
 * custom agent's prompt, AGENTS.md instructions, the Code Mode catalog and the
 * skills list never reached Claude. They now ride the preset append; the
 * stock OpenCode prompt, <env> and date stay behind. Layout as sent by
 * OpenCode 2.0.18.
 *
 * Run: bun test/system-context-regression.ts
 */
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const STOCK =
  "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n# Harness\n- Responses are rendered as GitHub-flavored Markdown.";

function openCodeSystem(base: string): string {
  return [
    base,
    "",
    "# Your Model\n- Name: Opus 5.5\n- Provider ID: claude-code\n- Model ID: claude-opus-5-5[1m]",
    "Here is some useful information about the environment you are running in:",
    "<env>\n  Working directory: /work\n  Platform: linux\n</env>",
    "",
    "Today's date: Sun Sep 27 2026",
    "",
    "# Code Mode\n\nUse the `execute` tool to call the tools listed below.",
    "",
    "Instructions from: /home/u/.config/opencode/AGENTS.md\n# Language\n\nRespond in Russian.",
    "",
    "<available_skills>\n  <skill>\n    <id>xlsx</id>\n  </skill>\n</available_skills>",
  ].join("\n");
}

async function main() {
  const { post, proxy } = await startMockedProxy("system-context");
  const { openCodeSystemContext } = await import("../src/system-context.ts");

  // Stock agent: only the configuration after the harness block
  const stock = openCodeSystemContext([
    { role: "system", content: openCodeSystem(STOCK) },
    { role: "user", content: "hi" },
  ]);
  assert.doesNotMatch(stock, /Agent role/);
  assert.doesNotMatch(stock, /AI agent running in OpenCode|<env>|# Your Model|Today's date/);
  assert.match(stock, /^# OpenCode context\n\n# Code Mode/);
  assert.match(stock, /Instructions from: \/home\/u\/\.config\/opencode\/AGENTS\.md/);
  assert.match(stock, /<id>xlsx<\/id>/);

  // A custom agent's prompt replaces the stock one and is forwarded first
  const custom = openCodeSystemContext([
    { role: "system", content: openCodeSystem("You are CRITIC. Review harshly.") },
  ]);
  assert.match(custom, /^# Agent role\n[\s\S]*You are CRITIC\. Review harshly\.\n\n# OpenCode context/);

  // Only the leading system message is the prompt; unknown layouts forward nothing
  assert.doesNotMatch(
    openCodeSystemContext([
      { role: "system", content: openCodeSystem(STOCK) },
      { role: "system", content: "Today's date is now: Mon Sep 28 2026" },
    ]),
    /date is now/,
  );
  assert.equal(openCodeSystemContext([{ role: "system", content: "Just a prompt." }]), "");
  assert.equal(openCodeSystemContext([{ role: "user", content: "hi" }]), "");

  // Through the proxy: appended to the preset for turns, not meta requests
  const appends: Array<string | undefined> = [];
  proxy.setClaudeQueryStarter(async (params) => {
    const system = params.systemPrompt as { append?: string } | string | undefined;
    appends.push(typeof system === "string" ? system : system?.append);
    return mockHandle(
      (async function* () {
        yield textDelta("ok");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    );
  });
  try {
    const system = { role: "system", content: openCodeSystem("You are CRITIC. Review harshly.") };
    const turn = await post("system-context-turn", {
      messages: [system, { role: "user", content: "review this" }],
    });
    assert.equal(turn.status, 200);
    assert.match(appends[0] ?? "", /You are CRITIC\. Review harshly\./);
    assert.match(appends[0] ?? "", /Respond in Russian\./);

    process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT = "0";
    await post("system-context-off", { messages: [system, { role: "user", content: "again" }] });
    assert.doesNotMatch(appends[1] ?? "", /CRITIC|Respond in Russian/);
  } finally {
    delete process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT;
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — system context regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
