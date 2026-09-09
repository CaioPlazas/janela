import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { test } from "node:test";

import { backoffDelay, freeLocalPort, tunnelArgs, Tunnels } from "./tunnel.ts";

const TARGET = { host: "eda01", user: "" };

test("the tunnel forwards loopback to loopback and runs no command", () => {
  const args = tunnelArgs(TARGET, 51000, 14000);
  assert.ok(args.includes("-N"));
  assert.ok(args.includes("127.0.0.1:51000:127.0.0.1:14000"));
  assert.ok(args.includes("eda01"));
});

// Without this the forward can fail while ssh stays up, which looks exactly
// like a working tunnel to everything downstream.
test("a taken port is an exit, not a silent no-op", () => {
  assert.ok(tunnelArgs(TARGET, 1, 2).includes("ExitOnForwardFailure=yes"));
});

// A dead link must become an exit we can act on, rather than a hang.
test("keepalives are set, so a dead link is noticed", () => {
  const args = tunnelArgs(TARGET, 1, 2);
  assert.ok(args.includes("ServerAliveInterval=15"));
  assert.ok(args.includes("ServerAliveCountMax=3"));
});

test("a configured user reaches the host as that user", () => {
  assert.ok(tunnelArgs({ host: "eda01", user: "caio" }, 1, 2).includes("caio@eda01"));
});

test("backoff grows and then settles, so a long outage still recovers", () => {
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(3), 4000);
  // Capped: a laptop shut for a weekend should not wait hours on reopening.
  assert.equal(backoffDelay(20), 30_000);
  assert.equal(backoffDelay(20, 5000), 5000);
});

test("a free local port is one the OS gave us, and is bindable", async () => {
  const port = await freeLocalPort();
  assert.ok(port > 1024 && port < 65536, `got ${port}`);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A stand-in for the ssh child, so supervision can be tested without a server. */
class FakeSsh extends EventEmitter {
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
  die(code = 255) {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function harness(options: { reachable?: () => boolean } = {}) {
  const spawned: { args: string[]; child: FakeSsh }[] = [];
  let reachable = options.reachable ?? (() => true);
  const tunnels = new Tunnels(() => {}, {
    spawn: (_command, args) => {
      const child = new FakeSsh();
      spawned.push({ args, child });
      return child as never;
    },
    backoff: () => 1,
    probe: async () => reachable(),
  });
  return { tunnels, spawned, setReachable: (fn: () => boolean) => (reachable = fn) };
}

test("a tunnel that comes up reports itself up", async () => {
  const { tunnels, spawned } = harness();
  const tunnel = await tunnels.open(TARGET, 14000);
  assert.equal(spawned.length, 1);
  assert.equal(tunnel.status().state, "up");
  tunnel.release();
});

// The whole point. The old code deleted the entry and left every window
// pointing at a closed port with nothing to say about it.
test("when ssh dies the tunnel comes back, on the same port", async () => {
  const { tunnels, spawned } = harness();
  const tunnel = await tunnels.open(TARGET, 14000);
  const port = tunnel.localPort;
  const seen: string[] = [];
  tunnel.onState((status) => seen.push(status.state));

  spawned[0].child.stderr.emit("data", "Connection reset by peer");
  spawned[0].child.die();
  assert.deepEqual(seen, ["retrying"], "a death must be announced, not swallowed");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(spawned.length, 2, "it must be restarted");
  assert.equal(tunnel.localPort, port, "and the port must not move under the windows");
  assert.equal(seen.at(-1), "up");
  tunnel.release();
});

test("what ssh said reaches whoever is listening", async () => {
  const { tunnels, spawned } = harness();
  const tunnel = await tunnels.open(TARGET, 14000);
  let detail: string | undefined;
  tunnel.onState((status) => (detail = status.detail ?? detail));
  spawned[0].child.stderr.emit("data", "Permission denied (publickey).");
  spawned[0].child.die();
  assert.match(detail ?? "", /publickey/);
  tunnel.release();
});

test("windows of one session share a tunnel, and one closing keeps it up", async () => {
  const { tunnels, spawned } = harness();
  const first = await tunnels.open(TARGET, 14000);
  const second = await tunnels.open(TARGET, 14000);
  assert.equal(spawned.length, 1, "one session, one ssh");
  assert.equal(first.localPort, second.localPort);

  first.release();
  assert.equal(spawned[0].child.killed, false, "the other window still needs it");
  second.release();
  assert.equal(spawned[0].child.killed, true, "the last one closes it");
  assert.equal(tunnels.size, 0);
});

test("releasing stops the supervision rather than restarting forever", async () => {
  const { tunnels, spawned } = harness();
  const tunnel = await tunnels.open(TARGET, 14000);
  tunnel.release();
  spawned[0].child.die();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spawned.length, 1, "a released tunnel must not come back");
});

// spawn does not throw when the binary is missing; it emits `error`, and an
// `error` event with no listener is an uncaught exception. This spawns a real
// process rather than a fake one, because the fake never emits it - which is
// exactly why the crash survived a release.
test("a missing ssh is an error message, not a crash", async () => {
  const tunnels = new Tunnels(() => {}, {
    spawn: (_command, args) => spawn("janela-no-such-ssh-binary", args, { stdio: ["ignore", "pipe", "pipe"] }),
    backoff: () => 1,
    probe: async () => false,
  });
  await assert.rejects(
    () => tunnels.open(TARGET, 14000),
    (error: Error) => /ENOENT|no-such-ssh/i.test(error.message),
    "the failure must name what went wrong",
  );
  assert.equal(tunnels.size, 0, "and leave nothing held");
});

test("an error after the tunnel is up is announced like any other loss", async () => {
  const { tunnels, spawned } = harness();
  const tunnel = await tunnels.open(TARGET, 14000);
  const seen: string[] = [];
  tunnel.onState((status) => seen.push(`${status.state}:${status.detail ?? ""}`));
  spawned[0].child.emit("error", new Error("spawn ssh EACCES"));
  assert.match(seen.join(" "), /retrying:.*EACCES/);
  tunnel.release();
});

test("a tunnel that never comes up fails loudly instead of retrying in silence", async () => {
  const { tunnels } = harness({ reachable: () => false });
  await assert.rejects(() => tunnels.open(TARGET, 14000));
  assert.equal(tunnels.size, 0, "and leaves nothing held");
});

test("dispose kills every child, so none outlive the window", async () => {
  const { tunnels, spawned } = harness();
  await tunnels.open(TARGET, 14000);
  await tunnels.open({ host: "other", user: "" }, 14001);
  tunnels.dispose();
  assert.deepEqual(spawned.map((s) => s.child.killed), [true, true]);
  assert.equal(tunnels.size, 0);
});
