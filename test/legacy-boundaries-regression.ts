/**
 * Regression: turn boundaries stored before they carried a session id.
 *
 * Such a boundary was recorded against the binding's session. A rewind to
 * it forks that session when its file still holds the leaf; after a fork
 * the old boundaries are stamped with the session they came from. A legacy
 * boundary whose leaf is not in the binding's session (an older build
 * carried one across a session change) can't be forked: history as text.
 *
 * Run: bun test/legacy-boundaries-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userHistoryFingerprints } from "../src/prompt.ts";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });
const hash = (...texts: string[]) => userHistoryFingerprints(texts.map(user)).at(-1)!;
const chain = (uuids: string[]) =>
  uuids.map((uuid, i) => JSON.stringify({ type: "assistant", uuid, parentUuid: i ? uuids[i - 1] : null })).join("\n") + "\n";

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-legacy-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const projectDir = join(claudeConfig, "projects", "proj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "legacy-a.jsonl"), chain(["A1", "A2", "A3"]));
  writeFileSync(join(projectDir, "legacy-b.jsonl"), chain(["B2", "B3"]));

  const { post, proxy } = await startMockedProxy("legacy-boundaries");
  const { getForeignSessionId, getSessionTurns } = await import("../src/session-store.ts");
  // The store as an older build left it: boundaries without sessionId.
  const storeFile = join(process.env.XDG_DATA_HOME!, "opencode-claude", "sessions.json");
  mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode-claude"), { recursive: true });
  const legacyTurns = (leaves: string[]) =>
    leaves.map((leafUuid, i) => ({
      count: i + 1,
      hash: hash(...["u1", "u2", "u3"].slice(0, i + 1)),
      leafUuid,
    }));
  writeFileSync(
    storeFile,
    JSON.stringify({
      a: { conversationKey: "a", foreignSessionId: "legacy-a", leafUuid: "A3", turns: legacyTurns(["A1", "A2", "A3"]), updatedAt: 1 },
      // "X1" was carried over from the session before legacy-b.
      b: { conversationKey: "b", foreignSessionId: "legacy-b", leafUuid: "B3", turns: legacyTurns(["X1", "B2", "B3"]), updatedAt: 1 },
    }),
  );

  const forks: string[] = [];
  proxy.setClaudeSessionForker(async (id, at) => {
    const fork = `fork-${forks.length + 1}`;
    forks.push(`${id}@${at}`);
    writeFileSync(join(projectDir, `${fork}.jsonl`), chain([`${fork}-${at}`]));
    return fork;
  });
  let seen: Record<string, unknown> = {};
  const answering = (leaf: string) =>
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      const session = (params.resume as string | undefined) ?? "fresh";
      return mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: session };
          yield { type: "assistant", uuid: leaf, session_id: session, parent_tool_use_id: null, message: { content: [] } };
          yield textDelta("ok");
          yield { type: "result", is_error: false, usage: {}, session_id: session };
        })(),
      );
    });
  const send = async (key: string, leaf: string, messages: unknown[]) => {
    answering(leaf);
    const res = await post(key, { messages });
    assert.equal(res.status, 200);
    await res.text();
    return { resume: seen.resume, transferred: /<conversation_history>/.test(String(seen.prompt)) };
  };

  try {
    // Legacy boundary in the binding's own session: fork from it.
    let r = await send("a", "N3", [user("u1"), assistant("x"), user("u2"), assistant("y"), user("u3 edited")]);
    assert.deepEqual(r, { resume: "fork-1", transferred: false });
    assert.deepEqual(forks, ["legacy-a@A2"]);
    // The fork stamped the older legacy boundary with where it came from.
    assert.deepEqual(
      getSessionTurns("a").map((t) => `${t.sessionId}:${t.leafUuid}`),
      ["legacy-a:A1", "fork-1:fork-1-A2", "fork-1:N3"],
    );
    // And a rewind across that fork still forks from legacy-a.
    r = await send("a", "N2", [user("u1"), assistant("x"), user("u2 edited")]);
    assert.deepEqual(r, { resume: "fork-2", transferred: false });
    assert.equal(forks.at(-1), "legacy-a@A1");

    // Legacy boundary whose leaf isn't in the binding's session: text.
    r = await send("b", "M2", [user("u1"), assistant("x"), user("u2 edited")]);
    assert.deepEqual(r, { resume: undefined, transferred: true });
    assert.equal(forks.length, 2);
    assert.equal(getForeignSessionId("b"), "fresh");
  } finally {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
  }
  console.log("ok — legacy boundaries regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
