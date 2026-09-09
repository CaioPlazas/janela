/**
 * Janela: a session manager for remote X11 applications.
 *
 * The extension runs on the machine the user is sitting at, because that is
 * where the xpra client has to be launched. Everything about the server is
 * asked over ssh - the same ssh Remote-SSH already uses - and answered by one
 * script, `scripts/janela-server`, which lives there because every question it
 * answers is about that filesystem.
 *
 * Pixels are not this extension's business. The native client draws them, in
 * real windows on the desktop, which is why there is no webview here, no
 * keyboard grab, no scaling and no passphrase.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { downloadMicromamba, downloadPayload, parseExplicit, parseRpmList, stagingLayout } from "./payload.ts";
import {
  copyAnywhere,
  hostFromAuthority,
  isLocal,
  LOCAL,
  runAnywhere,
  serverCommand,
  type RemoteTarget,
  withEnv,
} from "./remote.ts";
import { registry, type Registry, type ServerRunner, type Status } from "./sessions.ts";
import { SessionTree, WindowNode, type SessionNode } from "./sessionTree.ts";
import { Tunnels } from "./tunnel.ts";
import { SessionWindows } from "./windows.ts";

/** Inside VS Code's folders, but not under any extension's per-extension
 *  storage: that path is deleted with the extension, which cost a working xpra
 *  once already. A full server uninstall still removes it, so everything here
 *  is re-creatable and gets re-created when it is found missing. */
function serverDir(): string {
  return config().get<string>("serverDir", "~/.vscode-server/janela").trim() || "~/.vscode-server/janela";
}
const remoteScript = () => `${serverDir()}/janela-server`;

let output: vscode.LogOutputChannel;
let tree: SessionTree;
let known: Registry | undefined;
let runner: ServerRunner | undefined;
let scriptPushed = false;
/** ssh -L, one per session, shared by that session's windows. */
let tunnels: Tunnels;
/** Sessions currently on screen, so attaching twice reveals rather than
 *  doubles. */
const opened = new Map<string, SessionWindows>();
/** Sessions we have not seen in the last status, and how many times running.
 *  One miss is a hiccup; two is gone. */
const missing = new Map<string, number>();

/**
 * Close the windows of a session that is no longer there.
 *
 * A session can end without this extension being told - killed from a shell, or
 * the machine rebooted. Its windows would otherwise sit reconnecting forever to
 * something that is never coming back, which says the wrong thing very
 * persistently. Two consecutive absences, so a single failed poll does not
 * close anything.
 */
function forgetDeadSessions(status: Status): void {
  const alive = new Set(status.sessions.filter((s) => s.state === "LIVE").map((s) => s.display));
  for (const display of [...opened.keys()]) {
    if (alive.has(display)) {
      missing.delete(display);
      continue;
    }
    const strikes = (missing.get(display) ?? 0) + 1;
    missing.set(display, strikes);
    if (strikes >= 2) {
      output.info(`${display} is gone; closing the windows it was showing`);
      opened.get(display)?.dispose();
      opened.delete(display);
      missing.delete(display);
    }
  }
}


function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("janela");
}

/**
 * The server, from the setting or from the window's own SSH connection.
 *
 * `vscode.env.remoteName` says only "ssh-remote"; the host is in the authority
 * of the workspace's own URIs, which a UI extension can read even though the
 * files themselves live on the far side.
 */
function windowAuthority(): string | undefined {
  return (
    vscode.workspace.workspaceFolders?.[0]?.uri.authority ||
    vscode.window.activeTextEditor?.document.uri.authority ||
    undefined
  );
}

function resolveTarget(): RemoteTarget | undefined {
  const settings = config();
  const configured = settings.get<string>("host", "").trim();
  const host = configured || hostFromAuthority(windowAuthority());
  if (!host) {
    // Not a remote window and nothing configured: run against this machine.
    // On a Linux desktop that is exactly right, and it is the only honest way
    // to drive the whole extension from a test.
    return windowAuthority() ? undefined : LOCAL;
  }
  return { host, user: settings.get<string>("user", "").trim() };
}

/**
 * Put the server script in place. Done once per window: it is a few KB, and
 * copying it again on every command would be noise in the ssh logs.
 */
async function ensureScript(context: vscode.ExtensionContext, target: RemoteTarget): Promise<boolean> {
  if (scriptPushed) {
    return true;
  }
  const dir = serverDir();
  const mkdir = await runAnywhere(target, `mkdir -p ${dir}/bin`);
  if (mkdir.code !== 0) {
    output.error(`could not create ${dir} on ${target.host}: ${mkdir.stderr.trim()}`);
    return false;
  }
  // janela-server delegates to install-server.sh, and janelas delegates to
  // janela-server; a machine that received only some of them fails confusingly.
  const files: Array<[string, string]> = [
    ["janela-server", `${dir}/janela-server`],
    ["install-server.sh", `${dir}/install-server.sh`],
    ["janelas", `${dir}/bin/janelas`],
  ];
  for (const [name, destination] of files) {
    const source = path.join(context.extensionPath, "scripts", name);
    const copied = await copyAnywhere(target, source, destination);
    if (copied.code !== 0) {
      output.error(`could not copy ${name}: ${copied.stderr.trim()}`);
      return false;
    }
  }
  await runAnywhere(target, `chmod +x ${dir}/bin/janelas ${dir}/janela-server`);
  output.info(`server scripts in place at ${target.host}:${dir}`);
  scriptPushed = true;
  return true;
}

function serverRunner(context: vscode.ExtensionContext, target: RemoteTarget): ServerRunner {
  return async (args) => {
    if (!(await ensureScript(context, target))) {
      return { code: 1, stdout: "", stderr: "the server script could not be installed" };
    }
    const settings = config();
    const prefix = settings.get<string>("serverPrefix", "").trim();
    const start = settings.get<string>("startCommand", "").trim();
    return runAnywhere(
      target,
      withEnv(
        { JANELA_HOME: serverDir(), JANELA_XPRA_PREFIX: prefix, JANELA_START: start },
        serverCommand(remoteScript(), args),
      ),
    );
  };
}

async function ensureRegistry(context: vscode.ExtensionContext): Promise<Registry | undefined> {
  const target = resolveTarget();
  if (!target) {
    void vscode.window.showErrorMessage(
      "Janela does not know which server to talk to. Open a folder over Remote-SSH, or set janela.host.",
    );
    return undefined;
  }
  runner = serverRunner(context, target);
  known = registry(runner, (message) => output.info(message));
  return known;
}

/**
 * Make sure the server has an xpra, and get one there if it does not.
 *
 * Two routes, and which one is available is decided at build time. A bundled
 * VSIX carries a packed environment: it is pushed over the ssh connection that
 * is already open and unpacked there, so the server never needs internet, conda
 * or root - which is the whole point on a locked-down machine. A thin VSIX has
 * nothing to push, so it asks the server to fetch xpra itself.
 */
async function ensureServerXpra(context: vscode.ExtensionContext, target: RemoteTarget): Promise<boolean> {
  if (!runner) {
    return false;
  }
  const prefix = await runner(["prefix"]);
  if (prefix.code === 0 && prefix.stdout.trim()) {
    return true;
  }

  const mode = config().get<string>("payloadMode", "auto");
  const bundle = path.join(context.extensionPath, "bundle", "xpra-linux-x64.tar.gz");
  const carried = fs.existsSync(bundle) && mode !== "lite" && mode !== "conda";
  const size = carried ? `${(fs.statSync(bundle).size / 1e6).toFixed(0)} MB` : "";

  const offer = carried
    ? `${target.host} has no xpra. Copy the bundled one across (${size})? It needs no internet, conda or root on that machine.`
    : mode === "conda"
      ? `${target.host} has no xpra. Install it there from conda-forge? That machine will need internet access.`
      : `${target.host} has no xpra. Download it here and copy it across? 15 MB if that machine can run its own packages, 200 MB if not - either way it needs no internet.`;
  const choice = await vscode.window.showInformationMessage(
    offer,
    carried ? "Copy it across" : mode === "conda" ? "Install it" : "Download and copy",
    "Not now",
  );
  if (choice === "Not now" || !choice) {
    return false;
  }

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Janela: setting up xpra on ${target.host}`, cancellable: false },
    async (progress) => {
      if (!carried && mode !== "conda") {
        return provisionLite(context, target, progress);
      }
      if (carried) {
        progress.report({ message: `copying ${size} over ssh` });
        // The configured directory, not the legacy one: a bundle unpacked into
        // ~/.janela while everything else looks in serverDir installs nothing
        // anyone can find.
        const tarball = `${serverDir()}/xpra-linux-x64.tar.gz`;
        await runAnywhere(target, `mkdir -p ${serverDir()}`);
        const copied = await copyAnywhere(target, bundle, tarball);
        if (copied.code !== 0) {
          output.error(`could not copy the bundle: ${copied.stderr.trim()}`);
          return false;
        }
        progress.report({ message: "unpacking" });
        const boot = await runner!(["bootstrap", tarball]);
        output.info(boot.stdout.trim() || boot.stderr.trim() || "(no output)");
        return boot.code === 0;
      }
      progress.report({ message: "installing from conda-forge" });
      const installed = await runner!(["install"]);
      output.info(installed.stdout.trim() || installed.stderr.trim() || "(no output)");
      return installed.code === 0;
    },
  );
}

/**
 * The small payload: xpra's own el8 packages, about 15 MB rather than 200.
 *
 * Only usable on a machine that already has the exact interpreter they were
 * built against, the GTK typelibs PyGObject needs, and the libraries they link.
 * The server answers that - `rpm-check` - because it is the only one that can
 * see its own filesystem. "This machine cannot" is a normal answer, not a
 * failure: the caller then sends the self-contained environment instead.
 */
async function provisionRpm(
  context: vscode.ExtensionContext,
  target: RemoteTarget,
  progress: vscode.Progress<{ message?: string }>,
): Promise<"ok" | "skip" | "fail"> {
  // Newest first: a server with both interpreters should get the newer xpra.
  for (const file of ["xpra-el8-py312.rpms.txt", "xpra-el8-py311.rpms.txt"]) {
    const listFile = path.join(context.extensionPath, "scripts", file);
    if (!fs.existsSync(listFile)) {
      continue;
    }
    const list = parseRpmList(fs.readFileSync(listFile, "utf8"));
    if (!list.python || list.entries.length === 0) {
      continue;
    }

    progress.report({ message: `checking python${list.python} on ${target.host}` });
    const check = await runner!(["rpm-check", list.python, ...list.libs]);
    output.info(`rpm-check python${list.python}:\n${(check.stdout || check.stderr).trim()}`);
    if (check.code !== 0) {
      continue;
    }

    const local = path.join(context.globalStorageUri.fsPath, `rpms-py${list.python.replace(".", "")}`);
    progress.report({ message: `downloading ${list.entries.length} packages` });
    const fetched = await downloadPayload(list.entries, local, (done, total) => {
      progress.report({ message: `downloading packages (${done}/${total})` });
    });
    if (fetched.failed.length > 0) {
      output.error(`could not fetch ${fetched.failed.join(", ")}`);
      return "fail";
    }
    // Whatever an earlier version of this list left behind would otherwise be
    // copied across and extracted along with the packages that belong here.
    const wanted = new Set(list.entries.map((entry) => entry.name));
    for (const name of fs.readdirSync(local)) {
      if (!wanted.has(name)) {
        fs.rmSync(path.join(local, name), { force: true, recursive: true });
      }
    }

    const staging = `${serverDir()}/staging`;
    progress.report({ message: `copying ${(fetched.bytes / 1e6).toFixed(0)} MB to ${target.host}` });
    await runAnywhere(target, `rm -rf ${staging} && mkdir -p ${serverDir()}`);
    if ((await copyAnywhere(target, local, staging, true)).code !== 0) {
      output.error("could not copy the packages to the server");
      return "fail";
    }

    progress.report({ message: "extracting on the server" });
    const boot = await runner!(["bootstrap-rpm", staging, list.python]);
    output.info(boot.stdout.trim() || boot.stderr.trim() || "(no output)");
    // bootstrap-rpm deletes what it extracted when it cannot run it, so a
    // failure here leaves nothing behind and the big payload is still an option.
    if (boot.code === 0) {
      return "ok";
    }
    output.info("the extracted packages did not run; falling back to the self-contained environment");
    return "skip";
  }
  output.info(`${target.host} cannot run the distribution packages; using the self-contained environment`);
  return "skip";
}

/**
 * The lite payload: fetched here, verified here, linked there.
 *
 * Every file is checked against the sha256 in the pinned list. That is not
 * belt-and-braces: the first version of this shipped a silently truncated
 * package, and the offline install failed three steps later naming a different
 * file entirely.
 */
async function provisionLite(
  context: vscode.ExtensionContext,
  target: RemoteTarget,
  progress: vscode.Progress<{ message?: string }>,
): Promise<boolean> {
  // The small route first: on a server that can run its own packages this moves
  // 15 MB instead of 200, and it is the server that decides.
  const rpm = await provisionRpm(context, target, progress);
  if (rpm === "ok") {
    return true;
  }
  if (rpm === "fail") {
    return false;
  }

  const listFile = path.join(context.extensionPath, "scripts", "xpra-linux-64.explicit.txt");
  if (!fs.existsSync(listFile)) {
    output.error(`no package list at ${listFile}; this build cannot install xpra remotely`);
    return false;
  }
  const entries = parseExplicit(fs.readFileSync(listFile, "utf8"));
  const local = path.join(context.globalStorageUri.fsPath, "payload");
  const layout = stagingLayout(local);

  progress.report({ message: `downloading ${entries.length} packages` });
  const fetched = await downloadPayload(entries, layout.packages, (done, total) => {
    if (done % 10 === 0 || done === total) {
      progress.report({ message: `downloading packages (${done}/${total})` });
    }
  });
  output.info(
    `payload: ${fetched.downloaded} downloaded, ${fetched.reused} already had, ` +
      `${(fetched.bytes / 1e6).toFixed(0)} MB total`,
  );
  if (fetched.failed.length > 0) {
    output.error(`could not fetch ${fetched.failed.length} packages: ${fetched.failed.slice(0, 5).join(", ")}`);
    return false;
  }

  progress.report({ message: "downloading micromamba" });
  const micromamba = await downloadMicromamba(local);
  if (!micromamba) {
    output.error("could not download micromamba");
    return false;
  }
  fs.copyFileSync(listFile, layout.explicit);

  const staging = `${serverDir()}/staging`;
  progress.report({ message: `copying ${(fetched.bytes / 1e6).toFixed(0)} MB to ${target.host}` });
  await runAnywhere(target, `rm -rf ${staging} && mkdir -p ${serverDir()}`);
  const copied = await copyAnywhere(target, local, staging, true);
  if (copied.code !== 0) {
    output.error(`could not copy the payload: ${copied.stderr.trim()}`);
    return false;
  }

  progress.report({ message: "installing on the server" });
  const installed = await runner!(["bootstrap-offline", staging]);
  output.info(installed.stdout.trim() || installed.stderr.trim() || "(no output)");
  return installed.code === 0;
}

// -- commands ---------------------------------------------------------------

function nextName(existing: { name?: string }[]): string {
  const used = existing
    .map((session) => Number(/^Janela (\d+)$/.exec(session.name ?? "")?.[1]))
    .filter((n) => Number.isFinite(n)) as number[];
  return `Janela ${Math.max(0, ...used) + 1}`;
}

async function newSession(context: vscode.ExtensionContext) {
  const sessions = known ?? (await ensureRegistry(context));
  const target = resolveTarget();
  if (!sessions || !target) {
    return;
  }
  if (!(await ensureServerXpra(context, target))) {
    return;
  }
  const name = nextName(await sessions.list());
  const display = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Janela: starting ${name}` },
    () => sessions.create(name),
  );
  tree.refresh();
  if (!display) {
    const choice = await vscode.window.showErrorMessage("Janela: the session did not start.", "Show log");
    if (choice === "Show log") {
      output.show();
    }
    return;
  }
  await attach(context, undefined, display);
  // Once, after there is a session for it to talk about.
  void offerWrapper(context, target);
}

async function attach(
  context: vscode.ExtensionContext,
  node?: SessionNode,
  explicit?: string,
  forceWhole = false,
) {
  const whole = forceWhole || config().get<string>("windowMode", "per-window") === "session";
  const target = resolveTarget();
  if (!target) {
    return;
  }
  let display = explicit ?? node?.session.display;
  if (!display) {
    const sessions = known ?? (await ensureRegistry(context));
    const live = (await sessions?.list())?.filter((session) => session.state === "LIVE") ?? [];
    if (live.length === 0) {
      const choice = await vscode.window.showInformationMessage("Janela: no sessions are running.", "New Session");
      if (choice === "New Session") {
        await newSession(context);
      }
      return;
    }
    const picked = await vscode.window.showQuickPick(
      live.map((session) => ({
        label: session.name || `Session ${session.display}`,
        description: `${session.display} - ${session.windows ?? 0} windows`,
        display: session.display,
      })),
      { title: "Attach to a session" },
    );
    display = picked?.display;
  }
  if (!display) {
    return;
  }

  // So `janelas` and the sidebar cannot disagree about which session is meant.
  await runner?.(["set-current", display]);
  await openWindows(context, target, display, whole);
  tree.refresh();
}

/**
 * Put a session on screen: one OS window per application window, or the whole
 * session in one.
 *
 * The session's websocket is on loopback on the server, so a tunnel comes
 * first. Everything here fails with a message rather than an empty window - a
 * webview that never connects and says nothing is the single most expensive
 * failure this project has had.
 */
/**
 * The windows of one session, opening the tunnel the first time it is asked.
 *
 * Shared by attaching and by restoring panels after a restart, so both reach a
 * session the same way and neither can invent a second tunnel for it.
 */
async function sessionWindows(
  context: vscode.ExtensionContext,
  target: RemoteTarget,
  display: string,
  prompt = false,
): Promise<SessionWindows | undefined> {
  const existing = opened.get(display);
  if (existing) {
    return existing;
  }

  const run = serverRunner(context, target);
  const ws = await run(["ws", display]);
  if (ws.code !== 0) {
    output.error((ws.stderr || ws.stdout).trim() || "the session did not say which port it listens on");
    if (prompt) {
      const choice = await vscode.window.showErrorMessage(
        `Janela: ${display} has no websocket to connect to. Sessions created before this version were not given one.`,
        "New Session",
        "Show Log",
      );
      if (choice === "New Session") {
        await newSession(context);
      } else if (choice === "Show Log") {
        output.show();
      }
    }
    return undefined;
  }
  const remotePort = Number(ws.stdout.trim());
  if (!Number.isInteger(remotePort) || remotePort <= 0) {
    output.error(`could not read a port out of "${ws.stdout.trim()}"`);
    return undefined;
  }

  let tunnel;
  try {
    // Nothing to forward when the server is this machine: the session's socket
    // is already on this loopback.
    tunnel = isLocal(target)
      ? {
          localPort: remotePort,
          status: () => ({ state: "up" as const }),
          onState: () => () => undefined,
          release: () => undefined,
        }
      : await tunnels.open(target, remotePort);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output.error(`could not reach ${display}: ${detail}`);
    if (prompt) {
      void vscode.window
        .showErrorMessage(
          `Janela: could not open an ssh tunnel to ${target.host}. See the Janela output for what ssh said.`,
          "Show Log",
        )
        .then((choice) => choice === "Show Log" && output.show());
    }
    return undefined;
  }

  const windows = new SessionWindows({
    context,
    output,
    webroot: path.join(context.extensionPath, "media", "www"),
    tunnel,
    display,
    info: async () => (await run(["info", display])).stdout,
  });
  opened.set(display, windows);
  // Whatever the tunnel does from here reaches the glass, so a dropped link
  // reads as a dropped link rather than as a frozen application.
  tunnel.onState((status) => {
    windows.setTunnelStatus(status);
    if (status.state === "retrying") {
      output.warn(`${display}: connection lost, retrying${status.detail ? ` - ${status.detail}` : ""}`);
    }
  });
  windows.setTunnelStatus(tunnel.status());
  return windows;
}

/**
 * Put a session on screen: one OS window per application window, or the whole
 * session in one.
 *
 * Safe to call on a session already showing - it reveals what is open and fills
 * in what is missing, rather than closing the user's windows to rebuild them.
 */
async function openWindows(
  context: vscode.ExtensionContext,
  target: RemoteTarget,
  display: string,
  whole: boolean,
): Promise<void> {
  const windows = await sessionWindows(context, target, display, true);
  if (!windows) {
    return;
  }
  const count = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Janela: opening ${display}` },
    async () => {
      const opened = whole ? 0 : await windows.openPerWindow();
      if (whole) {
        await windows.openWholeSession();
      }
      return opened;
    },
  );
  output.info(`${display}: ${whole ? "whole session" : `${count} window${count === 1 ? "" : "s"}`} on screen`);
}

/**
 * End one application, from the sidebar.
 *
 * Closing its window on the desktop does not end it - that is what a session
 * is for - so this is the only way to stop a tool without going to a shell.
 * `close` asks, the way clicking the application's X does, and it may put up a
 * "save your work?" dialog. `kill` signals the process, for one that ignores
 * the question or has stopped answering it.
 */
async function closeWindow(context: vscode.ExtensionContext, node: WindowNode | undefined, force: boolean) {
  if (!node) {
    return;
  }
  const target = resolveTarget();
  if (!target) {
    return;
  }
  const name = node.window.title || node.window.application || `window ${node.window.id}`;
  if (force) {
    const confirmed = await vscode.window.showWarningMessage(
      `Kill ${name}? Its process is signalled directly, so anything unsaved in it is lost.`,
      { modal: true },
      "Kill",
    );
    if (confirmed !== "Kill") {
      return;
    }
  }
  const run = serverRunner(context, target);
  const result = await run([force ? "kill-window" : "close", node.display, String(node.window.id)]);
  output.info(`${force ? "kill" : "close"} ${name}: ${(result.stdout || result.stderr).trim() || "(no output)"}`);
  if (result.code !== 0) {
    void vscode.window.showErrorMessage(`Janela: could not close ${name}. ${(result.stderr || result.stdout).trim()}`);
  }
  // The window going away reaches the panels on their own connections; this is
  // only so the sidebar does not keep showing it until the next poll.
  setTimeout(() => tree.refresh(), 800);
}

/**
 * Put `janelas` on the user's PATH, if they want it there.
 *
 * The wrapper has always been pushed to the server and never mentioned, so the
 * only way to find out it existed was to read the README. Asked once, and only
 * ever writes to a startup file when told to.
 */
async function offerWrapper(context: vscode.ExtensionContext, target: RemoteTarget, force = false): Promise<void> {
  const asked = "janela.wrapperOffered";
  if (!force && context.globalState.get<boolean>(asked)) {
    return;
  }
  const run = serverRunner(context, target);
  const current = await run(["shell-setup"]);
  if (current.code !== 0) {
    if (force) {
      output.error((current.stderr || current.stdout).trim());
      output.show();
    }
    return;
  }
  const line = /^line\s+(.*)$/m.exec(current.stdout)?.[1] ?? "";
  const file = /^file\s+(.*)$/m.exec(current.stdout)?.[1] ?? "";
  if (/^state already set up$/m.test(current.stdout)) {
    if (force) {
      void vscode.window.showInformationMessage(`Janela: \`janelas\` is already on your PATH, from ${file}.`);
    }
    await context.globalState.update(asked, true);
    return;
  }

  await context.globalState.update(asked, true);
  const choice = await vscode.window.showInformationMessage(
    "Run tools on this session from any terminal: `janelas simvision`. Add it to your PATH?",
    "Add it",
    "Show me the line",
    "Not now",
  );
  if (choice === "Add it") {
    const applied = await run(["shell-setup", "--apply"]);
    output.info(applied.stdout.trim() || applied.stderr.trim());
    void vscode.window.showInformationMessage(
      applied.code === 0
        ? `Janela: added to ${file}. Open a new terminal, then \`janelas simvision\`.`
        : `Janela: could not write to ${file}. See the Janela output.`,
    );
  } else if (choice === "Show me the line") {
    output.info(`add this to ${file}:\n\n    ${line}\n`);
    output.show();
  }
}

async function killSession(context: vscode.ExtensionContext, node?: SessionNode) {
  const display = node?.session.display;
  if (!display) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Kill the session on ${display}? Every application running on it dies with it.`,
    { modal: true },
    "Kill",
  );
  if (confirmed !== "Kill") {
    return;
  }
  const sessions = known ?? (await ensureRegistry(context));
  const ok = await sessions?.kill(display);
  if (ok) {
    // Its windows are showing something that no longer exists. Left open they
    // would sit there reconnecting to a session that is never coming back,
    // which is a worse lie than closing them.
    opened.get(display)?.dispose();
    opened.delete(display);
  }
  tree.refresh();
  if (!ok) {
    const choice = await vscode.window.showErrorMessage(`Janela: could not kill ${display}.`, "Show log");
    if (choice === "Show log") {
      output.show();
    }
  }
}

/**
 * Start a program in a session that is already running.
 *
 * `xpra control <display> start` puts it there without anyone setting DISPLAY,
 * and the server runs it through a login shell so `module load`, conda and
 * PATH mean what they mean in a terminal on that machine.
 *
 * This is also the answer to "must every tool have its own session": no. One
 * session holds as many as you like, which is what a VNC desktop does.
 */
async function launchIn(context: vscode.ExtensionContext, node?: SessionNode) {
  const sessions = known ?? (await ensureRegistry(context));
  if (!sessions || !runner) {
    return;
  }

  let display = node?.session.display;
  if (!display) {
    const live = (await sessions.list()).filter((session) => session.state === "LIVE");
    if (live.length === 0) {
      void vscode.window.showInformationMessage("Janela: no sessions are running. Create one first.");
      return;
    }
    display =
      live.length === 1
        ? live[0].display
        : (
            await vscode.window.showQuickPick(
              live.map((session) => ({
                label: session.name || `Session ${session.display}`,
                description: `${session.display} - ${session.windows ?? 0} windows`,
                display: session.display,
              })),
              { title: "Launch in which session?" },
            )
          )?.display;
  }
  if (!display) {
    return;
  }

  const configured = config().get<{ label?: string; command?: string }[]>("applications", []);
  const choices = [
    ...configured
      .filter((app) => app.command)
      .map((app) => ({ label: app.label || app.command!, description: app.command!, command: app.command! })),
    { label: "$(edit) Enter a command...", description: "", command: "" },
  ];
  const picked =
    choices.length === 1
      ? choices[0]
      : await vscode.window.showQuickPick(choices, { title: `Launch in ${display}` });
  if (!picked) {
    return;
  }

  const command =
    picked.command ||
    (await vscode.window.showInputBox({
      title: `Launch in ${display}`,
      prompt: "Command to run on the server, as you would type it in a terminal there",
      placeHolder: "gtkwave dump.vcd",
      ignoreFocusOut: true,
    })) ||
    "";
  if (!command.trim()) {
    return;
  }

  output.info(`${display}: launching ${command}`);
  const result = await runner(["run", display, command]);
  output.info(result.stdout.trim() || result.stderr.trim() || "(no output)");
  if (result.code !== 0) {
    const choice = await vscode.window.showErrorMessage(`Janela: could not launch in ${display}.`, "Show log");
    if (choice === "Show log") {
      output.show();
    }
  }
  setTimeout(() => tree.refresh(), 2000);
}

/** What the server actually has. The first thing to run when a machine
 *  surprises us, and the only honest way to plan for one we cannot see. */
async function survey(context: vscode.ExtensionContext) {
  const target = resolveTarget();
  if (!target) {
    return;
  }
  if (!(await ensureScript(context, target))) {
    output.show();
    return;
  }
  const result = await serverRunner(context, target)(["survey"]);
  output.info(`--- survey of ${target.host} ---\n${result.stdout.trim() || result.stderr.trim()}`);
  output.show();
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Janela", { log: true });
  tree = new SessionTree(() => known);
  tunnels = new Tunnels((message) => output.info(message));

  void ensureRegistry(context).then(() => tree.refresh());
  tree.start();

  // Separate from the sidebar's poll, deliberately. VS Code does not ask a
  // hidden view for its children, so a tree-driven check would stop noticing
  // the moment the sidebar was collapsed - and windows left reconnecting to a
  // session that no longer exists are the thing this prevents. It costs a call
  // only while something is actually on screen.
  const watchdog = setInterval(() => {
    if (opened.size === 0) {
      return;
    }
    void known?.status().then(forgetDeadSessions, () => undefined);
  }, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(watchdog) });

  const view = vscode.window.createTreeView("janela.sessions", { treeDataProvider: tree });
  context.subscriptions.push(
    output,
    tree,
    view,
    // Polling a sidebar nobody is looking at costs a connection every ten
    // seconds for nothing.
    view.onDidChangeVisibility((event) => tree.setVisible(event.visible)),
    vscode.commands.registerCommand("janela.newSession", () => newSession(context)),
    // The display can be passed directly, so the command is usable without a
    // node - from a keybinding, from another extension, or from a test. Without
    // it, calling this with no node always opens a picker and waits for a human.
    vscode.commands.registerCommand("janela.attach", (node?: SessionNode, display?: string) =>
      attach(context, node, display),
    ),
    vscode.commands.registerCommand("janela.openSession", (node?: SessionNode, display?: string) =>
      attach(context, node, display, true),
    ),
    vscode.commands.registerCommand("janela.kill", (node?: SessionNode) => killSession(context, node)),
    vscode.commands.registerCommand("janela.launch", (node?: SessionNode) => launchIn(context, node)),
    vscode.commands.registerCommand("janela.closeWindow", (node?: WindowNode) =>
      closeWindow(context, node, false),
    ),
    vscode.commands.registerCommand("janela.killWindow", (node?: WindowNode) =>
      closeWindow(context, node, true),
    ),
    vscode.commands.registerCommand("janela.revealWindow", (node?: WindowNode) => {
      if (node && !opened.get(node.display)?.reveal(node.window.id)) {
        // Not on screen - the session is open somewhere else, or not at all.
        void attach(context, undefined, node.display);
      }
    }),
    // Restored tabs after a restart. VS Code brings the frames back; without
    // this they are blank, which is what losing every window on restart looked
    // like from the outside.
    vscode.window.registerWebviewPanelSerializer("janela.window", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        const remembered = (state ?? {}) as { display?: string; wid?: number };
        const target = resolveTarget();
        if (!target || !remembered.display) {
          output.warn(`a restored window did not say which session it belonged to: ${JSON.stringify(state)}`);
          panel.dispose();
          return;
        }
        const windows = await sessionWindows(context, target, remembered.display);
        if (!windows) {
          output.warn(`${remembered.display} is gone; discarding the window it left behind`);
          panel.dispose();
          return;
        }
        windows.adopt(panel, typeof remembered.wid === "number" ? remembered.wid : undefined);
        output.info(`${remembered.display}: restored window ${remembered.wid ?? "(whole session)"}`);
      },
    }),
    vscode.commands.registerCommand("janela.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("janela.survey", () => survey(context)),
    vscode.commands.registerCommand("janela.setUpWrapper", async () => {
      const target = resolveTarget();
      if (target && (await ensureScript(context, target))) {
        await offerWrapper(context, target, true);
      }
    }),
    vscode.commands.registerCommand("janela.installServer", async () => {
      const target = resolveTarget();
      if (!target || !(known ?? (await ensureRegistry(context)))) {
        return;
      }
      const ok = await ensureServerXpra(context, target);
      tree.refresh();
      void (ok
        ? vscode.window.showInformationMessage(`Janela: ${target.host} is ready.`)
        : vscode.window.showErrorMessage(`Janela: ${target.host} still has no xpra.`));
    }),
  );

  const api: JanelaApi = {
    diagnostics: () => Object.fromEntries([...opened].map(([display, windows]) => [display, windows.describe()])),
  };
  return api;
}

/** What the extension exposes, for tests and for diagnosis. */
export interface JanelaApi {
  diagnostics(): Record<string, ReturnType<SessionWindows["describe"]>>;
}

export function deactivate() {
  tree?.dispose();
  // ssh children would otherwise outlive the window that opened them.
  for (const windows of opened.values()) {
    windows.dispose();
  }
  opened.clear();
  tunnels?.dispose();
}
