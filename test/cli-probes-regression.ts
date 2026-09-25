/**
 * Regression for the fork's 70bf4ad:
 * - CLI probes (auth status, version, resolution) spawn asynchronously, so a
 *   slow `claude` never freezes the OpenCode server's event loop;
 * - a superseded `claude auth login` child exiting late cannot tear down or
 *   fail the sign-in flow that replaced it.
 *
 * Run: bun test/cli-probes-regression.ts
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "./helpers.ts";

async function main() {
  const { probeClaudeAuthStatusCli, detectClaudeCode } = await import("../src/detect.ts");
  const { resetClaudeCliResolutionCache, resolveClaudeCli } = await import(
    "../src/executable-path.ts"
  );

  const dir = mkdtempSync(join(tmpdir(), "opencode-claude-probe-"));
  try {
    const cli = join(dir, "claude");
    writeFileSync(
      cli,
      [
        "#!/bin/sh",
        "/bin/sleep 0.4",
        'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'; else echo "2.1.300 (Claude Code)"; fi',
      ].join("\n"),
    );
    chmodSync(cli, 0o755);

    // The event loop keeps ticking while the slow CLI answers (a sync spawn
    // would allow at most one tick).
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const status = await probeClaudeAuthStatusCli({ binaryPath: cli, env: { PATH: dir, HOME: dir } });
    clearInterval(ticker);
    assert.equal(status?.loggedIn, true);
    assert.ok(ticks >= 8, `event loop blocked during the probe (${ticks} ticks)`);

    resetClaudeCliResolutionCache();
    assert.equal(await resolveClaudeCli({ PATH: dir, HOME: dir }), cli);
    const detected = await detectClaudeCode({ env: { PATH: dir, HOME: dir }, binaryPath: cli });
    assert.equal(detected.version, "2.1.300");

    // A hung CLI is killed at the timeout instead of hanging the caller.
    const hung = join(dir, "hung");
    writeFileSync(hung, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(hung, 0o755);
    const { runCliProbe } = await import("../src/executable-path.ts");
    const started = Date.now();
    const timedOut = await runCliProbe(hung, [], { timeoutMs: 300 });
    assert.equal(timedOut.failed, true);
    assert.ok(Date.now() - started < 5_000);
    resetClaudeCliResolutionCache();

    // Concurrent callers share one probe; a miss is remembered briefly.
    const counted = mkdtempSync(join(tmpdir(), "opencode-claude-count-"));
    try {
      const log = join(counted, "calls");
      writeFileSync(log, "");
      writeFileSync(
        join(counted, "claude"),
        `#!/bin/sh\necho x >> ${log}\n/bin/sleep 0.2\necho "2.1.300 (Claude Code)"\n`,
      );
      chmodSync(join(counted, "claude"), 0o755);
      const env = { PATH: counted, HOME: counted };
      resetClaudeCliResolutionCache();
      const both = await Promise.all([resolveClaudeCli(env), resolveClaudeCli(env)]);
      assert.deepEqual(both, [join(counted, "claude"), join(counted, "claude")]);
      const { readFileSync } = await import("node:fs");
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "one shared probe");

      const empty = join(counted, "empty");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(empty);
      const missEnv = { PATH: empty, HOME: empty };
      resetClaudeCliResolutionCache();
      assert.equal(await resolveClaudeCli(missEnv), null);
      // Installed behind our back: the cached miss still answers for a while…
      writeFileSync(join(empty, "claude"), "#!/bin/sh\necho 2.1.300\n");
      chmodSync(join(empty, "claude"), 0o755);
      assert.equal(await resolveClaudeCli(missEnv), null, "miss is cached");
      // …while the install action's reset makes it visible at once.
      resetClaudeCliResolutionCache();
      assert.equal(await resolveClaudeCli(missEnv), join(empty, "claude"));
      resetClaudeCliResolutionCache();
    } finally {
      rmSync(counted, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Installer: one total budget, and a temp-dir failure is a result, not a throw.
  {
    const { installClaudeCli } = await import("../src/cli-install.ts");
    const hangingChild = () =>
      Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {
          return true;
        },
      });
    const spawned: string[] = [];
    const started = Date.now();
    const slow = await installClaudeCli({
      env: { PATH: "/usr/bin" },
      timeoutMs: 300,
      spawnInstall(command) {
        spawned.push(command);
        return hangingChild() as any;
      },
    });
    assert.equal(slow.ok, false);
    assert.match(slow.ok ? "" : slow.message, /timed out/);
    assert.deepEqual(spawned, ["npm"], "no fresh budget for the fallback");
    assert.ok(Date.now() - started < 1_500);

    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), "definitely-missing-dir", "nested");
    try {
      const noTmp = await installClaudeCli({
        env: { PATH: "/usr/bin" },
        spawnInstall() {
          const child = hangingChild();
          process.nextTick(() => child.emit("exit", 127));
          return child as any;
        },
      });
      assert.equal(noTmp.ok, false);
      assert.match(noTmp.ok ? "" : noTmp.message, /temp dir/);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
  }

  // Superseded login child: its late exit must not fail the current flow.
  {
    const { startClaudeCliLogin, cancelClaudeCliLogin, getClaudeCliLoginStatus, resetClaudeCliLoginForTests } =
      await import("../src/cli-login.ts");
    const fakeCli = () => {
      const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
      return Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        killed: false,
        stdout: stream(),
        stderr: stream(),
        stdin: Object.assign(new EventEmitter(), { writable: true, write: () => true }),
        kill() {
          this.killed = true;
          return true;
        },
      });
    };
    const url = (n: number) => `https://claude.com/cai/oauth/authorize?code=true&state=s${n}`;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const children = [fakeCli(), fakeCli()];
    let spawned = 0;
    const start = () =>
      startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: { PATH: "/usr/local/bin" },
        spawnLogin: () => children[spawned++] as any,
      });

    const first = start();
    await tick();
    children[0]!.stdout.emit("data", `visit: ${url(1)}\n`);
    assert.deepEqual(await first, { state: "awaiting-code", url: url(1) });
    cancelClaudeCliLogin();

    const second = start();
    await tick();
    children[1]!.stdout.emit("data", `visit: ${url(2)}\n`);
    assert.deepEqual(await second, { state: "awaiting-code", url: url(2) });

    // The killed first child exits only now, and prints on its way out.
    children[0]!.stdout.emit("data", `visit: ${url(9)}\n`);
    children[0]!.exitCode = 143;
    children[0]!.emit("exit", 143, "SIGTERM");
    assert.deepEqual(getClaudeCliLoginStatus(), { state: "awaiting-code", url: url(2) });
    resetClaudeCliLoginForTests();
  }

  console.log("ok — cli probes regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
