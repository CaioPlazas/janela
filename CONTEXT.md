# Language

The words this project uses, and what each one means here. A glossary, nothing else -- no rules,
no rationale, no implementation. Those live in `AGENTS.md` and the ADRs under `docs/adr/`.

When a word below and a word in the code disagree, one of them is wrong and it is worth finding
out which before writing anything.

## On the server

**Session** -- an xpra server on its own display, owned by the user. It outlives every client:
closing the client, losing the SSH connection, or the laptop sleeping do not end it. Created and
killed explicitly, never implicitly, and identified by its display. It is the whole point of the
project: a session is to a GUI application what a tmux session is to a shell.

**Display** -- the X server a session runs on, written `:100`. What an application puts in its
`DISPLAY` variable. One display, one session.

**Window** -- an X11 window belonging to some application on a display. xpra forwards every window
on the display, including ones an application opens long after it started, which is why xpra and
not a per-application hook.

**Backend** -- how a session got its X server: a **borrowed** display the user already owned (a
VNC session, usually), **Xvfb**, or the unpacked Ubuntu fallback. The server script chooses and
reports which; the choice is the first thing to look at when a machine behaves unexpectedly.

**Prefix** -- a directory containing `bin/xpra`. Resolved on the server, by the server, because
that is where the filesystem is.

**Janela directory** -- where everything Janela puts on the server lives: the scripts, the
`janelas` wrapper, the prefix, and the record of the current session. It sits inside VS Code's
folders but outside any extension's per-extension storage, which is deleted when an extension is
uninstalled.

**Current session** -- the one `janelas` sends things to. Recorded when a session is created or
attached, and confirmed alive before it is trusted: a display that has died must not swallow a
tool into somewhere invisible.

## On the user's machine

**Client** -- xpra's HTML5 client, vendored at a pinned version and run inside a webview. One per
window on screen: each connects to the session and draws exactly one of its windows.

**Panel** -- one window on screen. A VS Code webview moved into an operating-system window of its
own, showing one application window. What the user thinks of as "the waveform viewer".

**Tunnel** -- the ssh forward a panel reaches the session through. The session's websocket is
bound to loopback on the server and to nothing else, so there is no port on the network and still
no passphrase. One tunnel per session, however many panels it has, and its local port never moves
for as long as the session is on screen: a page carries that port inside it, and a page pointed at
a port that has moved can never find its way back.

**Local mode** -- Janela with no ssh at all, when the server is the machine VS Code is running on.
Everything else is the same: the same script, the same sessions, the same wrapper.

**Attach** -- put a session on screen, one panel per window. **Detach** -- close the panels; the
session and everything in it stay running. **Kill** -- end a session, taking its display and every
application on it. Only kill destroys anything.

**Override-redirect** -- a window X11 gives no decoration and no window manager: a menu, a
tooltip, a dropdown. It belongs over the window it covers rather than in a panel of its own, which
would give a menu a title bar and take focus from the thing it is part of. Each panel draws the
ones that overlap its own window and ignores the rest.

**Wrapper** -- `janelas`, on the server. `janelas simvision` runs one command against the current
session's display and changes nothing else, so a plain `simvision` still goes wherever it always
did. It inherits the shell it was called from, which is the point: the modules loaded and the
licence variables set are already there.

**Payload** -- what a server needs to run xpra, moved from a machine that can download to one that
cannot. Three forms. Two are a self-contained **environment**, about 200 MB, carrying its own
python and GTK: either packed inside the VSIX or fetched here as conda packages. They weigh the
same. The third is the server's own **distribution packages**, about 15 MB, which borrow the
machine's python and GTK instead of bringing their own -- and therefore only work on a machine
that has the right ones.

**Suitable** -- what a server is when it can run the distribution packages: the exact interpreter
they were built against, the GTK typelibs, and every library they link. The server answers this
about itself, because it is the only one that can see. An unsuitable server is not a failure; it
gets the environment instead.

**Staging** -- where a payload lands on the server before it becomes a prefix. Deleted once the
environment is built, because a payload that lingers is a copy of something already installed.

**Target** -- the server Janela talks to: a host and optionally a user, taken from the window's own
Remote-SSH connection unless configured. Every server-side action is one ssh command to it.
