import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxDiedError, sandboxFromDriver } from "@flue/runtime";
import { ConflictError, CoveTimeoutError, NotFoundError, RateLimitError } from "@runcove/sdk";
import {
  type CoveExecClient,
  CoveSandboxDriver,
  KILL_GROUP,
  timeoutSecsFor,
} from "../src/driver.ts";
import { localShellClient, scriptedClient } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "flue-cove-exec-"));

/** Poll until `cond()` holds, or fail after `deadlineMs`. Loaded machines get the whole budget. */
async function eventually(what: string, cond: () => boolean, deadlineMs = 20_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`${what} did not happen within ${deadlineMs} ms`);
    await sleep(50);
  }
}

/** The pid a test command wrote to `file`, once it has. */
async function pidFrom(file: string): Promise<number> {
  await eventually(`${file} written`, () => {
    try {
      return /^\d+\s*$/.test(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  });
  return Number(readFileSync(file, "utf8").trim());
}

/** Gone, or a zombie waiting to be reaped: either way it runs nothing more. */
function dead(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}
after(() => rmSync(dir, { recursive: true, force: true }));

describe("timeoutSecsFor", () => {
  it("rounds up to whole seconds, never down", () => {
    assert.equal(timeoutSecsFor(undefined), undefined);
    assert.equal(timeoutSecsFor(1), 1);
    assert.equal(timeoutSecsFor(999), 1);
    assert.equal(timeoutSecsFor(1000), 1);
    assert.equal(timeoutSecsFor(1001), 2);
    assert.equal(timeoutSecsFor(2500), 3);
    assert.equal(timeoutSecsFor(120_000), 120);
  });
  it("never sends zero, which a server could read as 'no deadline'", () => {
    assert.equal(timeoutSecsFor(0), 1);
  });
});

describe("exec: collection", () => {
  it("collects stdout, stderr and a non-zero exit code without rejecting", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const res = await driver.exec("echo out; echo err >&2; printf more; exit 3");
    assert.deepEqual(res, { stdout: "out\nmore", stderr: "err\n", exitCode: 3 });
  });

  it("runs in cwd with env layered on, quoting both", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const res = await driver.exec('printf "%s|%s" "$(pwd)" "$V"', {
      cwd: dir,
      env: { V: "a 'b' $c" },
    });
    assert.equal(res.stdout, `${dir}|a 'b' $c`);
  });

  it("forwards timeoutMs as whole seconds and the signal as the request's signal", async () => {
    const { client, calls } = scriptedClient(() => [{ kind: "exit", code: 0, timedOut: false }]);
    const driver = new CoveSandboxDriver(client, "my-vm");
    const ac = new AbortController();
    await driver.exec("true", { timeoutMs: 1500, signal: ac.signal });
    assert.equal(calls[0]?.vm, "my-vm");
    assert.equal(calls[0]?.timeoutSecs, 2);
    assert.equal(calls[0]?.signal, ac.signal);
  });

  it("refuses a bad env name before running anything", async () => {
    const { client, calls } = scriptedClient(() => [{ kind: "exit", code: 0, timedOut: false }]);
    const driver = new CoveSandboxDriver(client, "vm");
    await assert.rejects(driver.exec("true", { env: { "A;rm -rf /": "x" } }), TypeError);
    assert.equal(calls.length, 0);
  });

  it("streams chunks to onOutput as they arrive", async () => {
    const seen: Array<[string, string]> = [];
    const { client } = scriptedClient(() => [
      { kind: "stdout", data: "a" },
      { kind: "stderr", data: "b" },
      { kind: "stdout", data: "c" },
      { kind: "exit", code: 0, timedOut: false },
    ]);
    const driver = new CoveSandboxDriver(client, "vm", {
      onOutput: (chunk, stream) => seen.push([stream, chunk]),
    });
    const res = await driver.exec("x");
    assert.deepEqual(seen, [
      ["stdout", "a"],
      ["stderr", "b"],
      ["stdout", "c"],
    ]);
    assert.equal(res.stdout, "ac");
  });

  it("a throwing onOutput hook does not break the exec", async () => {
    const { client } = scriptedClient(() => [
      { kind: "stdout", data: "a" },
      { kind: "exit", code: 0, timedOut: false },
    ]);
    const driver = new CoveSandboxDriver(client, "vm", {
      onOutput: () => {
        throw new Error("hook bug");
      },
    });
    assert.equal((await driver.exec("x")).stdout, "a");
  });
});

describe("exec: terminal events", () => {
  it("a paused event is SandboxDiedError", async () => {
    const { client } = scriptedClient(() => [
      { kind: "stdout", data: "start\n" },
      { kind: "paused", reason: "VM transitioned to Pausing mid-exec", newState: "Pausing" },
    ]);
    const driver = new CoveSandboxDriver(client, "vm");
    await assert.rejects(driver.exec("sleep 9"), (err: unknown) => {
      assert.ok(err instanceof SandboxDiedError);
      assert.equal(err.type, "sandbox_died");
      return true;
    });
  });

  it("an error event rejects with the server's message", async () => {
    const { client } = scriptedClient(() => [{ kind: "error", error: "guest agent error: boom" }]);
    const driver = new CoveSandboxDriver(client, "vm");
    await assert.rejects(driver.exec("x"), /guest agent error: boom/);
  });

  it("a stream that ends without an exit status rejects", async () => {
    const { client } = scriptedClient(() => [{ kind: "stdout", data: "partial" }]);
    const driver = new CoveSandboxDriver(client, "vm");
    await assert.rejects(driver.exec("x"), /ended without an exit status/);
  });

  it("a VM that is not running (409 invalid_state_transition) is SandboxDiedError", async () => {
    const { client } = scriptedClient(() => {
      throw new ConflictError(409, "invalid state transition", "invalid_state_transition");
    });
    await assert.rejects(new CoveSandboxDriver(client, "vm").exec("x"), SandboxDiedError);
  });

  it("a VM that is gone (404 vm_not_found) is SandboxDiedError", async () => {
    const { client } = scriptedClient(() => {
      throw new NotFoundError(404, "no such vm", "vm_not_found");
    });
    await assert.rejects(new CoveSandboxDriver(client, "vm").exec("x"), SandboxDiedError);
  });

  it("other API errors pass through unchanged", async () => {
    const boom = new ConflictError(409, "other", "something_else");
    const { client } = scriptedClient(() => {
      throw boom;
    });
    await assert.rejects(new CoveSandboxDriver(client, "vm").exec("x"), (e) => e === boom);
  });
});

describe("exec: timeout", () => {
  it("normalises Cove's timeout error to exit 124, keeping partial output", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const res = await driver.exec("echo before; echo oops >&2; sleep 5; echo after", {
      timeoutMs: 1000,
    });
    assert.equal(res.exitCode, 124);
    assert.equal(res.stdout, "before\n");
    assert.match(res.stderr, /^oops\n/);
    assert.match(res.stderr, /timed out after 1s/);
  });

  it("kills the whole process group, not just the direct child", {
    skip: process.platform !== "linux" && "needs setsid",
  }, async () => {
    // The background child records its pid and would sleep for a minute. The
    // kill is proved by polling until that process is dead, with a generous
    // deadline, not by a fixed wait racing a timer: under load the kill can
    // land later than any short bound.
    const pidFile = join(dir, "timeout-child.pid");
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const res = await driver.exec(
      `sh -c 'echo $$ > "$1"; exec sleep 60' sh '${pidFile}' & sleep 30`,
      { timeoutMs: 500 },
    );
    assert.equal(res.exitCode, 124);
    const child = await pidFrom(pidFile);
    await eventually("the backgrounded child killed with its group", () => dead(child));
  });

  it("does not treat an unrelated error as a timeout when no deadline was set", async () => {
    const { client } = scriptedClient(() => [
      { kind: "error", error: "guest agent error: command timed out after 30s" },
    ]);
    await assert.rejects(new CoveSandboxDriver(client, "vm").exec("x"), /timed out/);
  });
});

describe("exec: abort", () => {
  it("kills the guest command when the caller aborts", async () => {
    const pidFile = join(dir, "abort-child.pid");
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const ac = new AbortController();
    const p = driver.exec(`sh -c 'echo $$ > "$1"; exec sleep 60' sh '${pidFile}'`, {
      signal: ac.signal,
    });
    const child = await pidFrom(pidFile);
    ac.abort(new Error("stop"));
    await assert.rejects(p);
    await eventually("the aborted command killed", () => dead(child));
    // The kill went out as a second exec, without the aborted signal.
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.signal, undefined);
  });

  it("through sandboxFromDriver, an abort rejects promptly with AbortError", async () => {
    const { client } = localShellClient();
    const sandbox = sandboxFromDriver(new CoveSandboxDriver(client, "vm"), "/");
    const ac = new AbortController();
    const started = Date.now();
    const p = sandbox.exec("sleep 5", { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p, { name: "AbortError" });
    assert.ok(Date.now() - started < 2000);
  });
});

describe("exec: secrets", () => {
  it("routes through execWithSecrets with the selector", async () => {
    const { client, secretsCalls, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    const res = await driver.exec("echo hi; exit 4", { env: { X: "1" } });
    assert.deepEqual(res, { stdout: "hi\n", stderr: "", exitCode: 4 });
    assert.equal(secretsCalls.length, 1);
    assert.deepEqual(secretsCalls[0]?.selector, { kind: "all" });
    // Only the helper's own stream ran; no streaming exec for the user command.
    assert.equal(calls.length, 1);
  });

  it("enforces timeoutMs itself (the route has none): 124 and the group is killed", {
    skip: process.platform !== "linux" && "needs setsid",
  }, async () => {
    const marker = join(dir, "secrets-marker");
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    const res = await driver.exec(`echo start; (sleep 2; touch '${marker}') & sleep 5`, {
      timeoutMs: 500,
    });
    assert.equal(res.exitCode, 124);
    assert.equal(res.stdout, "start\n");
    assert.match(res.stderr, /timed out after 500ms/);
    await sleep(2500);
    assert.equal(existsSync(marker), false);
  });

  it("forwards the signal", async () => {
    const { client, secretsCalls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", {
      secrets: { kind: "subset", names: ["A"] },
    });
    const ac = new AbortController();
    await driver.exec("true", { signal: ac.signal });
    assert.equal(secretsCalls[0]?.signal, ac.signal);
  });
});

describe("exec: shell", () => {
  it("runs the command under bash when the guest has it", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const res = await driver.exec(
      '[[ "a b" == "a b" ]] && echo ok; set -o pipefail; false | true; echo "pipe=$?"',
    );
    assert.equal(res.stdout, "ok\npipe=1\n");
    assert.equal(res.exitCode, 0);
  });
});

const LINUX = process.platform === "linux";

/** True when `pid` has exited (ENOENT) or is a zombie awaiting its reaper. */
function goneOrZombie(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /, "")
      .startsWith("Z");
  } catch {
    return true;
  }
}

function killQuietly(pid: number | undefined): void {
  try {
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe("the group-kill helper", { skip: !LINUX && "needs /proc and setsid" }, () => {
  const run = (script: string, ...args: string[]) =>
    new Promise<number>((resolve) => {
      const child = spawn("sh", ["-c", script, "sh", ...args], { stdio: "ignore" });
      child.on("close", (code) => resolve(code ?? -1));
    });
  const starttime = (pid: number) =>
    readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /, "")
      .split(" ")[19];

  it("kills a recorded group even after its leader is gone", async () => {
    const pidFile = join(dir, "g.pid");
    const memberFile = join(dir, "g.member");
    // A new session whose leader exits at once, leaving a member running.
    const leader = spawn(
      "setsid",
      ["sh", "-c", `sleep 30 & echo $! > '${memberFile}'; echo "g $$ x" > '${pidFile}'; exit 0`],
      { stdio: "ignore" },
    );
    await new Promise((r) => leader.on("close", r));
    const member = Number(readFileSync(memberFile, "utf8").trim());
    try {
      assert.equal(goneOrZombie(member), false, "the member should be running before the kill");
      assert.equal(await run(KILL_GROUP, pidFile), 0);
      await sleep(200);
      assert.equal(goneOrZombie(member), true, "the group survived");
    } finally {
      killQuietly(member);
    }
  });

  it("does not kill a single pid whose start time no longer matches (pid reuse)", async () => {
    const pidFile = join(dir, "p.pid");
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(pidFile, `p ${victim.pid} 1`);
      await run(KILL_GROUP, pidFile);
      await sleep(100);
      assert.equal(goneOrZombie(victim.pid as number), false);
    } finally {
      killQuietly(victim.pid);
    }
  });

  it("kills a single pid whose start time matches", async () => {
    const pidFile = join(dir, "p2.pid");
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    const closed = new Promise((r) => victim.on("close", r));
    try {
      await sleep(50);
      writeFileSync(pidFile, `p ${victim.pid} ${starttime(victim.pid as number)}`);
      await run(KILL_GROUP, pidFile);
      await closed;
      assert.equal(goneOrZombie(victim.pid as number), true);
    } finally {
      killQuietly(victim.pid);
    }
  });

  it("waits briefly for a pid file that does not exist yet", async () => {
    const pidFile = join(dir, "late.pid");
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    const closed = new Promise((r) => victim.on("close", r));
    try {
      await sleep(50);
      setTimeout(
        () => writeFileSync(pidFile, `p ${victim.pid} ${starttime(victim.pid as number)}`),
        300,
      );
      await run(KILL_GROUP, pidFile);
      await closed;
      assert.equal(goneOrZombie(victim.pid as number), true);
    } finally {
      killQuietly(victim.pid);
    }
  });

  it("ignores garbage in the pid file", async () => {
    const pidFile = join(dir, "bad.pid");
    writeFileSync(pidFile, "g 1 x");
    assert.equal(await run(KILL_GROUP, pidFile), 0);
    writeFileSync(pidFile, "g $(id) x");
    assert.equal(await run(KILL_GROUP, pidFile), 0);
  });
});

describe("exec: secrets timers", () => {
  /**
   * A secrets exec whose first attempt is refused with 429 and whose second
   * attempt answers only when the test says so. Kills (the driver's
   * `KILL_GROUP` helper, which goes over plain exec) are recorded, not run.
   * Driven by mocked timers and a zero jitter, so the schedule is exact and
   * no wall-clock time is measured.
   */
  function rateLimitedOnce() {
    let attempts = 0;
    const kills: string[][] = [];
    let answer: ((out: { stdout: string; stderr: string; exit_code: number }) => void) | undefined;
    const client = {
      vms: {
        exec: async function* (_vm: string, opts: { command: string[] }) {
          kills.push(opts.command);
          yield { kind: "exit", code: 0 };
        },
        execWithSecrets: async () => {
          if (++attempts === 1) throw new RateLimitError(429, "HTTP 429: Too Many Requests");
          return new Promise((r) => {
            answer = r;
          });
        },
      },
    } as unknown as CoveExecClient;
    return {
      driver: new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } }),
      attempts: () => attempts,
      kills,
      answer: (out: { stdout: string; stderr: string; exit_code: number }) => {
        assert.ok(answer, "the retry has not been sent");
        answer(out);
      },
    };
  }

  /** Let every pending promise continuation run (setImmediate is not mocked). */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  it("a deadline shorter than the 429 backoff neither reports 124 nor kills the retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0); // the backoff is exactly 250 ms
    const fake = rateLimitedOnce();
    const res = fake.driver.exec("echo ok", { timeoutMs: 200 });
    await settle();
    assert.equal(fake.attempts(), 1);
    // The backoff: 249 ms in, the first attempt's 200 ms timer, had it
    // survived the 429, would have fired and killed (and found the retry's
    // pid file).
    t.mock.timers.tick(249);
    await settle();
    assert.equal(fake.attempts(), 1);
    assert.deepEqual(fake.kills, []);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(fake.attempts(), 2);
    // The retry gets its own 200 ms: 199 ms into it (449 ms after the first
    // request) it answers, with no kill and no 124.
    t.mock.timers.tick(199);
    await settle();
    fake.answer({ stdout: "ok\n", stderr: "", exit_code: 0 });
    assert.deepEqual(await res, { stdout: "ok\n", stderr: "", exitCode: 0 });
    assert.deepEqual(fake.kills, []);
  });

  it("the retry's own deadline still fires, 200 ms after the retry went out", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0);
    const fake = rateLimitedOnce();
    const res = fake.driver.exec("sleep 9", { timeoutMs: 200 });
    await settle();
    t.mock.timers.tick(250);
    await settle();
    assert.equal(fake.attempts(), 2);
    t.mock.timers.tick(199);
    await settle();
    assert.deepEqual(fake.kills, []);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(fake.kills.length, 1);
    assert.equal(fake.kills[0]?.[2], KILL_GROUP);
    fake.answer({ stdout: "", stderr: "", exit_code: 137 });
    const out = await res;
    assert.equal(out.exitCode, 124);
    assert.match(out.stderr, /command timed out after 200ms/);
  });

  it("a timeoutMs beyond setTimeout's range does not fire at once", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    const res = await driver.exec("sleep 0.3; echo done", { timeoutMs: 2 ** 40 });
    assert.deepEqual(res, { stdout: "done\n", stderr: "", exitCode: 0 });
  });

  it("an SDK request deadline (CoveTimeoutError) also kills the guest command", async () => {
    const marker = join(dir, "sdk-cove-timeout-marker");
    const shell = localShellClient();
    const client = {
      vms: {
        exec: shell.client.vms.exec,
        execWithSecrets: async (vm: string, opts: { command: string[] }) => {
          // Start the command, then fail the request the way the SDK's deadline does.
          void shell.client.vms.execWithSecrets(vm, { ...opts, selector: { kind: "all" } });
          await sleep(300);
          const cause = new DOMException("Request timed out after 300 ms", "TimeoutError");
          throw new CoveTimeoutError(cause.message, { cause });
        },
      },
    } as unknown as CoveExecClient;
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    await assert.rejects(driver.exec(`sleep 2; touch '${marker}'`), CoveTimeoutError);
    await sleep(2500);
    assert.equal(existsSync(marker), false);
  });

  it("an older SDK copy's request timeout (TimeoutError) also kills the guest command", async () => {
    const marker = join(dir, "sdk-timeout-marker");
    const shell = localShellClient();
    const client = {
      vms: {
        exec: shell.client.vms.exec,
        execWithSecrets: async (vm: string, opts: { command: string[] }) => {
          // Start the command, then fail the request the way the SDK's deadline does.
          void shell.client.vms.execWithSecrets(vm, { ...opts, selector: { kind: "all" } });
          await sleep(300);
          throw new DOMException("Request timed out after 300 ms", "TimeoutError");
        },
      },
    } as unknown as CoveExecClient;
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    await assert.rejects(driver.exec(`sleep 2; touch '${marker}'`), { name: "TimeoutError" });
    await sleep(2500);
    assert.equal(existsSync(marker), false);
  });
});
