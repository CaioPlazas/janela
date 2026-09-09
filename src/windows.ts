/**
 * One OS window per application window.
 *
 * A session's windows are discovered once over ssh (`xpra info`), and after
 * that the clients themselves report what appears and disappears - they are
 * already connected and already being told, so polling the server would be
 * asking a question we are having answered anyway.
 *
 * Each window gets a webview panel, and each panel is pushed into its own
 * operating-system window. VS Code has no API for that; the workbench command
 * is the only route, so a version without it degrades to tabs rather than
 * failing.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { buildWebviewHtml, type JanelaConfig } from "./html.ts";
import { parseWindows, windowsNeedingPanels, type RemoteWindow } from "./sessions.ts";
import type { Tunnel, TunnelStatus } from "./tunnel.ts";

const VIEW_TYPE = "janela.window";

/** Moves the active editor into a window of its own. Not in the extension API:
 *  floating editor windows exist only as a workbench command. */
const TO_NEW_WINDOW = "workbench.action.moveEditorToNewWindow";

export interface WindowHost {
  context: vscode.ExtensionContext;
  output: vscode.LogOutputChannel;
  /** Where the vendored client lives on disk. */
  webroot: string;
  tunnel: Tunnel;
  display: string;
  /** `xpra info <display>`, for the initial set of windows. */
  info: () => Promise<string>;
}

interface Held {
  panel: vscode.WebviewPanel;
  window: RemoteWindow;
}

/** A message from a page. Anything else is ignored: this is untrusted in the
 *  sense that a client bug should not throw here. */
interface FromPage {
  type?: string;
  wid?: number;
  title?: string;
  overrideRedirect?: boolean;
  width?: number;
  height?: number;
  message?: string;
  state?: string;
  detail?: string;
}

export class SessionWindows {
  private readonly host: WindowHost;
  private readonly panels = new Map<number, Held>();
  /** Set while the whole session is in one panel, rather than one each. */
  private whole: vscode.WebviewPanel | undefined;
  /**
   * True when that panel is only standing in for an empty session.
   *
   * The distinction matters: a placeholder must give way the moment a real
   * window appears, and a whole-session view the user asked for must not. The
   * old code could not tell them apart, so a tool started after attaching to an
   * empty session was trapped in the desktop view forever.
   */
  private wholeIsPlaceholder = false;
  private closed = false;
  private lastStatus: TunnelStatus | undefined;
  /** How many windows the pages have told us about, and how much they have
   *  said at all - the difference tells a silent page from a silent client. */
  private reported = 0;
  private messages = 0;

  constructor(host: WindowHost) {
    this.host = host;
  }

  /**
   * Every window of the session, each in its own OS window.
   *
   * Safe to run again on a session already on screen: it reveals what is open
   * and opens only what is missing. Re-attaching used to dispose everything
   * first and rebuild, which closed the user's windows to show them the same
   * windows - and lost them outright if the second half failed.
   */
  async openPerWindow(): Promise<number> {
    const windows = windowsNeedingPanels(parseWindows(await this.host.info()));
    if (windows.length === 0) {
      // An empty session has nothing to put in a window. Showing the session
      // itself is the honest answer: the user sees a desktop rather than
      // nothing at all, and any application started later appears in it.
      this.host.output.info(`${this.host.display} has no windows yet; showing the session`);
      await this.openWholeSession(true);
      return 0;
    }
    for (const window of windows) {
      const held = this.panels.get(window.id);
      if (held) {
        held.panel.reveal();
      } else {
        await this.openWindow(window);
      }
    }
    return windows.length;
  }

  /** The fallback, and the answer when a tool's menus overflow their window. */
  async openWholeSession(placeholder = false): Promise<void> {
    if (this.whole) {
      // Asking for it deliberately promotes a placeholder, so it stops giving
      // way to the next window that appears.
      this.wholeIsPlaceholder = this.wholeIsPlaceholder && placeholder;
      this.whole.reveal();
      return;
    }
    const panel = this.createPanel(`Janela ${this.host.display}`, undefined);
    this.whole = panel;
    this.wholeIsPlaceholder = placeholder;
    panel.onDidDispose(() => {
      this.whole = undefined;
      this.wholeIsPlaceholder = false;
      this.releaseIfEmpty();
    });
  }

  private async openWindow(window: RemoteWindow): Promise<void> {
    if (this.panels.has(window.id)) {
      return;
    }
    const panel = this.createPanel(window.title || `Window ${window.id}`, window.id);
    this.panels.set(window.id, { panel, window });
    panel.onDidDispose(() => {
      this.panels.delete(window.id);
      this.releaseIfEmpty();
    });
    // Into a window of its own. Best effort in both directions: a VS Code
    // without the command leaves the panel as an editor tab, which is worse but
    // not broken - and a command that never settles must not hold up a window
    // that is already on screen, so it gets a deadline rather than an await.
    if (process.env.JANELA_NO_FLOAT !== "1") {
      try {
        await Promise.race([
          vscode.commands.executeCommand(TO_NEW_WINDOW),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch (error) {
        this.host.output.warn(`could not move ${window.title || window.id} into its own window: ${error}`);
      }
    }
  }

  /** The options a panel of ours needs, in one place so a restored panel and a
   *  new one cannot drift apart. */
  static options(context: vscode.ExtensionContext, webroot: string): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      // The client keeps its whole decode state in the page; rebuilding it on
      // every focus change would reconnect and repaint from scratch.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(webroot), vscode.Uri.joinPath(context.extensionUri, "media")],
    };
  }

  /**
   * Take over a panel VS Code restored after a restart.
   *
   * Without this the tabs come back and the extension has nothing to put in
   * them, so they are blank frames where windows used to be - which is what
   * "closing and reopening VS Code loses everything" looked like.
   */
  adopt(panel: vscode.WebviewPanel, wid: number | undefined): void {
    panel.webview.options = SessionWindows.options(this.host.context, this.host.webroot);
    this.dress(panel, wid);
    if (wid === undefined) {
      this.whole = panel;
      this.wholeIsPlaceholder = false;
      panel.onDidDispose(() => {
        this.whole = undefined;
        this.releaseIfEmpty();
      });
      return;
    }
    const window: RemoteWindow = {
      id: wid, title: panel.title, x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, type: "",
    };
    this.panels.set(wid, { panel, window });
    panel.onDidDispose(() => {
      this.panels.delete(wid);
      this.releaseIfEmpty();
    });
  }

  private createPanel(title: string, onlyWindow: number | undefined): vscode.WebviewPanel {
    const { context, webroot } = this.host;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      vscode.ViewColumn.Active,
      SessionWindows.options(context, webroot),
    );
    this.dress(panel, onlyWindow);
    return panel;
  }

  /** Give a panel its page and its wiring. Shared by new and restored ones. */
  private dress(panel: vscode.WebviewPanel, onlyWindow: number | undefined): void {
    const { context, webroot, tunnel } = this.host;
    const config: JanelaConfig = {
      host: "127.0.0.1",
      port: tunnel.localPort,
      ssl: false,
      path: "/",
      grabOnOpen: vscode.workspace.getConfiguration("janela").get<string>("grabMode", "pointer") !== "manual",
      grabMode: vscode.workspace.getConfiguration("janela").get<string>("grabMode", "pointer"),
      onlyWindow,
      // Persisted by the page, so VS Code can hand it back after a restart.
      display: this.host.display,
    };

    panel.webview.html = buildWebviewHtml(fs.readFileSync(path.join(webroot, "index.html"), "utf8"), {
      baseHref: panel.webview.asWebviewUri(vscode.Uri.file(webroot)).toString(),
      bootScriptUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "janela-boot.js"))
        .toString(),
      cspSource: panel.webview.cspSource,
      config,
    });

    panel.webview.onDidReceiveMessage((message: FromPage) => this.onMessage(panel, message));
    if (this.lastStatus) {
      void panel.webview.postMessage({ type: "tunnel", ...this.lastStatus });
    }
  }

  private onMessage(panel: vscode.WebviewPanel, message: FromPage): void {
    this.messages++;
    switch (message.type) {
      case "window":
        this.reported++;
        // A window appeared. Every page is told about it, so the first one to
        // report it opens the panel and the rest find it already there.
        // Not gated on `whole` any more, except for a view the user asked for:
        // a placeholder desktop must hand over to the real window.
        if (
          !(this.whole && !this.wholeIsPlaceholder) &&
          typeof message.wid === "number" &&
          !message.overrideRedirect &&
          (message.width ?? 0) > 0 &&
          !this.panels.has(message.wid)
        ) {
          // A rejection here - a missing index.html in a broken install, say -
          // would otherwise be an unhandled rejection and no window.
          void this.openWindow({
            id: message.wid,
            title: message.title ?? "",
            x: 0,
            y: 0,
            width: message.width ?? 0,
            height: message.height ?? 0,
            overrideRedirect: false,
            type: "",
          }).catch((error) => this.host.output.error(`could not open a window for ${message.wid}: ${error}`));
          // The empty session now has something in it, so the stand-in has
          // nothing left to stand in for.
          if (this.wholeIsPlaceholder) {
            this.wholeIsPlaceholder = false;
            this.whole?.dispose();
          }
        }
        break;
      case "window-gone": {
        const held = typeof message.wid === "number" ? this.panels.get(message.wid) : undefined;
        held?.panel.dispose();
        break;
      }
      case "window-title":
        if (typeof message.wid === "number" && message.title) {
          const held = this.panels.get(message.wid);
          if (held) {
            held.panel.title = message.title;
          }
        }
        break;
      case "error":
        this.host.output.error(`${panel.title}: ${message.message}`);
        break;
      case "state":
        this.host.output.info(`${panel.title}: ${message.state}${message.detail ? ` ${message.detail}` : ""}`);
        break;
      default:
        break;
    }
  }

  /**
   * Tell every window where the connection stands.
   *
   * The page shows this rather than freezing silently, which is what it did
   * before: a dropped link looked exactly like a hung application.
   */
  setTunnelStatus(status: TunnelStatus): void {
    this.lastStatus = status;
    for (const { panel } of this.panels.values()) {
      void panel.webview.postMessage({ type: "tunnel", ...status });
    }
    void this.whole?.webview.postMessage({ type: "tunnel", ...status });
  }

  /**
   * What this session has on screen, for tests and for diagnosis.
   *
   * `spikes/verify-extension.ts` runs outside the extension host and can only
   * see tab labels, which cannot distinguish "the message never arrived" from
   * "the panel was never opened".
   */
  describe(): { wids: number[]; whole: boolean; placeholder: boolean; reported: number; messages: number } {
    return {
      wids: [...this.panels.keys()].sort((a, b) => a - b),
      whole: !!this.whole,
      placeholder: this.wholeIsPlaceholder,
      reported: this.reported,
      messages: this.messages,
    };
  }

  /** Bring one window's panel to the front, for clicking it in the sidebar. */
  reveal(wid: number): boolean {
    const held = this.panels.get(wid);
    held?.panel.reveal();
    return !!held;
  }

  /** The tunnel belongs to the session, so it goes when the last window does. */
  private releaseIfEmpty(): void {
    if (this.closed || this.panels.size > 0 || this.whole) {
      return;
    }
    this.closed = true;
    this.host.tunnel.release();
    this.host.output.info(`${this.host.display}: last window closed`);
  }

  dispose(): void {
    for (const { panel } of [...this.panels.values()]) {
      panel.dispose();
    }
    this.whole?.dispose();
    this.releaseIfEmpty();
  }
}
