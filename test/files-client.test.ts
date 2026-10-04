import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CoveFileError,
  createFetchFiles,
  DownloadTruncatedError,
  FileNotRegularError,
  FilePathDeniedError,
  FileTooLargeError,
  fileErrorStatus,
  UnavailableError,
  VmFileNotFoundError,
} from "../src/files.ts";

const KEY = "cvk_unit_test_secret_value";

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  redirect?: RequestRedirect;
}

/** A fetch double that records each request and answers with `respond`. */
function mockFetch(respond: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(init?.body instanceof Uint8Array ? { body: init.body } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    seen.push(req);
    return respond(req);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function files(respond: (req: Seen) => Response | Promise<Response>) {
  const m = mockFetch(respond);
  return {
    ...m,
    client: createFetchFiles({ baseUrl: "http://127.0.0.1:8091/", token: KEY, fetch: m.fetchImpl }),
  };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Uint8Array(parts);
    parts.push(...value);
  }
}

const jsonError = (status: number, code: string, message = `${code} happened`) =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Assert the thrown error is a CoveFileError and carries no credential. */
async function rejectsWith(p: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof CoveFileError, `expected CoveFileError, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    assert.doesNotMatch(JSON.stringify(err), /cvk_/);
    assert.doesNotMatch(String(err.stack), /cvk_/);
    assert.doesNotMatch(err.message, /cvk_/);
    return true;
  });
}

describe("createFetchFiles: requests", () => {
  it("HEADs the files route with the bearer key, percent-encoding the path", async () => {
    const { client, seen } = files(
      () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": "12", "x-cove-file-mode": "0755" },
        }),
    );
    const info = await client.stat("my-vm", "/root/a b+c/ü's.txt");
    assert.deepEqual(info, { size: 12, mode: 0o755 });
    const req = seen[0];
    assert.ok(req);
    assert.equal(req.method, "HEAD");
    assert.equal(req.url.pathname, "/api/vms/my-vm/files");
    assert.equal(req.url.searchParams.get("path"), "/root/a b+c/ü's.txt");
    // A space must travel as %20 and a plus as %2B: the server applies only
    // percent-decoding, so `+` would be read as a literal plus.
    assert.match(req.url.search, /a%20b%2Bc/);
    assert.equal(req.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(req.redirect, "error");
  });

  it("encodes the VM name as one path segment", async () => {
    const { client, seen } = files(() => new Response(null, { status: 200 }));
    await client.stat("we/ird", "/x");
    assert.equal(seen[0]?.url.pathname, "/api/vms/we%2Fird/files");
  });

  it("downloads the bytes exactly, asking for no content encoding", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    const { client, seen } = files(
      () => new Response(bytes, { status: 200, headers: { "content-length": "7" } }),
    );
    assert.deepEqual(await client.downloadBytes("vm", "/bin.dat"), bytes);
    assert.equal(seen[0]?.headers.get("accept-encoding"), "identity");
  });

  it("download() streams: size and mode up front, then the body", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const { client } = files(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-length": "3", "x-cove-file-mode": "0600" },
        }),
    );
    const dl = await client.download("vm", "/f");
    assert.equal(dl.size, 3);
    assert.equal(dl.mode, 0o600);
    assert.deepEqual(await readAll(dl.body), bytes);
  });

  it("uploads raw bytes with PUT, octet-stream and the optional mode", async () => {
    const { client, seen } = files(
      () =>
        new Response(JSON.stringify({ path: "/x", size: 3, mode: 0o600, sha256: "ab" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const out = await client.upload("vm", "/x", new Uint8Array([1, 2, 3]), { mode: 0o600 });
    assert.deepEqual(out, { path: "/x", size: 3, mode: 0o600, sha256: "ab" });
    const req = seen[0];
    assert.equal(req?.method, "PUT");
    assert.equal(req?.url.searchParams.get("mode"), "0600");
    assert.equal(req?.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(req?.body, new Uint8Array([1, 2, 3]));
  });

  it("omits mode when none is given", async () => {
    const { client, seen } = files(
      () => new Response(JSON.stringify({ path: "/x", size: 0, mode: 420, sha256: "" })),
    );
    await client.upload("vm", "/x", new Uint8Array());
    assert.equal(seen[0]?.url.searchParams.has("mode"), false);
  });

  it("refuses a size that does not match the data", async () => {
    const { client, seen } = files(() => new Response(null));
    await assert.rejects(client.upload("vm", "/x", new Uint8Array(3), { size: 4 }), RangeError);
    assert.equal(seen.length, 0);
  });

  it("refuses an out-of-range mode before sending anything", async () => {
    const { client, seen } = files(() => new Response(null));
    await assert.rejects(client.upload("vm", "/x", new Uint8Array(), { mode: 0o1777 }), RangeError);
    assert.equal(seen.length, 0);
  });
});

describe("createFetchFiles: statuses", () => {
  for (const [status, code] of [
    [400, "validation_failed"],
    [403, "file_path_denied"],
    [404, "file_not_found"],
    [404, "vm_not_found"],
    [409, "invalid_state_transition"],
    [409, "guest_agent_too_old"],
    [413, "file_too_large"],
    [422, "file_not_regular"],
    [503, "unavailable"],
    [507, "guest_disk_full"],
  ] as const) {
    it(`GET ${status} ${code} → CoveFileError with that code`, async () => {
      const { client } = files(() => jsonError(status, code));
      await rejectsWith(client.downloadBytes("vm", "/f"), status, code);
    });
    it(`PUT ${status} ${code} → CoveFileError with that code`, async () => {
      const { client } = files(() => jsonError(status, code));
      await rejectsWith(client.upload("vm", "/f", new Uint8Array([1])), status, code);
    });
  }

  for (const [status, code, cls] of [
    [413, "file_too_large", FileTooLargeError],
    [403, "file_path_denied", FilePathDeniedError],
    [404, "file_not_found", VmFileNotFoundError],
    [422, "file_not_regular", FileNotRegularError],
    [503, "unavailable", UnavailableError],
  ] as const) {
    it(`${status} ${code} is a ${cls.name}`, async () => {
      const { client } = files(() => jsonError(status, code));
      await assert.rejects(client.downloadBytes("vm", "/f"), cls);
    });
  }

  it("404 vm_not_found is not a VmFileNotFoundError", async () => {
    const { client } = files(() => jsonError(404, "vm_not_found"));
    await assert.rejects(client.downloadBytes("vm", "/f"), (err: unknown) => {
      assert.ok(!(err instanceof VmFileNotFoundError));
      assert.deepEqual(fileErrorStatus(err), { status: 404, code: "vm_not_found" });
      return true;
    });
  });

  it("a HEAD 404 cannot say whether the file or the VM is missing: no code, no subclass", async () => {
    const { client } = files(() => new Response(null, { status: 404 }));
    await assert.rejects(client.stat("vm", "/f"), (err: unknown) => {
      assert.ok(!(err instanceof VmFileNotFoundError));
      assert.deepEqual(fileErrorStatus(err), { status: 404, code: undefined });
      return true;
    });
  });

  it("fileErrorStatus ignores errors without an HTTP status", () => {
    assert.equal(fileErrorStatus(new Error("x")), undefined);
    assert.equal(fileErrorStatus("x"), undefined);
  });

  it("HEAD errors carry a status but no code (HEAD has no body)", async () => {
    const { client } = files(() => new Response(null, { status: 422 }));
    await rejectsWith(client.stat("vm", "/f"), 422, undefined);
  });

  it("an error body that is not JSON still yields a status", async () => {
    const { client } = files(() => new Response("bad gateway", { status: 502 }));
    await rejectsWith(client.downloadBytes("vm", "/f"), 502, undefined);
  });

  it("401 is reported without the credential", async () => {
    const { client } = files(() => jsonError(401, "credential_invalid"));
    await rejectsWith(client.downloadBytes("vm", "/f"), 401, "credential_invalid");
  });
});

describe("createFetchFiles: short bodies", () => {
  it("a body shorter than Content-Length is a failed download", async () => {
    const { client } = files(() => {
      // Stream 3 bytes while promising 10, the way the server ends a failed transfer.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "10" } });
    });
    await assert.rejects(client.downloadBytes("vm", "/f"), (err: unknown) => {
      assert.ok(err instanceof DownloadTruncatedError);
      assert.match(err.message, /3 of 10 bytes/);
      return true;
    });
  });

  it("a stream that errors mid-body is a failed download", async () => {
    const { client } = files(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.error(new Error("socket hang up"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "5" } });
    });
    await assert.rejects(client.downloadBytes("vm", "/f"), DownloadTruncatedError);
  });
});

describe("createFetchFiles: streamed download truncation", () => {
  it("the streamed body errors with DownloadTruncatedError when short", async () => {
    const { client } = files(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "4" } });
    });
    const dl = await client.download("vm", "/f");
    await assert.rejects(readAll(dl.body), DownloadTruncatedError);
  });
});

describe("createFetchFiles: transport", () => {
  it("refuses http:// to a non-loopback host", () => {
    assert.throws(
      () => createFetchFiles({ baseUrl: "http://cove.example.com", token: KEY }),
      /cleartext/,
    );
  });

  it("allows it with allowInsecureHttp", () => {
    assert.doesNotThrow(() =>
      createFetchFiles({ baseUrl: "http://cove.example.com", token: KEY, allowInsecureHttp: true }),
    );
  });

  it("wraps a network failure without the credential", async () => {
    const client = createFetchFiles({
      baseUrl: "https://cove.example.com",
      token: KEY,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await assert.rejects(client.stat("vm", "/f"), (err: unknown) => {
      assert.ok(err instanceof CoveFileError);
      assert.equal(err.status, 0);
      assert.doesNotMatch(`${err.message}${JSON.stringify(err)}`, /cvk_/);
      return true;
    });
  });

  it("passes an abort through as the caller's abort", async () => {
    const ac = new AbortController();
    ac.abort();
    const client = createFetchFiles({
      baseUrl: "https://cove.example.com",
      token: KEY,
      fetch: (async (_u: unknown, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return new Response(null);
      }) as typeof fetch,
    });
    await assert.rejects(client.stat("vm", "/f", { signal: ac.signal }), { name: "AbortError" });
  });

  it("does not leak the credential through JSON or inspection", () => {
    const client = createFetchFiles({ baseUrl: "https://cove.example.com", token: KEY });
    assert.doesNotMatch(JSON.stringify(client), /cvk_/);
  });
});
