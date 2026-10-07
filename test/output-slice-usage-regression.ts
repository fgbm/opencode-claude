/**
 * Regression: the usage journal counts cut outputs and output_slice reads,
 * so it shows how much of what was cut Claude actually reads back. The
 * counters belong to the line of the hop they happened in and reset after it.
 *
 * Run: bun test/output-slice-usage-regression.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, bashTool, callTool, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const { tmp, post, proxy } = await startMockedProxy("slice-usage");
  const session = "ses_slice_usage";
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");

  const sliced: Array<{ ok: boolean; text: string }> = [];
  proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "slice-sess" };
        const cut = await callTool(params, "bash", { command: "cat big" });
        const id = /output_slice\(id="(o[0-9a-f]+)"/.exec(cut.content[0]!.text)?.[1];
        assert.ok(id, "the bash result was cut and names its output id");
        for (const args of [{ id, offset: 100, limit: 500 }, { id: "o000000000000" }]) {
          const res = await callTool(params, "output_slice", args);
          sliced.push({ ok: !(res as { isError?: boolean }).isError, text: res.content[0]!.text });
        }
        yield { type: "user", message: { role: "user", content: [] } };
        await callTool(params, "bash", { command: "true" });
        yield { type: "user", message: { role: "user", content: [] } };
        yield textDelta("DONE");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    ),
  );

  const history: Array<Record<string, unknown>> = [{ role: "user", content: "read the big file" }];
  const send = async (): Promise<any> => {
    const res = await post(session, { tools: [bashTool], messages: history });
    assert.equal(res.status, 200);
    return res.json();
  };
  const answer = (body: any, content: string) => {
    const call = body.choices[0].message.tool_calls[0];
    history.push({ role: "assistant", content: null, tool_calls: [call] });
    history.push({ role: "tool", tool_call_id: call.id, content });
  };

  try {
    answer(await send(), big);
    answer(await send(), "");
    const last = await send();
    assert.match(String(last.choices[0].message.content), /DONE/);

    assert.deepEqual(sliced.map((s) => s.ok), [true, false]);
    const lines = readFileSync(join(tmp, "opencode-claude", "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).sections);
    assert.equal(lines.length, 3);

    // Opening hop: nothing cut or read yet.
    assert.equal(lines[0].spills, undefined);
    assert.equal(lines[0].output_slices, undefined);

    // The hop that got the cut result and read it back.
    assert.equal(lines[1].hop, "continuation");
    assert.equal(lines[1].spills, 1);
    assert.equal(lines[1].output_slices, 2);
    assert.equal(lines[1].output_slice_misses, 1);
    assert.equal(lines[1].output_slice_chars, 500);
    assert.ok(lines[1].spilled_chars > 0);

    // Counters reset after the line that reported them.
    assert.equal(lines[2].spills, undefined);
    assert.equal(lines[2].output_slices, undefined);
    assert.equal(lines[2].output_slice_misses, undefined);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — output_slice usage regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
