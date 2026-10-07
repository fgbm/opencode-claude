/**
 * Regression: chat turns ask Claude Code to keep the working directory,
 * memory path and git status out of its system prompt. With them in, no two
 * sessions share the prompt and every new session writes all of it to the
 * cache again; without them a new session reads it from the cache. Utility
 * turns (titles) keep their own one-line prompt, and
 * OPENCODE_CLAUDE_DYNAMIC_SECTIONS=keep restores the old layout.
 *
 * Run: bun test/dynamic-sections-regression.ts
 */
import type { StartClaudeQueryParams } from "../src/query.ts";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

type PresetPrompt = { type?: string; excludeDynamicSections?: boolean };

async function main() {
  // The flag reaches the SDK only for the claude_code preset.
  const { startClaudeQuery } = await import("../src/query.ts");
  const sdkPrompt = async (systemPrompt: StartClaudeQueryParams["systemPrompt"]) => {
    let seen: any;
    await startClaudeQuery({
      prompt: "x",
      cwd: process.cwd(),
      systemPrompt,
      queryImpl: () => (input: any) => {
        seen = input.options;
        return (async function* () {})();
      },
    } as any);
    return seen.systemPrompt;
  };
  assert.deepEqual(
    await sdkPrompt({ type: "preset", preset: "claude_code", excludeDynamicSections: true }),
    { type: "preset", preset: "claude_code", excludeDynamicSections: true },
  );
  assert.deepEqual(await sdkPrompt({ type: "preset", preset: "claude_code" }), {
    type: "preset",
    preset: "claude_code",
  });

  const { post, proxy } = await startMockedProxy("dynamic-sections");
  const prompts: unknown[] = [];
  proxy.setClaudeQueryStarter(async (params) => {
    prompts.push(params.systemPrompt);
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-dynamic" };
        yield { ...textDelta("ok"), session_id: "sess-dynamic" };
        yield { type: "result", is_error: false, usage: {}, session_id: "sess-dynamic" };
      })(),
    );
  });
  const turn = async (session: string, body: Record<string, unknown>) => {
    const res = await post(session, body);
    assert.equal(res.status, 200, await res.clone().text());
    return prompts.at(-1);
  };

  try {
    const chat = (await turn("dyn-chat", {
      messages: [{ role: "user", content: "hello" }],
    })) as PresetPrompt;
    assert.equal(chat.type, "preset");
    assert.equal(chat.excludeDynamicSections, true, "chat turns drop the dynamic sections");

    const title = await turn("dyn-title", {
      messages: [
        { role: "system", content: "You are a title generator. Output only a thread title." },
        { role: "user", content: "hello" },
      ],
    });
    assert.equal(typeof title, "string", "a title keeps its own one-line prompt");

    process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS = "keep";
    const kept = (await turn("dyn-keep", {
      messages: [{ role: "user", content: "hello" }],
    })) as PresetPrompt;
    assert.equal(kept.excludeDynamicSections, undefined, "keep restores the old layout");
  } finally {
    delete process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS;
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — dynamic sections regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
