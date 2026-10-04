import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ConflictError,
  CoveAPIError,
  CoveConnectionError,
  type CreateVmRequest,
  type ExecEvent,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  type VmState,
  type VmSummary,
} from "@cove/sdk";
import { type CoveProvisioningClient, cove, coveVms } from "../src/factory.ts";
import type { CoveFiles } from "../src/files.ts";

interface FakeVm {
  name: string;
  state: VmState;
  tags: Record<string, string>;
}

/**
 * An in-memory Cove control plane: create is async (creating → running after
 * a tick), delete is async (deleting → gone), exec always exits 0 and is
 * recorded. `createOutcome` can make creates fail.
 */
function fakeCove(
  opts: {
    createOutcome?: "running" | "failed";
    createDelayMs?: number;
    /** Like the server: initial tags land only after the VM is created. `false` drops them. */
    applyTags?: boolean;
    /** The create was accepted, but the response never arrived. */
    createTransportError?: boolean;
    /** How long after `running` the server applies the initial tags (default 20 ms). */
    tagDelayMs?: number;
    tagSetFails?: boolean;
  } = {},
) {
  const vms = new Map<string, FakeVm>();
  const log: string[] = [];
  const creates: CreateVmRequest[] = [];
  const execs: Array<{ vm: string; command: string[] }> = [];
  let seq = 0;

  const get = async (name: string) => {
    const vm = vms.get(name);
    if (!vm) throw new NotFoundError(404, `no VM ${name}`, "vm_not_found");
    return { ...vm, image: "img" } as unknown as Awaited<
      ReturnType<CoveProvisioningClient["vms"]["get"]>
    >;
  };

  const client: CoveProvisioningClient = {
    vms: {
      async *iter(params) {
        log.push(`iter ${JSON.stringify(params?.tag)}`);
        const wanted = ([] as string[]).concat(params?.tag ?? []);
        for (const vm of vms.values()) {
          if (
            wanted.every((t) => vm.tags[t.slice(0, t.indexOf("="))] === t.slice(t.indexOf("=") + 1))
          ) {
            yield { name: vm.name, state: vm.state, image: "img", tags: vm.tags } as VmSummary;
          }
        }
      },
      async create(req) {
        creates.push(req);
        const name = req.name ?? `vm-${++seq}`;
        log.push(`create ${name}`);
        vms.set(name, { name, state: "creating", tags: {} });
        setTimeout(() => {
          const vm = vms.get(name);
          if (!vm) return;
          vm.state = opts.createOutcome ?? "running";
          // Like cove-server: the tags land a little after the VM reports running.
          if (vm.state === "running" && opts.applyTags !== false) {
            setTimeout(() => Object.assign(vm.tags, req.initial_tags ?? {}), opts.tagDelayMs ?? 20);
          }
        }, opts.createDelayMs ?? 5);
        if (opts.createTransportError) throw new CoveConnectionError("socket hang up");
        return { name };
      },
      get,
      async waitForState(name, states) {
        for (;;) {
          const vm = await get(name);
          if (states.includes(vm.state)) return vm;
          await sleep(2);
        }
      },
      async delete(name) {
        log.push(`delete ${name}`);
        const vm = vms.get(name);
        if (!vm) throw new NotFoundError(404, "gone", "vm_not_found");
        vm.state = "deleting";
        setTimeout(() => vms.delete(name), 10);
      },
      async start(name) {
        log.push(`start ${name}`);
        const vm = vms.get(name);
        if (vm) setTimeout(() => (vm.state = "running"), 2);
      },
      async resume(name) {
        log.push(`resume ${name}`);
        const vm = vms.get(name);
        if (vm) setTimeout(() => (vm.state = "running"), 2);
      },
      async wake(name) {
        log.push(`wake ${name}`);
        const vm = vms.get(name);
        if (vm) setTimeout(() => (vm.state = "running"), 2);
      },
      async *exec(vm, o): AsyncGenerator<ExecEvent> {
        execs.push({ vm, command: o.command });
        yield { kind: "exit", code: 0 };
      },
      async execWithSecrets() {
        return { exit_code: 0, stdout: "", stderr: "" };
      },
    },
    tags: {
      async set(name, key, value) {
        log.push(`tag ${name} ${key}=${value}`);
        if (opts.tagSetFails) throw new PermissionDeniedError(403, "no tags:write", "scope_denied");
        const vm = vms.get(name);
        if (!vm) throw new NotFoundError(404, "gone", "vm_not_found");
        vm.tags[key] = value;
      },
    },
  };
  return { client, vms, log, creates, execs };
}

const noFiles: CoveFiles = {
  stat: async () => ({ size: 0 }),
  download: async () => ({ size: 0, body: new Blob([]).stream() }),
  downloadBytes: async () => new Uint8Array(),
  upload: async (_vm, path) => ({ path, size: 0, mode: 0o644, sha256: "" }),
};

describe("coveVms: provisioning", () => {
  it("creates a VM tagged with the id, waits for running, and mkdir -p's the cwd", async () => {
    const fake = fakeCove();
    const factory = coveVms({
      client: fake.client,
      files: noFiles,
      image: "ubuntu-2604-slim",
      cpus: 2,
      memoryMb: 2048,
      diskSizeGb: 20,
      tags: { "flue-cove-test": "1" },
      expiry: { maxLifetimeSecs: 3600 },
      initialSecrets: [
        { name: "TOKEN", exposure: "env", lifetime: "persistent", value_b64: "eA==" },
      ],
    });
    const sandbox = await factory.createSandbox({ id: "conv-1" });
    assert.equal(sandbox.cwd, "/workspace");
    assert.deepEqual(fake.creates, [
      {
        image: "ubuntu-2604-slim",
        cpus: 2,
        memory_mb: 2048,
        disk_size_gb: 20,
        initial_tags: { "flue-id": "conv-1", "flue-cove-test": "1" },
        ttl_policy: { max_lifetime_secs: 3600 },
        initial_secrets: [
          { name: "TOKEN", exposure: "env", lifetime: "persistent", value_b64: "eA==" },
        ],
      },
    ]);
    assert.equal(fake.vms.get("vm-1")?.state, "running");
    assert.deepEqual(fake.execs[0]?.command, ["mkdir", "-p", "--", "/workspace"]);
    assert.equal(factory.vmName("conv-1"), "vm-1");
  });

  it("honours a custom cwd", async () => {
    const fake = fakeCove();
    const sandbox = await coveVms({
      client: fake.client,
      files: noFiles,
      cwd: "/srv/app",
    }).createSandbox({
      id: "x",
    });
    assert.equal(sandbox.cwd, "/srv/app");
    assert.deepEqual(fake.execs[0]?.command, ["mkdir", "-p", "--", "/srv/app"]);
  });

  it("a VM that ends in failed throws, and the failed VM is deleted", async () => {
    const fake = fakeCove({ createOutcome: "failed" });
    const factory = coveVms({ client: fake.client, files: noFiles });
    await assert.rejects(factory.createSandbox({ id: "bad" }), /failed/);
    assert.ok(fake.log.includes("delete vm-1"));
  });

  it("rejects an id Cove cannot store as a tag value", async () => {
    const fake = fakeCove();
    const factory = coveVms({ client: fake.client, files: noFiles });
    await assert.rejects(factory.createSandbox({ id: "a\nb" }), /flue-id/);
    await assert.rejects(factory.createSandbox({ id: "x".repeat(257) }), /flue-id/);
    assert.equal(fake.creates.length, 0);
  });
});

describe("coveVms: id dedupe and reuse", () => {
  it("concurrent calls with the same id share one create", async () => {
    const fake = fakeCove({ createDelayMs: 30 });
    const factory = coveVms({ client: fake.client, files: noFiles });
    const [a, b, c] = await Promise.all([
      factory.createSandbox({ id: "same" }),
      factory.createSandbox({ id: "same" }),
      factory.createSandbox({ id: "same" }),
    ]);
    assert.ok(a && b && c);
    assert.equal(fake.creates.length, 1);
  });

  it("different ids get different VMs", async () => {
    const fake = fakeCove();
    const factory = coveVms({ client: fake.client, files: noFiles });
    await Promise.all([factory.createSandbox({ id: "a" }), factory.createSandbox({ id: "b" })]);
    assert.equal(fake.creates.length, 2);
  });

  it("a later call reuses the VM found by tag, even from a fresh factory", async () => {
    const fake = fakeCove();
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "durable" });
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "durable" });
    assert.equal(fake.creates.length, 1);
  });

  it("matches on the extra tags too, so two apps sharing ids do not collide", async () => {
    const fake = fakeCove();
    await coveVms({ client: fake.client, files: noFiles, tags: { app: "one" } }).createSandbox({
      id: "i",
    });
    await coveVms({ client: fake.client, files: noFiles, tags: { app: "two" } }).createSandbox({
      id: "i",
    });
    assert.equal(fake.creates.length, 2);
  });

  it("starts a stopped VM, resumes a paused one and wakes a hibernated one", async () => {
    for (const [state, verb] of [
      ["stopped", "start"],
      ["paused", "resume"],
      ["hibernated", "wake"],
    ] as const) {
      const fake = fakeCove();
      fake.vms.set("old", { name: "old", state, tags: { "flue-id": "z" } });
      await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "z" });
      assert.ok(fake.log.includes(`${verb} old`), `${state} should ${verb}`);
      assert.equal(fake.creates.length, 0);
    }
  });

  it("ignores failed and deleting VMs and creates a new one", async () => {
    const fake = fakeCove();
    fake.vms.set("dead", { name: "dead", state: "failed", tags: { "flue-id": "z" } });
    fake.vms.set("going", { name: "going", state: "deleting", tags: { "flue-id": "z" } });
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "z" });
    assert.equal(fake.creates.length, 1);
  });

  it("reuse: false always creates", async () => {
    const fake = fakeCove();
    const factory = coveVms({ client: fake.client, files: noFiles, reuse: false });
    await factory.createSandbox({ id: "r" });
    await factory.createSandbox({ id: "r" });
    assert.equal(fake.creates.length, 2);
  });
});

describe("coveVms: tags and races", () => {
  it("waits for tags that arrive late, without calling setVmTag", async () => {
    const fake = fakeCove({ tagDelayMs: 150, tagSetFails: true });
    const factory = coveVms({ client: fake.client, files: noFiles, tags: { app: "x" } });
    await factory.createSandbox({ id: "late" });
    assert.deepEqual(fake.vms.get("vm-1")?.tags, { "flue-id": "late", app: "x" });
    assert.deepEqual(
      fake.log.filter((l) => l.startsWith("tag ")),
      [],
    );
  });

  it("sets the tags itself when they never arrive within the grace period", async () => {
    const fake = fakeCove({ applyTags: false });
    const factory = coveVms({
      client: fake.client,
      files: noFiles,
      tags: { app: "x" },
      tagGraceMs: 50,
    });
    await factory.createSandbox({ id: "t" });
    assert.deepEqual(fake.vms.get("vm-1")?.tags, { "flue-id": "t", app: "x" });
    assert.ok(fake.log.includes("tag vm-1 flue-id=t"));
  });

  it("does not re-set tags the server already applied", async () => {
    const fake = fakeCove();
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "t" });
    assert.deepEqual(
      fake.log.filter((l) => l.startsWith("tag ")),
      [],
    );
  });

  it("deletes the VM and throws when the tags cannot be set", async () => {
    const fake = fakeCove({ applyTags: false, tagSetFails: true });
    await assert.rejects(
      coveVms({ client: fake.client, files: noFiles, tagGraceMs: 50 }).createSandbox({ id: "t" }),
      /tag/,
    );
    assert.equal(fake.vms.size, 0);
  });

  it("a concurrent reviver's 409 from start/resume/wake is tolerated", async () => {
    const fake = fakeCove();
    fake.vms.set("old", { name: "old", state: "stopped", tags: { "flue-id": "z" } });
    fake.client.vms.start = async (name) => {
      const vm = fake.vms.get(name);
      if (vm) setTimeout(() => (vm.state = "running"), 5);
      throw new ConflictError(
        409,
        "invalid state transition: starting -> running",
        "invalid_state_transition",
      );
    };
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "z" });
    assert.equal(fake.creates.length, 0);
  });

  it("after a revive 409 it waits for a settled state and revives from there", async () => {
    const fake = fakeCove();
    fake.vms.set("old", { name: "old", state: "stopped", tags: { "flue-id": "h" } });
    fake.client.vms.start = async (name) => {
      // Someone else hibernates it meanwhile; the VM moves through hibernating.
      const vm = fake.vms.get(name);
      if (vm) {
        vm.state = "hibernating";
        setTimeout(() => (vm.state = "hibernated"), 10);
      }
      throw new ConflictError(409, "invalid state transition", "invalid_state_transition");
    };
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "h" });
    assert.ok(fake.log.includes("wake old"));
    assert.equal(fake.vms.get("old")?.state, "running");
    assert.equal(fake.creates.length, 0);
  });

  it("gives up reviving after a bounded number of 409s", async () => {
    const fake = fakeCove();
    fake.vms.set("old", { name: "old", state: "stopped", tags: { "flue-id": "b" } });
    let starts = 0;
    fake.client.vms.start = async () => {
      starts++;
      throw new ConflictError(409, "invalid state transition", "invalid_state_transition");
    };
    await assert.rejects(
      coveVms({ client: fake.client, files: noFiles, reuse: true }).createSandbox({ id: "b" }),
      /revive/,
    );
    assert.ok(starts > 1 && starts <= 4, `starts=${starts}`);
  });

  it("releaseAll also deletes a VM whose create response was lost", async () => {
    const fake = fakeCove({ createTransportError: true });
    const factory = coveVms({ client: fake.client, files: noFiles });
    await assert.rejects(factory.createSandbox({ id: "lost" }), /socket hang up/);
    await sleep(80); // the server finished creating and tagged it
    await factory.releaseAll();
    assert.equal(fake.vms.size, 0);
  });
});

describe("coveVms: release", () => {
  it("release(id) deletes the VM and waits until it is gone", async () => {
    const fake = fakeCove();
    const factory = coveVms({ client: fake.client, files: noFiles });
    await factory.createSandbox({ id: "r" });
    await factory.release("r");
    assert.equal(fake.vms.size, 0);
    assert.equal(factory.vmName("r"), undefined);
  });

  it("release(id) waits for an in-flight create first", async () => {
    const fake = fakeCove({ createDelayMs: 30 });
    const factory = coveVms({ client: fake.client, files: noFiles });
    const pending = factory.createSandbox({ id: "r" });
    await sleep(1);
    await factory.release("r");
    await pending.catch(() => undefined);
    assert.equal(fake.vms.size, 0);
  });

  it("release(id) finds the VM by tag when this factory never saw it", async () => {
    const fake = fakeCove();
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "elsewhere" });
    await coveVms({ client: fake.client, files: noFiles }).release("elsewhere");
    assert.equal(fake.vms.size, 0);
  });

  it("release(id) deletes every VM tagged with the id, not just the one it resolved", async () => {
    const fake = fakeCove();
    const factory = coveVms({ client: fake.client, files: noFiles });
    await factory.createSandbox({ id: "dup" });
    fake.vms.set("stray", { name: "stray", state: "running", tags: { "flue-id": "dup" } });
    await factory.release("dup");
    assert.equal(fake.vms.size, 0);
  });

  it("retries control-plane calls that Cove refuses with 429", async () => {
    const fake = fakeCove();
    const create = fake.client.vms.create;
    let n = 0;
    fake.client.vms.create = async (req) => {
      if (++n < 3) throw new RateLimitError(429, "HTTP 429: Too Many Requests");
      return create(req);
    };
    const del = fake.client.vms.delete;
    let d = 0;
    fake.client.vms.delete = async (name) => {
      if (++d < 2) throw new RateLimitError(429, "HTTP 429: Too Many Requests");
      return del(name);
    };
    const factory = coveVms({ client: fake.client, files: noFiles });
    await factory.createSandbox({ id: "busy" });
    await factory.release("busy");
    assert.equal(fake.creates.length, 1);
    assert.equal(fake.vms.size, 0);
  });

  it("retries a create whose server-generated name collides with a reserved name", async () => {
    const fake = fakeCove();
    const create = fake.client.vms.create;
    let n = 0;
    fake.client.vms.create = async (req) => {
      if (++n < 2) {
        throw new CoveAPIError(
          400,
          "HTTP 400: VM name invalid: name is reserved: a Warpgate target of that name already exists",
          "validation_failed",
        );
      }
      return create(req);
    };
    await coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "n" });
    assert.equal(n, 2);
  });

  it("does not retry other 400s", async () => {
    const fake = fakeCove();
    let n = 0;
    fake.client.vms.create = async () => {
      n++;
      throw new CoveAPIError(400, "HTTP 400: unknown image", "validation_failed");
    };
    await assert.rejects(
      coveVms({ client: fake.client, files: noFiles }).createSandbox({ id: "n" }),
      /unknown image/,
    );
    assert.equal(n, 1);
  });

  it("release of an unknown id is a no-op", async () => {
    const fake = fakeCove();
    await coveVms({ client: fake.client, files: noFiles }).release("never");
    assert.deepEqual(
      fake.log.filter((l) => l.startsWith("delete")),
      [],
    );
  });

  it("releaseAll deletes every VM this factory resolved, and only those", async () => {
    const fake = fakeCove();
    fake.vms.set("unrelated", { name: "unrelated", state: "running", tags: {} });
    const factory = coveVms({ client: fake.client, files: noFiles });
    await Promise.all([factory.createSandbox({ id: "a" }), factory.createSandbox({ id: "b" })]);
    await factory.releaseAll();
    assert.deepEqual([...fake.vms.keys()], ["unrelated"]);
  });

  it("a VM already gone counts as released", async () => {
    const fake = fakeCove();
    const factory = coveVms({ client: fake.client, files: noFiles });
    await factory.createSandbox({ id: "g" });
    fake.vms.clear();
    await factory.release("g");
  });
});

describe("cove(): the pure adapter", () => {
  it("adapts an existing VM and never creates or deletes", async () => {
    const fake = fakeCove();
    fake.vms.set("existing", { name: "existing", state: "running", tags: {} });
    const factory = cove(fake.client, "existing", { cwd: "/work", files: noFiles });
    const sandbox = await factory.createSandbox({ id: "anything" });
    assert.equal(sandbox.cwd, "/work");
    await sandbox.exec("true");
    assert.equal(fake.creates.length, 0);
    assert.deepEqual(
      fake.log.filter((l) => l.startsWith("delete")),
      [],
    );
    assert.ok(fake.execs.every((e) => e.vm === "existing"));
  });

  it("defaults the cwd to /workspace", async () => {
    const fake = fakeCove();
    const sandbox = await cove(fake.client, "v", { files: noFiles }).createSandbox({ id: "x" });
    assert.equal(sandbox.cwd, "/workspace");
  });

  it("accepts client options instead of a client", () => {
    assert.doesNotThrow(() => cove({ baseUrl: "https://cove.example.com", token: "cvk_x" }, "v"));
  });
});
