# 1. The client is not in an iframe

Date: 2026-08-27

## Status

Superseded by [0002](0002-the-pixels-are-not-ours-to-draw.md): this extension no longer displays
anything, so it has no page to put in an iframe or otherwise. Kept because the reasoning was
sound for the architecture it describes, and the limits it names are why that architecture was
abandoned.

## Context

VS Code can already display xpra's HTML5 client with no extension at all: forward the port, run
`Simple Browser: Show`, and the session renders. Everything about the picture works.

The keyboard does not. Simple Browser loads the page in an **iframe**, and keyboard events do not
escape one usefully: `Ctrl` and `Alt` combinations are consumed by the host before the page can
act on them ([noVNC#506](https://github.com/novnc/noVNC/issues/506),
[vscode#65333](https://github.com/microsoft/vscode/issues/65333)). For a waveform viewer, where
`Ctrl+F`, `Alt+←` and friends are the entire interaction model, a viewer that cannot receive them
is a screenshot.

The obvious implementation of an extension has the same defect: a webview whose HTML is
`<iframe src="http://localhost:PORT/">`. It is three lines, it renders correctly, and it fails in
exactly the same way.

## Decision

The client's own files are loaded as **webview resources**. The extension reads xpra's stock
`index.html`, injects a `<base href>` pointing at the client directory so every relative `<script
src>`, `<link href>` and XHR in it resolves unchanged, and serves that as the webview's HTML.

No iframe is involved at any point. A capture-phase listener on `document` therefore sees every
keystroke before anything else does, and while the keyboard is grabbed it calls
`stopImmediatePropagation()` and hands the event to the client's own handler directly.

## Consequences

The extension is coupled to the client's page structure. It depends on `<head>` and `</body>`
existing, on `default_settings` and `client` being script-scope bindings, and on
`XpraClient.prototype.connect` being overridable. A future xpra-html5 release can break any of
these. Mitigations: the client is vendored at a pinned version (`media/www/VERSION`) rather than
taken from whatever a conda env holds, the transform fails loudly rather than silently when the
page is not what it expects, and `spikes/verify-client.ts` drives the real page in a real browser.

The parameter route into the client could not be used either. `index.html` sanitises the server
address through a character class that excludes dots, turning `127.0.0.1` into `127001`, so the
connection is set by overriding `connect()` instead. Credentials travel the same way.

A CSP is required, since a webview with local scripts and a websocket to a forwarded port must be
told both are allowed. `frame-src 'none'` is in it deliberately: it is the machine-checkable
statement of this decision.

## Alternatives considered

**An iframe with a key-forwarding shim.** Rejected: the shim would have to re-dispatch synthetic
events into the frame, which is both lossy and the exact thing the linked issues describe failing.

**Contributing a fix to Simple Browser.** Out of our hands, and it would still be an iframe.

**The xpra native client over X11 forwarding.** A perfect keyboard, but it is not in VS Code,
which is the entire point of the project.
