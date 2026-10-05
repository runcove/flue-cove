import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoveAPIError, RateLimitError, ServerError } from "@cove/sdk";
import { CoveSandboxDriver } from "../src/driver.ts";
import type { CoveFiles } from "../src/files.ts";
import {
  isRateLimited,
  MAX_RETRY_AFTER_MS,
  MAX_TOTAL_RETRY_WAIT_MS,
  retryDelayMs,
  withRateLimitRetry,
} from "../src/retry.ts";
import { apiError, scriptedClient } from "./helpers.ts";

const limited = () => new RateLimitError(429, "HTTP 429: Too Many Requests");

describe("Retry-After", () => {
  it("a 429 or 5xx with Retry-After waits that long, plus jitter under the base delay", () => {
    for (const err of [
      new RateLimitError(429, "slow down", "rate_limited", undefined, 2),
      new ServerError(503, "busy", "unavailable", undefined, 2),
    ]) {
      const ms = retryDelayMs(err, 0, 10);
      assert.ok(ms >= 2000 && ms < 2010, `${ms}`);
    }
  });

  it("a long Retry-After is capped", () => {
    const ms = retryDelayMs(new RateLimitError(429, "x", "rate_limited", undefined, 3600), 0, 10);
    assert.ok(ms >= MAX_RETRY_AFTER_MS && ms < MAX_RETRY_AFTER_MS + 10, `${ms}`);
  });

  it("without Retry-After, the exponential backoff applies", () => {
    const ms = retryDelayMs(limited(), 3, 10);
    assert.ok(ms >= 80 && ms < 90, `${ms}`);
    assert.ok(retryDelayMs(new Error("x"), 0, 10) < 20);
  });

  it("a 429 from another SDK copy is read by shape", () => {
    const foreign = Object.assign(new Error("HTTP 429"), {
      status: 429,
      code: "rate_limited",
      retryAfterSecs: 1,
    });
    const ms = retryDelayMs(foreign, 0, 10);
    assert.ok(ms >= 1000 && ms < 1010, `${ms}`);
  });

  it("withRateLimitRetry waits what Retry-After asks", async () => {
    let n = 0;
    const started = Date.now();
    await withRateLimitRetry(
      async () => {
        if (++n < 2) throw new RateLimitError(429, "x", "rate_limited", undefined, 1);
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    assert.equal(n, 2);
    assert.ok(Date.now() - started >= 950, `waited ${Date.now() - started} ms`);
  });

  it("a retry whose wait would pass the total budget is not made", async () => {
    let n = 0;
    const started = Date.now();
    await assert.rejects(
      withRateLimitRetry(
        async () => {
          n++;
          throw new RateLimitError(429, "x", "rate_limited", undefined, 5);
        },
        { baseDelayMs: 1, maxTotalDelayMs: 4000 },
      ),
      RateLimitError,
    );
    assert.equal(n, 1);
    assert.ok(Date.now() - started < 500);
    assert.ok(MAX_TOTAL_RETRY_WAIT_MS >= MAX_RETRY_AFTER_MS);
  });

  it("exec's stream retry waits what Retry-After asks", async () => {
    let n = 0;
    const { client } = scriptedClient(() => {
      if (++n < 2) throw new RateLimitError(429, "x", "rate_limited", undefined, 1);
      return [{ kind: "exit", code: 0, timedOut: false }];
    });
    const started = Date.now();
    await new CoveSandboxDriver(client, "vm").exec("true");
    assert.equal(n, 2);
    assert.ok(Date.now() - started >= 950, `waited ${Date.now() - started} ms`);
  });
});

describe("rate limiting (429)", () => {
  it("recognises the SDK's 429s, nothing else", () => {
    assert.equal(isRateLimited(limited()), true);
    assert.equal(isRateLimited(apiError(429)), true);
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
        { kind: "exit", code: 0, timedOut: false },
      ];
    });
    const res = await new CoveSandboxDriver(client, "vm").exec("echo hi");
    assert.equal(res.stdout, "hi");
  });

  it("file operations retry a 503 unavailable, then give up", async () => {
    let n = 0;
    const files: CoveFiles = {
      stat: async () => ({ size: 0, mode: undefined, mtime: undefined }),
      upload: async () => {
        n++;
        throw apiError(503, "unavailable", "guest agent timed out");
      },
      download: async () => ({
        size: 0,
        mode: undefined,
        mtime: undefined,
        body: new Blob([]).stream(),
      }),
      downloadBytes: async () => new Uint8Array(),
    };
    const { client } = scriptedClient(() => []);
    const driver = new CoveSandboxDriver(client, "vm", { files });
    await assert.rejects(driver.writeFile("/f", "x"), /guest agent timed out/);
    assert.equal(n, 4);
  });

  it("file operations retry a 429", async () => {
    let n = 0;
    const files: CoveFiles = {
      stat: async () => ({ size: 0, mode: undefined, mtime: undefined }),
      upload: async (_vm, path) => ({ path, size: 0, mode: 0o644, sha256: "" }),
      download: async () => ({
        size: 0,
        mode: undefined,
        mtime: undefined,
        body: new Blob([]).stream(),
      }),
      downloadBytes: async () => {
        if (++n < 2) throw apiError(429);
        return new TextEncoder().encode("data");
      },
    };
    const { client } = scriptedClient(() => []);
    const driver = new CoveSandboxDriver(client, "vm", { files });
    assert.equal(await driver.readFile("/f"), "data");
  });
});
