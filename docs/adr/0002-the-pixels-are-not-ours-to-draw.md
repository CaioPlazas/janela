# 2. The pixels are not ours to draw

Date: 2026-08-29

## Status

Superseded by [0005](0005-one-os-window-per-application-window.md): the client this decision hands
the drawing to is blocked as malware on the machine that has to run it. Kept because the reasoning
about what a session must survive was right, and 0005 keeps that part unchanged.

## Context

The extension began as a way to put xpra's HTML5 client inside a VS Code webview, so that a remote
GUI would sit next to the code. That worked, eventually, and every step of getting there cost a
defect that only existed because of the webview:

- `new Worker()` refuses a cross-origin script, and a webview serves its files from an origin
  other than the page's. The client died constructing its protocol worker before opening a socket.
- Hiding `window.Worker` fixed that and dropped the client to `SAFE_ENCODINGS` -- `jpeg, png,
  rgb, scroll`. No h264, no webp, decoding on the protocol thread.
- Xvfb's framebuffer cannot be resized (`server.randr.options` lists exactly one mode), so the
  desktop had to be scaled into the tab with a CSS transform.
- Each window captures `client.scale` at construction, so windows that existed before the scale
  was applied dragged in untransformed pixels while the pointer moved in scaled ones.
- A webview cannot take `Alt+Tab` or the Windows key from the OS, however aggressively it grabs.
- The session needed a TCP socket for the browser to reach, which needed a port to forward and a
  passphrase to protect, neither of which a remote desktop should need.

Meanwhile the actual requirement was stated: *tmux for X applications*. Tools that live on the
server, survive a disconnected laptop and a weekend, and reattach seamlessly.

That is what xpra is for, and its **native client** is how it is meant to be used. It draws each
remote window as a real window on the desktop, with the full codec set, the full keyboard, no
framebuffer to fit and no scaling. `ssh://` reaches the session over the connection the user
already has, so SSH does the authentication and no socket is exposed at all.

## Decision

Janela manages sessions. It does not display them.

The extension runs on the user's machine, asks the server over ssh, and launches xpra's own client
to attach. The webview, the vendored HTML5 client, the keyboard grab, the scaling, the passphrase
and the port forwarding are deleted rather than fixed.

## Consequences

The extension is a fraction of its former size -- the VSIX went from 201 MB to 31 KB, and 93,000
lines were removed. Every defect listed above disappeared with the webview rather than being
worked around.

The cost is that the GUI is no longer inside the VS Code window. That was the original premise,
and it was the wrong one: the value was persistence and seamlessness, and a tab provided neither
better than a window does.

Two dependencies are now external and must be honest about it: the user's machine needs xpra's
client (portable build, no administrator rights, downloaded by the extension), and the server
needs xpra (a packed environment, pushed over the same ssh, for machines with no internet).

`docs/adr/0001` is kept rather than deleted. Its subject is gone, but the reasoning was correct
for the architecture it described, and the failure modes it names are why that architecture was
abandoned.
