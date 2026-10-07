# flue-cove

Run [Flue](https://flueframework.com/) agents' sandboxed work on Cove microVMs.

Flue agents do their shell and file work through a *sandbox*. `flue-cove` is a
sandbox adapter that puts that work in a Cove VM: a full Linux machine per
conversation, reached over the Cove API with the Cove TypeScript SDK
(`@runcove/sdk`).

- `coveVms(options)` is a provisioning `SandboxFactory`. It finds or creates
  one VM per Flue instance id and deletes it when you call `release`.
- `cove(client, vmName, { cwd })` is a pure adapter over a VM you already have.
  It never creates or deletes anything.
- `CoveSandboxDriver` implements Flue's `SandboxDriver`, for custom wiring.
- `fromEnv()` builds a `CoveClient` from environment variables.
- `CoveClient` is re-exported from the `@runcove/sdk` the adapter depends on.
  A client built from another copy of the SDK works too: the adapter recognises its errors
  by their HTTP `status` and API `code`, not by class.

It implements Flue's [Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
(`@flue/runtime` 2.2.x) and imports only public `@flue/runtime` exports.

## Install

Install `@runcove/flue` from npm, next to `@flue/runtime` (a peer
dependency). It brings the Cove TypeScript SDK, `@runcove/sdk`, as a
dependency:

```sh
npm install @runcove/flue @flue/runtime@2.2.2
```

To run an unreleased change, install it from a clone or from a packed tarball:

```sh
# from a clone
git clone <this repository> flue-cove
cd flue-cove && npm ci && npm run build
cd ../my-flue-app && npm install --install-links ../flue-cove @flue/runtime@2.2.2

# or from a tarball
cd flue-cove && TGZ=$(npm pack | tail -n 1)    # its last line is the tarball's file name
cd ../my-flue-app && npm install "../flue-cove/$TGZ" @flue/runtime@2.2.2
```

From a clone, install a *copy*, never a symlink: a plain `npm install ../flue-cove` links
the clone, and the adapter then loads the clone's own development copy of
`@flue/runtime`. Its `SandboxDiedError` and `SandboxOperationUnsupportedError`
are then not `instanceof` your app's `FlueError`, and Flue classifies sandbox
errors with `instanceof`. `--install-links` (or `install-links=true` in your
`.npmrc`, as `examples/repo-agent` has) or the tarball avoids that.

Node.js 22.19 or newer, ESM only (Flue's own requirements).

**Cove server.** The file API (`HEAD`/`GET`/`PUT /api/vms/{name}/files`) needs
a server newer than `cove-server` 0.33.2, whose tag has no file routes. A
pre-release build with them may still report version 0.33.2. Older servers
work too, more slowly: the adapter notices that the route is missing and runs
every file operation over exec. A newer server also names a `HEAD` error's code
(`X-Cove-Error-Code`) and sends `Last-Modified`, so `stat` tells a missing
VM from a missing file and returns `mtime`.

## Configuration

`fromEnv()`, and `coveVms()` when you pass no `client`, read:

| Variable | Meaning |
|---|---|
| `COVE_API_URL` | Base URL of the Cove API (the server's bearer-key listener), e.g. `https://<cove-host>` |
| `COVE_API_KEY` | A Cove API key (`cvk_…`) |
| `COVE_API_KEY_FILE` | Or: a file holding the key (read in-process; keeps the key out of the environment and off command lines) |

The key never appears in errors, logs or a serialized client. Plain `http://`
is refused unless the host is loopback.

Scopes the key needs (each is the `x-required-scope` of the API operations
named):

| Scope | Operations | Used for |
|---|---|---|
| `vms:read` | `listVms`, `getVm` | finding a VM by tag, waiting for states, reading its tags |
| `vms:write` | `createVm`, `startVm`, `resumeVm`, `wakeVm`, `deleteVm` | provisioning and `release` (`initial_tags` and `initial_secrets` ride on `createVm`) |
| `vms:exec` | `execVm`, `execVmWithSecrets` | every command, and the exec fallbacks for files |
| `tags:write` | `setVmTag` | only if Cove has not applied a new VM's initial tags within `tagGraceMs` (see below); normally never called |
| `files:read` | `statVmFile`, `downloadVmFile` | reads and stats |
| `files:write` | `uploadVmFile` | writes |

`cove()` needs only `vms:exec` and `files:*`. A key without `files:read` or
`files:write` still works: on the first 403 `scope_denied` the driver moves
that direction (reads and stats, or writes) over exec and stops calling the
API for it. `initialSecrets` additionally needs secrets enabled on the server.

## Quick example

```ts
// src/sandbox.ts — build the factory ONCE, at module scope
import { coveVms } from "@runcove/flue";

export const vms = coveVms({
  cpus: 2,
  memoryMb: 4096,
  tags: { app: "my-app" },
  expiry: { maxLifetimeSecs: 2 * 60 * 60 }, // Cove's own backstop against leaks
});
```

```ts
// src/agents/assistant.ts
"use agent";
import { useModel, useSandbox } from "@flue/runtime";
import { vms } from "../sandbox.ts";

export function Assistant() {
  useModel("anthropic/claude-sonnet-4-6");
  useSandbox(vms); // the agent's bash/read/write/edit/grep/glob tools now run in the VM
  return "You are a helpful engineer with a Linux machine.";
}
```

```ts
// when a conversation is over (an HTTP route, a job, a CLI)
await vms.release(conversationId);
// on shutdown
await vms.releaseAll();
```

To adapt a VM you manage yourself:

```ts
import { cove, fromEnv } from "@runcove/flue";
useSandbox(cove(fromEnv(), "my-existing-vm", { cwd: "/workspace" }));
```

`examples/repo-agent/` is a complete Flue project: an agent that clones a
public repository into its VM, runs the tests and summarises them, plus the
`release` script and a model-free smoke test. Its `smoke` and `release`
scripts load `.env` the way `flue run` does; run `release` with the same
`REPO_AGENT_TAGS` as the agent (or fewer), since the lookup matches every
configured tag. The example installs `@runcove/flue` as a copy (`install-links`),
built by the root package's `prepare` script, which needs the root's dev
dependencies: run `npm ci` at the repository root first, then `npm ci` in
`examples/repo-agent`. Reinstall the example (`npm ci` there) after changing
the adapter.

### Options

`coveVms(options)`: `client` (default `fromEnv()`), `image`, `cpus`,
`memoryMb`, `diskSizeGb`, `team`, `tags`, `idTag` (default `flue-id`),
`expiry: { maxLifetimeSecs }`, `initialSecrets`, `reuse` (default `true`),
`readyTimeoutMs` (overall budget for a VM to become ready), `deleteTimeoutMs`, `tagGraceMs`, and the options shared with `cove()`:

- `cwd`: the sandbox's working directory, created with `mkdir -p` (default `/workspace`);
- `onOutput(chunk, stream)`: called with each output chunk as Cove streams it;
- `secrets`: an `InjectSelector` (`{ kind: "all" }`, `{ kind: "subset", names }`,
  `{ kind: "setup_tag", tag }`). Every `exec` then goes through
  `execWithSecrets`, which Cove buffers (no live output, no `onOutput`) and
  gives no server-side deadline; the adapter enforces `timeoutMs` itself;
- `files`: a file-API client (default: the client's own `client.vms.files`),
  or `false` to move all file content over exec.

## Lifecycle and cleanup

Flue never creates or destroys provider resources; the application does.

- `createSandbox({ id })` looks for a VM tagged `flue-id=<id>` (and your
  `tags`). A running VM is reused, a stopped one started, a paused one resumed,
  a hibernated one woken; failed or deleting VMs are ignored. Otherwise it
  creates one with those tags and waits for `running` (a VM that ends in
  `failed` is deleted and the call throws). So a conversation keeps its
  filesystem across messages and restarts.
- Cove applies the tags only after the whole create has finished, which is
  shortly after the VM already reports `running` (0.1-0.2 s on a test server),
  and only best effort. Until then the VM cannot be found by tag. The factory
  waits up to `tagGraceMs` (default 30 s) for them to appear. Only if some are
  still missing then does it set them itself, which needs `tags:write`; if
  that fails, it deletes the VM and throws. A key without `tags:write` works
  as long as Cove applies the tags, which it normally does.
- Concurrent calls with the same id share one provisioning. Two *processes*
  racing on a brand-new id can still create two VMs; `release(id)` deletes
  every VM carrying the id's tags, so neither leaks once both are tagged.
- Because tags arrive late, `release(id)` (and `releaseAll()`) cannot see a VM
  that is still being created, and a create whose response was lost leaves a
  VM whose name nobody knows. Always set `expiry`: it is the backstop for
  every VM the factory cannot find.
- `release(id)` deletes the id's VMs and waits until Cove no longer lists them.
  It finds them by tag, so it works from a fresh process.
- `releaseAll()` releases every id this factory instance provisioned or
  adopted. Build the factory once, outside the agent function, or it cannot
  know them: Flue re-renders the agent function many times.
- `expiry` sets Cove's `ttl_policy`: Cove deletes the VM itself after that long,
  whether or not anyone calls `release`. Recommended for every factory.
- `cove()` never creates, starts, stops or deletes.

## How operations map onto Cove

| Flue | Cove |
|---|---|
| `exec` | streaming `vms.exec`; the command runs under `bash` when the guest has it, else `sh`; `cwd`/`env` become a quoted `cd`/`export` prefix (env names are validated); `timeoutMs` → `timeout_secs = ceil(ms / 1000)` |
| `readFile`, `readFileBuffer` | file API `GET`; exec fallback (`base64`) |
| `writeFile` | file API `PUT` (atomic in the guest); exec fallback (chunked `base64`, then `cat >` so symlinks are written through) |
| `stat`, `exists` | file API `HEAD`; exec fallback (`stat -L`, `test -L`, `test -e`) |
| `readdir`, `mkdir`, `rm` | exec (`mkdir [-p] --`, `rm [-r][-f] --`, a NUL-separated listing) |

The file API refuses some paths a shell can still serve, and those fall back
to exec: a symlink anywhere in the path or a non-regular target (422
`file_not_regular`), a path on the API's deny-list such as `/proc` (403
`file_path_denied`), a guest agent that predates the API (409
`guest_agent_too_old`), a key without `files:read`/`files:write` (403
`scope_denied`), a path the API's syntax rules reject (400), and a server
without the file API at all (below). On
Ubuntu `/bin`, `/lib` and `/sbin` are symlinks, so paths under them always use
the fallback. 404 is `ENOENT`. 413 `file_too_large` is an error for
`readFile`/`readFileBuffer`/`writeFile`; `stat` and `exists` fall back to exec
on it, since a shell can still stat a file too big to transfer. A VM that is not running or is gone becomes Flue's
`SandboxDiedError`, as does a `paused` event in the middle of an exec. 429
(rate limit) and file-API 503 (`unavailable`) are retried, waiting for the
server's `Retry-After` when it sends one (at most 10 s a wait, 30 s in all
for one call), else with backoff. A
`200` the SDK cannot trust (no readable `Content-Length`, or a
`Content-Encoding` such as gzip added by a proxy) also sends `stat`, `exists`
and reads to exec. A download whose body stops short of its `Content-Length`
(`DownloadTruncatedError`) fails and is never retried over exec: it is never
taken for a complete file.

A server that predates the file API answers every `/files` request with its
router's bare 404, which has no error code. The real route always names what
is missing on a `GET` or `PUT` (`vm_not_found` or `file_not_found`), so a
codeless 404 there means "no route". A `HEAD` error never has a body; a
current server names its code in `X-Cove-Error-Code`, but one that predates
that header sends a bare 404 for a missing file or VM too. So the first bare
`HEAD` 404 is checked once per driver with a probe: `HEAD` of the
path `/`, which the route refuses with 400 before touching the guest and an
old server answers with the same bare 404. Only those two answers are
recorded. Anything else (no answer, a 429 or 5xx after the retries, a 401 or
403 from the auth gate) decides nothing, and the next bare `HEAD` 404 probes
again. Once the route is known to be missing, every file operation runs over
exec. `CoveSandboxDriver.fileRoute`
reports what the driver found.

Every option Flue defines (`exec`'s `cwd`, `env`, `timeoutMs`, `signal`;
`mkdir`'s `recursive`; `rm`'s `recursive` and `force`) is honoured exactly. An
option the adapter does not know is refused with Flue's
`SandboxOperationUnsupportedError` before anything runs, never ignored.

Paths reach every helper command as separate arguments (`"$1"`), after `--`
where the tool takes options, so spaces, quotes, newlines and leading dashes
are safe.

## Limitations

These were measured against a Cove server built after 0.33.2 that includes the file API (it reports version 0.33.2).

- **Shell.** Commands run under `bash` when the guest has it (so `[[ ]]` and
  `set -o pipefail` work), otherwise under `sh`.
- **No streaming in Flue's contract.** `exec` resolves with the collected
  output; use `onOutput` to show it live.
- **Timeouts.** Cove ends an expired `timeout_secs` with an error event
  (`guest agent error: command timed out after <n>s`), not an exit code. The
  adapter turns that into `exitCode: 124` with a `[flue-cove]` note on stderr,
  the `timeout(1)` convention. Cove kills only the command's direct child;
  anything it started in the background lives on. The adapter therefore runs
  each command as the leader of its own process group (`setsid`, when the
  guest has it) and kills the whole group on a timeout.
- **Abort.** Aborting the request does not stop the command in the guest; Cove
  lets it run to completion. The adapter forwards `signal` (which closes the
  stream) and then kills the command's process group with a second exec. Flue
  rejects the caller with `AbortError` at once, as its contract requires; the
  kill lands a few hundred milliseconds later. Without `setsid` in the guest
  only the top process is killed. A command that has not recorded its pid
  yet when the kill lands (the abort raced the request itself) exits without
  running anything once it starts. A recorded pid that has since been reused
  by another process is left alone.
- **Non-UTF-8 output.** If a command writes bytes that are not valid UTF-8,
  Cove drops that command's output (and the command may then die of
  `SIGPIPE`). The adapter's own transfers use base64, so file content is safe;
  output of your own commands is not, so pipe binary output through `base64`.
- **`stat` over the file API has `mtime` only from a current server**: it
  comes from `Last-Modified`, in whole seconds. A server that predates it
  sends size and mode only, and `mtime` is then left out rather than
  invented; it is always present when the exec fallback answers
  (directories, symlinks).
- **Size cap.** The file API refuses files above the server's `[files]
  max_bytes` (100 MiB by default) with 413. Reads and writes of such a file
  fail; there is no exec fallback for content (`stat`/`exists` still work).
- **Timeouts on transfers.** A client's `timeoutMs` does not cut file
  transfers short. Each upload gets its own deadline from its size: twice
  the time the server allows at its 256 KiB/s floor, plus a minute, and
  never under three minutes. For downloads, the SDK applies `timeoutMs` to
  the response headers only.
- **File-API writes** create files owned by root, keep an existing file's mode
  and use `0644` for a new one.
- **Rate limit.** Cove limits each source address (30 requests/s by default).
  The adapter retries 429s, but many agents behind one address will be slowed.
- **`execWithSecrets`** is buffered and has no server-side deadline (see `secrets` above).
- **Liveness.** A VM paused or stopped mid-exec is detected through Cove's
  `paused` event. A file transfer in flight when the VM dies ends with an error
  from the server; there is no separate liveness poll.

## Testing

| Command | What it proves |
|---|---|
| `npm test` | Unit tests with no Cove server: quoting through a real `sh`, env-name validation, timeout rounding, every exec terminal event (`exit`, `error`, `paused`, timeout → 124), abort and timeout killing the process group, every file-API status and its fallback (a filesystem-backed fake with Cove's rules that throws the SDK's own errors), the SDK's file methods through a real `CoveClient` against a mock `fetch` (path encoding, error classes and codes, short bodies), 429/503 retries, id dedupe and reuse, release, and that the API key never leaks into errors or serialized objects |
| `npm run test:integration` | Against a live Cove server (skipped without `COVE_API_URL` and a key): creates a VM through `coveVms`, runs every Sandbox operation through Flue's `sandboxFromDriver` (text, binary and multi-MiB files, symlinked paths, directories, quoted/dashed/newline paths, `/proc`, the timeout, abort, a non-zero exit, `cwd` and `env`, a VM paused mid-exec), checks reuse by id, and deletes the VM in `after` |
| `cd examples/repo-agent && npm ci && npm run smoke` (after `npm ci` at the repository root) | The example agent through Flue's real runtime (`start`, `init`, `dispatch`) on a real VM, with Pi's faux model provider replaying a scripted session of `bash`/`write`/`read` tool calls, then `release`; also checks that the adapter's errors are `instanceof` the app's own `FlueError` |

Tag test VMs so they are easy to find: the integration test tags its VM
`flue-cove-test=1`, and the example takes extra tags from `REPO_AGENT_TAGS`.

**Not exercised here:** a real model driving the agent. No model key is used
in this repository's verification, so `flue run` with a live LLM, and how a
model uses these tools, are untested. `flue run` itself was checked up to the
model call (it loads the agent and provisions the VM, then stops at "Provider
is not configured").

## Development

```sh
npm ci
npm run lint           # biome
npm run typecheck      # tsc --noEmit (src, test)
npm test               # unit tests (node --test, TypeScript run directly by Node)
npm run build          # tsc → dist/
COVE_API_URL=https://<cove-host> COVE_API_KEY_FILE=~/.cove/api_key npm run test:integration
```

File transfer uses the SDK's `client.vms.files` (`stat`, `download`,
`downloadBytes`, `upload`). `src/files.ts` wraps it in a small `CoveFiles`
interface, so tests can hand the driver a fake, and re-exports the SDK's file
error classes (`FileTooLargeError`, `FilePathDeniedError`,
`VmFileNotFoundError`, `FileNotRegularError`, `UnavailableError`,
`DownloadTruncatedError`). The driver classifies a failure only by its HTTP
status and API `code` (`fileErrorStatus`), never by its message. A key
without `files:read`/`files:write` is the SDK's plain `PermissionDeniedError`
with code `scope_denied`. A `HEAD` error has no body: a current server sends
its code in `X-Cove-Error-Code`, which the SDK reads, and from an older one
`stat`'s 403 and 404 carry no code. The SDK's own request deadline is
`CoveTimeoutError` and a client misconfiguration `CoveConfigError`. The SDK
does not retry 429s; the driver does, using the `Retry-After` the SDK exposes
as `retryAfterSecs`.

Changes, including breaking ones, are listed in [CHANGELOG.md](CHANGELOG.md).

## Where it is developed

The adapter is developed inside the Cove repository, as `integrations/flue`,
where its checks run with Cove's own. This repository is its public copy,
updated from there commit by commit.

## License

Apache License 2.0. See [LICENSE](LICENSE).
