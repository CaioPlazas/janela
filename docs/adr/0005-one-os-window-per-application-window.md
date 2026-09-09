# 5. One OS window per application window

Date: 2026-09-01

## Status

Accepted. Supersedes [0002](0002-the-pixels-are-not-ours-to-draw.md), and restores the approach
[0001](0001-the-client-is-not-in-an-iframe.md) describes.

## Context

0002 handed the drawing to xpra's own client: it produces real windows, real keyboard handling and
survives a disconnect. The extension became a session manager and the display code was deleted.

That client is **blocked as malware on the machine it has to run on**. The classification is
wrong, and it is also not appealable, so the route is closed. The pixels come back into VS Code.

Not into a tab, though. The requirement that 0002 was reaching for was never "a native client" —
it was that a waveform viewer and its dialogs behave like windows. A desktop-in-a-tab was
acceptable and not wanted.

What is unchanged: **sessions live on the server and survive**. Closing the laptop, losing the
link, a weekend away — none of them touch a session, because none of them are on the server. That
was the real requirement behind 0002 and no display choice can affect it.

## Decision

Each application window gets its own VS Code webview panel, moved into its own operating-system
window with `workbench.action.moveEditorToNewWindow`. Each panel runs its own xpra-html5 client
against the session, showing exactly one window.

Three facts make that affordable rather than absurd:

1. **`Client.js` sends `map_window` from inside `_new_window`.** A window a page never creates is
   a window it never maps, and the server sends no pixels for an unmapped window. Four windows
   therefore cost four pixel streams, not sixteen. This is asserted in `spikes/verify-windows.ts`
   against a real session: with `onlyWindow` set the client builds `[1]`, without it `[1, 2]`.
2. **`--sharing=yes`.** Without it the second window to open would evict the first.
3. **The session already knows its windows.** `xpra info` reports `windows.<id>.title`,
   `.geometry` and `.override-redirect`, so the first set needs no client. After that the pages
   report what appears and disappears, because they are being told anyway.

Menus and tooltips are the exception, and they are why the rule is not simply "one window, one
panel". X11 gives an override-redirect window no decoration and no window manager; it belongs
*over* the window it covers. Given an OS window of its own it would arrive with a title bar and
take focus from the menu it is part of. So a page draws override-redirect windows that overlap its
own, shifted into its coordinates, and ignores the rest.

The websocket is bound to `127.0.0.1` on the server and reached through an `ssh -L` the extension
opens itself (`src/tunnel.ts`). VS Code's own forwarding would do it when it notices the port, and
when it does not the symptom is a webview that connects to nothing and says nothing — the single
most expensive failure this project has had. Owning the tunnel makes that an ssh exit status with
a message on it.

`extensionKind` stays `["ui"]`. The extension has to run where the internet is, because the
payload work in 0003 and 0004 downloads on the client machine and pushes to a server that cannot.

## Consequences

A menu that extends past its parent window's edge is **clipped**, because it is drawn inside that
window's panel. Most EDA menus open within the application window; a combo box near a screen edge
will not. `Janela: Open Whole Session in One Window` is the escape hatch, and is the same client
with `onlyWindow` unset — nearly free to keep, and the reason it is kept.

Every window costs a connection and a handshake. For the three to five windows a waveform viewer
opens that is nothing; for a tool that spawns thirty dialogs it would be felt.

Trimming the chrome is settings, not API: `workbench.editor.showTabs`, `window.menuBarVisibility`.
An auxiliary window keeps a title bar. That is the floor, and it is what "thinnest border
possible" resolves to.

Everything 0001 says about the page still holds — no iframe, capture-phase input, the vendored
client at a pinned version, `window.Worker` hidden because a webview's scripts are cross-origin to
its own page. That decision was never the problem and is unchanged.
