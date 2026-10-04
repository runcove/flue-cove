/**
 * flue-cove bundles its own copy of `@cove/sdk`. An application may build its
 * `CoveClient` from another copy, whose error classes are different objects,
 * so `instanceof` against flue-cove's copy fails for every error it throws.
 * This builds a client from a second, separately extracted copy of the
 * vendored SDK and checks that the driver still classifies its errors.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { CoveAPIError } from "@cove/sdk";
import { CoveSandboxDriver } from "../src/driver.ts";
import { fileErrorStatus, filesFor } from "../src/files.ts";
import { isRateLimited } from "../src/retry.ts";
import { localShellClient } from "./helpers.ts";

const tarball = readdirSync(resolve("vendor")).find((f) => f.endsWith(".tgz"));
const tmp = mkdtempSync(join(tmpdir(), "flue-cove-sdk-copy-"));
// biome-ignore lint/suspicious/noExplicitAny: a module loaded at run time
let Other: any;

before(async () => {
  assert.ok(tarball, "no vendored SDK tarball");
  execFileSync("tar", ["-xzf", resolve("vendor", tarball), "-C", tmp]);
  Other = await import(pathToFileURL(join(tmp, "package", "dist", "index.js")).href);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const json = (status: number, code: string) =>
  new Response(JSON.stringify({ code, message: code }), {
    status,
    headers: { "content-type": "application/json" },
  });

function otherClient(respond: (url: URL, init?: RequestInit) => Response) {
  return new Other.CoveClient({
    baseUrl: "http://127.0.0.1:8091",
    token: "cvk_second_copy_test",
    fetch: (async (u: string | URL, init?: RequestInit) =>
      respond(new URL(String(u)), init)) as typeof fetch,
  });
}

describe("a CoveClient from a second @cove/sdk copy", () => {
  it("is really a different copy", () => {
    assert.notEqual(Other.CoveAPIError, CoveAPIError);
    assert.ok(!(new Other.RateLimitError(429, "x") instanceof CoveAPIError));
  });

  it("its errors are still classified by status and code", () => {
    assert.deepEqual(fileErrorStatus(new Other.FileNotRegularError(422, "m", "file_not_regular")), {
      status: 422,
      code: "file_not_regular",
    });
    assert.equal(isRateLimited(new Other.RateLimitError(429, "slow down")), true);
  });

  it("a 422 from it falls back to exec", async () => {
    const shell = localShellClient();
    const client = otherClient(() => json(422, "file_not_regular"));
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: filesFor(client) });
    const dir = mkdtempSync(join(tmp, "f-"));
    writeFileSync(join(dir, "f"), "via exec");
    assert.equal(await driver.readFile(join(dir, "f")), "via exec");
    assert.equal(shell.calls.length, 1);
  });

  it("a 429 from it is retried", async () => {
    let n = 0;
    const shell = localShellClient();
    const client = otherClient(() =>
      ++n < 2
        ? new Response(null, { status: 429 })
        : new Response(new Uint8Array([104, 105]), { headers: { "content-length": "2" } }),
    );
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: filesFor(client) });
    assert.equal(await driver.readFile("/f"), "hi");
    assert.equal(n, 2);
    assert.equal(shell.calls.length, 0);
  });

  it("a scope_denied from it sets the refusal memory", async () => {
    let gets = 0;
    const shell = localShellClient();
    const client = otherClient((_u, init) => {
      if ((init?.method ?? "GET") === "GET") gets++;
      return json(403, "scope_denied");
    });
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: filesFor(client) });
    const dir = mkdtempSync(join(tmp, "s-"));
    writeFileSync(join(dir, "f"), "x");
    await driver.readFile(join(dir, "f"));
    await driver.readFile(join(dir, "f"));
    assert.equal(gets, 1);
  });
});
