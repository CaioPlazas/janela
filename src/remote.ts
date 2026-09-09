/**
 * Talking to the server from the machine the user is sitting at.
 *
 * The extension runs on the laptop now, because that is where the xpra client
 * has to be launched. Everything it needs to know about the server therefore
 * arrives over ssh - the same ssh that Remote-SSH already uses, with the same
 * keys, which is why there is no authentication code anywhere in this project.
 *
 * One script answers every server-side question (`scripts/janela-server`), so
 * this module only has to know how to reach it.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The host to talk to, taken from the window's own remote connection.
 *
 * VS Code reports `ssh-remote+eda01` while connected over Remote-SSH. Any
 * other authority (a container, WSL, a tunnel) is not something ssh can reach
 * the same way, so it is refused rather than guessed at.
 */
export function hostFromAuthority(authority: string | undefined): string | undefined {
  if (!authority) {
    return undefined;
  }
  const match = /^ssh-remote\+(.+)$/.exec(decodeURIComponent(authority));
  return match?.[1] || undefined;
}

export interface RemoteTarget {
  host: string;
  /** Empty when ssh config decides, which is the normal case. */
  user: string;
}

/** `ssh` arguments for one command. BatchMode so a missing key fails rather
 *  than hanging on a password prompt nobody can see. */
export function sshArgs(target: RemoteTarget, command: string): string[] {
  const where = target.user ? `${target.user}@${target.host}` : target.host;
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", where, command];
}

/**
 * Where the server-side script lives once pushed, and how to run it.
 *
 * `bash <path>` rather than executing it: scp does not always carry the execute
 * bit, and a login shell on the far side may be anything.
 */
export function serverCommand(remotePath: string, args: string[]): string {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  return `bash ${remotePath}${quoted ? ` ${quoted}` : ""}`;
}

export interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runRemote(target: RemoteTarget, command: string, timeoutMs = 120_000): Promise<RemoteResult> {
  return new Promise((resolve) => {
    execFile("ssh", sshArgs(target, command), { timeout: timeoutMs, maxBuffer: 1 << 25 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as never as { code?: number }).code === "number"
          ? (error as never as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Copy to the server: one file, or a directory when `recursive`. */
export function scpArgs(
  target: RemoteTarget,
  localPath: string,
  remotePath: string,
  recursive = false,
): string[] {
  const where = target.user ? `${target.user}@${target.host}` : target.host;
  return ["-o", "BatchMode=yes", ...(recursive ? ["-r"] : []), localPath, `${where}:${remotePath}`];
}

export function copyToRemote(
  target: RemoteTarget,
  localPath: string,
  remotePath: string,
  recursive = false,
  // 200 MB over a slow link takes as long as it takes; the default would give up.
  timeoutMs = 3_600_000,
): Promise<RemoteResult> {
  return new Promise((resolve) => {
    execFile("scp", scpArgs(target, localPath, remotePath, recursive), { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Set variables for one remote command, in a way every login shell accepts.
 *
 * `VAR=value command` is sh and bash syntax. ssh hands what it is given to the
 * account's login shell, and on an EDA server that is routinely tcsh, which
 * reads `JANELA_HOME=...` as the name of a command and reports it missing -
 * which is exactly how this was found. `env` is a program, so it works under
 * any of them.
 */
export function withEnv(variables: Record<string, string>, command: string): string {
  const set = Object.entries(variables)
    .filter(([, value]) => value.trim() !== "")
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  return set.length > 0 ? `env ${set.join(" ")} ${command}` : command;
}

/**
 * The server is this machine.
 *
 * With no Remote-SSH authority and no configured host there is nothing to ssh
 * to, and nothing that needs it: `janela-server` is a shell script and the
 * session's socket is already on loopback. This is a real way to use Janela on
 * a Linux desktop, and it is also what lets the extension be driven end to end
 * by a test, which no amount of ssh mocking would have achieved honestly.
 */
export const LOCAL: RemoteTarget = { host: "", user: "" };

export function isLocal(target: RemoteTarget): boolean {
  return target.host === "";
}

export function runLocal(command: string, timeoutMs = 120_000): Promise<RemoteResult> {
  return new Promise((resolve) => {
    execFile("bash", ["-c", command], { timeout: timeoutMs, maxBuffer: 1 << 25 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as never as { code?: number }).code === "number"
          ? (error as never as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Reach the server, wherever it is. */
export function runAnywhere(target: RemoteTarget, command: string, timeoutMs?: number): Promise<RemoteResult> {
  return isLocal(target) ? runLocal(command, timeoutMs) : runRemote(target, command, timeoutMs);
}

/**
 * `~` belongs to a shell, not to Node.
 *
 * Every path Janela uses on the server is written the way a user would write it,
 * and a remote shell expands it. When the server is this machine there is no
 * shell in the way, so it has to be done here.
 */
export function expandHome(target: string): string {
  return target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
}

/**
 * Copy to the server, wherever it is.
 *
 * The three provisioning routes each called `copyToRemote` directly, so in local
 * mode they built `scp -r <dir> :~/...` - a remote path with no host - and
 * provisioning could not work at all. Deciding once, here, is why this exists
 * rather than a fourth `isLocal` check at a fourth call site.
 */
export async function copyAnywhere(
  target: RemoteTarget,
  localPath: string,
  remotePath: string,
  recursive = false,
  timeoutMs?: number,
): Promise<RemoteResult> {
  if (!isLocal(target)) {
    return copyToRemote(target, localPath, remotePath, recursive, timeoutMs);
  }
  try {
    const destination = expandHome(remotePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(localPath, destination, { recursive });
    return { code: 0, stdout: "", stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String(error) };
  }
}
