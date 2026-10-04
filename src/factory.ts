/**
 * Flue `SandboxFactory`s over Cove VMs.
 *
 * - {@link cove}: the pure adapter. Wraps a VM the application already has;
 *   never creates, starts or deletes anything.
 * - {@link coveVms}: the provisioning factory. Finds or creates one VM per
 *   Flue instance id and deletes it when the application calls `release`.
 *   Flue itself never tears a sandbox down; cleanup is the application's job.
 */
import {
  type CoveClient,
  type CoveClientOptions,
  NotFoundError,
  type SecretSpec,
  type VmState,
  type VmSummary,
} from "@cove/sdk";
import { type Sandbox, type SandboxFactory, sandboxFromDriver } from "@flue/runtime";
import { createCoveClient, filesFor, fromEnv } from "./client.ts";
import { type CoveDriverOptions, type CoveExecClient, CoveSandboxDriver } from "./driver.ts";
import type { CoveFiles } from "./files.ts";
import { withRateLimitRetry } from "./retry.ts";

/** The part of `CoveClient` the provisioning factory uses. */
export interface CoveProvisioningClient {
  vms: Pick<
    CoveClient["vms"],
    | "iter"
    | "create"
    | "get"
    | "waitForState"
    | "delete"
    | "start"
    | "resume"
    | "wake"
    | "exec"
    | "execWithSecrets"
  >;
}

export const DEFAULT_CWD = "/workspace";
export const DEFAULT_ID_TAG = "flue-id";

/** Options shared by both factories. */
export interface CoveSandboxOptions extends Pick<CoveDriverOptions, "onOutput" | "secrets"> {
  /** The sandbox's working directory, created with `mkdir -p` if missing. Default `/workspace`. */
  cwd?: string;
  /**
   * The file-API client. Defaults to the one registered for a client built by
   * `fromEnv()`/`createCoveClient()`. `false` moves all file content over exec.
   */
  files?: CoveFiles | false;
}

type ClientInput = CoveClient | CoveExecClient | CoveProvisioningClient | CoveClientOptions;

function isClientOptions(value: ClientInput): value is CoveClientOptions {
  return !("vms" in value);
}

function resolveFiles(client: object, files: CoveFiles | false | undefined): CoveFiles | undefined {
  if (files === false) return undefined;
  if (files) return files;
  return filesFor(client as CoveClient);
}

function driverOptions(files: CoveFiles | undefined, opts: CoveSandboxOptions): CoveDriverOptions {
  const out: CoveDriverOptions = {};
  if (files) out.files = files;
  if (opts.onOutput) out.onOutput = opts.onOutput;
  if (opts.secrets) out.secrets = opts.secrets;
  return out;
}

async function sandboxOn(driver: CoveSandboxDriver, cwd: string): Promise<Sandbox> {
  await driver.mkdir(cwd, { recursive: true });
  return sandboxFromDriver(driver, cwd);
}

/**
 * A `SandboxFactory` over an existing VM. Pass a `CoveClient` (ideally one
 * from `fromEnv()`, which brings the file API with it) or client options.
 * Every `createSandbox` call, whatever its id, targets `vmName`.
 */
export function cove(
  client: ClientInput,
  vmName: string,
  options: CoveSandboxOptions = {},
): SandboxFactory {
  const resolved = isClientOptions(client) ? createCoveClient(client) : client;
  const cwd = options.cwd ?? DEFAULT_CWD;
  return {
    async createSandbox(): Promise<Sandbox> {
      const files = resolveFiles(resolved, options.files);
      return sandboxOn(new CoveSandboxDriver(resolved, vmName, driverOptions(files, options)), cwd);
    },
  };
}

export interface CoveVmsOptions extends CoveSandboxOptions {
  /** The Cove client. Default: `fromEnv()`, built on first use. */
  client?: CoveClient | CoveProvisioningClient;
  /** Image to create from. Default: the server's default image. */
  image?: string;
  cpus?: number;
  memoryMb?: number;
  diskSizeGb?: number;
  /** Charge the VM to this team's quota instead of the key owner's. */
  team?: string;
  /**
   * Extra tags set on every VM at create. They also narrow the reuse lookup,
   * so two applications that share Flue ids but use different tags never
   * adopt each other's VMs.
   */
  tags?: Record<string, string>;
  /** Tag key that carries the Flue instance id. Default `flue-id`. */
  idTag?: string;
  /**
   * A leak backstop: Cove deletes the VM by itself after this long, even if
   * the application never calls `release`. Sent as `ttl_policy`.
   */
  expiry?: { maxLifetimeSecs: number };
  /** Secrets to inject into the VM at create (`initial_secrets`). */
  initialSecrets?: SecretSpec[];
  /** Find an existing VM tagged with the id before creating one. Default `true`. */
  reuse?: boolean;
  /** How long to wait for a VM to reach `running`. Default 300 000 ms. */
  readyTimeoutMs?: number;
  /** How long `release` waits for a deleted VM to disappear. Default 300 000 ms. */
  deleteTimeoutMs?: number;
}

export interface CoveVmsFactory extends SandboxFactory {
  /** Delete the VM for `id` and wait until Cove no longer lists it. */
  release(id: string): Promise<void>;
  /** `release` every id this factory has provisioned or adopted. */
  releaseAll(): Promise<void>;
  /** The VM name this factory resolved for `id`, if any. */
  vmName(id: string): string | undefined;
}

/** States a reusable VM can be brought back to `running` from. */
const REVIVE: Partial<Record<VmState, "start" | "resume" | "wake" | "wait">> = {
  running: "wait",
  creating: "wait",
  pooled: "wait",
  resuming: "wait",
  waking: "wait",
  pausing: "wait",
  stopping: "wait",
  force_stopping: "wait",
  checkpointing: "wait",
  hibernating: "wait",
  stopped: "start",
  paused: "resume",
  hibernated: "wake",
};

/** Prefer a VM that is already running, then one that is closest to it. */
const PREFERENCE: VmState[] = [
  "running",
  "resuming",
  "waking",
  "creating",
  "paused",
  "hibernated",
  "stopped",
];

// Cove's tag value rule: at most 256 characters, no control characters.
const hasControlChar = (value: string): boolean =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

function checkTagValue(key: string, value: string): void {
  if (value.length === 0 || value.length > 256 || hasControlChar(value)) {
    throw new TypeError(
      `cannot use ${JSON.stringify(value.slice(0, 40))} as the ${key} tag: Cove tag values are 1-256 characters with no control characters`,
    );
  }
}

/**
 * The provisioning factory: one Cove VM per Flue instance id.
 *
 * `createSandbox({ id })` finds a VM tagged `flue-id=<id>` (plus `tags`) and
 * brings it to `running`, or creates one, then returns a sandbox rooted at
 * `cwd`. Concurrent calls for the same id share one provisioning.
 *
 * Construct it ONCE (module scope or app setup), not inside the agent
 * function, so `releaseAll()` sees every VM it provisioned. `release(id)`
 * also works from a fresh factory: it finds the VM by tag.
 */
export function coveVms(options: CoveVmsOptions = {}): CoveVmsFactory {
  const idTag = options.idTag ?? DEFAULT_ID_TAG;
  const cwd = options.cwd ?? DEFAULT_CWD;
  const readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
  const deleteTimeoutMs = options.deleteTimeoutMs ?? 300_000;
  const extraTags = { ...(options.tags ?? {}) };
  for (const [k, v] of Object.entries(extraTags)) checkTagValue(k, v);

  let client: CoveClient | CoveProvisioningClient | undefined = options.client;
  const getClient = () => {
    client ??= fromEnv();
    return client;
  };

  const rl = <T>(fn: () => Promise<T>): Promise<T> => withRateLimitRetry(fn);
  const inflight = new Map<string, Promise<string>>();
  const resolved = new Map<string, string>();

  const tagsFor = (id: string): Record<string, string> => ({ [idTag]: id, ...extraTags });
  const tagFilter = (id: string): string[] =>
    Object.entries(tagsFor(id)).map(([k, v]) => `${k}=${v}`);

  async function findTagged(id: string): Promise<VmSummary[]> {
    return rl(async () => {
      const found: VmSummary[] = [];
      for await (const vm of getClient().vms.iter({ tag: tagFilter(id) })) {
        // Defensive: the server drops a malformed filter rather than failing,
        // so check the tags it returns (when it returns them).
        const tags = vm.tags;
        if (!tags || Object.entries(tagsFor(id)).every(([k, v]) => tags[k] === v)) found.push(vm);
      }
      return found;
    });
  }

  async function waitRunning(name: string): Promise<void> {
    const vm = await rl(() =>
      getClient().vms.waitForState(name, ["running", "failed", "deleted"], {
        timeoutMs: readyTimeoutMs,
      }),
    );
    if (vm.state !== "running") {
      throw new Error(`Cove VM ${name} did not reach running (state: ${vm.state})`);
    }
  }

  async function revive(vm: VmSummary): Promise<boolean> {
    const how = REVIVE[vm.state];
    if (!how) return false;
    const vms = getClient().vms;
    if (how === "wait") {
      const settled = await rl(() =>
        vms.waitForState(
          vm.name,
          ["running", "stopped", "paused", "hibernated", "failed", "deleted"],
          { timeoutMs: readyTimeoutMs },
        ),
      );
      if (settled.state === "running") return true;
      return revive({ ...vm, state: settled.state });
    }
    if (how === "start") await rl(() => vms.start(vm.name));
    else if (how === "resume") await rl(() => vms.resume(vm.name));
    else await rl(() => vms.wake(vm.name));
    await waitRunning(vm.name);
    return true;
  }

  async function provision(id: string): Promise<string> {
    checkTagValue(idTag, id);
    const vms = getClient().vms;
    if (options.reuse !== false) {
      const candidates = (await findTagged(id))
        .filter((vm) => REVIVE[vm.state] !== undefined)
        .sort((a, b) => rank(a.state) - rank(b.state));
      for (const vm of candidates) {
        if (await revive(vm)) return vm.name;
      }
    }
    const { name } = await rl(() =>
      vms.create({
        ...(options.image !== undefined ? { image: options.image } : {}),
        ...(options.cpus !== undefined ? { cpus: options.cpus } : {}),
        ...(options.memoryMb !== undefined ? { memory_mb: options.memoryMb } : {}),
        ...(options.diskSizeGb !== undefined ? { disk_size_gb: options.diskSizeGb } : {}),
        ...(options.team !== undefined ? { team: options.team } : {}),
        initial_tags: tagsFor(id),
        ...(options.expiry
          ? { ttl_policy: { max_lifetime_secs: options.expiry.maxLifetimeSecs } }
          : {}),
        ...(options.initialSecrets ? { initial_secrets: options.initialSecrets } : {}),
      }),
    );
    try {
      const vm = await rl(() =>
        vms.waitForState(name, ["running", "failed"], { timeoutMs: readyTimeoutMs }),
      );
      if (vm.state === "failed") throw new Error(`Cove VM ${name} failed to start`);
    } catch (err) {
      // We created it; don't leave a broken VM behind.
      await deleteAndWait(name).catch(() => undefined);
      throw err;
    }
    return name;
  }

  async function ensure(id: string): Promise<string> {
    let pending = inflight.get(id);
    if (!pending) {
      pending = provision(id).then((name) => {
        resolved.set(id, name);
        return name;
      });
      inflight.set(id, pending);
      const clear = () => {
        if (inflight.get(id) === pending) inflight.delete(id);
      };
      pending.then(clear, clear);
    }
    return pending;
  }

  async function deleteAndWait(name: string): Promise<void> {
    const vms = getClient().vms;
    try {
      await rl(() => vms.delete(name));
    } catch (err) {
      if (err instanceof NotFoundError) return;
      throw err;
    }
    const deadline = Date.now() + deleteTimeoutMs;
    for (;;) {
      try {
        const vm = await rl(() => vms.get(name));
        if (vm.state === "deleted") return;
      } catch (err) {
        if (err instanceof NotFoundError) return;
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error(`Cove VM ${name} was still present ${deleteTimeoutMs} ms after delete`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function release(id: string): Promise<void> {
    await inflight.get(id)?.catch(() => undefined);
    // The VM this factory resolved, plus any other VM carrying the id's tags
    // (another process, or an earlier run, may have created one).
    const names = new Set((await findTagged(id)).map((vm) => vm.name));
    const known = resolved.get(id);
    if (known) names.add(known);
    await Promise.all([...names].map(deleteAndWait));
    resolved.delete(id);
  }

  return {
    async createSandbox({ id }): Promise<Sandbox> {
      const name = await ensure(id);
      const c = getClient();
      const files = resolveFiles(c, options.files);
      return sandboxOn(new CoveSandboxDriver(c, name, driverOptions(files, options)), cwd);
    },
    release,
    async releaseAll(): Promise<void> {
      const ids = new Set([...resolved.keys(), ...inflight.keys()]);
      const results = await Promise.allSettled([...ids].map(release));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) {
        throw new AggregateError(
          failed.map((r) => r.reason),
          `releaseAll: ${failed.length} of ${ids.size} VMs could not be deleted`,
        );
      }
    },
    vmName: (id) => resolved.get(id),
  };
}

function rank(state: VmState): number {
  const i = PREFERENCE.indexOf(state);
  return i === -1 ? PREFERENCE.length : i;
}
