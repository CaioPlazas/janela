# Changelog

## 0.11.2 - 2026-09-09

The first public release, and four faults found while preparing it.

- **A missing `ssh` crashed the extension host.** `spawn` does not throw when the binary is not
  there; it emits an `error` event, and an `error` event with no listener is an uncaught exception.
  A machine without OpenSSH on `PATH` took Janela down instead of being told what was missing.
- **Provisioning could not work without ssh at all.** Only the script push checked for local mode;
  the bundled, lite and distribution-package routes each built `scp -r <dir> :~/...` with no host.
  All copying now goes through one place that knows where the server is.
- **A failed record of the current session was silent.** The session would run and `janelas` would
  never find it — the same "the tool went somewhere invisible" fault the wrapper was changed to
  stop causing.
- **A window that could not be opened said nothing**, becoming an unhandled rejection.

Also: `scripts/README.md` documented four scripts that no longer exist and omitted four that do.
It is folded into the README, because a second index of the same directory is a second thing to
keep true, and this one had not been true for weeks.

The source now lives at **https://github.com/CaioPlazas/janela**, with the VSIX attached to each
release. `media/www` is xpra-html5 v20, unmodified, under the MPL-2.0.

## 0.11.1 - 2026-09-08

Housekeeping. No behaviour changes.

- Removed the scaffolding left over from finding the reconnect bug: a page-side marker written
  thirteen times and read nowhere, a restore counter with no reader, a duplicated VS Code launch
  configuration, and three dead imports.
- The extension's diagnostics are now **asserted** by the headless VS Code suite rather than
  printed into it. Instrumentation nothing checks is just weight.
- `noUnusedLocals` and `noUnusedParameters` are on, and `tsc` now covers `spikes/` as well as
  `src/`. The spikes had never been typechecked at all - Node's type stripping does not check
  anything - and turning it on found the dead imports immediately. Dead code should be a compile
  error rather than something noticed months later.

## 0.11.0 - 2026-09-07

Reconnecting works. It never had.

Not intermittently - never. A fresh page load was the only way back to a session, which from the
outside is exactly what "unreliable" feels like. Five causes, found by cutting a real connection to
a real session in a real browser and reading what the page did next:

- **`close_protocol()` threw on every reconnect.** It calls `protocol.close()` and then
  `protocol.terminate()`, and only the worker host has `terminate`. Janela hides `window.Worker`
  deliberately, because a webview's scripts are cross-origin to its own page, so the plain protocol
  is the only one ever used - and reconnecting died there before reaching `connect()`.
- **The page navigated itself away.** xpra's `index.html` installs a close callback that goes to
  `connect.html`, replacing the document and taking this extension's script, its overlay and any
  possibility of reconnecting with it. The window did not freeze; it left.
- **Recovery waited on a once-a-second poll** to have seen the connected state, so a link that
  dropped just after connecting was never recovered.
- **Re-attaching closed every window and rebuilt it**, losing them outright if the rebuild failed.
- **The forwarded port moved**, stranding pages that were still pointing at the old one.

What replaces all of it: a page that has lost its connection **says so, and keeps trying**, with a
retry you can press; the tunnel **keeps one port per session** and restarts its ssh child with a
backoff that settles rather than gives up; re-attaching **reveals what is open** and fills in only
what is missing; and windows **come back after VS Code restarts** instead of returning as blank
frames.

Running tools from a terminal:

- **`janelas` no longer starts a session behind your back.** It used to create one silently when
  none was current, so the tool went to a display nobody was attached to and the only symptom was
  a window that never appeared. It now names the command to run and stops.
- **A tool started after attaching to an empty session gets its own window.** A guard meant the
  desktop stand-in kept everything inside it forever.
- **The extension offers to put `janelas` on your `PATH`**, in the right file for bash, zsh, tcsh
  or fish, and never writes to one unless asked. `Janela: Set Up the Shell Wrapper` does it later.
- **The sidebar marks the current session**, so "where did that tool go" is answered by looking.

Also:

- **Displays are no longer used up for good.** xpra leaves its socket directory behind when a
  session dies, and `free_display` counted those as occupied - so every display a session had ever
  used was lost permanently, until no session could be started at all. On the twenty-display range
  the test spike uses, that took about a day. A display is free when nothing is serving it.
- **Windows close when their session goes away**, whether you killed it from the sidebar or from a
  shell. They used to sit there reconnecting to something that was never coming back, which says
  the wrong thing very persistently. Two consecutive absences, so one failed poll closes nothing.
- One ssh round trip per poll instead of one plus one per session, and no polling while the sidebar
  is hidden. Windows OpenSSH has no `ControlMaster`, so there is no multiplexing to lean on.
- **Local mode**: with no Remote-SSH window and no `janela.host`, Janela runs against this machine.
  Useful on a Linux desktop, and it is what lets the extension be driven by a test.
- New gates: `spikes/verify-reconnect.ts` cuts a real connection and proves the window comes back;
  `spikes/verify-extension.ts` drives a real headless VS Code through 13 checks, and immediately
  found a bug no other gate could - every panel was reloading itself before it finished connecting, because it
  read "the tunnel is up" as recovery rather than as confirmation.

## 0.10.1 - 2026-09-01

The sidebar lists what is running, and can end it.

Closing a Janela window does not end the application - that is what a session is for, and it is
also why there was no way to stop a tool without opening a shell.

- **Every session expands to show its tools**, with what the application calls itself, its size,
  and the command it was started with in the tooltip. Clicking one brings its window forward.
- **Close** asks the application to quit, the way clicking its X does, so a tool that wants to ask
  about unsaved work still gets to.
- **Kill** signals the process behind the window - TERM, then KILL if it is still there ten
  seconds later. Offered only for a window that reports a pid, because a button that cannot work
  should not be there. It confirms first: signalling a process loses whatever was unsaved.
- `janela-server` gains `close <display> <wid>` and `kill-window <display> <wid>`. Both were run
  against real windows: `close` ended an xterm through xpra's control channel, `kill-window`
  ended one by pid and TERM was enough.

The tool list costs no extra round trip: it comes out of the same `xpra info` the window counts
already came from.

## 0.10.0 - 2026-09-01

The pixels come back, one window at a time.

xpra's native client is blocked as malware on the machine that has to run it. The classification
is wrong and it is also not appealable, so Janela draws the windows again - but not in a tab.

- **One operating-system window per application window.** Each gets a VS Code webview running its
  own xpra HTML5 client, moved into a window of its own. A waveform viewer and its dialogs behave
  like the separate windows they are, and can go on separate monitors.
- **Menus stay where they belong.** An override-redirect window - a menu, a tooltip, a dropdown -
  is drawn over the window it covers rather than given a window of its own, which would hand a
  menu a title bar and take focus from the thing it is part of.
- **Four windows cost four streams, not sixteen.** `Client.js` sends `map_window` from inside
  `_new_window`, so a window a page never builds is one the server never sends it pixels for.
  Proven in `spikes/verify-windows.ts` against a real session in real Chromium: with `onlyWindow`
  set the client builds `[1]`, without it `[1, 2]`.
- **Nothing is installed on your machine.** The HTML5 client is vendored in the extension at a
  pinned version. No download, no binary, nothing for an antivirus to quarantine.
- **Sessions gain a websocket**, bound to `127.0.0.1` and nowhere else, reached through an
  `ssh -L` the extension opens and owns - so a failure is an ssh message rather than a window that
  connects to nothing and says nothing. `janela-server ws <display>` reports the port, read from
  the session rather than guessed.
- **`Janela: Open Whole Session in One Window`** for when a tool's menus overflow their window.
  A menu that extends past its parent's edge is clipped; this is the way round it.
- `janela.windowMode` and `janela.grabMode` are settings again. `janela.clientCommand` and
  `janela.clientUrl` are gone, with the client downloader they configured.

ADR 0005 records the decision and what it costs; ADR 0002 is superseded but kept, because what it
said about sessions surviving a disconnect is still true and still the point.

## 0.9.2 - 2026-08-31

Found live, on a real server: nothing ran at all.

- **`VAR=value command` is not a thing in tcsh.** ssh hands what it is given to the account's
  login shell, and on an EDA server that is routinely tcsh, which read `JANELA_HOME=...` as the
  name of a command and reported it missing - so every server-side call failed before it started.
  Variables now go through `env`, which is a program rather than shell syntax and works under sh,
  bash, tcsh and fish alike.
- **`Attach` and `Survey` were asking the server without those variables at all**, so they
  answered for the default directory. Attach used the result to pick the `--remote-xpra` the
  client connects with, which on a configured `janela.serverDir` was the wrong xpra or none.
  Both go through the same runner as everything else now.
- **The bundled installer unpacked into `~/.janela`** regardless of `janela.serverDir`, leaving an
  environment nothing else would look for. It uses the configured directory.

## 0.9.1 - 2026-08-30

One fix, on the path every install takes.

- **`~` in a server path was never expanded.** The extension sends
  `JANELA_HOME="~/.vscode-server/janela"`, and the shell does not expand a tilde inside quotes -
  so `janela-server` resolved it to a literal `~` directory under `$HOME`, while `scp`, which does
  expand it, wrote to the real one. The payload arrived in one place and the install looked in
  another. Every path the extension passes in is now expanded on arrival: `JANELA_HOME`,
  `janela.serverPrefix`, and the staging and destination arguments of all three bootstraps.

  It had been masked by the legacy `~/.janela` fallback silently rewriting the path, which 0.9.0
  removed. On a server with no `~/.janela`, it would have failed either way.

## 0.9.0 - 2026-08-30

A 15 MB install on a server that can take it, and the server decides.

- **The distribution-package route.** Before sending 201 MB, Janela asks the server whether it can
  run xpra's own el8 packages: the right interpreter (`python3.11` or `python3.12`), the GTK
  typelibs PyGObject loads through, and the 45 libraries they link. If it can, setup is **13
  packages, 15 MB**, downloaded on your machine and extracted under `janela.serverDir` without
  root and without touching the RPM database. If it cannot, the self-contained 201 MB environment
  goes across as before. The Output panel names whatever was missing.
- **A failed attempt leaves nothing behind.** `bootstrap-rpm` runs `xpra --version` from the tree
  it extracted and deletes the whole prefix if that fails, keeping the packages. A prefix that
  exists but does not work is worse than none: it satisfies `find_prefix`, so every later command
  fails instead of the install.
- **Both package lists are generated**, by `scripts/build-rpm-list.sh`, which resolves the
  dependency closure against xpra.org's own repository metadata and writes the sonames the server
  must already provide. `janela-server` keeps no copy of that list; it is told what to look for.
- **Fixed:** an explicitly-set `JANELA_HOME` was overridden by a legacy `~/.janela` directory, so
  `janela.serverDir` was silently ignored on any server carrying an older install.

`docs/adr/0004-the-server-decides-which-payload-it-gets.md` records why this was built now, having
been deliberately left unbuilt in ADR 0003.

## 0.8.0 - 2026-08-30

`janelas`, and an installer that does not need a 200 MB VSIX.

- **`janelas <anything>`** runs one command against the current session's display and changes
  nothing else, so plain `simvision` still goes where it always did. Multiple arguments pass
  through untouched; a single quoted argument may contain shell syntax. It inherits the shell it
  was called from - the modules you loaded, the licence variables you set - which
  `Janela: Launch an Application` cannot, because that starts a fresh login shell. A script rather
  than a shell function, so bash, zsh and tcsh all work. Add
  `export PATH="$HOME/.vscode-server/janela/bin:$PATH"` once.
- **A current session**, recorded when one is created or attached and confirmed alive before it is
  used, so the sidebar and the shell cannot disagree. `janela-server current` reports it.
- **A lite installer.** The extension downloads the 181 pinned conda packages here, verifies every
  one against its sha256, copies them over the ssh connection already open, and links them into an
  environment on the server without touching the network there. `janela.payloadMode` chooses
  between that, a carried bundle, and asking the server to fetch its own.
- Everything Janela puts on the server now lives in `~/.vscode-server/janela` - inside VS Code's
  folders, but not under extension storage, which is deleted when an extension is uninstalled and
  took a working xpra with it once.
- `scripts/build-explicit.sh` regenerates the pinned list. `RELEASE.md` requires it, because a
  release shipping a stale list installs an environment nobody has run.

The lite route moves 201 MB where the bundled one moves 211 MB. It exists for a small VSIX and a
current payload, not to save transfer - the measurement is in
`docs/adr/0003-the-payload-is-fetched-by-the-client.md`.

## 0.7.0 - 2026-08-29

Launch from your own shell, and set up a server that cannot reach the internet.

- **`janela-server env`** prints `export DISPLAY=:106` for the session. `eval` it and every tool
  you start from that shell lands in the session, inheriting your environment exactly - the
  modules you loaded, the licence variables you set. `Janela: Launch an Application` cannot do
  that: it starts a fresh login shell. Both have their place, and this one is better for EDA
  tooling. The terminal inside a new session already has `DISPLAY` set, so it needs no `eval`.
- **`Janela: Set Up xpra on the Server`**, and it happens automatically when a session is created
  on a machine that has none. A bundled build carries a packed environment and copies it across
  the ssh connection already open, then unpacks and relocates it there: no internet, no conda, no
  root, no package request. `npm run package:bundled` produces that build, now targeting
  `win32-x64` since that is where the extension runs.
- `janela-server bootstrap` does the unpacking, and is usable by hand for anyone who would rather
  scp the tarball themselves.

## 0.6.0 - 2026-08-29

Launch tools into a session without knowing its display, and put them all in one session.

- **`Janela: Launch an Application`**, also a play button on each live session. It runs
  `xpra control <display> start` on the server, so nothing has to set `DISPLAY` - and it runs the
  command **through a login shell**, so `module load`, conda and `PATH` mean what they mean in a
  terminal on that machine. That last part is why launching a tool worked from a terminal and
  failed from the extension in the first attempt.
- **`janela.applications`** holds the tools you launch often - a label and the command you would
  type. Leave it empty and it asks for a command each time.
- **One session can hold everything.** That was already true and is now usable: launch targets a
  session that is already running rather than creating another. A session with several tools in it
  is exactly what a VNC desktop is.
- Sessions are started with `--start-new-commands=yes`, so xpra's own client menu can start
  programs too.

## 0.5.2 - 2026-08-29

Two things that made a working attach look like a broken one.

- **A new session now starts a terminal in it.** xpra forwards windows, and an empty display has
  none, so attaching to a fresh session drew literally nothing - indistinguishable from a client
  that failed. The server picks the first terminal it finds, with `--exit-with-children=no` so
  closing it does not end the session. `janela.startCommand` overrides it; `none` keeps the old
  behaviour. This is also where the next application gets launched from, which is the point.
- **Audio is refused outright**: `--audio=no --speaker=disabled --microphone=disabled` on the
  client. It was trying to forward speakers and failing noisily on a machine with no audio path to
  the server, which is every machine this is for. `disabled` rather than `off` - `off` still
  negotiates it.
- `janela-server survey` reports which terminal it would use, and `new` reports what it started.

The attach itself was working the whole time: the server log showed `setting key repeat rate from
client`, which only happens after a successful handshake.

## 0.5.1 - 2026-08-29

First run against a real server, and it failed silently. Both causes were mine.

- **The error was being thrown away by a redirect.** `janela-server new` ended its xpra call with
  `>/dev/null 2>&1`, which also swallowed the message explaining why it could not run one. The
  extension logged `(no output)` and nothing else. xpra's chatter now goes to a temporary file and
  is printed when a start fails, which is the only time anyone wants it.
- **The server's xpra had been deleted.** It lived in the remote extension's global storage, so
  uninstalling that extension took it. Storing the server's runtime inside a VS Code extension's
  storage was wrong: the extension's lifecycle owned it. The prefix search now looks in
  `~/.janela/xpra` and the usual conda locations, and never inside extension storage.
- `janela-server new` says so plainly when there is no xpra, instead of failing three calls deep.
- New `janela-server install`, which puts xpra in `~/.janela/xpra` without root. The extension
  pushes `install-server.sh` alongside the server script so it is there when needed.

## 0.5.0 - 2026-08-29

Janela stopped drawing pixels. It manages sessions; xpra's own client displays them.

- **The webview is gone**, and with it every defect that only existed because of it: the Worker
  that cannot be constructed cross-origin, the encodings lost when it was disabled, the fixed
  framebuffer, the scale captured at window creation, the keyboard that could never take
  `Alt+Tab`, the passphrase and the forwarded port that existed only so a browser could reach the
  socket. 93,000 lines removed; the VSIX went from 201 MB to 31 KB.
- **The extension runs on your machine** (`extensionKind: ["ui"]`), because that is where a client
  has to be launched. Install it locally, not on the server.
- **The portable xpra client is downloaded and unpacked by the extension** - the MSI wants
  administrator rights, the zip does not, and it carries openh264, vpx, webp and jpeg decoders.
- **One script answers everything on the server** (`scripts/janela-server`), because every question
  it answers is about that filesystem. It also chooses the X backend rather than assuming one: a
  display you already own, then Xvfb, then the unpacked fallback - and it says which. Display
  ownership is checked, since `/tmp/.X11-unix` on a shared machine holds other people's.
- **Sessions listen on unix sockets only.** No TCP, no port to forward, no passphrase possible.
  `ssh://` reaches them over the connection you already have.
- `Janela: Survey the Server` reports what a machine actually has, which is the only honest way to
  plan for one you cannot see.

## 0.4.1 - 2026-08-29

Dragging a window moved it somewhere other than the cursor.

Only windows that already existed when the viewer attached were affected, which is why closing
everything and reopening appeared to fix it: windows opened afterwards were always fine.

- **The scale is applied before connecting**, so every window is created under it. Each window
  captures `client.scale` at construction (`Client.js:3212`) and configures jQuery UI from it -
  `make_draggable` passes `transform: true` only when that scale is not 1 (`Window.js:283`). A
  window built at scale 1 and then rendered under a CSS transform drags in untransformed pixels
  while the pointer moves in scaled ones.
- **Changing the scale later now rebuilds each window's draggable**, so resizing the tab does not
  reintroduce the same mismatch for windows already on screen.
- `spikes/verify-window-scale.ts` opens a window before connecting and compares every window's
  scale with the pointer's. Against 0.4.0 it reports `window 1: scale=1 transform=null` beside
  `client.scale = 2.133`; with the fix all of them agree.

## 0.4.0 - 2026-08-29

The grab is now as aggressive as a webview allows.

- **Listeners moved to `window`, capture phase.** Capture runs outermost-first, so they fire
  before anything on `document` - including the forwarder VS Code's webview preamble installs to
  feed its keybinding service. On `document` we were competing by registration order and losing,
  which is why some keys still reached the editor.
- **Right-click goes to the remote application.** The client already suppressed the *browser*
  menu (`index.html:1618`), but VS Code's own was drawn from the forwarded event first. It is now
  stopped before either sees it.
- Wheel-zoom, text selection and drag-and-drop are suppressed while grabbed. `keypress` is
  swallowed too: xpra does not need it, and left alone it still reached the host.
- **The pointer decides, like a VM console.** `janela.grabMode` defaults to `pointer`: the
  keyboard is grabbed while the mouse is over the tab and handed back when it leaves.
  `Ctrl+Alt+G` still releases explicitly, and that release lasts until the pointer leaves and
  returns. `always` and `manual` are there for anyone who wants the old behaviour.
- The grab state is mirrored to `data-janela-grab` on `<html>`, which is the only way to see it
  from outside and is what `spikes/verify-grab.ts` asserts against.

What no browser can take, and this does not pretend to: `Alt+Tab`, the Windows key and
`Ctrl+Alt+Del`. The OS claims those first. Chrome's Keyboard Lock, which would take even those,
needs fullscreen and a permission a webview iframe is not granted - it is attempted and ignored.

## 0.3.4 - 2026-08-29

The desktop fits the tab.

- **The viewer scales the remote desktop to the window.** A session's screen is a fixed-size Xvfb
  framebuffer: xpra asks it to match the client and it cannot comply - `server.randr.options`
  lists exactly one mode - so anything larger than the tab was simply cropped. Xdummy is how xpra
  normally avoids this, and Xdummy needs root. The client's own `scale` renders the whole desktop
  and transforms it down, dividing pointer coordinates by the same factor so clicks still land
  where they look. It re-fits when the window changes, and never scales *up*: magnifying a small
  desktop is worse than empty space, especially for a waveform.
- New `janela.geometry` (default `1920x1080`) sets a new session's screen. Match it to your usual
  tab size for a crisp 1:1 picture instead of a scaled one.
- `xpra info` reports the screen as `server.root_window_size`, and the extension now asks for it
  directly when building a viewer, retrying while a just-started session still answers without it.

## 0.3.3 - 2026-08-29

The blank tab was never a networking problem.

- **`window.Worker` is hidden before the client loads.** A webview page's origin is
  `vscode-webview://<uuid>` while its files are served from `…vscode-resource.vscode-cdn.net`,
  and `new Worker(url)` refuses a cross-origin script. xpra's client threw
  `SecurityError: Failed to construct 'Worker'` at `Protocol.js:39` and stopped there - before
  opening any connection, which is why the server never saw one. The client uses workers only
  when `window.Worker` exists and otherwise runs the protocol in the page, which is a supported
  path: verified connecting, focusing a window and delivering `Ctrl`/`Alt` with the modifier bits
  set.
- The cost is that protocol handling and decoding share the page's thread. If that shows up as
  slow waveform rendering, the fix is re-serving each worker from a `blob:` URL, which also means
  rewriting the relative `importScripts` calls inside them.

Two earlier attempts at this were wrong and are worth naming: `asExternalUri` (0.3.1) and
`portMapping` (0.3.2). The address the client was given, `ws://localhost:14500/`, had been
correct since 0.3.2 - the console line right before the failure said so.

## 0.3.2 - 2026-08-29

The webview reaches the session through `portMapping`, which is the mechanism built for it.

- A webview is a browser context on the **client** machine, so its `localhost` is the laptop, not
  the server. `asExternalUri` was the wrong tool: it exists to expose a port to a browser the
  user opens themselves, and under Remote-SSH it handed the address straight back. The result was
  a tab that stayed blue while the session behind it was running perfectly, with three windows on
  it.
- `portMapping` routes a port inside the webview to a port on the **extension host** - the server
  - with no forwarding for the user to do.
- A viewer that has not connected after ten seconds now says so and names the port to forward,
  because an unconnected tab and an empty session look identical.

## 0.3.1 - 2026-08-29

Fixes the first thing that happened on a real Windows client: the tab opened blue and never
connected.

- **The webview is pointed at `localhost`, not `127.0.0.1`.** VS Code's port forwarding matches
  on the hostname and handed `127.0.0.1` straight back untouched, so the webview dialled its own
  machine - Windows - where nothing was listening. The Output log said
  `webview will connect to ws://127.0.0.1:14509`, then `disconnected`, and the server never saw a
  TCP connection at all.
- When `asExternalUri` returns the address unchanged while connected to a remote, Janela now says
  so, names the port, and offers the PORTS panel - instead of leaving an empty tab to be
  interpreted.

## 0.3.0 - 2026-08-29

Janela became a session manager, and stopped leaving sessions open to the whole machine.

- **Sessions, in a sidebar tree.** Several at once, each on its own display, listed with their
  name, window count and whether a viewer is attached - including sessions started from a shell,
  and ones that have died. New Session creates an empty desktop and tells you the `DISPLAY` to
  run things into; Kill is the only thing that destroys anything, and empty sessions are left
  standing on purpose.
- **Every session now requires a passphrase.** xpra's default is no authentication at all, and
  `127.0.0.1` only keeps other *hosts* out: on a shared server every local account could attach
  to your desktop. Set once, typed once per window, held in memory only.
- Several viewers can be open at once, and the keyboard grab is per viewer rather than global.
- The launcher allocates a free display as well as a free port, and takes `JANELA_AUTH_FILE` and
  `JANELA_SESSION_NAME`.
- A bundled env now records which bundle it came from, so a VSIX carrying a newer xpra actually
  replaces it instead of being silently ignored. xpra stays pinned at 6.2.2 until there is a
  reason to move.
- `CONTEXT.md` defines the vocabulary (session, display, viewer, attach, detach, kill), and
  `docs/adr/0001` records why the client is not in an iframe.

Three things learned the hard way, all in `docs/verification.md`: xpra's PAM module is missing
from the conda-forge build, the per-socket `auth=` syntax its own help recommends is silently
ignored (leaving the socket open while looking configured), and `xpra info` reports the session
name under `session.name`.

## 0.2.0 - 2026-08-27

Installing the VSIX is now the whole install.

- **The HTML5 client ships inside the extension** (`media/www`, xpra-html5 v20, vendored by
  `scripts/fetch-html5.sh`) and is served with `--html=<absolute path>` - an option xpra accepts
  but does not document. Nothing is copied into a conda env any more, and every install serves
  the same client this was tested against.
- **A second, self-contained build**: `npm run package:bundled` produces a `linux-x64` VSIX
  carrying a `conda-pack`'d xpra env (~200 MB), unpacked into the extension's own storage on
  first run. It needs no network, no conda and no root on the target machine.
- **`Janela: Install Server Components`** for the thin build: one script,
  `scripts/install-server.sh`, now used by the extension, the wizard and by hand.
- One resolver decides which xpra is used - a prefix you configured, the bundled one, or a
  managed install - so the three can coexist without surprises. New `janela.serverPrefix`;
  `janela.condaEnv` still works and `janela.xpraCommand` is gone.
- `extensionKind: ["workspace"]`, so under Remote-SSH the extension runs on the server where
  xpra and the X display actually are. It was unspecified before, which was a bug.
- The launcher takes `JANELA_XPRA_PREFIX` and `JANELA_WWW`, and can borrow an existing display
  with `XPRA_TAB_USE_DISPLAY=1`. A copy already deployed in `~/bin` keeps working.
- `RELEASE.md` documents both artifacts; `spikes/verify-bundle.ts` proves the packed env works
  somewhere other than where it was built.

## 0.1.0 - 2026-08-27

First working version.

- `Janela: Open Session` hosts xpra's HTML5 client in a webview, loading its files as webview
  resources rather than iframing a URL, so keystrokes can be intercepted before VS Code sees them.
- Keyboard grab with `Ctrl+Alt+G` and a status bar item saying which side owns the keyboard.
- `asExternalUri` is used to reach the session, so the port is forwarded by VS Code under
  Remote-SSH rather than by hand.
- `Janela: Stop Session`, and a launcher-driven port lookup that starts or reuses a session.
- `scripts/eda-server-wizard.sh`: interactive setup for a server this repo cannot run on.
- `docs/rootless-xpra-recipe.md` and `docs/verification.md`: how the stack was built without root,
  and exactly what has and has not been proven.
