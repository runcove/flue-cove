#!/usr/bin/env bash
# verify-release.sh — check a downloaded Cove package release before it is published to a
# registry. Carried into each public package repository as .github/scripts/verify-release.sh,
# where publish.yml runs it; it runs on a workstation the same way.
#
#   verify-release.sh --dir <dir> --tag vX.Y.Z --asset <name> [--asset <name>] \
#       --registry npm|pypi --name <registry name> --pubkey <RW...> [--out <dir>]
#
# <dir> holds the release's assets, sha256.sum and sha256.sum.minisig. It exits 0 only when
# ALL of these hold, and otherwise prints one line naming the first that does not and exits 1
# (2 for a usage error):
#   - the tag is vMAJOR.MINOR.PATCH;
#   - the public key has minisign's shape (RW + 54 base64 characters), so a placeholder
#     refuses every release;
#   - sha256.sum.minisig verifies sha256.sum against that key;
#   - its trusted comment is exactly the source tag the release was signed for, of a family
#     that package takes: cove-server-vX.Y.Z or sdk-ts-vX.Y.Z for an npm SDK, cove-server-vX.Y.Z
#     or sdk-py-vX.Y.Z for PyPI, flue-vX.Y.Z (only) for @runcove/flue;
#   - sha256.sum has exactly one line per asset, and the asset's sha256 matches it;
#   - every archive member is a plain file or directory at a safe relative path, and every npm
#     tarball member sits under package/ with a POSIX ustar header, so npm and this script
#     read the same path;
#   - the artefact's own name and version are --name and the tag's version: package.json in
#     the npm tarball; the wheel's METADATA and the sdist's PKG-INFO for PyPI (names compared
#     after PEP 503 normalisation).
# For pypi, --out names an empty or missing directory that receives the wheel and the sdist
# under their PEP 427 / PEP 625 file names, built from the checked metadata, bytes unchanged.
#
# Needs bash, minisign, sha256sum and python3. Inputs are only ever passed as arguments: none
# is evaluated or spliced into code.
set -euo pipefail

PROG=verify-release
refuse() { printf '%s: refused: %s\n' "$PROG" "$*" >&2; exit 1; }
usage() {
    printf '%s: %s\n' "$PROG" "$*" >&2
    printf 'usage: verify-release.sh --dir <dir> --tag vX.Y.Z --asset <name> [--asset <name>] --registry npm|pypi --name <registry name> --pubkey <RW...> [--out <dir>]\n' >&2
    exit 2
}

dir="" tag="" registry="" name="" pubkey="" out=""
assets=()
while [ $# -gt 0 ]; do
    case "$1" in
        --dir|--tag|--asset|--registry|--name|--pubkey|--out)
            [ $# -ge 2 ] || usage "$1 needs a value"
            case "$1" in
                --dir) dir="$2" ;;
                --tag) tag="$2" ;;
                --asset) assets+=("$2") ;;
                --registry) registry="$2" ;;
                --name) name="$2" ;;
                --pubkey) pubkey="$2" ;;
                --out) out="$2" ;;
            esac
            shift 2 ;;
        *) usage "unknown argument: $1" ;;
    esac
done
[ -n "$dir" ] || usage "--dir is required"
[ -n "$registry" ] || usage "--registry is required"
[ -n "$name" ] || usage "--name is required"
[ "${#assets[@]}" -gt 0 ] || usage "at least one --asset is required"

# --- the inputs ------------------------------------------------------------------------
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || refuse "the tag '$tag' is not vMAJOR.MINOR.PATCH"
version="${tag#v}"
[[ "$pubkey" =~ ^RW[A-Za-z0-9+/]{54}$ ]] \
    || refuse "the minisign public key is not a minisign public key (RW followed by 54 base64 characters); nothing is published until the release key's public half is set"
case "$registry" in
    npm)
        [[ "$name" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$ ]] || refuse "'$name' is not an npm package name" ;;
    pypi)
        [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]] || refuse "'$name' is not a PyPI project name"
        [ -n "$out" ] || usage "--out is required for pypi" ;;
    *) usage "--registry must be npm or pypi, got '$registry'" ;;
esac
[ -d "$dir" ] || refuse "'$dir' is not a directory"

declare -A seen=()
wheel="" sdist="" tgz=""
for a in "${assets[@]}"; do
    [[ "$a" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuse "'$a' is not a plain asset file name"
    [ -z "${seen[$a]:-}" ] || refuse "the asset '$a' is named twice"
    seen[$a]=1
    case "$a" in
        *.tgz) [ -z "$tgz" ] || refuse "more than one .tgz asset"; tgz="$a" ;;
        *.whl) [ -z "$wheel" ] || refuse "more than one .whl asset"; wheel="$a" ;;
        *.tar.gz) [ -z "$sdist" ] || refuse "more than one .tar.gz asset"; sdist="$a" ;;
        *) refuse "the asset '$a' is not a .tgz, .whl or .tar.gz" ;;
    esac
done
case "$registry" in
    npm) [ -n "$tgz" ] && [ "${#assets[@]}" -eq 1 ] || refuse "an npm release takes exactly one .tgz asset" ;;
    pypi) [ -n "$wheel" ] && [ -n "$sdist" ] && [ "${#assets[@]}" -eq 2 ] \
              || refuse "a PyPI release takes exactly one .whl and one .tar.gz asset" ;;
esac
for f in sha256.sum sha256.sum.minisig "${assets[@]}"; do
    [ -f "$dir/$f" ] && [ ! -L "$dir/$f" ] || refuse "$f is missing from '$dir' (or is not a regular file)"
done

# --- the signature -----------------------------------------------------------------------
command -v minisign >/dev/null 2>&1 || refuse "minisign is not installed"
minisign -V -q -P "$pubkey" -m "$dir/sha256.sum" -x "$dir/sha256.sum.minisig" >/dev/null 2>&1 \
    || refuse "sha256.sum.minisig does not verify sha256.sum against the pinned minisign public key"
# minisign has verified the trusted comment (line 3 of the signature file) along with the file.
comment="$(sed -n 3p -- "$dir/sha256.sum.minisig")"
[[ "$comment" =~ ^trusted\ comment:\ ((cove-server|sdk-ts|sdk-py|flue)-v[0-9]+\.[0-9]+\.[0-9]+)$ ]] \
    || refuse "the signature's trusted comment is not 'trusted comment: <source tag>' with a cove-server, sdk-ts, sdk-py or flue release tag"
source_tag="${BASH_REMATCH[1]}"
# Each package takes only its own source releases: the SDKs ride cove-server releases or their
# own sdk-ts / sdk-py tags; Flue has only flue tags.
family="${BASH_REMATCH[2]}"
case "$registry:$name:$family" in
    npm:@runcove/flue:flue) ;;
    npm:@runcove/flue:*) refuse "a $family release cannot publish $name" ;;
    npm:*:cove-server|npm:*:sdk-ts|pypi:*:cove-server|pypi:*:sdk-py) ;;
    *) refuse "a $family release cannot publish $name" ;;
esac

# --- the hashes --------------------------------------------------------------------------
for a in "${assets[@]}"; do
    n=0 want=""
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || refuse "sha256.sum has a line that is not '<sha256>  <name>'"
        if [ "${BASH_REMATCH[2]}" = "$a" ]; then n=$((n + 1)); want="${BASH_REMATCH[1]}"; fi
    done < "$dir/sha256.sum"
    [ "$n" -eq 1 ] || refuse "sha256.sum has $n lines for $a, not exactly one"
    got="$(sha256sum -- "$dir/$a")"; got="${got%% *}"
    [ "$got" = "$want" ] || refuse "$a does not match its sha256.sum line"
done

# --- the artefacts' own names and versions -------------------------------------------------
# meta <kind> <file>: three lines, the artefact's name, its version and (wheel and sdist) its
# standard file name. Every input reaches Python as an argument; the program is fixed text.
meta() {
    python3 - "$1" "$2" <<'PY'
import email.parser, gzip, json, re, sys, tarfile, zipfile

class Refused(Exception):
    pass

def fail(msg):
    raise Refused(msg)

def headers(raw, what):
    msg = email.parser.HeaderParser().parsestr(raw.decode("utf-8"))
    vals = []
    for key in ("Name", "Version"):
        got = msg.get_all(key) or []
        if len(got) != 1 or not got[0].strip():
            fail(f"{what} does not have exactly one {key}")
        vals.append(got[0].strip())
    return vals

def under(name):  # PEP 427 / PEP 625 distribution name
    return re.sub(r"[-_.]+", "_", name).lower()

NPM_NAME = r"(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*"
PYPI_NAME = r"[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?"
VERSION = r"[0-9A-Za-z.+!_-]+"

def emit(what, name, version, name_re, file_name=""):
    # Every line printed is checked first, so no value can carry a line break (or anything
    # else) into the shell's three-line read.
    if not re.fullmatch(name_re, name):
        fail(f"{what} has a malformed name")
    if not re.fullmatch(VERSION, version):
        fail(f"{what} has a malformed version")
    if file_name and not re.fullmatch(r"[A-Za-z0-9_.+!-]+", file_name):
        fail(f"{what} gives a malformed file name")
    print(name); print(version); print(file_name)

def safe_members(t, what):
    # Every member a plain file or directory at a relative path with no `..`: an archive that
    # could point outside itself, or link to something, is refused whatever the registry does.
    # node-tar (npm) splits a name on "/", drops the first part and path.resolve()s the rest,
    # so package/./package.json and package//package.json both land on package/package.json
    # while this check would read them as other files: any empty, "." or ".." part is refused.
    # (tarfile strips a directory entry's trailing "/", so directories still pass.)
    members = t.getmembers()
    for m in members:
        parts = m.name.split("/")
        if not m.name or m.name.startswith("/") or any(p in ("", ".", "..") for p in parts):
            fail(f"{what} has an unsafe member path")
        if not (m.isfile() or m.isdir()):
            fail(f"{what} has a member that is neither a file nor a directory")
    return members

def posix_headers(path, what):
    # Python's tarfile joins the ustar prefix field (bytes 345-500) onto a member's name whatever
    # the header magic says; node-tar (npm) uses it only for POSIX magic "ustar\0" + "00". A
    # header with another magic (GNU "ustar  \0", or none at all) would be a different path to
    # npm than to tarfile, so every raw header block, pax extended headers included, must carry
    # exactly the POSIX magic. A pax global header (typeflag g) is refused outright. npm pack
    # writes POSIX headers, so a genuine tarball passes.
    with gzip.open(path, "rb") as f:
        while True:
            block = f.read(512)
            if len(block) < 512 or block == bytes(512):
                return
            if block[257:265] != b"ustar\x0000":
                fail(f"{what} has a header that is not POSIX ustar")
            if block[156:157] == b"g":
                fail(f"{what} has a pax global header")
            if block[124] & 0x80:
                fail(f"{what} has a header size in an unsupported encoding")
            try:
                size = int(block[124:136].rstrip(b"\x00 ") or b"0", 8)
            except ValueError:
                fail(f"{what} has a header with a malformed size")
            skip = (size + 511) // 512 * 512
            if len(f.read(skip)) < skip:
                return

def main(kind, path):
    if kind == "npm":
        posix_headers(path, "the npm tarball")
        with tarfile.open(path, "r:gz") as t:
            members = safe_members(t, "the npm tarball")
            if any(m.name == "package" and not m.isdir() for m in members):
                fail("the npm tarball has a member named package that is not a directory")
            # npm drops the first path component of every member, so any other top-level
            # directory could override package/: everything must sit under package/.
            if any(m.name != "package" and not m.name.startswith("package/") for m in members):
                fail("the npm tarball has a member outside package/")
            hits = [m for m in members if m.name == "package/package.json"]
            if len(hits) != 1 or not hits[0].isfile():
                fail("the npm tarball does not hold exactly one package/package.json")
            pkg = json.load(t.extractfile(hits[0]))
        name, version = pkg.get("name"), pkg.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            fail("the npm tarball's package.json has no string name and version")
        emit("the npm tarball's package.json", name, version, NPM_NAME)
    elif kind == "wheel":
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            if any(not n or n.startswith("/") or ".." in n.split("/") for n in names):
                fail("the wheel has an unsafe member path")
            metas = [n for n in names if re.fullmatch(r"[^/]+\.dist-info/METADATA", n)]
            if len(metas) != 1:
                fail("the wheel does not hold exactly one .dist-info/METADATA")
            info = metas[0].split("/")[0]
            name, version = headers(z.read(metas[0]), "the wheel's METADATA")
            if f"{info}/WHEEL" not in names:
                fail("the wheel has no .dist-info/WHEEL")
            wmsg = email.parser.HeaderParser().parsestr(z.read(f"{info}/WHEEL").decode("utf-8"))
        tags = wmsg.get_all("Tag") or []
        if not tags or any(len(t.strip().split("-")) != 3 for t in tags):
            fail("the wheel's WHEEL file has no well-formed Tag")
        parts = [t.strip().split("-") for t in tags]
        py, abi, plat = (sorted({p[i] for p in parts}) for i in range(3))
        if len(set(map(tuple, parts))) != len(py) * len(abi) * len(plat):
            fail("the wheel's tags are not a compressible tag set")
        build = (wmsg.get_all("Build") or [None])[0]
        if build is not None and not re.fullmatch(r"[0-9][A-Za-z0-9_.]*", build.strip()):
            fail("the wheel's build tag is malformed")
        stem = [under(name), version] + ([build.strip()] if build else []) + [".".join(py), ".".join(abi), ".".join(plat)]
        emit("the wheel", name, version, PYPI_NAME, "-".join(stem) + ".whl")
    elif kind == "sdist":
        with tarfile.open(path, "r:gz") as t:
            members = safe_members(t, "the sdist")
            tops = {m.name.split("/")[0] for m in members}
            if len(tops) != 1:
                fail("the sdist does not have exactly one top-level directory")
            top = tops.pop()
            hits = [m for m in members if m.name == f"{top}/PKG-INFO"]
            if len(hits) != 1 or not hits[0].isfile():
                fail("the sdist does not hold exactly one PKG-INFO at its top level")
            name, version = headers(t.extractfile(hits[0]).read(), "the sdist's PKG-INFO")
        emit("the sdist", name, version, PYPI_NAME, f"{under(name)}-{version}.tar.gz")
    else:
        fail(f"unknown kind {kind}")

try:
    main(sys.argv[1], sys.argv[2])
except Refused as e:
    print(e)
    sys.exit(1)
except Exception as e:  # a corrupt or truncated archive: one line, never a traceback
    print(f"cannot be read ({e.__class__.__name__})")
    sys.exit(1)
PY
}

# pep503 <name>: the PEP 503 normalised form, compared case- and separator-insensitively.
pep503() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[-_.]+/-/g'; }

# check <kind> <asset>: sets file_name; refuses on a name or version mismatch.
check() {
    local m got_name got_version
    # On a refusal the helper prints its one-line reason on stdout and exits 1.
    m="$(meta "$1" "$dir/$2" 2>/dev/null)" || refuse "$2: $(head -1 <<<"${m:-cannot be read}")"
    file_name=""
    { IFS= read -r got_name; IFS= read -r got_version; IFS= read -r file_name || true; } <<<"$m"
    if [ "$1" = npm ]; then
        [ "$got_name" = "$name" ] || refuse "$2 is the npm package '$got_name', not '$name'"
    else
        [ "$(pep503 "$got_name")" = "$(pep503 "$name")" ] || refuse "$2 is the PyPI project '$got_name', not '$name'"
    fi
    [ "$got_version" = "$version" ] || refuse "$2 is version '$got_version', not the tag's $version"
}

case "$registry" in
    npm) check npm "$tgz" ;;
    pypi)
        check wheel "$wheel"; wheel_out="$file_name"
        check sdist "$sdist"; sdist_out="$file_name"
        if [ -e "$out" ]; then
            [ -d "$out" ] && [ -z "$(ls -A -- "$out")" ] || refuse "the output '$out' is not an empty directory"
        else
            mkdir -p -- "$out"
        fi
        command cp -f -- "$dir/$wheel" "$out/$wheel_out"
        command cp -f -- "$dir/$sdist" "$out/$sdist_out"
        if ! cmp -s -- "$dir/$wheel" "$out/$wheel_out" || ! cmp -s -- "$dir/$sdist" "$out/$sdist_out"; then
            refuse "the copies in '$out' differ from the verified files"
        fi
        printf '%s: wrote %s and %s to %s\n' "$PROG" "$wheel_out" "$sdist_out" "$out" ;;
esac

printf '%s: OK: %s %s, signed as source release %s\n' "$PROG" "$name" "$version" "$source_tag"
