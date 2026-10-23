import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxDiedError, sandboxFromDriver } from "@flue/runtime";
import { ConflictError, CoveTimeoutError, NotFoundError, RateLimitError } from "@runcove/sdk";
import {
  type CoveExecClient,
  CoveSandboxDriver,
  clientSendsExecEnv,
  INNER,
  KILL_GROUP,
  RESERVED_PREFIX,
  sdkSendsExecEnv,
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

  it("runs in cwd with env layered on, values intact", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    const res = await driver.exec('printf "%s|%s" "$(pwd)" "$V"', {
      cwd: dir,
      env: { V: "a 'b' $c" },
    });
    assert.equal(res.stdout, `${dir}|a 'b' $c`);
  });

  it("sends env under reserved names in the request, with only the names in argv", async () => {
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    const secret = "value-that-must-stay-out-of-argv";
    const res = await driver.exec(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
      'printf "%s|%s" "$API_TOKEN" "${__FLUE_COVE_E_API_TOKEN-unset}"',
      {
        env: { API_TOKEN: secret, N: "1" },
      },
    );
    // The command sees the real name; the reserved one is gone before it runs.
    assert.equal(res.stdout, `${secret}|unset`);
    assert.deepEqual(calls[0]?.env, {
      __FLUE_COVE_E_API_TOKEN: secret,
      __FLUE_COVE_E_N: "1",
    });
    const argv = JSON.stringify(calls[0]?.command);
    assert.doesNotMatch(argv, /must-stay-out-of-argv/);
    assert.match(argv, /API_TOKEN N/);
  });

  it("the launcher wrapper passes env to the user's command and its children", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    const res = await driver.exec('sh -c \'printf "%s" "$CHILD_V"\'', {
      env: { CHILD_V: "inherited" },
    });
    assert.equal(res.stdout, "inherited");
  });

  it("a user PATH takes effect only for the command: the wrapper still records the start time", async () => {
    const pidFile = join(dir, "path.pid");
    const child = spawn("sh", ["-c", INNER, "sh", pidFile, 'printf "%s" "$PATH"', "p", "PATH"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", __FLUE_COVE_E_PATH: "/nonexistent" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    await new Promise((r) => child.on("close", r));
    assert.equal(out, "/nonexistent");
    // `p <pid> <starttime>`: the start time exists only if sed and cut ran
    // with the real PATH (the trap's rm then could not run, so the file stays).
    assert.match(readFileSync(pidFile, "utf8").trim(), /^p \d+ \d+$/);
    rmSync(pidFile, { force: true });
  });

  it("refuses a name in the adapter's reserved namespace, sending nothing", async () => {
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    await assert.rejects(driver.exec("true", { env: { __FLUE_COVE_X: "1" } }), TypeError);
    assert.equal(calls.length, 0);
  });

  it("refuses a NUL in a value locally, naming no value", async () => {
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    await assert.rejects(driver.exec("true", { env: { X: "a\0b" } }), (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /NUL/);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("refuses an invalid env name on the streaming driver, sending nothing", async () => {
    const { client, calls, secretsCalls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    await assert.rejects(driver.exec("true", { env: { "BAD NAME": "x" } }), TypeError);
    assert.equal(calls.length, 0);
    assert.equal(secretsCalls.length, 0);
  });

  it("refuses non-empty env when the SDK cannot send it, naming no value", async () => {
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: false });
    await assert.rejects(
      driver.exec("true", { env: { X: "must-stay-out-of-errors" } }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /@runcove\/sdk/);
        assert.match(err.message, /0\.5\.2/);
        assert.doesNotMatch(err.message, /must-stay-out-of-errors/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
    // An empty env, or none, is not refused.
    assert.equal((await driver.exec("true", { env: {} })).exitCode, 0);
    assert.equal((await driver.exec("true")).exitCode, 0);
  });

  it("the launcher leaves the user's command no positional arguments, with and without env", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    assert.equal((await driver.exec('printf %s "$#"')).stdout, "0");
    assert.equal((await driver.exec('printf %s "$#"', { env: { A: "1", B: "2" } })).stdout, "0");
  });

  it("refuses the lowercase reserved namespace in any case, sending nothing", async () => {
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    for (const name of ["__flue_cove_cmd", "__Flue_Cove_n", "__FLUE_COVE_E_X"]) {
      await assert.rejects(driver.exec("true", { env: { [name]: "x" } }), TypeError);
    }
    assert.equal(calls.length, 0);
  });

  it("caps a name so the prefixed name fits the server's 256 bytes, naming no value", async () => {
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    const longest = "N".repeat(256 - RESERVED_PREFIX.length);
    assert.equal((await driver.exec("true", { env: { [longest]: "v" } })).exitCode, 0);
    assert.equal(RESERVED_PREFIX.length + longest.length, 256);
    await assert.rejects(
      driver.exec("true", { env: { [`${longest}X`]: "must-stay-out-of-errors" } }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.doesNotMatch(err.message, /must-stay-out-of-errors/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("trusts the SDK probe only for a client of that SDK's CoveClient", async () => {
    class Own {}
    const newSdk = { CoveClient: Own, EXEC_STDIN_MIN_API_VERSION: 8 };
    assert.equal(clientSendsExecEnv(new Own(), newSdk), true);
    // A client from another copy of the SDK, or a double, is not vouched for.
    assert.equal(clientSendsExecEnv({}, newSdk), false);
    assert.equal(clientSendsExecEnv(new (class Other {})(), newSdk), false);
    // An SDK without the export vouches for nobody.
    assert.equal(clientSendsExecEnv(new Own(), { CoveClient: Own }), false);
    assert.equal(clientSendsExecEnv(new Own(), {}), false);
  });

  it("a client the SDK cannot vouch for needs sendsExecEnv, and the refusal says so", async () => {
    const { client, calls } = localShellClient();
    const plain = new CoveSandboxDriver(client, "vm");
    await assert.rejects(plain.exec("true", { env: { X: "1" } }), /sendsExecEnv: true/);
    assert.equal(calls.length, 0);
    const told = new CoveSandboxDriver(client, "vm", { sendsExecEnv: true });
    assert.equal((await told.exec("true", { env: { X: "1" } })).exitCode, 0);
  });

  it("detects the capability from the SDK module: an export only the new SDK has", () => {
    assert.equal(sdkSendsExecEnv({ CoveClient: class {} }), false);
    assert.equal(sdkSendsExecEnv({ EXEC_STDIN_MIN_API_VERSION: 8 }), true);
  });

  it("leaves env out of the request when none is given", async () => {
    const { client, calls } = scriptedClient(() => [{ kind: "exit", code: 0, timedOut: false }]);
    await new CoveSandboxDriver(client, "vm").exec("true");
    assert.equal(calls[0]?.env, undefined);
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
    const res = await driver.exec("echo hi; exit 4");
    assert.deepEqual(res, { stdout: "hi\n", stderr: "", exitCode: 4 });
    assert.equal(secretsCalls.length, 1);
    assert.deepEqual(secretsCalls[0]?.selector, { kind: "all" });
    // Only the helper's own stream ran; no streaming exec for the user command.
    assert.equal(calls.length, 1);
  });

  it("refuses env with secrets, running nothing and putting no value in argv", async () => {
    const { client, secretsCalls, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    await assert.rejects(
      driver.exec("true", { env: { X: "must-stay-out-of-argv" } }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /`secrets`/);
        assert.doesNotMatch(err.message, /must-stay-out-of-argv/);
        return true;
      },
    );
    assert.equal(secretsCalls.length, 0);
    assert.equal(calls.length, 0);
  });

  it("refuses an invalid env name on the secrets driver, sending nothing", async () => {
    const { client, secretsCalls, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    await assert.rejects(driver.exec("true", { env: { "BAD NAME": "x" } }), TypeError);
    assert.equal(secretsCalls.length, 0);
    assert.equal(calls.length, 0);
  });

  it("accepts an empty env with secrets", async () => {
    const { client, secretsCalls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    const res = await driver.exec("echo hi", { env: {} });
    assert.equal(res.exitCode, 0);
    assert.equal(secretsCalls.length, 1);
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

  it("stops a command that starts after the kill, before it runs anything", async () => {
    // However late the command starts, it finds the kill's marker and exits:
    // nothing the kill does waits a fixed time for the pid file.
    const pidFile = join(dir, "late.pid");
    const marker = join(dir, "late.ran");
    assert.equal(await run(KILL_GROUP, pidFile), 0);
    assert.equal(await run(INNER, pidFile, `touch '${marker}'`, "p", ""), 125);
    assert.equal(existsSync(marker), false, "the user command ran after the kill");
    assert.equal(existsSync(pidFile), false);
    assert.equal(existsSync(`${pidFile}.kill`), false);
  });

  it("a command that started first is killed, and the kill cleans up after itself", async () => {
    const pidFile = join(dir, "early.pid");
    const victim = spawn("sh", ["-c", INNER, "sh", pidFile, "sleep 30", "p", ""], {
      stdio: "ignore",
    });
    const closed = new Promise((r) => victim.on("close", r));
    try {
      await eventually(
        `${pidFile} written`,
        () => existsSync(pidFile) && /\d/.test(readFileSync(pidFile, "utf8")),
      );
      assert.equal(await run(KILL_GROUP, pidFile), 0);
      await closed;
      assert.equal(goneOrZombie(victim.pid as number), true);
      assert.equal(existsSync(pidFile), false);
      assert.equal(existsSync(`${pidFile}.kill`), false);
    } finally {
      killQuietly(victim.pid);
    }
  });

  it("kills a group whose leader is gone though its start time was recorded", async () => {
    // Pins the rule, not the race: a recorded start time that can no longer be
    // read means the leader is gone, not that its pid was recycled.
    const pidFile = join(dir, "gone.pid");
    const memberFile = join(dir, "gone.member");
    const leader = spawn(
      "setsid",
      [
        "sh",
        "-c",
        `sleep 30 & echo $! > '${memberFile}'; ` +
          `echo "g $$ $(sed 's/^.*) //' /proc/$$/stat | cut -d' ' -f20)" > '${pidFile}'; exit 0`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((r) => leader.on("close", r));
    const member = Number(readFileSync(memberFile, "utf8").trim());
    try {
      assert.equal(goneOrZombie(member), false, "the member should be running before the kill");
      assert.equal(await run(KILL_GROUP, pidFile), 0);
      await eventually("the group killed", () => goneOrZombie(member));
    } finally {
      killQuietly(member);
    }
  });

  it("still kills the group when the marker cannot be created", {
    skip: process.getuid?.() === 0 && "root can write to a read-only directory",
  }, async () => {
    // A full /tmp or a read-only one: the kill must not stop at the marker.
    const roDir = mkdtempSync(join(dir, "ro-"));
    const pidFile = join(roDir, "ro.pid");
    const memberFile = join(dir, "ro.member");
    const leader = spawn(
      "setsid",
      [
        "sh",
        "-c",
        `sleep 30 & echo $! > '${memberFile}'; ` +
          `echo "g $$ $(sed 's/^.*) //' /proc/$$/stat | cut -d' ' -f20)" > '${pidFile}'; exit 0`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((r) => leader.on("close", r));
    const member = Number(readFileSync(memberFile, "utf8").trim());
    chmodSync(roDir, 0o555);
    try {
      assert.equal(goneOrZombie(member), false, "the member should be running before the kill");
      assert.equal(await run(KILL_GROUP, pidFile), 0);
      await eventually("the group killed", () => goneOrZombie(member));
    } finally {
      chmodSync(roDir, 0o755);
      killQuietly(member);
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

  /**
   * A secrets exec whose attempts are all answered by the test, in order:
   * each call to `execWithSecrets` waits for `reply(n)`. Records the pid file
   * every attempt was launched with and the kills (recorded, not run).
   */
  function scriptedAttempts() {
    type Out = { stdout: string; stderr: string; exit_code: number };
    const pidFiles: string[] = [];
    const kills: string[][] = [];
    const pending: Array<{ resolve: (o: Out) => void; reject: (e: unknown) => void }> = [];
    const client = {
      vms: {
        exec: async function* (_vm: string, opts: { command: string[] }) {
          kills.push(opts.command);
          yield { kind: "exit", code: 0 };
        },
        execWithSecrets: (_vm: string, opts: { command: string[] }) => {
          pidFiles.push(opts.command[5] as string);
          return new Promise<Out>((resolve, reject) => pending.push({ resolve, reject }));
        },
      },
    } as unknown as CoveExecClient;
    return {
      driver: new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } }),
      pidFiles,
      kills,
      attempts: () => pending.length,
      refuse: (n: number) => pending[n]?.reject(new RateLimitError(429, "HTTP 429")),
      answer: (n: number, out: Out) => pending[n]?.resolve(out),
    };
  }

  it("each 429 retry launches with its own pid file", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0);
    const fake = scriptedAttempts();
    const res = fake.driver.exec("echo ok", { timeoutMs: 60_000 });
    await settle();
    fake.refuse(0);
    await settle();
    t.mock.timers.tick(250);
    await settle();
    fake.refuse(1);
    await settle();
    t.mock.timers.tick(500);
    await settle();
    assert.equal(fake.attempts(), 3);
    assert.equal(new Set(fake.pidFiles).size, 3, "every attempt has a pid file of its own");
    fake.answer(2, { stdout: "ok\n", stderr: "", exit_code: 0 });
    assert.deepEqual(await res, { stdout: "ok\n", stderr: "", exitCode: 0 });
  });

  it("a slow 429 that arrives after the deadline killed the attempt reports the timeout, not 125", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0);
    const fake = scriptedAttempts();
    const res = fake.driver.exec("echo ok", { timeoutMs: 200 });
    await settle();
    // The deadline fires while the first request is still waiting: the group
    // kill leaves its marker beside that attempt's pid file.
    t.mock.timers.tick(200);
    await settle();
    assert.equal(fake.kills.length, 1);
    assert.equal(fake.kills[0]?.[4], fake.pidFiles[0]);
    // Then the 429 arrives. The attempt ran nothing and the time is up:
    // no retry is sent (it would find the marker and exit 125 with no note).
    fake.refuse(0);
    await settle();
    // Old code backs off 250 ms (random pinned to 0) and then retries; advance
    // the mocked clock past that, so the retry is sent there and the
    // assertion fails rather than the test hanging.
    t.mock.timers.tick(250);
    await settle();
    assert.equal(fake.attempts(), 1, "no retry after the deadline");
    const out = await res;
    assert.equal(out.exitCode, 124);
    assert.match(out.stderr, /command timed out after 200ms/);
  });

  it("a 125 after the deadline killed the attempt reports the timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = scriptedAttempts();
    const res = fake.driver.exec("echo ok", { timeoutMs: 200 });
    await settle();
    t.mock.timers.tick(200);
    await settle();
    fake.answer(0, { stdout: "", stderr: "", exit_code: 125 });
    const out = await res;
    assert.equal(out.exitCode, 124);
    assert.match(out.stderr, /command timed out after 200ms/);
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
