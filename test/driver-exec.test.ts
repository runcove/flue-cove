import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ConflictError, NotFoundError } from "@cove/sdk";
import { SandboxDiedError, sandboxFromDriver } from "@flue/runtime";
import {
  type CoveExecClient,
  CoveSandboxDriver,
  KILL_GROUP,
  timeoutSecsFor,
} from "../src/driver.ts";
import { localShellClient, scriptedClient } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "flue-cove-exec-"));
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
    const { client, calls } = scriptedClient(() => [{ kind: "exit", code: 0 }]);
    const driver = new CoveSandboxDriver(client, "my-vm");
    const ac = new AbortController();
    await driver.exec("true", { timeoutMs: 1500, signal: ac.signal });
    assert.equal(calls[0]?.vm, "my-vm");
    assert.equal(calls[0]?.timeoutSecs, 2);
    assert.equal(calls[0]?.signal, ac.signal);
  });

  it("refuses a bad env name before running anything", async () => {
    const { client, calls } = scriptedClient(() => [{ kind: "exit", code: 0 }]);
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
      { kind: "exit", code: 0 },
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
      { kind: "exit", code: 0 },
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

  it("kills the whole process group, not just the direct child", async () => {
    const marker = join(dir, "timeout-marker");
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const res = await driver.exec(`(sleep 2; touch '${marker}') & sleep 5`, { timeoutMs: 500 });
    assert.equal(res.exitCode, 124);
    await sleep(2500);
    assert.equal(existsSync(marker), false, "a backgrounded child outlived the timeout");
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
    const marker = join(dir, "abort-marker");
    const { client, calls } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm");
    const ac = new AbortController();
    const p = driver.exec(`sleep 2; touch '${marker}'`, { signal: ac.signal });
    await sleep(300);
    ac.abort(new Error("stop"));
    await assert.rejects(p);
    await sleep(2500);
    assert.equal(existsSync(marker), false, "the aborted command kept running");
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

  it("enforces timeoutMs itself (the route has none): 124 and the group is killed", async () => {
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

describe("the group-kill helper", () => {
  const run = (script: string, ...args: string[]) =>
    new Promise<number>((resolve) => {
      const child = spawn("sh", ["-c", script, "sh", ...args], { stdio: "ignore" });
      child.on("close", (code) => resolve(code ?? -1));
    });
  const starttime = (pid: number) =>
    readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /, "")
      .split(" ")[19];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills a recorded group even after its leader is gone", async () => {
    const pidFile = join(dir, "g.pid");
    // A new session whose leader exits at once, leaving a member running.
    const leader = spawn(
      "setsid",
      ["sh", "-c", `echo "g $$ x" > '${pidFile}'; sleep 30 & exit 0`],
      {
        stdio: "ignore",
      },
    );
    await new Promise((r) => leader.on("close", r));
    const pgid = Number(readFileSync(pidFile, "utf8").split(" ")[1]);
    assert.equal(await run(KILL_GROUP, pidFile), 0);
    await sleep(200);
    const out = execFileSync("ps", ["-eo", "pgid="], { encoding: "utf8" });
    assert.ok(!out.split("\n").some((l) => Number(l.trim()) === pgid), "group survived");
  });

  it("does not kill a single pid whose start time no longer matches (pid reuse)", async () => {
    const pidFile = join(dir, "p.pid");
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    writeFileSync(pidFile, `p ${victim.pid} 1`);
    await run(KILL_GROUP, pidFile);
    await sleep(100);
    assert.equal(alive(victim.pid as number), true);
    victim.kill();
  });

  it("kills a single pid whose start time matches", async () => {
    const pidFile = join(dir, "p2.pid");
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    await sleep(50);
    writeFileSync(pidFile, `p ${victim.pid} ${starttime(victim.pid as number)}`);
    await run(KILL_GROUP, pidFile);
    await new Promise((r) => victim.on("close", r));
    assert.equal(alive(victim.pid as number), false);
  });

  it("waits briefly for a pid file that does not exist yet", async () => {
    const pidFile = join(dir, "late.pid");
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    await sleep(50);
    setTimeout(
      () => writeFileSync(pidFile, `p ${victim.pid} ${starttime(victim.pid as number)}`),
      300,
    );
    await run(KILL_GROUP, pidFile);
    await new Promise((r) => victim.on("close", r));
    assert.equal(alive(victim.pid as number), false);
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
  it("a timeoutMs beyond setTimeout's range does not fire at once", async () => {
    const { client } = localShellClient();
    const driver = new CoveSandboxDriver(client, "vm", { secrets: { kind: "all" } });
    const res = await driver.exec("sleep 0.3; echo done", { timeoutMs: 2 ** 40 });
    assert.deepEqual(res, { stdout: "done\n", stderr: "", exitCode: 0 });
  });

  it("an SDK request timeout (TimeoutError) also kills the guest command", async () => {
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
