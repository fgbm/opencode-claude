/**
 * Regression: the session store is written only when a binding changes,
 * and transcript lookups find entries anywhere in a large file, including
 * across the border of two read chunks.
 *
 * Run: bun test/store-writes-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-store-"));
  process.env.XDG_DATA_HOME = tmp;
  const store = await import("../src/session-store.ts");
  const path = join(tmp, "opencode-claude", "sessions.json");

  // Our writes are indented; a compact file shows nothing rewrote it.
  const compact = () => writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8"))));
  const rewritten = () => readFileSync(path, "utf8").includes("\n  ");

  store.setForeignSessionId("chat", "sess-1", { modelId: "m", cwd: "/p", leafUuid: "leaf-1" });
  assert.ok(rewritten());
  compact();
  // Events of the same turn that carry no new leaf, or the same leaf.
  store.setForeignSessionId("chat", "sess-1", { modelId: "m", cwd: "/p" });
  store.setForeignSessionId("chat", "sess-1", { modelId: "m", cwd: "/p", leafUuid: "leaf-1" });
  assert.equal(rewritten(), false, "unchanged binding is not written");
  assert.equal(store.getSessionLeafUuid("chat"), "leaf-1");
  // A new leaf is.
  store.setForeignSessionId("chat", "sess-1", { modelId: "m", cwd: "/p", leafUuid: "leaf-2" });
  assert.ok(rewritten());
  assert.equal(store.getSessionLeafUuid("chat"), "leaf-2");
  compact();
  // So is a new session id, which drops the old chain's leaf.
  store.setForeignSessionId("chat", "sess-2", { modelId: "m", cwd: "/p" });
  assert.ok(rewritten());
  assert.equal(store.getForeignSessionId("chat"), "sess-2");
  assert.equal(store.getSessionLeafUuid("chat"), undefined);
  // Clearing forgets the cache: the same binding set again is written.
  store.clearForeignSessionId("chat");
  assert.equal(store.getForeignSessionId("chat"), undefined);
  store.setForeignSessionId("chat", "sess-2", { modelId: "m", cwd: "/p" });
  assert.equal(store.getForeignSessionId("chat"), "sess-2");

  // Transcript lookup from the end, in small chunks to cross borders.
  const file = join(tmp, "transcript.jsonl");
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ uuid: `entry-${i}`, pad: "x".repeat(i % 37) }));
  writeFileSync(file, lines.join("\n") + "\n");
  for (const chunk of [7, 64, 1000, 1 << 20]) {
    for (const i of [0, 1, 199, 200, 398, 399]) {
      assert.ok(store.sessionFileHasEntry(file, `entry-${i}`, chunk), `entry-${i} with ${chunk}-byte chunks`);
    }
    assert.equal(store.sessionFileHasEntry(file, "entry-400", chunk), false);
    assert.equal(store.sessionFileHasEntry(file, "entry-4", chunk), true);
    assert.equal(store.sessionFileHasEntry(file, "ntry-4", chunk), false, "whole uuid only");
  }
  assert.equal(store.sessionFileHasEntry(join(tmp, "missing.jsonl"), "entry-1"), false);
  console.log("ok — store writes regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
