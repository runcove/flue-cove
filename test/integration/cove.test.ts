/**
 * Live test against a Cove server. Skipped unless COVE_API_URL and
 * COVE_API_KEY or COVE_API_KEY_FILE are set. Creates one VM (tagged
 * `flue-cove-test=1`), drives every Sandbox operation through Flue's
 * `sandboxFromDriver`, and deletes the VM in `after`, even on failure.
 *
 *   COVE_API_URL=https://<cove-host> COVE_API_KEY_FILE=~/.cove/api_key npm run test:integration
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { CoveClient } from "@cove/sdk";
import { type Sandbox, SandboxDiedError } from "@flue/runtime";
import { cove, coveVms, fromEnv } from "../../src/index.ts";

const enabled =
  !!process.env.COVE_API_URL && !!(process.env.COVE_API_KEY || process.env.COVE_API_KEY_FILE);
const TEST_TAG = { "flue-cove-test": "1" };

describe("Cove integration", {
  skip: !enabled && "set COVE_API_URL and COVE_API_KEY(_FILE)",
}, () => {
  const id = `it-${randomUUID()}`;
  let client: CoveClient;
  let factory: ReturnType<typeof coveVms>;
  let sandbox: Sandbox;
  let vm = "";

  before(async () => {
    client = fromEnv();
    factory = coveVms({
      client,
      tags: TEST_TAG,
      // Backstop: Cove deletes the VM itself if this process dies before `after`.
      expiry: { maxLifetimeSecs: 3600 },
    });
    sandbox = await factory.createSandbox({ id });
    vm = factory.vmName(id) ?? "";
    console.log(`# created VM ${vm}`);
  });

  after(async () => {
    // Release by id even if `before` failed halfway: it finds the VM by tag.
    await factory?.release(id);
    const left: string[] = [];
    for await (const v of client.vms.iter({ tag: [`flue-id=${id}`] })) left.push(v.name);
    assert.deepEqual(left, [], "VMs left behind");
    console.log(`# deleted VM ${vm}`);
  });

  it("starts in /workspace, which exists", async () => {
    assert.equal(sandbox.cwd, "/workspace");
    assert.equal(await sandbox.exists("/workspace"), true);
    assert.equal((await sandbox.exec("pwd")).stdout, "/workspace\n");
  });

  it("a repeated createSandbox with the same id reuses the VM", async () => {
    const [a, b] = await Promise.all([
      factory.createSandbox({ id }),
      coveVms({ client, tags: TEST_TAG }).createSandbox({ id }),
    ]);
    await a.writeFile("/tmp/reuse-check", "same vm");
    assert.equal(await b.readFile("/tmp/reuse-check"), "same vm");
    assert.equal(factory.vmName(id), vm);
    const tagged: string[] = [];
    for await (const v of client.vms.iter({ tag: [`flue-id=${id}`] })) tagged.push(v.name);
    assert.deepEqual(tagged, [vm], "exactly one VM carries the id");
  });

  it("exec: stdout, stderr, a non-zero exit, cwd and env", async () => {
    const res = await sandbox.exec("echo out; echo err >&2; exit 7");
    assert.deepEqual(res, { stdout: "out\n", stderr: "err\n", exitCode: 7 });
    await sandbox.mkdir("sub dir");
    const r2 = await sandbox.exec('printf "%s|%s" "$(pwd)" "$GREETING"', {
      cwd: "sub dir",
      env: { GREETING: "it's $HOME" },
    });
    assert.equal(r2.stdout, "/workspace/sub dir|it's $HOME");
  });

  it("exec: a timeout is exit 124 with a note, and the command's process group is killed", async () => {
    const started = Date.now();
    const res = await sandbox.exec("echo before; (sleep 3; touch /tmp/timeout-marker) & sleep 30", {
      timeoutMs: 1500,
    });
    const took = Date.now() - started;
    assert.equal(res.exitCode, 124);
    assert.equal(res.stdout, "before\n");
    assert.match(res.stderr, /timed out after 2s/);
    assert.ok(took < 10_000, `timeout took ${took} ms`);
    await sleep(3500);
    assert.equal(await sandbox.exists("/tmp/timeout-marker"), false);
  });

  it("exec: abort rejects promptly and kills the guest command", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sandbox.exec("sleep 3; touch /tmp/abort-marker", { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("caller abort")), 500);
    await assert.rejects(p, { name: "AbortError" });
    assert.ok(Date.now() - started < 2000);
    await sleep(4000);
    assert.equal(await sandbox.exists("/tmp/abort-marker"), false, "the aborted command ran on");
  });

  it("files: text round-trip, relative paths, parents created on write", async () => {
    await sandbox.writeFile("a/b/c.txt", "héllo wörld\n");
    assert.equal(await sandbox.readFile("/workspace/a/b/c.txt"), "héllo wörld\n");
    assert.deepEqual(await sandbox.readdir("a/b"), ["c.txt"]);
  });

  it("files: binary and a >1 MiB file round-trip through the file API", async () => {
    const all = new Uint8Array(256).map((_, i) => i);
    await sandbox.writeFile("bytes.bin", all);
    assert.deepEqual(await sandbox.readFileBuffer("bytes.bin"), all);
    const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
    await sandbox.writeFile("big.bin", big);
    assert.deepEqual(await sandbox.readFileBuffer("big.bin"), big);
    const st = await sandbox.stat("big.bin");
    assert.deepEqual(st, {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: big.length,
    });
    const sum = (await sandbox.exec("sha256sum big.bin | cut -d' ' -f1")).stdout.trim();
    const { createHash } = await import("node:crypto");
    assert.equal(sum, createHash("sha256").update(big).digest("hex"));
  });

  it("files: a symlinked path reads, writes and stats through the exec fallback", async () => {
    const big = new Uint8Array(randomBytes(1024 * 1024 + 5));
    await sandbox.writeFile("target.bin", big);
    await sandbox.exec("ln -sf /workspace/target.bin link.bin && ln -sfn /workspace/a linkdir");
    assert.deepEqual(await sandbox.readFileBuffer("link.bin"), big);
    const st = await sandbox.stat("link.bin");
    assert.equal(st.isSymbolicLink, true);
    assert.equal(st.isFile, true);
    assert.equal(st.size, big.length);
    await sandbox.writeFile("link.bin", "replaced through the link");
    assert.equal(await sandbox.readFile("target.bin"), "replaced through the link");
    assert.equal(
      (await sandbox.exec("test -L link.bin && echo still-a-link")).stdout,
      "still-a-link\n",
    );
    // A symlink in a parent directory is refused by the API too.
    assert.equal(await sandbox.readFile("linkdir/b/c.txt"), "héllo wörld\n");
    const dst = await sandbox.stat("linkdir");
    assert.equal(dst.isDirectory, true);
    assert.equal(dst.isSymbolicLink, true);
  });

  it("files: directory stat, exists, mkdir and rm", async () => {
    const st = await sandbox.stat("/workspace/a");
    assert.equal(st.isDirectory, true);
    assert.equal(st.isFile, false);
    assert.ok(st.mtime instanceof Date);
    assert.equal(await sandbox.exists("a"), true);
    assert.equal(await sandbox.exists("a/b/c.txt"), true);
    assert.equal(await sandbox.exists("nope"), false);
    assert.equal(await sandbox.exists("/proc/cpuinfo"), true);
    await assert.rejects(sandbox.stat("nope"), { code: "ENOENT" });
    await assert.rejects(sandbox.readFile("nope"), { code: "ENOENT" });
    await sandbox.mkdir("m/n/o", { recursive: true });
    await assert.rejects(sandbox.mkdir("m"));
    await assert.rejects(sandbox.rm("m"));
    await sandbox.rm("m", { recursive: true });
    await sandbox.rm("m", { recursive: true, force: true });
    assert.equal(await sandbox.exists("m"), false);
  });

  it("files: quoted, spaced, dashed and newline paths", async () => {
    const names = ['it\'s "quoted" & spaced.txt', "-leading-dash.txt", "new\nline.txt", "ü ✓.txt"];
    await sandbox.mkdir("weird dir/-x", { recursive: true });
    for (const name of names) {
      const p = `weird dir/-x/${name}`;
      await sandbox.writeFile(p, `content: ${name}`);
      assert.equal(await sandbox.readFile(p), `content: ${name}`);
      assert.equal((await sandbox.stat(p)).isFile, true);
      assert.equal(await sandbox.exists(p), true);
    }
    assert.deepEqual((await sandbox.readdir("weird dir/-x")).sort(), [...names].sort());
    await sandbox.rm("weird dir", { recursive: true });
    assert.equal(await sandbox.exists("weird dir"), false);
  });

  it("reads a pseudo-file the file API refuses (403 deny-list) over exec", async () => {
    assert.match(await sandbox.readFile("/proc/self/status"), /^Name:/m);
  });

  it("cove(): the pure adapter on the same VM, with live output", async () => {
    const chunks: string[] = [];
    const s = await cove(client, vm, { onOutput: (c) => chunks.push(c) }).createSandbox({
      id: "x",
    });
    const res = await s.exec("for i in 1 2 3; do echo $i; sleep 0.2; done");
    assert.equal(res.stdout, "1\n2\n3\n");
    assert.equal(chunks.join(""), "1\n2\n3\n");
    assert.ok(chunks.length >= 2, "output should arrive in several chunks");
  });

  it("a VM paused mid-exec rejects with SandboxDiedError", async () => {
    const died = assert.rejects(sandbox.exec("sleep 20"), SandboxDiedError);
    await sleep(1000);
    await client.vms.pause(vm);
    await died;
    await client.vms.waitForState(vm, ["paused"], { timeoutMs: 60_000 });
    await client.vms.resume(vm);
    await client.vms.waitForState(vm, ["running"], { timeoutMs: 60_000 });
  });
});
