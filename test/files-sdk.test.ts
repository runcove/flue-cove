/**
 * The file seam over a real `CoveClient` with a mock `fetch`: what reaches the
 * wire, and which error class and `code` each refusal arrives as, since the
 * driver's fallback rules key on `fileErrorStatus` of exactly those errors.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import {
  CoveClient,
  CoveConnectionError,
  CoveTimeoutError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@cove/sdk";
import { isDeadline, retryAfterSecs } from "../src/errors.ts";
import {
  DownloadTruncatedError,
  FileNotRegularError,
  FilePathDeniedError,
  FileTooLargeError,
  fileErrorStatus,
  filesFor,
  sdkFiles,
  UnavailableError,
  VmFileNotFoundError,
} from "../src/files.ts";
import { apiError } from "./helpers.ts";

const KEY = "cvk_unit_test_secret_value";

interface Seen {
  url: URL;
  rawUrl: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | undefined;
}

/** A real CoveClient whose fetch records each request and answers with `respond`. */
function client(respond: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      url: new URL(String(input)),
      rawUrl: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal ?? undefined,
    };
    seen.push(req);
    init?.signal?.throwIfAborted();
    return respond(req);
  }) as typeof fetch;
  const c = new CoveClient({ baseUrl: "http://127.0.0.1:8091", token: KEY, fetch: fetchImpl });
  const files = filesFor(c);
  assert.ok(files, "every CoveClient has a file client");
  return { files, seen, client: c };
}

const jsonError = (status: number, code: string, message = `${code} happened`) =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

const ok = (body: BodyInit | null, length: number, mode?: string) =>
  new Response(body, {
    status: 200,
    headers: { "content-length": String(length), ...(mode ? { "x-cove-file-mode": mode } : {}) },
  });

const uploaded = () =>
  new Response(JSON.stringify({ path: "/x", size: 1, mode: 0o644, sha256: "ab" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Uint8Array(parts);
    parts.push(...value);
  }
}

describe("filesFor / sdkFiles: the wire", () => {
  it("HEADs the files route, percent-encoding a space as %20 and a plus as %2B", async () => {
    const { files, seen } = client(() => ok(null, 12, "0755"));
    const info = await files.stat("my-vm", "/root/a b+c/ü's.txt");
    assert.deepEqual(info, { size: 12, mode: 0o755, mtime: undefined });
    const req = seen[0];
    assert.ok(req);
    assert.equal(req.method, "HEAD");
    assert.equal(req.url.pathname, "/api/vms/my-vm/files");
    assert.equal(req.url.searchParams.get("path"), "/root/a b+c/ü's.txt");
    // The server applies only percent-decoding, so `+` for a space would
    // arrive as a literal plus.
    assert.match(req.rawUrl, /a%20b%2Bc/);
    assert.equal(req.headers.get("authorization"), `Bearer ${KEY}`);
  });

  it("encodes the VM name as one path segment", async () => {
    const { files, seen } = client(() => ok(null, 0));
    await files.stat("we/ird", "/x");
    assert.equal(seen[0]?.url.pathname, "/api/vms/we%2Fird/files");
  });

  it("downloads bytes exactly, asking for no content encoding", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    const { files, seen } = client(() => ok(bytes, 7));
    assert.deepEqual(await files.downloadBytes("vm", "/bin.dat"), bytes);
    assert.equal(seen[0]?.method, "GET");
    assert.equal(seen[0]?.headers.get("accept-encoding"), "identity");
  });

  it("only GET asks for identity: HEAD and PUT send no Accept-Encoding: identity", async () => {
    const { files, seen } = client((req) => (req.method === "PUT" ? uploaded() : ok(null, 0)));
    await files.stat("vm", "/f");
    await files.upload("vm", "/f", new Uint8Array([1]));
    assert.deepEqual(
      seen.map((r) => r.method),
      ["HEAD", "PUT"],
    );
    for (const req of seen) assert.notEqual(req.headers.get("accept-encoding"), "identity");
  });

  it("download() gives size and mode up front, then the body", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const { files } = client(() => ok(bytes, 3, "0600"));
    const dl = await files.download("vm", "/f");
    assert.equal(dl.size, 3);
    assert.equal(dl.mode, 0o600);
    assert.deepEqual(await readAll(dl.body), bytes);
  });

  it("uploads with PUT and octet-stream; mode only when given", async () => {
    const { files, seen } = client(uploaded);
    const out = await files.upload("vm", "/x", new Uint8Array([1, 2, 3]), { mode: 0o600 });
    assert.deepEqual(out, { path: "/x", size: 1, mode: 0o644, sha256: "ab" });
    await files.upload("vm", "/x", new Uint8Array([1]));
    assert.equal(seen[0]?.method, "PUT");
    assert.equal(seen[0]?.url.searchParams.get("mode"), "0600");
    assert.equal(seen[0]?.headers.get("content-type"), "application/octet-stream");
    assert.equal(seen[1]?.url.searchParams.has("mode"), false);
  });

  it("passes the caller's signal through", async () => {
    const ac = new AbortController();
    ac.abort();
    const { files } = client(() => ok(null, 0));
    await assert.rejects(files.stat("vm", "/f", { signal: ac.signal }), { name: "AbortError" });
  });

  it("the file client serializes and inspects without the credential", () => {
    const { files } = client(() => ok(null, 0));
    assert.doesNotMatch(JSON.stringify(files), /cvk_/);
    assert.doesNotMatch(inspect(files, { depth: 8, showHidden: true }), /cvk_/);
  });

  it("filesFor is undefined for a client double without vms.files", () => {
    assert.equal(filesFor({ vms: {} }), undefined);
  });

  it("sdkFiles adapts any object with the four methods", async () => {
    const calls: string[] = [];
    const files = sdkFiles({
      stat: async (n, p) => {
        calls.push(`stat ${n} ${p}`);
        return { size: 1, mode: undefined, mtime: undefined };
      },
      download: async () => ({
        size: 0,
        mode: undefined,
        mtime: undefined,
        body: new Blob([]).stream(),
      }),
      downloadBytes: async () => new Uint8Array(),
      upload: async (_n, p) => ({ path: p, size: 0, mode: 0o644, sha256: "" }),
    });
    assert.deepEqual(await files.stat("vm", "/a"), { size: 1, mode: undefined, mtime: undefined });
    assert.deepEqual(calls, ["stat vm /a"]);
  });
});

describe("SDK errors as the driver sees them (fileErrorStatus)", () => {
  // GET and PUT error bodies carry the API's code.
  for (const [status, code, cls] of [
    [403, "file_path_denied", FilePathDeniedError],
    [403, "scope_denied", PermissionDeniedError],
    [404, "file_not_found", VmFileNotFoundError],
    [404, "vm_not_found", NotFoundError],
    [409, "invalid_state_transition", Error],
    [409, "guest_agent_too_old", Error],
    [413, "file_too_large", FileTooLargeError],
    [422, "file_not_regular", FileNotRegularError],
    [503, "unavailable", UnavailableError],
    [507, "guest_disk_full", Error],
  ] as const) {
    for (const method of ["GET", "PUT"] as const) {
      it(`${method} ${status} ${code} → ${cls.name}, status ${status}, code ${code}`, async () => {
        const { files } = client(() => jsonError(status, code));
        const p =
          method === "GET"
            ? files.downloadBytes("vm", "/f")
            : files.upload("vm", "/f", new Uint8Array([1]));
        await assert.rejects(p, (err: unknown) => {
          assert.ok(err instanceof cls, `got ${String(err)}`);
          assert.deepEqual(fileErrorStatus(err), { status, code });
          assert.doesNotMatch(`${String(err)} ${JSON.stringify(err)} ${err.stack}`, /cvk_/);
          return true;
        });
      });
    }
  }

  it("scope_denied is a plain PermissionDeniedError, not a FilePathDeniedError", async () => {
    const { files } = client(() => jsonError(403, "scope_denied"));
    await assert.rejects(files.downloadBytes("vm", "/f"), (err: unknown) => {
      assert.ok(err instanceof PermissionDeniedError);
      assert.ok(!(err instanceof FilePathDeniedError));
      return true;
    });
  });

  // HEAD error responses have no body: only statuses that imply one code get it.
  for (const [status, code, cls] of [
    [403, undefined, PermissionDeniedError],
    [404, undefined, NotFoundError],
    [409, undefined, Error],
    [413, "file_too_large", FileTooLargeError],
    [422, "file_not_regular", FileNotRegularError],
    [503, "unavailable", UnavailableError],
  ] as const) {
    it(`HEAD ${status} → ${cls.name}, code ${code}`, async () => {
      const { files } = client(() => new Response(null, { status }));
      await assert.rejects(files.stat("vm", "/f"), (err: unknown) => {
        assert.ok(err instanceof cls);
        assert.deepEqual(fileErrorStatus(err), { status, code });
        return true;
      });
    });
  }

  // A current server names a HEAD error's code in X-Cove-Error-Code.
  for (const [status, code, cls] of [
    [403, "file_path_denied", FilePathDeniedError],
    [403, "scope_denied", PermissionDeniedError],
    [404, "file_not_found", VmFileNotFoundError],
    [404, "vm_not_found", NotFoundError],
    [409, "invalid_state_transition", Error],
    [409, "guest_agent_too_old", Error],
  ] as const) {
    it(`HEAD ${status} with X-Cove-Error-Code ${code} → ${cls.name}, code ${code}`, async () => {
      const { files } = client(
        () => new Response(null, { status, headers: { "x-cove-error-code": code } }),
      );
      await assert.rejects(files.stat("vm", "/f"), (err: unknown) => {
        assert.ok(err instanceof cls, `got ${String(err)}`);
        assert.deepEqual(fileErrorStatus(err), { status, code });
        return true;
      });
    });
  }

  it("stat reads Last-Modified as mtime", async () => {
    const { files } = client(
      () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": "3", "last-modified": "Mon, 05 Oct 2026 08:00:00 GMT" },
        }),
    );
    const info = await files.stat("vm", "/f");
    assert.equal(info.mtime?.toISOString(), "2026-10-05T08:00:00.000Z");
  });

  it("a HEAD 404 without X-Cove-Error-Code cannot say whether the file or the VM is missing", async () => {
    const { files } = client(() => new Response(null, { status: 404 }));
    await assert.rejects(files.stat("vm", "/f"), (err: unknown) => {
      assert.ok(!(err instanceof VmFileNotFoundError));
      return true;
    });
  });

  it("a short body is a DownloadTruncatedError, with no HTTP status for the driver", async () => {
    const { files } = client(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "10" } });
    });
    await assert.rejects(files.downloadBytes("vm", "/f"), (err: unknown) => {
      assert.ok(err instanceof DownloadTruncatedError);
      assert.equal(err.expectedBytes, 10);
      assert.equal(err.receivedBytes, 3);
      assert.equal(fileErrorStatus(err), undefined);
      return true;
    });
  });

  it("a body that breaks mid-stream is a DownloadTruncatedError", async () => {
    const { files } = client(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.error(new Error("socket hang up"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "5" } });
    });
    await assert.rejects(files.downloadBytes("vm", "/f"), DownloadTruncatedError);
  });

  it("a transport failure has no HTTP status and carries no credential", async () => {
    const { files } = client(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(files.stat("vm", "/f"), (err: unknown) => {
      assert.ok(err instanceof CoveConnectionError);
      assert.equal(fileErrorStatus(err), undefined);
      assert.doesNotMatch(`${String(err)} ${JSON.stringify(err)}`, /cvk_/);
      return true;
    });
  });

  it("fileErrorStatus ignores anything that is not an API error", () => {
    assert.equal(fileErrorStatus(new Error("x")), undefined);
    assert.equal(fileErrorStatus("x"), undefined);
  });

  it("a 429's Retry-After reaches retryAfterSecs", async () => {
    const { files } = client(
      () => new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    );
    await assert.rejects(files.stat("vm", "/f"), (err: unknown) => {
      assert.ok(err instanceof RateLimitError);
      assert.equal(retryAfterSecs(err), 2);
      return true;
    });
  });

  it("the SDK's own deadline is a CoveTimeoutError, which isDeadline recognises", async () => {
    const { files } = client(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal?.reason), { once: true });
        }),
    );
    await assert.rejects(files.stat("vm", "/f", { timeoutMs: 20 }), (err: unknown) => {
      assert.ok(err instanceof CoveTimeoutError, `got ${String(err)}`);
      assert.ok(err instanceof CoveConnectionError);
      assert.equal(isDeadline(err), true);
      assert.equal(fileErrorStatus(err), undefined);
      return true;
    });
  });

  it("the SDK does not retry a 429 itself (the driver does)", async () => {
    const { files, seen } = client(() => new Response(null, { status: 429 }));
    await assert.rejects(files.stat("vm", "/f"), RateLimitError);
    await assert.rejects(files.upload("vm", "/f", new Uint8Array([1])), RateLimitError);
    assert.equal(seen.length, 2);
  });
});

describe("test helper apiError matches the SDK", () => {
  for (const status of [403, 404, 409, 413, 422, 503]) {
    it(`a body-less ${status} carries the same class and code as a live HEAD`, async () => {
      const { files } = client(() => new Response(null, { status }));
      const live = await files.stat("vm", "/f").then(
        () => assert.fail("expected a refusal"),
        (err: unknown) => err as Error,
      );
      const made = apiError(status);
      assert.equal(made.constructor.name, live.constructor.name);
      assert.deepEqual(fileErrorStatus(made), fileErrorStatus(live));
    });
  }
});
