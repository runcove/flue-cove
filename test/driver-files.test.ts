import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { CoveAPIError, CoveClient, CoveConnectionError } from "@cove/sdk";
import {
  SandboxDiedError,
  SandboxOperationUnsupportedError,
  sandboxFromDriver,
} from "@flue/runtime";
import { CoveSandboxDriver } from "../src/driver.ts";
import {
  type CoveFiles,
  DownloadTruncatedError,
  FileTooLargeError,
  filesFor,
} from "../src/files.ts";
import { apiError, localShellClient } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "flue-cove-files-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * A CoveFiles fake served from the local filesystem with Cove's rules:
 * regular files only, a symlink anywhere in the path or a non-regular target
 * is 422 `file_not_regular`, a missing file or parent is 404, uploads keep an
 * existing file's mode. Errors are the SDK's own, built by its mapping: a GET
 * or PUT error carries its code; a HEAD (`stat`) error has no body, so its 404
 * has none. `override` forces an error for a method.
 */
function fsFiles(override: Partial<Record<"stat" | "download" | "upload", Error>> = {}) {
  const used: string[] = [];
  const check = (path: string, op: "stat" | "download" | "upload") => {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const [i, part] of parts.entries()) {
      cur += `/${part}`;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(cur);
      } catch {
        if (op === "upload" && i === parts.length - 1) return;
        throw op === "stat" ? apiError(404) : apiError(404, "file_not_found", `${cur} not found`);
      }
      if (st.isSymbolicLink()) {
        throw apiError(422, "file_not_regular", `${cur} is a symbolic link`);
      }
      if (i === parts.length - 1 && !st.isFile()) {
        throw apiError(422, "file_not_regular", `${cur} is not a regular file`);
      }
    }
  };
  const files: CoveFiles = {
    async stat(_vm, path) {
      used.push(`stat ${path}`);
      if (override.stat) throw override.stat;
      check(path, "stat");
      const st = statSync(path);
      // Like a server that predates `Last-Modified` on HEAD; tests that
      // want an mtime override `stat`.
      return { size: st.size, mode: st.mode & 0o777, mtime: undefined };
    },
    async downloadBytes(_vm, path) {
      used.push(`download ${path}`);
      if (override.download) throw override.download;
      check(path, "download");
      return new Uint8Array(readFileSync(path));
    },
    async download(vm, path) {
      const bytes = await files.downloadBytes(vm, path);
      return {
        size: bytes.length,
        mode: undefined,
        mtime: undefined,
        body: new Blob([new Uint8Array(bytes)]).stream(),
      };
    },
    async upload(_vm, path, bytes) {
      used.push(`upload ${path}`);
      if (override.upload) throw override.upload;
      check(path, "upload");
      writeFileSync(path, bytes);
      const st = statSync(path);
      return { path, size: st.size, mode: st.mode & 0o777, sha256: "" };
    },
  };
  return { files, used };
}

function setup(override?: Parameters<typeof fsFiles>[0]) {
  const shell = localShellClient();
  const fake = fsFiles(override);
  const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
  return { driver, files: fake.files, used: fake.used, calls: shell.calls };
}

let n = 0;
let dir = "";
beforeEach(() => {
  dir = join(root, `case-${n++}`);
  mkdirSync(dir);
});

const NASTY_NAMES = [
  "plain.txt",
  "with space.txt",
  "it's.txt",
  "new\nline.txt",
  "-dash.txt",
  "ü✓.txt",
];

describe("readFile / readFileBuffer", () => {
  it("reads a regular file through the file API, without exec", async () => {
    const { driver, used, calls } = setup();
    writeFileSync(join(dir, "a.txt"), "héllo\n");
    assert.equal(await driver.readFile(join(dir, "a.txt")), "héllo\n");
    assert.deepEqual(used, [`download ${dir}/a.txt`]);
    assert.equal(calls.length, 0);
  });

  it("reads binary bytes exactly", async () => {
    const { driver } = setup();
    const bytes = randomBytes(4096);
    writeFileSync(join(dir, "b.bin"), bytes);
    assert.deepEqual(await driver.readFileBuffer(join(dir, "b.bin")), new Uint8Array(bytes));
  });

  it("follows a symlink by falling back to exec on 422", async () => {
    const { driver, calls } = setup();
    const bytes = randomBytes(70_000);
    writeFileSync(join(dir, "target.bin"), bytes);
    symlinkSync(join(dir, "target.bin"), join(dir, "link"));
    assert.deepEqual(await driver.readFileBuffer(join(dir, "link")), new Uint8Array(bytes));
    assert.equal(calls.length, 1);
  });

  for (const [status, code] of [
    [403, "file_path_denied"],
    [409, "guest_agent_too_old"],
    [400, "validation_failed"],
  ] as const) {
    it(`falls back to exec on ${status} ${code}`, async () => {
      const { driver, calls } = setup({ download: apiError(status, code, "x") });
      writeFileSync(join(dir, "f"), "via exec");
      assert.equal(await driver.readFile(join(dir, "f")), "via exec");
      assert.equal(calls.length, 1);
    });
  }

  it("404 is a missing file, with no fallback", async () => {
    const { driver, calls } = setup();
    await assert.rejects(driver.readFile(join(dir, "nope")), (err: unknown) => {
      assert.match(String(err), /no such file/i);
      assert.equal((err as { code?: string }).code, "ENOENT");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("a short body is a failed read, never partial content", async () => {
    const { driver, calls } = setup({
      download: new DownloadTruncatedError(10, 3),
    });
    writeFileSync(join(dir, "f"), "0123456789");
    await assert.rejects(driver.readFile(join(dir, "f")), /3 of 10 bytes/);
    assert.equal(calls.length, 0);
  });

  it("413 file_too_large is an error, not an exec fallback", async () => {
    const { driver, calls } = setup({
      download: apiError(413, "file_too_large", "limit is 100 MiB"),
    });
    await assert.rejects(driver.readFile(join(dir, "f")), /100 MiB/);
    assert.equal(calls.length, 0);
  });

  it("503 unavailable surfaces", async () => {
    const { driver } = setup({ download: apiError(503, "unavailable", "retry") });
    await assert.rejects(driver.readFile(join(dir, "f")), /retry/);
  });

  it("409 invalid_state_transition is SandboxDiedError", async () => {
    const { driver } = setup({
      download: apiError(409, "invalid_state_transition", "not running"),
    });
    await assert.rejects(driver.readFile(join(dir, "f")), SandboxDiedError);
  });

  it("404 vm_not_found is SandboxDiedError", async () => {
    const { driver } = setup({ download: apiError(404, "vm_not_found", "gone") });
    await assert.rejects(driver.readFile(join(dir, "f")), SandboxDiedError);
  });

  it("the exec fallback reports a missing target", async () => {
    const { driver } = setup();
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    await assert.rejects(driver.readFile(join(dir, "dangling")), /No such file/);
  });

  it("the exec fallback refuses a directory", async () => {
    const { driver } = setup();
    mkdirSync(join(dir, "d"));
    await assert.rejects(driver.readFile(join(dir, "d")), /directory/i);
  });

  it("works with exec only when no file client is configured", async () => {
    const shell = localShellClient();
    const driver = new CoveSandboxDriver(shell.client, "vm");
    writeFileSync(join(dir, "f"), "exec only");
    assert.equal(await driver.readFile(join(dir, "f")), "exec only");
  });
});

describe("writeFile", () => {
  it("uploads strings as UTF-8 and bytes verbatim through the file API", async () => {
    const { driver, used, calls } = setup();
    await driver.writeFile(join(dir, "s.txt"), "ünï\n");
    const bytes = randomBytes(2048);
    await driver.writeFile(join(dir, "b.bin"), new Uint8Array(bytes));
    assert.equal(readFileSync(join(dir, "s.txt"), "utf8"), "ünï\n");
    assert.deepEqual(readFileSync(join(dir, "b.bin")), bytes);
    assert.deepEqual(used, [`upload ${dir}/s.txt`, `upload ${dir}/b.bin`]);
    assert.equal(calls.length, 0);
  });

  it("404 (missing parent) rejects so the wrapper can mkdir -p and retry", async () => {
    const { driver } = setup();
    await assert.rejects(driver.writeFile(join(dir, "no/such/f"), "x"), /ENOENT|no such/i);
    const sandbox = sandboxFromDriver(driver, dir);
    await sandbox.writeFile("deep/er/f.txt", "made it");
    assert.equal(readFileSync(join(dir, "deep/er/f.txt"), "utf8"), "made it");
  });

  it("writes through a symlink via exec on 422, in chunks, for a large file", async () => {
    const { driver, calls } = setup();
    const bytes = randomBytes(300 * 1024);
    writeFileSync(join(dir, "target"), "old");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    await driver.writeFile(join(dir, "link"), new Uint8Array(bytes));
    assert.deepEqual(readFileSync(join(dir, "target")), bytes);
    assert.ok(lstatSync(join(dir, "link")).isSymbolicLink(), "the link itself must survive");
    assert.ok(calls.length > 2, `expected a chunked write, saw ${calls.length} execs`);
    for (const call of calls) {
      for (const arg of call.command) assert.ok(arg.length < 128 * 1024, "argv string too long");
    }
  });

  it("writes an empty file through the exec fallback", async () => {
    const { driver } = setup({ upload: apiError(422, "file_not_regular", "x") });
    await driver.writeFile(join(dir, "empty"), "");
    assert.equal(readFileSync(join(dir, "empty"), "utf8"), "");
  });

  it("413 is an error, not a fallback", async () => {
    const { driver, calls } = setup({
      upload: apiError(413, "file_too_large", "too big"),
    });
    await assert.rejects(driver.writeFile(join(dir, "f"), "x"), /too big/);
    assert.equal(calls.length, 0);
  });

  it("507 guest_disk_full surfaces", async () => {
    const { driver } = setup({ upload: apiError(507, "guest_disk_full", "disk full") });
    await assert.rejects(driver.writeFile(join(dir, "f"), "x"), /disk full/);
  });

  for (const name of NASTY_NAMES) {
    it(`round-trips the awkward name ${JSON.stringify(name)} over exec`, async () => {
      const { driver } = setup({
        upload: apiError(422, "file_not_regular", "x"),
        download: apiError(422, "file_not_regular", "x"),
      });
      await driver.writeFile(join(dir, name), `content of ${name}`);
      assert.equal(await driver.readFile(join(dir, name)), `content of ${name}`);
    });
  }
});

describe("stat", () => {
  it("a regular file via HEAD carries the server's Last-Modified as mtime", async () => {
    const { driver, files, calls } = setup();
    writeFileSync(join(dir, "f"), "12345");
    const when = new Date("2026-10-05T08:00:00Z");
    files.stat = async () => ({ size: 5, mode: 0o644, mtime: when });
    const st = await driver.stat(join(dir, "f"));
    assert.deepEqual(st, {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: 5,
      mtime: when,
    });
    assert.equal(calls.length, 0);
  });

  it("an unparseable mtime is left out, not passed on", async () => {
    const { driver, files } = setup();
    files.stat = async () => ({ size: 5, mode: 0o644, mtime: new Date(Number.NaN) });
    assert.equal("mtime" in (await driver.stat(join(dir, "f"))), false);
  });

  it("a regular file via HEAD from a server without Last-Modified: no invented mtime", async () => {
    const { driver, calls } = setup();
    writeFileSync(join(dir, "f"), "12345");
    const st = await driver.stat(join(dir, "f"));
    assert.deepEqual(st, { isFile: true, isDirectory: false, isSymbolicLink: false, size: 5 });
    assert.equal("mtime" in st, false);
    assert.equal(calls.length, 0);
  });

  it("a directory via the exec fallback", async () => {
    const { driver } = setup();
    mkdirSync(join(dir, "d d"));
    const st = await driver.stat(join(dir, "d d"));
    assert.equal(st.isDirectory, true);
    assert.equal(st.isFile, false);
    assert.equal(st.isSymbolicLink, false);
    assert.ok(st.mtime instanceof Date && !Number.isNaN(st.mtime.getTime()));
  });

  it("a symlink: target fields, isSymbolicLink for the path itself", async () => {
    const { driver } = setup();
    writeFileSync(join(dir, "t"), "abc");
    symlinkSync(join(dir, "t"), join(dir, "l"));
    const st = await driver.stat(join(dir, "l"));
    assert.equal(st.isFile, true);
    assert.equal(st.isSymbolicLink, true);
    assert.equal(st.size, 3);
  });

  it("a symlink to a directory", async () => {
    const { driver } = setup();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "dl"));
    const st = await driver.stat(join(dir, "dl"));
    assert.equal(st.isDirectory, true);
    assert.equal(st.isSymbolicLink, true);
  });

  it("missing: 404 throws ENOENT", async () => {
    const { driver } = setup();
    await assert.rejects(driver.stat(join(dir, "nope")), { code: "ENOENT" });
  });

  it("a dangling symlink throws, like stat(2)", async () => {
    const { driver } = setup();
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    await assert.rejects(driver.stat(join(dir, "dangling")), { code: "ENOENT" });
  });

  it("413 on HEAD (a big file) falls back to exec instead of failing", async () => {
    const { driver } = setup({ stat: apiError(413) });
    writeFileSync(join(dir, "f"), "x");
    assert.equal((await driver.stat(join(dir, "f"))).size, 1);
  });
});

describe("exists", () => {
  it("true for a file via HEAD, false for 404, without exec", async () => {
    const { driver, calls } = setup();
    writeFileSync(join(dir, "f"), "");
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal(await driver.exists(join(dir, "nope")), false);
    assert.equal(calls.length, 0);
  });

  it("directories and symlinks go over exec", async () => {
    const { driver } = setup();
    mkdirSync(join(dir, "d"));
    symlinkSync(join(dir, "d"), join(dir, "l"));
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    assert.equal(await driver.exists(join(dir, "d")), true);
    assert.equal(await driver.exists(join(dir, "l")), true);
    assert.equal(await driver.exists(join(dir, "dangling")), false);
  });

  it("never throws: transport errors and dead VMs read as false", async () => {
    const boom = new CoveConnectionError("network down");
    const failing = new CoveSandboxDriver(
      {
        vms: {
          exec: async function* () {
            yield* [];
            throw new Error("exec down too");
          },
          execWithSecrets: async () => {
            throw new Error("nope");
          },
        },
      },
      "vm",
      {
        files: {
          stat: async () => {
            throw boom;
          },
          download: async () => {
            throw boom;
          },
          downloadBytes: async () => {
            throw boom;
          },
          upload: async () => {
            throw boom;
          },
        },
      },
    );
    assert.equal(await failing.exists("/x"), false);
  });
});

describe("readdir / mkdir / rm", () => {
  it("lists every name, awkward ones included, and nothing else", async () => {
    const { driver } = setup();
    for (const name of [...NASTY_NAMES, ".hidden", "..dots", "sub"]) {
      if (name === "sub") mkdirSync(join(dir, name));
      else writeFileSync(join(dir, name), "");
    }
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));
    const names = (await driver.readdir(dir)).sort();
    assert.deepEqual(names, [...NASTY_NAMES, ".hidden", "..dots", "sub", "dangling"].sort());
  });

  it("an empty directory lists nothing", async () => {
    const { driver } = setup();
    assert.deepEqual(await driver.readdir(dir), []);
  });

  it("readdir of a file or a missing path throws", async () => {
    const { driver } = setup();
    writeFileSync(join(dir, "f"), "");
    await assert.rejects(driver.readdir(join(dir, "f")));
    await assert.rejects(driver.readdir(join(dir, "nope")));
  });

  it("mkdir, mkdir -p, and mkdir of an existing dir without recursive fails", async () => {
    const { driver } = setup();
    await driver.mkdir(join(dir, "-a b"));
    await driver.mkdir(join(dir, "x/y/z"), { recursive: true });
    await driver.mkdir(join(dir, "x/y/z"), { recursive: true });
    assert.ok(statSync(join(dir, "-a b")).isDirectory());
    assert.ok(statSync(join(dir, "x/y/z")).isDirectory());
    await assert.rejects(driver.mkdir(join(dir, "-a b")), /exists/i);
    await assert.rejects(driver.mkdir(join(dir, "p/q")), /No such file/i);
  });

  it("rm honours recursive and force exactly", async () => {
    const { driver } = setup();
    writeFileSync(join(dir, "-f"), "");
    await driver.rm(join(dir, "-f"));
    await assert.rejects(driver.rm(join(dir, "-f")), /No such file/i);
    await driver.rm(join(dir, "-f"), { force: true });
    mkdirSync(join(dir, "tree/sub"), { recursive: true });
    await assert.rejects(driver.rm(join(dir, "tree")), /directory/i);
    await assert.rejects(driver.rm(join(dir, "tree"), { force: true }), /directory/i);
    await driver.rm(join(dir, "tree"), { recursive: true });
    await assert.rejects(driver.rm(join(dir, "tree"), { recursive: true }));
    await driver.rm(join(dir, "tree"), { recursive: true, force: true });
  });
});

describe("through sandboxFromDriver", () => {
  it("relative paths resolve against the sandbox cwd", async () => {
    const { driver } = setup();
    const sandbox = sandboxFromDriver(driver, dir);
    await sandbox.writeFile("rel.txt", "relative");
    assert.equal(await sandbox.readFile(`${dir}/rel.txt`), "relative");
    assert.equal((await sandbox.exec("cat rel.txt")).stdout, "relative");
  });
});

describe("options the contract does not define", () => {
  it("rm with an unknown option throws SandboxOperationUnsupportedError before touching anything", async () => {
    const { driver, calls } = setup();
    writeFileSync(join(dir, "keep"), "x");
    const opts = { recursive: false, maxRetries: 3 } as unknown as { recursive?: boolean };
    await assert.rejects(driver.rm(join(dir, "keep"), opts), (err: unknown) => {
      assert.ok(err instanceof SandboxOperationUnsupportedError);
      assert.deepEqual((err as { meta?: { options?: string[] } }).meta?.options, ["maxRetries"]);
      return true;
    });
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(join(dir, "keep"), "utf8"), "x");
  });

  it("mkdir with an unknown option throws SandboxOperationUnsupportedError", async () => {
    const { driver, calls } = setup();
    const opts = { mode: 0o700 } as unknown as { recursive?: boolean };
    await assert.rejects(driver.mkdir(join(dir, "m"), opts), SandboxOperationUnsupportedError);
    assert.equal(calls.length, 0);
  });

  it("exec with an unknown option throws SandboxOperationUnsupportedError", async () => {
    const { driver, calls } = setup();
    const opts = { shell: "/bin/zsh" } as unknown as { cwd?: string };
    await assert.rejects(driver.exec("true", opts), SandboxOperationUnsupportedError);
    assert.equal(calls.length, 0);
  });

  it("undefined values of unknown keys are ignored", async () => {
    const { driver } = setup();
    const opts = { recursive: true, extra: undefined } as unknown as { recursive?: boolean };
    await driver.mkdir(join(dir, "ok/nested"), opts);
    assert.ok(statSync(join(dir, "ok/nested")).isDirectory());
  });
});

describe("a key without files:* scopes (403 scope_denied)", () => {
  it("GET 403 scope_denied falls back to exec, and later reads skip the API", async () => {
    const { driver, used, calls } = setup({
      download: apiError(403, "scope_denied", "key lacks files:read"),
    });
    writeFileSync(join(dir, "a"), "one");
    writeFileSync(join(dir, "b"), "two");
    assert.equal(await driver.readFile(join(dir, "a")), "one");
    assert.equal(await driver.readFile(join(dir, "b")), "two");
    assert.equal(used.filter((u) => u.startsWith("download")).length, 1);
    assert.equal(calls.length, 2);
    // A read refusal says nothing about stat via HEAD: same scope, so skip it too.
    await driver.stat(join(dir, "a"));
    assert.equal(used.filter((u) => u.startsWith("stat")).length, 0);
  });

  it("PUT 403 scope_denied falls back to exec, and later writes skip the API", async () => {
    const { driver, used } = setup({
      upload: apiError(403, "scope_denied", "key lacks files:write"),
    });
    await driver.writeFile(join(dir, "w1"), "x");
    await driver.writeFile(join(dir, "w2"), "y");
    assert.equal(readFileSync(join(dir, "w2"), "utf8"), "y");
    assert.equal(used.filter((u) => u.startsWith("upload")).length, 1);
    // Reads still use the API: files:read may be granted on its own.
    assert.equal(await driver.readFile(join(dir, "w1")), "x");
    assert.equal(used.filter((u) => u.startsWith("download")).length, 1);
  });
});

describe("fallback rules, one per refusal", () => {
  it("422 file_not_regular: read, write and stat all fall back to exec", async () => {
    const err = apiError(422, "file_not_regular", "x");
    const { driver, calls } = setup({ download: err, upload: err, stat: err });
    await driver.writeFile(join(dir, "f"), "via exec");
    assert.equal(await driver.readFile(join(dir, "f")), "via exec");
    assert.equal((await driver.stat(join(dir, "f"))).size, 8);
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal(calls.length, 4);
  });

  it("403 file_path_denied: read and write fall back, and are tried again next time", async () => {
    const err = apiError(403, "file_path_denied", "denied path");
    const { driver, used } = setup({ download: err, upload: err });
    await driver.writeFile(join(dir, "f"), "one");
    await driver.writeFile(join(dir, "f"), "two");
    assert.equal(await driver.readFile(join(dir, "f")), "two");
    assert.equal(await driver.readFile(join(dir, "f")), "two");
    // A denied path is about that path, not the key: no refusal memory.
    assert.equal(used.filter((u) => u.startsWith("upload")).length, 2);
    assert.equal(used.filter((u) => u.startsWith("download")).length, 2);
  });

  it("HEAD 403 (no code: denied path or missing scope) falls back without refusal memory", async () => {
    const { driver, used } = setup({ stat: apiError(403) });
    writeFileSync(join(dir, "f"), "abc");
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal(used.filter((u) => u.startsWith("stat")).length, 2);
    // Reads still use the API: a HEAD 403 cannot say the key lacks files:read.
    assert.equal(await driver.readFile(join(dir, "f")), "abc");
    assert.equal(used.filter((u) => u.startsWith("download")).length, 1);
  });

  it("403 scope_denied on a read: exists and stat skip the API from then on", async () => {
    const { driver, used } = setup({ download: apiError(403, "scope_denied", "no files:read") });
    writeFileSync(join(dir, "f"), "abc");
    assert.equal(await driver.readFile(join(dir, "f")), "abc");
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.deepEqual(used, [`download ${dir}/f`]);
  });

  it("refusal memory is per driver", async () => {
    const shell = localShellClient();
    const fake = fsFiles({ download: apiError(403, "scope_denied", "no files:read") });
    const one = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    const two = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    writeFileSync(join(dir, "f"), "abc");
    await one.readFile(join(dir, "f"));
    await one.readFile(join(dir, "f"));
    await two.readFile(join(dir, "f"));
    assert.equal(fake.used.filter((u) => u.startsWith("download")).length, 2);
  });

  it("413: stat and exists fall back to exec, reads and writes fail", async () => {
    const big = apiError(413, "file_too_large", "over the 100 MiB limit");
    const { driver, calls } = setup({ stat: big, download: big, upload: big });
    writeFileSync(join(dir, "f"), "12");
    assert.equal((await driver.stat(join(dir, "f"))).size, 2);
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal(calls.length, 2);
    await assert.rejects(driver.readFile(join(dir, "f")), FileTooLargeError);
    await assert.rejects(driver.writeFile(join(dir, "f"), "x"), FileTooLargeError);
    assert.equal(calls.length, 2, "no exec fallback for content");
  });

  it("HEAD 404 file_not_found (X-Cove-Error-Code) is ENOENT with no probe and no exec", async () => {
    const shell = localShellClient();
    const fake = fsFiles();
    fake.files.stat = async (_vm, path) => {
      fake.used.push(`stat ${path}`);
      throw CoveAPIError.fromResponse(404, undefined, undefined, "file_not_found");
    };
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    await assert.rejects(driver.stat(join(dir, "f")), { code: "ENOENT" });
    assert.equal(await driver.exists(join(dir, "f")), false);
    assert.equal(driver.fileRoute, "present");
    assert.ok(!fake.used.includes("stat /"), "no probe");
    assert.equal(shell.calls.length, 0);
  });

  it("HEAD 404 vm_not_found (X-Cove-Error-Code) is SandboxDiedError for stat, false for exists", async () => {
    const shell = localShellClient();
    const fake = fsFiles();
    fake.files.stat = async (_vm, path) => {
      fake.used.push(`stat ${path}`);
      throw CoveAPIError.fromResponse(404, undefined, undefined, "vm_not_found");
    };
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    await assert.rejects(driver.stat(join(dir, "f")), SandboxDiedError);
    assert.equal(await driver.exists(join(dir, "f")), false);
    assert.ok(!fake.used.includes("stat /"), "no probe");
    assert.equal(shell.calls.length, 0);
  });

  it("HEAD 403 file_path_denied and scope_denied (X-Cove-Error-Code) fall back to exec as before", async () => {
    for (const code of ["file_path_denied", "scope_denied"]) {
      const shell = localShellClient();
      const fake = fsFiles({
        stat: CoveAPIError.fromResponse(403, undefined, undefined, code),
      });
      const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
      writeFileSync(join(dir, "f"), "abc");
      assert.equal((await driver.stat(join(dir, "f"))).size, 3, code);
      assert.equal(await driver.exists(join(dir, "f")), true, code);
      assert.ok(shell.calls.length > 0, code);
    }
  });

  it("HEAD 403 scope_denied (X-Cove-Error-Code) is remembered: later reads skip the API", async () => {
    const shell = localShellClient();
    const fake = fsFiles({
      stat: CoveAPIError.fromResponse(403, undefined, undefined, "scope_denied"),
    });
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    writeFileSync(join(dir, "f"), "abc");
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.equal(await driver.readFile(join(dir, "f")), "abc");
    assert.deepEqual(fake.used, [`stat ${dir}/f`], "the read never tried the API");
  });

  it("a codeless HEAD 403 (older server) is not remembered: reads still use the API", async () => {
    const shell = localShellClient();
    const fake = fsFiles({ stat: apiError(403) });
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    writeFileSync(join(dir, "f"), "abc");
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.equal(await driver.readFile(join(dir, "f")), "abc");
    assert.ok(fake.used.includes(`download ${dir}/f`));
  });

  it("HEAD 409 invalid_state_transition (X-Cove-Error-Code) is SandboxDiedError, no exec", async () => {
    const shell = localShellClient();
    const fake = fsFiles({
      stat: CoveAPIError.fromResponse(409, undefined, undefined, "invalid_state_transition"),
    });
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    await assert.rejects(driver.stat(join(dir, "f")), SandboxDiedError);
    assert.equal(shell.calls.length, 0);
  });

  it("a codeless HEAD 409 (older server) falls back to exec as before", async () => {
    const shell = localShellClient();
    const fake = fsFiles({ stat: apiError(409) });
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    writeFileSync(join(dir, "f"), "abc");
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.ok(shell.calls.length > 0);
  });

  it("HEAD 404 with no code (a server without X-Cove-Error-Code) reads as a missing file even if the VM is gone", async () => {
    // An older server's HEAD error has no body and no code header:
    // vm_not_found and file_not_found are both a bare 404. The route itself
    // exists: its probe of `/` answers 400.
    const shell = localShellClient();
    const fake = fsFiles();
    fake.files.stat = async (_vm, path) => {
      throw path === "/" ? apiError(400) : apiError(404);
    };
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    await assert.rejects(driver.stat(join(dir, "f")), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "ENOENT");
      assert.ok(!(err instanceof SandboxDiedError));
      return true;
    });
    assert.equal(await driver.exists(join(dir, "f")), false);
    assert.equal(shell.calls.length, 0);
  });

  it("a short body is a failed read: not retried, no exec fallback", async () => {
    let n = 0;
    const shell = localShellClient();
    const files: CoveFiles = {
      ...fsFiles().files,
      downloadBytes: async () => {
        n++;
        throw new DownloadTruncatedError(10, 3);
      },
    };
    const driver = new CoveSandboxDriver(shell.client, "vm", { files });
    await assert.rejects(driver.readFileBuffer(join(dir, "f")), DownloadTruncatedError);
    assert.equal(n, 1);
    assert.equal(shell.calls.length, 0);
  });
});

describe("a server without the file route", () => {
  /**
   * A server that predates the file API answers every /files request with
   * its router's bare 404: no body, so no code, for GET, PUT and HEAD alike.
   */
  function noRoute() {
    const used: string[] = [];
    const bare = () => apiError(404);
    const files: CoveFiles = {
      stat: async (_vm, path) => {
        used.push(`stat ${path}`);
        throw bare();
      },
      download: async (_vm, path) => {
        used.push(`download ${path}`);
        throw bare();
      },
      downloadBytes: async (_vm, path) => {
        used.push(`download ${path}`);
        throw bare();
      },
      upload: async (_vm, path) => {
        used.push(`upload ${path}`);
        throw bare();
      },
    };
    const shell = localShellClient();
    return {
      driver: new CoveSandboxDriver(shell.client, "vm", { files }),
      used,
      calls: shell.calls,
    };
  }

  it("a GET 404 with no code means no route: read over exec, then skip the API", async () => {
    const { driver, used } = noRoute();
    writeFileSync(join(dir, "f"), "old server");
    assert.equal(await driver.readFile(join(dir, "f")), "old server");
    assert.equal(await driver.readFile(join(dir, "f")), "old server");
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal((await driver.stat(join(dir, "f"))).size, 10);
    await driver.writeFile(join(dir, "g"), "written");
    assert.equal(readFileSync(join(dir, "g"), "utf8"), "written");
    assert.deepEqual(used, [`download ${dir}/f`]);
  });

  it("a PUT 404 with no code means no route: write over exec", async () => {
    const { driver, used } = noRoute();
    await driver.writeFile(join(dir, "w"), "via exec");
    assert.equal(readFileSync(join(dir, "w"), "utf8"), "via exec");
    assert.equal(await driver.readFile(join(dir, "w")), "via exec");
    assert.deepEqual(used, [`upload ${dir}/w`]);
  });

  it("a HEAD 404 is checked once with a probe of '/': no route, so stat and exists use exec", async () => {
    const { driver, used } = noRoute();
    writeFileSync(join(dir, "f"), "abc");
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal(await driver.exists(join(dir, "nope")), false);
    assert.deepEqual(used, [`stat ${dir}/f`, "stat /"]);
  });

  it("concurrent first calls share one probe", async () => {
    const { driver, used } = noRoute();
    writeFileSync(join(dir, "f"), "abc");
    await Promise.all([driver.stat(join(dir, "f")), driver.exists(join(dir, "f"))]);
    assert.equal(used.filter((u) => u === "stat /").length, 1);
  });
});

describe("a server with the file route", () => {
  it("a HEAD 404 is probed once; the probe's 400 confirms the route, so it is ENOENT", async () => {
    const shell = localShellClient();
    const fake = fsFiles();
    const stat = fake.files.stat;
    fake.files.stat = async (vm, path, opts) => {
      // The route refuses `/` lexically (an empty component) with 400.
      if (path === "/") {
        fake.used.push("stat /");
        throw apiError(400);
      }
      return stat(vm, path, opts);
    };
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
    await assert.rejects(driver.stat(join(dir, "nope")), { code: "ENOENT" });
    assert.equal(await driver.exists(join(dir, "nope2")), false);
    await assert.rejects(driver.stat(join(dir, "nope3")), { code: "ENOENT" });
    assert.equal(fake.used.filter((u) => u === "stat /").length, 1);
    assert.equal(shell.calls.length, 0);
  });

  it("a successful call proves the route: a later HEAD 404 needs no probe", async () => {
    const { driver, used } = setup();
    writeFileSync(join(dir, "f"), "x");
    await driver.stat(join(dir, "f"));
    await assert.rejects(driver.stat(join(dir, "nope")), { code: "ENOENT" });
    assert.ok(!used.includes("stat /"));
  });

  it("a GET 404 file_not_found is ENOENT, never mistaken for a missing route", async () => {
    const { driver, used } = setup();
    await assert.rejects(driver.readFile(join(dir, "nope")), { code: "ENOENT" });
    writeFileSync(join(dir, "f"), "x");
    await driver.readFile(join(dir, "f"));
    assert.equal(used.filter((u) => u.startsWith("download")).length, 2);
  });
});

describe("a 200 the SDK cannot trust (no Content-Length, or a content encoding)", () => {
  /** A driver over a real CoveClient whose fetch answers every file call with `respond`. */
  function viaSdk(respond: (method: string) => Response) {
    const client = new CoveClient({
      baseUrl: "http://127.0.0.1:8080",
      token: "cvk_unit",
      fetch: (async (_u: unknown, init?: RequestInit) =>
        respond(init?.method ?? "GET")) as typeof fetch,
    });
    const shell = localShellClient();
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: filesFor(client) });
    return { driver, calls: shell.calls };
  }

  it("a HEAD 200 without Content-Length: stat and exists ask the shell", async () => {
    const { driver, calls } = viaSdk(() => new Response(null, { status: 200 }));
    writeFileSync(join(dir, "f"), "abcd");
    assert.equal((await driver.stat(join(dir, "f"))).size, 4);
    assert.equal(await driver.exists(join(dir, "f")), true);
    assert.equal(calls.length, 2);
  });

  it("a GET 200 without Content-Length: the read falls back to exec", async () => {
    const { driver, calls } = viaSdk(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    writeFileSync(join(dir, "f"), "from the shell");
    assert.equal(await driver.readFile(join(dir, "f")), "from the shell");
    assert.equal(calls.length, 1);
  });

  it("a GET 200 with Content-Encoding gzip: the read falls back to exec", async () => {
    const { driver, calls } = viaSdk(
      () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-length": "2", "content-encoding": "gzip" },
        }),
    );
    writeFileSync(join(dir, "f"), "plain");
    assert.equal(await driver.readFile(join(dir, "f")), "plain");
    assert.equal(calls.length, 1);
  });

  it("a truncated download is still a hard failure", async () => {
    const { driver, calls } = viaSdk(
      () =>
        new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-length": "9" } }),
    );
    await assert.rejects(driver.readFile(join(dir, "f")), DownloadTruncatedError);
    assert.equal(calls.length, 0);
  });
});

describe("a client-wide timeoutMs and file transfers", () => {
  /** A real CoveClient with a short timeoutMs; its fetch takes `delayMs`, honouring the signal. */
  function slowClient(delayMs: number, respond: (method: string) => Response) {
    const seen: Array<{ method: string }> = [];
    const client = new CoveClient({
      baseUrl: "http://127.0.0.1:8080",
      token: "cvk_unit",
      timeoutMs: 50,
      fetch: (async (_u: unknown, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        seen.push({ method });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(init.signal?.reason);
          });
        });
        return respond(method);
      }) as typeof fetch,
    });
    return { client, seen };
  }

  it("an upload is not cut off by the client's short timeoutMs", async () => {
    const { client, seen } = slowClient(
      200,
      () =>
        new Response(JSON.stringify({ path: "/f", size: 1, mode: 420, sha256: "" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const shell = localShellClient();
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: filesFor(client) });
    await driver.writeFile(join(dir, "f"), "x");
    assert.deepEqual(seen, [{ method: "PUT" }]);
    assert.equal(shell.calls.length, 0, "no exec fallback");
  });

  it("the upload budget grows with the size and never drops below two minutes", async () => {
    const { uploadTimeoutMs } = await import("../src/driver.ts");
    assert.ok(uploadTimeoutMs(0) >= 120_000);
    assert.ok(uploadTimeoutMs(1024 ** 3) > uploadTimeoutMs(1024 ** 2));
    // At the server's floor of 256 KiB/s, 1 GiB takes 4096 s; the budget allows more.
    assert.ok(uploadTimeoutMs(1024 ** 3) > 4096_000);
  });

  it("a download's body is not bound by timeoutMs, only its headers (SDK behaviour)", async () => {
    const client = new CoveClient({
      baseUrl: "http://127.0.0.1:8080",
      token: "cvk_unit",
      timeoutMs: 50,
      fetch: (async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            await new Promise((r) => setTimeout(r, 200));
            c.enqueue(new Uint8Array([104, 105]));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": "2" } });
      }) as typeof fetch,
    });
    const shell = localShellClient();
    const driver = new CoveSandboxDriver(shell.client, "vm", { files: filesFor(client) });
    assert.equal(await driver.readFile("/f"), "hi");
  });
});

describe("the route probe records only what proves the route", () => {
  /**
   * A server WITHOUT the file API (every /files request a bare 404), except
   * that the probe of `/` gets `probe()` instead: an answer that says
   * nothing about the route.
   */
  function apiLess(probe: () => Error) {
    const used: string[] = [];
    const files: CoveFiles = {
      stat: async (_vm, path) => {
        used.push(`stat ${path}`);
        throw path === "/" ? probe() : apiError(404);
      },
      download: async () => {
        throw apiError(404);
      },
      downloadBytes: async () => {
        throw apiError(404);
      },
      upload: async () => {
        throw apiError(404);
      },
    };
    const shell = localShellClient();
    const driver = new CoveSandboxDriver(shell.client, "vm", { files });
    return { driver, used };
  }

  for (const [label, make] of [
    ["no HTTP answer", () => new CoveConnectionError("connection reset")],
    ["a 429 that outlasts the retries", () => apiError(429)],
    ["a proxy 502", () => apiError(502)],
    ["a 503 that outlasts the retries", () => apiError(503)],
    ["a 401", () => apiError(401, "credential_invalid")],
    ["a 403 scope_denied", () => apiError(403, "scope_denied")],
  ] as const) {
    it(`${label}: not cached, probed again next time`, async () => {
      const { driver, used } = apiLess(make);
      const probes = () => used.filter((u) => u === "stat /").length;
      await assert.rejects(driver.stat(join(dir, "nope")), { code: "ENOENT" });
      assert.equal(driver.fileRoute, "unknown");
      // A 429 or 503 is retried inside one probe, so count rounds, not calls.
      const perProbe = probes();
      assert.ok(perProbe >= 1);
      await assert.rejects(driver.stat(join(dir, "nope")), { code: "ENOENT" });
      assert.equal(probes(), 2 * perProbe, "probed again");
      assert.equal(driver.fileRoute, "unknown");
    });
  }

  it("once the probe gets its answer, stat on an API-less server ends correctly over exec", async () => {
    let flaky = true;
    const { driver } = apiLess(() => (flaky ? apiError(503) : apiError(404)));
    writeFileSync(join(dir, "f"), "abc");
    // The probe is inconclusive: the HEAD 404 stands as ENOENT this time.
    await assert.rejects(driver.stat(join(dir, "f")), { code: "ENOENT" });
    flaky = false;
    // Probed again: a bare 404 for `/` too, so the route is absent and the shell answers.
    assert.equal((await driver.stat(join(dir, "f"))).size, 3);
    assert.equal(driver.fileRoute, "absent");
  });

  it("only a 400 for `/` records the route as present", async () => {
    const { driver } = apiLess(() => apiError(400, "validation_failed"));
    await assert.rejects(driver.stat(join(dir, "nope")), { code: "ENOENT" });
    assert.equal(driver.fileRoute, "present");
  });
});

describe("GET/PUT answers that mark the route present", () => {
  function refusing(err: Error) {
    const fake = fsFiles({ download: err, upload: err });
    const shell = localShellClient();
    return new CoveSandboxDriver(shell.client, "vm", { files: fake.files });
  }

  for (const [status, code] of [
    [401, "credential_invalid"],
    [403, "scope_denied"],
    [404, "vm_not_found"],
    [503, "unavailable"],
    [409, "guest_agent_too_old"],
  ] as const) {
    it(`${status} ${code} leaves fileRoute unknown`, async () => {
      const driver = refusing(apiError(status, code));
      writeFileSync(join(dir, "f"), "x");
      await driver.readFile(join(dir, "f")).catch(() => undefined);
      assert.equal(driver.fileRoute, "unknown");
    });
  }

  for (const [status, code] of [
    [404, "file_not_found"],
    [422, "file_not_regular"],
    [403, "file_path_denied"],
    [413, "file_too_large"],
  ] as const) {
    it(`${status} ${code}, which only the files handler sends, marks it present`, async () => {
      const driver = refusing(apiError(status, code));
      writeFileSync(join(dir, "f"), "x");
      await driver.readFile(join(dir, "f")).catch(() => undefined);
      assert.equal(driver.fileRoute, "present");
    });
  }
});
