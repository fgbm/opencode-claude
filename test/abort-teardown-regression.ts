/**
 * Regression: closing a turn must end its claude process even when the CLI
 * is wedged. A fake CLI that ignores SIGTERM and stdin EOF stands in for a
 * hung child; close() on a never-iterated handle (a parked turn) has to get
 * it killed through the SDK's abort path.
 *
 * Run: bun test/abort-teardown-regression.ts
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "./helpers.ts";
import { startClaudeQuery } from "../src/query.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "oc-claude-abort-"));
  const pidFile = join(dir, "pid");
  const cli = join(dir, "claude");
  // SIG_IGN survives exec, so the sleep keeps ignoring SIGTERM; it never
  // reads stdin, so the SDK's graceful stdin-EOF close does nothing either.
  writeFileSync(cli, `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nexec sleep 600\n`);
  chmodSync(cli, 0o755);

  let pid = 0;
  try {
    const handle = await startClaudeQuery({
      prompt: "go",
      cwd: dir,
      pathToClaudeCodeExecutable: cli,
      settingSources: [],
    });
    // Not iterated, like a turn parked on a tool call.
    assert.ok(await waitFor(() => existsSync(pidFile), 10_000), "fake CLI started");
    pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(alive(pid), "fake CLI alive before close");

    handle.close();
    assert.ok(await waitFor(() => !alive(pid), 15_000), "close() kills a wedged CLI");
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("ok — abort teardown regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
