import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoveAPIError, RateLimitError } from "@cove/sdk";
import { CoveSandboxDriver } from "../src/driver.ts";
import { CoveFileError, type CoveFiles } from "../src/files.ts";
import { isRateLimited, withRateLimitRetry } from "../src/retry.ts";
import { scriptedClient } from "./helpers.ts";

const limited = () => new RateLimitError(429, "HTTP 429: Too Many Requests");

describe("rate limiting (429)", () => {
  it("recognises the SDK's and the file client's 429s, nothing else", () => {
    assert.equal(isRateLimited(limited()), true);
    assert.equal(isRateLimited(new CoveFileError(429, undefined, "slow down")), true);
    assert.equal(isRateLimited(new CoveAPIError(503, "busy")), false);
    assert.equal(isRateLimited(new Error("429")), false);
  });

  it("retries until the call succeeds", async () => {
    let n = 0;
    const out = await withRateLimitRetry(
      async () => {
        if (++n < 3) throw limited();
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    assert.equal(out, "ok");
    assert.equal(n, 3);
  });

  it("gives up after the attempt budget and rethrows the 429", async () => {
    let n = 0;
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          n++;
          throw limited();
        },
        { attempts: 4, baseDelayMs: 1 },
      ),
      RateLimitError,
    );
    assert.equal(n, 4);
  });

  it("does not retry other errors", async () => {
    let n = 0;
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          n++;
          throw new Error("boom");
        },
        { baseDelayMs: 1 },
      ),
      /boom/,
    );
    assert.equal(n, 1);
  });

  it("stops waiting when the signal aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          throw limited();
        },
        { baseDelayMs: 10_000, signal: ac.signal },
      ),
      { name: "AbortError" },
    );
  });

  it("exec retries a 429 that arrives before the stream starts", async () => {
    let n = 0;
    const { client } = scriptedClient(() => {
      if (++n < 3) throw limited();
      return [
        { kind: "stdout", data: "hi" },
        { kind: "exit", code: 0 },
      ];
    });
    const res = await new CoveSandboxDriver(client, "vm").exec("echo hi");
    assert.equal(res.stdout, "hi");
  });

  it("file operations retry a 503 unavailable, then give up", async () => {
    let n = 0;
    const files: CoveFiles = {
      stat: async () => ({ size: 0 }),
      upload: async () => {
        n++;
        throw new CoveFileError(503, "unavailable", "guest agent timed out");
      },
      download: async () => new Uint8Array(),
    };
    const { client } = scriptedClient(() => []);
    const driver = new CoveSandboxDriver(client, "vm", { files });
    await assert.rejects(driver.writeFile("/f", "x"), /guest agent timed out/);
    assert.equal(n, 4);
  });

  it("file operations retry a 429", async () => {
    let n = 0;
    const files: CoveFiles = {
      stat: async () => ({ size: 0 }),
      upload: async (_vm, path) => ({ path, size: 0, mode: 0o644, sha256: "" }),
      download: async () => {
        if (++n < 2) throw new CoveFileError(429, undefined, "slow down");
        return new TextEncoder().encode("data");
      },
    };
    const { client } = scriptedClient(() => []);
    const driver = new CoveSandboxDriver(client, "vm", { files });
    assert.equal(await driver.readFile("/f"), "data");
  });
});
