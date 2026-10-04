import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { inspect } from "node:util";
import { CoveClient } from "@cove/sdk";
import { createCoveClient, filesFor, fromEnv } from "../src/client.ts";

const KEY = "cvk_env_test_secret_value";
const dir = mkdtempSync(join(tmpdir(), "flue-cove-env-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function noKey(value: unknown) {
  const text = `${String(value)} ${JSON.stringify(value)} ${inspect(value, { depth: 5, showHidden: true })}`;
  assert.doesNotMatch(text, /cvk_env_test/);
}

describe("fromEnv", () => {
  it("builds a client from COVE_API_URL + COVE_API_KEY", () => {
    const client = fromEnv({ COVE_API_URL: "http://127.0.0.1:8091", COVE_API_KEY: KEY });
    assert.ok(client instanceof CoveClient);
    noKey(client);
    assert.ok(filesFor(client), "a fromEnv client carries a file-API client");
  });

  it("reads the key from COVE_API_KEY_FILE, trimming the trailing newline", async () => {
    const file = join(dir, "api_key");
    writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    let seen = "";
    const client = fromEnv(
      { COVE_API_URL: "https://cove.example.com", COVE_API_KEY_FILE: file },
      {
        fetch: (async (_u: unknown, init?: RequestInit) => {
          seen = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    );
    await client.meta.whoami();
    assert.equal(seen, `Bearer ${KEY}`);
    noKey(client);
  });

  it("COVE_API_KEY wins over COVE_API_KEY_FILE", () => {
    assert.doesNotThrow(() =>
      fromEnv({
        COVE_API_URL: "https://cove.example.com",
        COVE_API_KEY: KEY,
        COVE_API_KEY_FILE: join(dir, "does-not-exist"),
      }),
    );
  });

  it("names the missing variable", () => {
    assert.throws(() => fromEnv({ COVE_API_KEY: KEY }), /COVE_API_URL/);
    assert.throws(
      () => fromEnv({ COVE_API_URL: "https://cove.example.com" }),
      /COVE_API_KEY or COVE_API_KEY_FILE/,
    );
  });

  it("an unreadable key file is reported by path, never by content", () => {
    assert.throws(
      () => fromEnv({ COVE_API_URL: "https://x.example", COVE_API_KEY_FILE: join(dir, "missing") }),
      (err: unknown) => {
        assert.match(String(err), /COVE_API_KEY_FILE/);
        noKey(err);
        return true;
      },
    );
  });

  it("an empty key file is refused", () => {
    const file = join(dir, "empty_key");
    writeFileSync(file, "\n");
    assert.throws(
      () => fromEnv({ COVE_API_URL: "https://x.example", COVE_API_KEY_FILE: file }),
      /empty/,
    );
  });

  it("errors from a bad URL never carry the key", () => {
    assert.throws(
      () => fromEnv({ COVE_API_URL: "http://cove.example.com", COVE_API_KEY: KEY }),
      (err: unknown) => {
        noKey(err);
        return true;
      },
    );
  });
});

describe("createCoveClient", () => {
  it("registers a file-API client for the CoveClient it returns", () => {
    const client = createCoveClient({ baseUrl: "https://cove.example.com", token: KEY });
    assert.ok(filesFor(client));
    noKey(client);
  });

  it("a CoveClient built elsewhere has no file-API client", () => {
    const client = new CoveClient({ baseUrl: "https://cove.example.com", token: KEY });
    assert.equal(filesFor(client), undefined);
  });
});
