/**
 * Test doubles for the Cove client.
 *
 * `localShellClient` runs each exec's argv on this machine, the way the guest
 * agent does, and reproduces the Cove behaviours the adapter depends on, all
 * measured against a live server:
 * - output arrives as `stdout`/`stderr` events, then one terminal event;
 * - `timeout_secs` expiry kills the direct child only (its process group
 *   survives) and ends the stream with an `error` event
 *   `guest agent error: command timed out after <n>s`;
 * - an aborted request does not kill the guest command.
 */
import { spawn } from "node:child_process";
import {
  CoveAPIError,
  type ExecEvent,
  type ExecOptions,
  type ExecOutputDto,
  type ExecWithSecretsOptions,
} from "@cove/sdk";
import type { CoveExecClient } from "../src/driver.ts";

export interface ExecCall {
  vm: string;
  command: string[];
  timeoutSecs: number | undefined;
  signal: AbortSignal | undefined;
}

export interface SecretsCall {
  vm: string;
  command: string[];
  selector: ExecWithSecretsOptions["selector"];
  signal: AbortSignal | undefined;
}

/** A queue of async events fed from callbacks, consumed as an async iterator. */
function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const item = items.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = undefined;
      }
    },
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new DOMException("aborted", "AbortError");
}

export function localShellClient() {
  const calls: ExecCall[] = [];
  const secretsCalls: SecretsCall[] = [];

  async function* exec(
    vm: string,
    opts: ExecOptions,
    overrides?: { signal?: AbortSignal },
  ): AsyncGenerator<ExecEvent> {
    const signal = overrides?.signal;
    calls.push({ vm, command: opts.command, timeoutSecs: opts.timeoutSecs, signal });
    signal?.throwIfAborted();
    const [file, ...args] = opts.command;
    if (!file) throw new Error("empty argv");
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const events = channel<ExecEvent>();
    let timedOut = false;
    const timer =
      opts.timeoutSecs !== undefined
        ? setTimeout(() => {
            // Like the guest agent: kill the direct child and report at once,
            // even while descendants still hold the output pipes open.
            timedOut = true;
            child.kill("SIGKILL");
            events.push({
              kind: "error",
              error: `guest agent error: command timed out after ${opts.timeoutSecs}s`,
            });
            events.end();
          }, opts.timeoutSecs * 1000)
        : undefined;
    child.stdout
      .setEncoding("utf8")
      .on("data", (data: string) => events.push({ kind: "stdout", data }));
    child.stderr
      .setEncoding("utf8")
      .on("data", (data: string) => events.push({ kind: "stderr", data }));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      events.push({ kind: "exit", code: code ?? 137 });
      events.end();
    });
    const onAbort = () => events.end();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const ev of events.drain()) {
        if (signal?.aborted) throw abortError(signal);
        yield ev;
        if (ev.kind !== "stdout" && ev.kind !== "stderr") return;
      }
      if (signal?.aborted) throw abortError(signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function execWithSecrets(
    vm: string,
    opts: ExecWithSecretsOptions,
    overrides?: { signal?: AbortSignal },
  ): Promise<ExecOutputDto> {
    secretsCalls.push({
      vm,
      command: opts.command,
      selector: opts.selector,
      signal: overrides?.signal,
    });
    let stdout = "";
    let stderr = "";
    for await (const ev of exec(vm, { command: opts.command }, overrides)) {
      if (ev.kind === "stdout") stdout += ev.data;
      else if (ev.kind === "stderr") stderr += ev.data;
      else if (ev.kind === "exit") return { exit_code: ev.code, stdout, stderr };
    }
    throw new Error("no exit");
  }

  const client: CoveExecClient = { vms: { exec, execWithSecrets } };
  return { client, calls, secretsCalls };
}

/** A client whose exec stream is scripted: `script(call)` yields the events. */
export function scriptedClient(
  script: (call: ExecCall) => AsyncIterable<ExecEvent> | Iterable<ExecEvent>,
  fallback?: CoveExecClient,
) {
  const calls: ExecCall[] = [];
  async function* exec(
    vm: string,
    opts: ExecOptions,
    overrides?: { signal?: AbortSignal },
  ): AsyncGenerator<ExecEvent> {
    const call = {
      vm,
      command: opts.command,
      timeoutSecs: opts.timeoutSecs,
      signal: overrides?.signal,
    };
    calls.push(call);
    yield* script(call);
  }
  const client: CoveExecClient = {
    vms: {
      exec,
      execWithSecrets:
        fallback?.vms.execWithSecrets ??
        (async () => {
          throw new Error("not scripted");
        }),
    },
  };
  return { client, calls };
}

/**
 * The error `@cove/sdk` throws for an HTTP refusal, built by the SDK's own
 * mapping (`CoveAPIError.fromResponse`): `code` set means a JSON error body
 * (GET/PUT); omitted, a body-less HEAD answer, as `stat` sees it.
 */
export function apiError(status: number, code?: string, message = code ?? "refused"): CoveAPIError {
  return CoveAPIError.fromResponse(status, code === undefined ? undefined : { code, message });
}
