/**
 * Turning xpra's HTML5 client into a webview page.
 *
 * The whole point of the extension is that this is NOT an iframe. VS Code's
 * Simple Browser iframes the client, and an iframe swallows Ctrl/Alt combos on
 * its way out (noVNC#506, vscode#65333). Here the client's own files are loaded
 * as webview resources, so a capture-phase listener on `document` sees every
 * keystroke before anything else does.
 *
 * Two edits are made to the stock index.html:
 *   1. a <base href> pointing at the client directory, so every relative
 *      <script src>, <link href> and XHR in it keeps working unchanged;
 *   2. a config object plus the boot script, injected last so they run after
 *      the page's own inline script has declared `default_settings` and
 *      `client`.
 */

export interface JanelaConfig {
  /** Host the browser should open the websocket to (already tunnelled). */
  host: string;
  port: number;
  ssl: boolean;
  /** Websocket path on the xpra server. Not the webview's own pathname. */
  path: string;
  grabOnOpen: boolean;
  /** "pointer" | "always" | "manual" - see janela.grabMode. */
  grabMode?: string;
  /** Account the session was started under. xpra's file auth ignores it, but
   *  the client sends it and other auth modules use it. */
  username?: string;
  /** The session's passphrase. Reaches the page only through this object,
   *  never a form and never a log line. */
  password?: string;
  /**
   * The one window this page shows, or absent for the whole session.
   *
   * Set, the client draws that window and the menus over it and nothing else,
   * and never maps the rest - so the server sends this page no pixels for
   * windows it is not showing.
   */
  onlyWindow?: number;
  /** Which session this page belongs to. Persisted by the page so VS Code can
   *  hand it back after a restart. */
  display?: string;
  /** The remote screen's size. The viewer scales the whole desktop to fit the
   *  tab, because Xvfb's framebuffer is fixed and cannot follow the window -
   *  which is why xpra prefers Xdummy, and why we cannot. */
  desktopWidth?: number;
  desktopHeight?: number;
}

export interface BuildOptions {
  /** Webview URI of the client directory, WITHOUT a trailing slash. */
  baseHref: string;
  /** Webview URI of media/janela-boot.js. */
  bootScriptUri: string;
  /** webview.cspSource. */
  cspSource: string;
  config: JanelaConfig;
}

/**
 * A webview page's origin is `vscode-webview://<uuid>`, while its files are
 * served from `…vscode-resource.vscode-cdn.net`. `new Worker(url)` requires the
 * script to be same-origin, so xpra's client dies with
 *
 *   SecurityError: Failed to construct 'Worker': Script at '…vscode-cdn.net/…
 *   /js/Protocol.js' cannot be accessed from origin 'vscode-webview://…'
 *
 * ...before it opens any connection at all - which is why the server never saw
 * one, and the tab just sat there.
 *
 * The client only uses workers when `window.Worker` exists (`Client.js:16`),
 * and otherwise runs the protocol in the page: `new XpraProtocol()` instead of
 * `new XpraProtocolWorkerHost()`. Both are first-class paths in xpra. Hiding
 * the constructor before `Client.js` is evaluated takes the one that works
 * here.
 *
 * The cost is that protocol handling and image decoding share the page's
 * thread. If that ever shows, the alternative is fetching each worker's source
 * and re-serving it from a blob: URL - which also means rewriting the relative
 * `importScripts("./lib/lz4.js")` calls inside them, so it is not a one-liner.
 */
const WORKER_SHIM = [
  "// injected by Janela - see src/html.ts",
  "window.Worker = undefined;",
].join("\n");

/** Origins the page must be allowed to talk to: the tunnelled xpra server. */
function connectSources(config: JanelaConfig): string {
  const httpScheme = config.ssl ? "https" : "http";
  const wsScheme = config.ssl ? "wss" : "ws";
  const authority = `${config.host}:${config.port}`;
  return `${httpScheme}://${authority} ${wsScheme}://${authority}`;
}

function contentSecurityPolicy(options: BuildOptions): string {
  const source = options.cspSource;
  // No `base-uri` directive: the <base> tag below is load-bearing.
  return [
    `default-src 'none'`,
    `img-src ${source} data: blob:`,
    `media-src ${source} data: blob:`,
    `font-src ${source} data:`,
    `style-src ${source} 'unsafe-inline'`,
    // The client ships unbundled scripts and creates workers from blobs.
    `script-src ${source} 'unsafe-inline' 'unsafe-eval' blob:`,
    `worker-src ${source} blob:`,
    `child-src ${source} blob:`,
    `connect-src ${source} ${connectSources(options.config)} data: blob:`,
    `frame-src 'none'`,
  ].join("; ");
}

export function buildWebviewHtml(indexHtml: string, options: BuildOptions): string {
  const head = [
    `<base href="${options.baseHref}/">`,
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(options)}">`,
    // Must precede the client's own scripts, which read window.Worker on load.
    `<script>${WORKER_SHIM}</script>`,
  ].join("\n    ");

  const headIndex = indexHtml.indexOf("<head>");
  if (headIndex < 0) {
    throw new Error("xpra client index.html has no <head> - is janela.clientPath pointing at the right directory?");
  }
  let html =
    indexHtml.slice(0, headIndex + "<head>".length) +
    "\n    " +
    head +
    indexHtml.slice(headIndex + "<head>".length);

  const foot = [
    `<script>window.__JANELA__ = ${JSON.stringify(options.config)};</script>`,
    `<script src="${options.bootScriptUri}"></script>`,
  ].join("\n    ");

  const bodyIndex = html.lastIndexOf("</body>");
  if (bodyIndex < 0) {
    throw new Error("xpra client index.html has no </body> - is janela.clientPath pointing at the right directory?");
  }
  html = html.slice(0, bodyIndex) + "    " + foot + "\n  " + html.slice(bodyIndex);

  return html;
}
