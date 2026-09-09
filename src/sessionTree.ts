/**
 * The session list, in the sidebar.
 *
 * Sessions live on the server and outlive VS Code, so the tree is a view of
 * something it does not own: it reports what xpra says exists, including
 * sessions started from a shell and sessions that have died since anyone last
 * looked. Nothing here creates or destroys - the commands do that and ask for a
 * refresh.
 */

import * as vscode from "vscode";

import type { Registry, RemoteWindow, Session } from "./sessions.ts";

export class SessionNode extends vscode.TreeItem {
  constructor(readonly session: Session, readonly isCurrent = false) {
    // A client attached from anywhere counts, including one started by hand
    // outside this extension - which is the honest thing to report.
    const attached = (session.clients ?? 0) > 0;
    // Expanded when there is something in it: the tools are the reason to look
    // at this list, and one click to reach them is one too many.
    super(
      session.name || `Session ${session.display}`,
      (session.open?.length ?? 0) > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    const live = session.state === "LIVE";
    this.description = [
      session.display,
      // Which session `janelas` sends things to. Without this the answer to
      // "where did that tool go" was to read a file on the server.
      isCurrent ? "current" : undefined,
      live ? undefined : session.state.toLowerCase(),
      live && session.windows !== undefined ? `${session.windows} window${session.windows === 1 ? "" : "s"}` : undefined,
      attached ? `${session.clients} attached` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.name || "Session"}** on \`${session.display}\``,
        "",
        live
          ? `Run something in it, from any shell on the server:\n\n\`\`\`sh\nDISPLAY=${session.display} gtkwave dump.vcd &\n\`\`\``
          : "This session is gone. Killing it clears what it left behind.",
        isCurrent
          ? "\nThis is the session `janelas` sends things to."
          : "\nAttach to this session to make `janelas` use it.",
        session.clients !== undefined ? `\nViewers connected: ${session.clients}` : "",
      ].join("\n"),
    );

    // Drives which inline buttons appear - see the `when` clauses in package.json.
    this.contextValue = live ? (attached ? "janela.session.attached" : "janela.session.live") : "janela.session.dead";
    this.iconPath = new vscode.ThemeIcon(
      live ? (attached ? "vm-active" : "vm") : "vm-outline",
      live ? undefined : new vscode.ThemeColor("disabledForeground"),
    );
    if (live) {
      this.command = { command: "janela.attach", title: "Attach", arguments: [this] };
    }
  }
}

/**
 * One application window, under the session it belongs to.
 *
 * Closing a Janela window on your desktop does not end the application - that
 * is the whole point of a session, and it also means the list is the only place
 * an application can be ended from without going to a shell.
 */
export class WindowNode extends vscode.TreeItem {
  readonly display: string;
  readonly window: RemoteWindow;

  constructor(display: string, window: RemoteWindow) {
    super(window.title || window.application || `Window ${window.id}`, vscode.TreeItemCollapsibleState.None);
    this.display = display;
    this.window = window;

    this.description = [window.application, `${window.width}×${window.height}`]
      .filter(Boolean)
      .join(" · ");
    this.tooltip = new vscode.MarkdownString(
      [
        `**${window.title || window.application || `Window ${window.id}`}**`,
        "",
        window.command ? `\`${window.command}\`` : "_the application did not say what it is running_",
        "",
        window.pid
          ? `Process \`${window.pid}\` on \`${display}\`.`
          : `On \`${display}\`. It does not say which process owns it, so it can only be asked to close.`,
      ].join("\n"),
    );

    // Killing needs a pid; closing never does. The `when` clauses in
    // package.json use this so a button that cannot work is not offered.
    this.contextValue = window.pid ? "janela.window.killable" : "janela.window";
    this.iconPath = new vscode.ThemeIcon("window");
    this.command = { command: "janela.revealWindow", title: "Show", arguments: [this] };
  }
}

export type Node = SessionNode | WindowNode;

export class SessionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  private intervalMs = 10_000;
  private visible = true;

  constructor(private registry: () => Registry | undefined) {}

  /**
   * Poll, so a session that died in a terminal stops looking alive without
   * anyone having to ask.
   *
   * One ssh call per tick, not one plus one per session: over ssh each is a
   * whole connection, since Windows OpenSSH cannot multiplex.
   */
  start(intervalMs = this.intervalMs) {
    this.intervalMs = intervalMs;
    this.stop();
    if (this.visible) {
      this.timer = setInterval(() => this.refresh(), intervalMs);
    }
  }

  /** Nobody is looking at a hidden sidebar, and every tick costs a connection. */
  setVisible(visible: boolean) {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.refresh();
      this.start(this.intervalMs);
    } else {
      this.stop();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  refresh() {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node instanceof WindowNode) {
      return [];
    }
    if (node instanceof SessionNode) {
      return (node.session.open ?? []).map((window) => new WindowNode(node.session.display, window));
    }
    const registry = this.registry();
    if (!registry) {
      return [];
    }
    const status = await registry.status();
    return status.sessions.map((session) => new SessionNode(session, session.display === status.current));
  }

  dispose() {
    this.stop();
    this.changed.dispose();
  }
}
