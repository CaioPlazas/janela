import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { isIntact, parseExplicit, parseRpmList, sha256Of, stagingLayout } from "./payload.ts";

const SAMPLE = [
  "@EXPLICIT",
  "https://conda.anaconda.org/conda-forge/linux-64/_openmp_mutex-4.5-20_gnu.conda#a9f577da",
  "https://conda.anaconda.org/conda-forge/noarch/adwaita-icon-theme-49.0-unix_0.conda#b3f01795",
  "",
  "# a comment line that is not a url",
].join("\n");

test("the pinned list yields a url, a checksum and a filename", () => {
  const entries = parseExplicit(SAMPLE);
  assert.equal(entries.length, 2, "the header and the comment are not packages");
  assert.deepEqual(entries[0], {
    url: "https://conda.anaconda.org/conda-forge/linux-64/_openmp_mutex-4.5-20_gnu.conda",
    sha256: "a9f577da",
    name: "_openmp_mutex-4.5-20_gnu.conda",
  });
  // noarch packages sit in a different directory and must parse the same way.
  assert.equal(entries[1].name, "adwaita-icon-theme-49.0-unix_0.conda");
});

test("a list generated without checksums still parses, with none", () => {
  const entries = parseExplicit("@EXPLICIT\nhttps://example.test/x-1.0.conda");
  assert.equal(entries[0].sha256, "");
});

test("a file is only intact when it matches what the list says", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janela-payload-"));
  const file = path.join(dir, "pkg.conda");
  fs.writeFileSync(file, "the real contents");
  const real = sha256Of(file);

  assert.equal(isIntact(file, real), true);
  // A truncated download is the failure this exists to catch: it was shipped
  // once, and the offline install died three steps later naming another file.
  fs.writeFileSync(file, "the real conte");
  assert.equal(isIntact(file, real), false);
  assert.equal(isIntact(path.join(dir, "absent.conda"), real), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("with no checksum, presence is all that can be checked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janela-payload-"));
  const file = path.join(dir, "pkg.conda");
  fs.writeFileSync(file, "anything");
  assert.equal(isIntact(file, ""), true);
  assert.equal(isIntact(path.join(dir, "gone.conda"), ""), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the staging layout is what bootstrap-offline looks for", () => {
  const layout = stagingLayout("/remote/staging");
  assert.equal(layout.packages, path.join("/remote/staging", "pkgs"));
  assert.equal(layout.explicit, path.join("/remote/staging", "explicit.txt"));
  assert.equal(layout.micromamba, path.join("/remote/staging", "micromamba"));
});

const RPM_LIST = `# xpra 6.4.4 server for python3.11 on el8. GENERATED -- do not edit.
# 13 packages, 15.3 MB
python 3.11
need libX11.so.6
need libgdk-3.so.0
rpm 1a2b3c 	https://xpra.org/dists/rockylinux/8/x86_64/xpra-common-6.4.4-10.r0.el8.x86_64.rpm
rpm 4d5e6f https://xpra.org/dists/rockylinux/8/x86_64/libyuv-0-0.1899.el8.x86_64.rpm
`;

test("an RPM list gives the interpreter, the packages and what must already be there", () => {
  const list = parseRpmList(RPM_LIST);
  assert.equal(list.python, "3.11");
  assert.deepEqual(list.libs, ["libX11.so.6", "libgdk-3.so.0"]);
  assert.equal(list.entries.length, 2);
  assert.deepEqual(list.entries[0], {
    url: "https://xpra.org/dists/rockylinux/8/x86_64/xpra-common-6.4.4-10.r0.el8.x86_64.rpm",
    sha256: "1a2b3c",
    name: "xpra-common-6.4.4-10.r0.el8.x86_64.rpm",
  });
});

test("comments and blank lines in an RPM list are not packages", () => {
  const list = parseRpmList("# rpm not-a-package\n\npython 3.12\n");
  assert.equal(list.entries.length, 0);
  assert.equal(list.python, "3.12");
});

test("an RPM line missing its url is dropped rather than half-parsed", () => {
  assert.equal(parseRpmList("rpm deadbeef\n").entries.length, 0);
});
