import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LOCAL, copyAnywhere, expandHome, hostFromAuthority, scpArgs, serverCommand, sshArgs, withEnv } from "./remote.ts";

test("the host comes from the window's own Remote-SSH connection", () => {
  assert.equal(hostFromAuthority("ssh-remote+eda01"), "eda01");
  // VS Code percent-encodes the separator in some places.
  assert.equal(hostFromAuthority("ssh-remote%2Beda01"), "eda01");
  assert.equal(hostFromAuthority("ssh-remote+user@host.example"), "user@host.example");
});

test("an authority ssh cannot reach is refused, not guessed", () => {
  assert.equal(hostFromAuthority("wsl+Ubuntu"), undefined);
  assert.equal(hostFromAuthority("dev-container+abc"), undefined);
  assert.equal(hostFromAuthority(undefined), undefined);
  assert.equal(hostFromAuthority(""), undefined);
});

test("ssh fails fast rather than hanging on a prompt nobody can see", () => {
  const args = sshArgs({ host: "eda01", user: "" }, "uptime");
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ConnectTimeout=10"));
  assert.deepEqual(args.slice(-2), ["eda01", "uptime"]);
});

test("a user is only added when one was configured", () => {
  assert.deepEqual(sshArgs({ host: "h", user: "caio" }, "x").slice(-2), ["caio@h", "x"]);
  assert.deepEqual(sshArgs({ host: "h", user: "" }, "x").slice(-2), ["h", "x"]);
});

test("server arguments are quoted, because a session name can contain anything", () => {
  assert.equal(serverCommand("~/.janela/janela-server", ["new"]), "bash ~/.janela/janela-server 'new'");
  assert.equal(
    serverCommand("~/.janela/janela-server", ["new", "Waveforms: run 2"]),
    "bash ~/.janela/janela-server 'new' 'Waveforms: run 2'",
  );
  // A quote in the name must not end the quoting.
  assert.match(serverCommand("/s", ["new", "it's"]), /'it'\\''s'/);
});

test("no arguments produces no trailing space", () => {
  assert.equal(serverCommand("/s", []), "bash /s");
});

test("a directory needs -r, a file must not have it", () => {
  const dir = scpArgs({ host: "h", user: "" }, "/local/payload", "~/janela/staging", true);
  assert.ok(dir.includes("-r"));
  const file = scpArgs({ host: "h", user: "" }, "/local/x", "~/janela/x");
  assert.ok(!file.includes("-r"));
});

test("scp targets the same host the commands go to", () => {
  assert.deepEqual(scpArgs({ host: "eda01", user: "you" }, "/tmp/x", "~/.janela/x").slice(-2), [
    "/tmp/x",
    "you@eda01:~/.janela/x",
  ]);
});

test("variables are set with env, which is not shell syntax", () => {
  // `VAR=value command` is sh and bash only; tcsh reads it as a command name.
  const command = withEnv({ JANELA_HOME: "~/.vscode-server/janela" }, "bash /path/janela-server prefix");
  assert.equal(command, 'env JANELA_HOME="~/.vscode-server/janela" bash /path/janela-server prefix');
  assert.ok(!/^JANELA_HOME=/.test(command));
});

test("empty settings contribute no variables, and no bare env", () => {
  assert.equal(withEnv({ A: "", B: "  " }, "bash x"), "bash x");
});

test("several variables keep their order", () => {
  assert.equal(withEnv({ A: "1", B: "2" }, "cmd"), 'env A="1" B="2" cmd');
});

test("a tilde is expanded only when this machine is the server", () => {
  assert.equal(expandHome("~/x/y"), path.join(os.homedir(), "x/y"));
  // Not a home-relative path, and not ours to touch:
  assert.equal(expandHome("/tmp/x"), "/tmp/x");
  assert.equal(expandHome("~notauser/x"), "~notauser/x");
});

test("copying locally writes a real file instead of building an scp command", async () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), "janela-copy-"));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "janela-dest-"));
  try {
    fs.writeFileSync(path.join(from, "a.txt"), "hello");
    const result = await copyAnywhere(LOCAL, path.join(from, "a.txt"), path.join(to, "b.txt"));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(to, "b.txt"), "utf8"), "hello");

    // The provisioning routes copy a whole staging directory.
    const tree = await copyAnywhere(LOCAL, from, path.join(to, "tree"), true);
    assert.equal(tree.code, 0, tree.stderr);
    assert.equal(fs.readFileSync(path.join(to, "tree", "a.txt"), "utf8"), "hello");
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test("a remote target still builds an scp command, with a host on it", () => {
  const args = scpArgs({ host: "eda01", user: "" }, "/tmp/x", "~/dest", true);
  assert.ok(args.includes("eda01:~/dest"), args.join(" "));
});
