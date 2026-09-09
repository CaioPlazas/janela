import assert from "node:assert/strict";
import test from "node:test";

import { buildWebviewHtml, type BuildOptions } from "./html.ts";

const INDEX = `<!DOCTYPE html>
<html>
  <head>
    <title>Xpra</title>
    <script src="js/Client.js"></script>
  </head>
  <body>
    <div id="screen"></div>
    <script>
      const default_settings = {};
      let client;
    </script>
  </body>
</html>`;

function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    baseHref: "https://file+.vscode-resource.example/www",
    bootScriptUri: "https://file+.vscode-resource.example/media/janela-boot.js",
    cspSource: "https://file+.vscode-resource.example",
    config: { host: "localhost", port: 14500, ssl: false, path: "/", grabOnOpen: true },
    ...overrides,
  };
}

test("the base href makes the client's own relative paths resolve", () => {
  const html = buildWebviewHtml(INDEX, options());
  assert.match(html, /<base href="https:\/\/file\+\.vscode-resource\.example\/www\/">/);
  // The client's script tags are left exactly as they were.
  assert.match(html, /<script src="js\/Client\.js"><\/script>/);
});

test("the boot script is injected last, after the page declares client", () => {
  const html = buildWebviewHtml(INDEX, options());
  assert.ok(html.indexOf("let client;") < html.indexOf("janela-boot.js"));
  assert.ok(html.indexOf("__JANELA__") < html.indexOf("janela-boot.js"));
  assert.ok(html.indexOf("janela-boot.js") < html.indexOf("</body>"));
});

test("the config reaches the page as JSON", () => {
  const html = buildWebviewHtml(INDEX, options());
  const match = html.match(/window\.__JANELA__ = (\{.*?\});/);
  assert.ok(match, "no config object injected");
  assert.deepEqual(JSON.parse(match![1]), {
    host: "localhost",
    port: 14500,
    ssl: false,
    path: "/",
    grabOnOpen: true,
  });
});

test("the websocket origin is allowed by the CSP, in both schemes", () => {
  const plain = buildWebviewHtml(INDEX, options());
  assert.match(plain, /connect-src [^"]*ws:\/\/localhost:14500/);

  const secure = buildWebviewHtml(
    INDEX,
    options({ config: { host: "tunnel.example.net", port: 443, ssl: true, path: "/", grabOnOpen: false } }),
  );
  assert.match(secure, /connect-src [^"]*wss:\/\/tunnel\.example\.net:443/);
});

test("workers are hidden before the client can look for them", () => {
  const html = buildWebviewHtml(INDEX, options());
  // A webview serves its files from another origin, and `new Worker(url)`
  // refuses cross-origin scripts - so the client must take its main-thread path.
  assert.match(html, /window\.Worker = undefined;/);
  assert.ok(
    html.indexOf("window.Worker = undefined") < html.indexOf('src="js/Client.js"'),
    "the shim must run before Client.js evaluates Boolean(window.Worker)",
  );
});

test("nothing may be framed - an iframe is what this extension exists to avoid", () => {
  const html = buildWebviewHtml(INDEX, options());
  assert.match(html, /frame-src 'none'/);
});

test("a page that is not the xpra client fails loudly", () => {
  assert.throws(() => buildWebviewHtml("<html><body>nope</body></html>", options()), /no <head>/);
  assert.throws(() => buildWebviewHtml("<html><head></head>", options()), /no <\/body>/);
});
