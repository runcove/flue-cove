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
import {
  SandboxDiedError,
  SandboxOperationUnsupportedError,
  sandboxFromDriver,
} from "@flue/runtime";
import { CoveSandboxDriver } from "../src/driver.ts";
import {
  CoveFileError,
  type CoveFiles,
  DownloadTruncatedError,
  FileNotRegularError,
  VmFileNotFoundError,
} from "../src/files.ts";
import { localShellClient } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "flue-cove-files-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * A CoveFiles fake served from the local filesystem with Cove's rules:
 * regular files only, a symlink anywhere in the path or a non-regular target
 * is 422 `file_not_regular`, a missing file or parent is 404, uploads keep an
 * existing file's mode. `override` forces an error for a method.
 */
function fsFiles(override: Partial<Record<"stat" | "download" | "upload", CoveFileError>> = {}) {
  const used: string[] = [];
  const check = (path: string, forWrite: boolean) => {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const [i, part] of parts.entries()) {
      cur += `/${part}`;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(cur);
      } catch {
        if (forWrite && i === parts.length - 1) return;
        throw new VmFileNotFoundError(404, "file_not_found", `file not found: ${cur}`);
      }
      if (st.isSymbolicLink()) {
        throw new FileNotRegularError(422, "file_not_regular", `${cur} is a symbolic link`);
      }
      if (i === parts.length - 1 && !st.isFile()) {
        throw new FileNotRegularError(422, "file_not_regular", `${cur} is not a regular file`);
      }
    }
  };
  const files: CoveFiles = {
    async stat(_vm, path) {
      used.push(`stat ${path}`);
      if (override.stat) throw override.stat;
      check(path, false);
      const st = statSync(path);
      return { size: st.size, mode: st.mode & 0o777 };
    },
    async downloadBytes(_vm, path) {
      used.push(`download ${path}`);
      if (override.download) throw override.download;
      check(path, false);
      return new Uint8Array(readFileSync(path));
    },
    async download(vm, path) {
      const bytes = await files.downloadBytes(vm, path);
      return { size: bytes.length, body: new Blob([new Uint8Array(bytes)]).stream() };
    },
    async upload(_vm, path, bytes) {
      used.push(`upload ${path}`);
      if (override.upload) throw override.upload;
      check(path, true);
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
  return { driver, used: fake.used, calls: shell.calls };
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
      const { driver, calls } = setup({ download: new CoveFileError(status, code, "x") });
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
      download: new DownloadTruncatedError(200, undefined, "received 3 of 10 bytes"),
    });
    writeFileSync(join(dir, "f"), "0123456789");
    await assert.rejects(driver.readFile(join(dir, "f")), /3 of 10 bytes/);
    assert.equal(calls.length, 0);
  });

  it("413 file_too_large is an error, not an exec fallback", async () => {
    const { driver, calls } = setup({
      download: new CoveFileError(413, "file_too_large", "limit is 100 MiB"),
    });
    await assert.rejects(driver.readFile(join(dir, "f")), /100 MiB/);
    assert.equal(calls.length, 0);
  });

  it("503 unavailable surfaces", async () => {
    const { driver } = setup({ download: new CoveFileError(503, "unavailable", "retry") });
    await assert.rejects(driver.readFile(join(dir, "f")), /retry/);
  });

  it("409 invalid_state_transition is SandboxDiedError", async () => {
    const { driver } = setup({
      download: new CoveFileError(409, "invalid_state_transition", "not running"),
    });
    await assert.rejects(driver.readFile(join(dir, "f")), SandboxDiedError);
  });

  it("404 vm_not_found is SandboxDiedError", async () => {
    const { driver } = setup({ download: new CoveFileError(404, "vm_not_found", "gone") });
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
    const { driver } = setup({ upload: new CoveFileError(422, "file_not_regular", "x") });
    await driver.writeFile(join(dir, "empty"), "");
    assert.equal(readFileSync(join(dir, "empty"), "utf8"), "");
  });

  it("413 is an error, not a fallback", async () => {
    const { driver, calls } = setup({
      upload: new CoveFileError(413, "file_too_large", "too big"),
    });
    await assert.rejects(driver.writeFile(join(dir, "f"), "x"), /too big/);
    assert.equal(calls.length, 0);
  });

  it("507 guest_disk_full surfaces", async () => {
    const { driver } = setup({ upload: new CoveFileError(507, "guest_disk_full", "disk full") });
    await assert.rejects(driver.writeFile(join(dir, "f"), "x"), /disk full/);
  });

  for (const name of NASTY_NAMES) {
    it(`round-trips the awkward name ${JSON.stringify(name)} over exec`, async () => {
      const { driver } = setup({
        upload: new CoveFileError(422, "file_not_regular", "x"),
        download: new CoveFileError(422, "file_not_regular", "x"),
      });
      await driver.writeFile(join(dir, name), `content of ${name}`);
      assert.equal(await driver.readFile(join(dir, name)), `content of ${name}`);
    });
  }
});

describe("stat", () => {
  it("a regular file via HEAD: type, size, not a symlink, no invented mtime", async () => {
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
    const { driver } = setup({ stat: new CoveFileError(413, undefined, "too large") });
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
    const boom = new CoveFileError(0, undefined, "network down");
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
      download: new CoveFileError(403, "scope_denied", "key lacks files:read"),
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
      upload: new CoveFileError(403, "scope_denied", "key lacks files:write"),
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
