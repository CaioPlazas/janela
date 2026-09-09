/**
 * The ssh tunnel the windows connect through, and the thing that keeps it up.
 *
 * A session's websocket is bound to `127.0.0.1` on the server and nowhere else,
 * so nothing reaches it but a tunnel. Two properties matter more than anything
 * else here, because a session manager whose sessions you cannot get back to is
 * worse than none at all:
 *
 *   1. **The local port never moves.** A page is built with `127.0.0.1:<port>`
 *      baked into it, and the client's own reconnect goes back to that address.
 *      If a rebuilt tunnel came up somewhere else, every open window would be
 *      stranded with no way to say so. The port is chosen once per session and
 *      kept for as long as anything needs it.
 *   2. **The child is supervised.** ssh dies when the link does - a closed lid,
 *      a dropped VPN - and the old code simply forgot about it. Now it comes
 *      back, on the same port, with a backoff, and the windows are told where
 *      they stand while it is away.
 *
 * One tunnel per session, shared by every window of it.
 */

import { ChildProcess, spawn } from "child_process";
import * as net from "net";

import type { RemoteTarget } from "./remote.ts";

/** `up` - the port answers. `retrying` - ssh went away and is coming back.
 *  `failed` - it has stopped trying, which only happens once nothing needs it. */
export type TunnelState = "up" | "retrying" | "failed";

export interface TunnelStatus {
  state: TunnelState;
  /** What ssh said, when it said anything. Shown to the user verbatim: this is
   *  the difference between "the server is down" and "your key was refused". */
  detail?: string;
  attempt?: number;
}

export type TunnelListener = (status: TunnelStatus) => void;

/**
 * `ssh -N -L` for one session.
 *
 * `-N` because no command should run: the tunnel is the point.
 * `ExitOnForwardFailure` turns a port already in use into a non-zero exit
 * rather than a connection that silently is not forwarded. The keepalives make
 * a dead link show up as an exit within about a minute instead of hanging
 * forever, which is what makes supervision possible at all.
 */
export function tunnelArgs(target: RemoteTarget, localPort: number, remotePort: number): string[] {
  const where = target.user ? `${target.user}@${target.host}` : target.host;
  return [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    where,
  ];
}

/** How long to wait before the next attempt. Backs off, then settles: a laptop
 *  shut for the weekend should still find its session when it opens. */
export function backoffDelay(attempt: number, ceilingMs = 30_000): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), ceilingMs);
}

/** A port nothing is listening on, asked of the operating system rather than
 *  guessed. */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free local port"))));
    });
  });
}

/** Whether something answers on a local port yet. */
export function answers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

export interface Tunnel {
  localPort: number;
  status(): TunnelStatus;
  /** Told whenever the tunnel's state changes. Returns an unsubscribe. */
  onState(listener: TunnelListener): () => void;
  /** Drop one user of this tunnel. The last one closes it. */
  release(): void;
}

/** How a child process gets started. Injected so supervision can be tested
 *  without an ssh server, which is the only way it ever gets tested at all. */
export type Spawner = (command: string, args: string[]) => ChildProcess;

const defaultSpawner: Spawner = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

interface Held {
  child: ChildProcess | undefined;
  localPort: number;
  users: number;
  status: TunnelStatus;
  listeners: Set<TunnelListener>;
  timer: NodeJS.Timeout | undefined;
  attempt: number;
  /** Set while release() is tearing it down, so the exit is not a failure to
   *  recover from. */
  stopping: boolean;
}

export interface TunnelsOptions {
  spawn?: Spawner;
  /** Overridable so tests do not wait real seconds. */
  backoff?: (attempt: number) => number;
  probe?: (port: number) => Promise<boolean>;
}

export class Tunnels {
  private readonly held = new Map<string, Held>();
  private readonly log: (message: string) => void;
  private readonly spawner: Spawner;
  private readonly backoff: (attempt: number) => number;
  private readonly probe: (port: number) => Promise<boolean>;

  constructor(log: (message: string) => void, options: TunnelsOptions = {}) {
    this.log = log;
    this.spawner = options.spawn ?? defaultSpawner;
    this.backoff = options.backoff ?? backoffDelay;
    this.probe = options.probe ?? answers;
  }

  private key(target: RemoteTarget, remotePort: number): string {
    return `${target.user}@${target.host}:${remotePort}`;
  }

  private publish(held: Held, status: TunnelStatus): void {
    held.status = status;
    for (const listener of held.listeners) {
      try {
        listener(status);
      } catch {
        // A listener throwing must not stop the tunnel or the other listeners.
      }
    }
  }

  private handle(key: string, held: Held): Tunnel {
    return {
      localPort: held.localPort,
      status: () => held.status,
      onState: (listener) => {
        held.listeners.add(listener);
        return () => held.listeners.delete(listener);
      },
      release: () => this.release(key),
    };
  }

  /**
   * Open a tunnel, or take a share of one already open.
   *
   * Resolves once the port answers. After that it stays up on its own: a caller
   * never has to reopen it, and must not, because reopening is what used to
   * move the port out from under the windows.
   */
  async open(target: RemoteTarget, remotePort: number): Promise<Tunnel> {
    const key = this.key(target, remotePort);
    const existing = this.held.get(key);
    if (existing) {
      existing.users++;
      return this.handle(key, existing);
    }

    const held: Held = {
      child: undefined,
      localPort: await freeLocalPort(),
      users: 1,
      status: { state: "retrying", attempt: 0 },
      listeners: new Set(),
      timer: undefined,
      attempt: 0,
      stopping: false,
    };
    this.held.set(key, held);

    const ready = await this.start(key, held, target, remotePort);
    if (!ready) {
      // Never came up at all: an unknown host, a refused key, a port in use.
      // Nothing is holding it open yet, so fail loudly rather than sit in a
      // retry loop the caller cannot see.
      this.stop(held);
      this.held.delete(key);
      throw new Error(held.status.detail ?? `the tunnel to ${target.host}:${remotePort} did not come up`);
    }
    return this.handle(key, held);
  }

  /** Spawn the child and wait for the port. Resolves false if it never answers. */
  private async start(key: string, held: Held, target: RemoteTarget, remotePort: number): Promise<boolean> {
    held.attempt++;
    const child = this.spawner("ssh", tunnelArgs(target, held.localPort, remotePort));
    held.child = child;

    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

    // `spawn` does not throw when the binary is missing - it emits `error`, and
    // an `error` event with no listener is an uncaught exception. On a machine
    // without OpenSSH on PATH that took the extension host down instead of
    // saying "ssh is not installed".
    child.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
    });

    let ended = false;
    const ending = (code: number | null) => {
      if (ended || held.stopping || this.held.get(key) !== held) {
        return;
      }
      ended = true;
      const detail = stderr.trim() || `ssh exited with ${code}`;
      this.log(`tunnel to ${target.host}:${remotePort} went away: ${detail}`);
      this.publish(held, { state: "retrying", detail, attempt: held.attempt });
      // The link came back is the common case, so keep going indefinitely: a
      // laptop shut for a weekend must still find its session when it opens.
      const wait = this.backoff(held.attempt);
      held.timer = setTimeout(() => {
        // A rejection here would be unhandled and would stop the supervision
        // silently, which is the failure this whole class is meant to prevent.
        this.start(key, held, target, remotePort).then(
          (up) => up && this.log(`tunnel to ${target.host}:${remotePort} is back on ${held.localPort}`),
          (error) => this.log(`tunnel to ${target.host}:${remotePort} could not be restarted: ${error}`),
        );
      }, wait);
    };

    child.on("exit", ending);
    // Both can fire; whichever is first wins and the other is ignored.
    child.on("error", () => ending(child.exitCode));

    for (let tries = 0; tries < 40; tries++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        held.status = { state: "retrying", detail: stderr.trim(), attempt: held.attempt };
        return false;
      }
      if (await this.probe(held.localPort)) {
        held.attempt = 0;
        this.publish(held, { state: "up" });
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    held.status = { state: "retrying", detail: stderr.trim() || "the forwarded port never answered", attempt: held.attempt };
    return false;
  }

  private stop(held: Held): void {
    held.stopping = true;
    if (held.timer) {
      clearTimeout(held.timer);
      held.timer = undefined;
    }
    held.child?.kill();
    held.child = undefined;
  }

  private release(key: string): void {
    const held = this.held.get(key);
    if (!held) {
      return;
    }
    held.users--;
    if (held.users > 0) {
      return;
    }
    this.held.delete(key);
    this.stop(held);
    this.publish(held, { state: "failed", detail: "closed" });
    held.listeners.clear();
    this.log(`tunnel closed: ${key}`);
  }

  /** For tests and diagnosis: what is held right now. */
  get size(): number {
    return this.held.size;
  }

  /** On deactivate: leaving ssh children behind would outlive the window. */
  dispose(): void {
    for (const [key, held] of [...this.held]) {
      this.held.delete(key);
      this.stop(held);
      held.listeners.clear();
    }
  }
}
