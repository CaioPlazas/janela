# Janela

tmux for X11 applications: GUIs that live on a server, survive a disconnected laptop, and come
back when you reattach.

Each application window opens as its own VS Code window, drawn by xpra's HTML5 client inside it.
Nothing is installed on your machine to make that happen — no client, no binary, nothing for an
antivirus to object to. See `docs/adr/0005-one-os-window-per-application-window.md`.

## What it does

- lists every xpra session on the server, including ones you started from a shell, and ones that
  have died
- creates one, choosing an X backend rather than assuming: a display you already own (a VNC
  session), then `Xvfb`, then an unpacked fallback — and it tells you which it took
- opens a session as one operating-system window per application window, with menus drawn over the
  window they belong to
- opens the whole session in a single window instead, when a tool's menus need the room
- lists the tools running in each session, and ends one at a time: **close** asks the application
  to quit, **kill** signals its process
- keeps windows alive across a dropped connection: they say so, keep trying, and come back on
  their own when the link returns
- kills a session when you say so, and only then

## `janelas` — from your own terminal

The better route whenever a tool needs `module load` or a licence variable you set yourself. Add
this once, to your shell's rc file on the server:

```sh
export PATH="$HOME/.vscode-server/janela/bin:$PATH"
```

Then prefix anything:

```sh
module load questa
janelas vsim -gui                  # goes to the Janela session
vsim -gui                          # goes wherever it always did
```

It works for anything — python scripts, long commands, whatever:

```sh
janelas python plot.py --live
janelas 'vsim -gui & sleep 2; xterm'      # one quoted argument may contain shell syntax
```

The extension offers to add it to your `PATH` the first time you make a session, in the right file
for bash, zsh, tcsh or fish. `Janela: Set Up the Shell Wrapper` does it later; neither writes to a
startup file without being asked. If no session is current, `janelas` says so and stops rather than
starting one you are not looking at.

`janelas` inherits your shell exactly as it stands, which `Janela: Launch an Application` cannot:
that one starts a fresh login shell on the server. It prints the display it used, so when a tool
fails for its own reasons you can tell that apart from Janela sending it nowhere. If no session is
running it starts one.

It is a script, not a shell function, so it works from bash, zsh and tcsh alike.

The terminal Janela opens inside a new session already has `DISPLAY` set, so anything launched
from *that* terminal lands there too, with no wrapper at all.

## Requirements

- **On the server**: xpra. If it is missing, `Janela: Set Up xpra on the Server` puts it there,
  and creating a session does it automatically. Either build works on a machine with no internet,
  and neither needs conda or root there.

  The plain build asks the server what it can run before sending anything. A RHEL 8 machine with
  `python3.11` or `python3.12` and the usual GTK libraries gets xpra's own packages — **13 files,
  15 MB**, extracted under `janela.serverDir` without touching the RPM database. Anything else
  gets a self-contained environment with its own python and GTK — **201 MB**. The Output panel
  names the interpreter or library that decided it. The bundled build carries that environment
  inside the VSIX instead of downloading it.

  `janela.payloadMode` forces a choice; `Janela: Survey the Server` reports what that machine has.
- **On your machine**: nothing. The client is xpra's HTML5 one, vendored inside this extension and
  run in a webview — no download, no installer, no administrator rights, nothing on your `PATH`
  and nothing for an antivirus to quarantine.
- **Between them**: ssh. The same one Remote-SSH already uses, with the same keys. Sessions listen
  on unix sockets only; there is no port to forward and no password to set, because SSH has
  already authenticated you.

**Install this extension on your own machine**, not on the server. It declares
`extensionKind: ["ui"]` because it downloads what the server cannot reach, and opens the ssh
tunnel the windows connect through.

## Use

1. **Janela** in the activity bar → **New Session**. It reports the display.
2. Put something in it: the play button on the session, or
   **Janela: Launch an Application**. The command runs on the server through a login shell, so
   `module load` and conda work exactly as they do in a terminal there — and nothing has to set
   `DISPLAY`.

   List the tools you use often in `janela.applications` and they become one click.

   Everything can go in one session; that is what a session is for. Create a second only when you
   want the tools kept apart.
3. Close the windows whenever. The session and everything in it keep running. Click the session
   again to get them back — the ones already open stay open.

If the connection drops — a closed laptop, a VPN that went away — the windows say so and keep
trying. They come back on their own when the link does; there is a **Reconnect now** button if you
are impatient. Quitting VS Code and reopening it restores them too.

Windows are as bare as VS Code allows. To go further, set `workbench.editor.showTabs` to `none`
and `window.menuBarVisibility` to `hidden`; a title bar is the floor.

Closing a window does not end the tool. To actually stop one, expand its session in the sidebar
and use close (or kill, if it will not listen).

`Janela: Survey the Server` is the first thing to run when a machine surprises you: it reports the
xpra it found, the X displays you own, the backend it would choose, glibc, and free space.

## Settings

| setting | default | what it does |
|---|---|---|
| `janela.host` | `""` | server to manage; empty uses the host this window is connected to, or this machine if it is not a remote window |
| `janela.user` | `""` | ssh user; empty lets your ssh config decide |
| `janela.serverPrefix` | `""` | directory on the server containing `bin/xpra`; empty lets the server find one |
| `janela.windowMode` | `per-window` | `per-window` for one OS window each, `session` for all of them in one |
| `janela.grabMode` | `pointer` | when a window takes the keyboard: `pointer`, `always`, `manual` |
| `janela.applications` | `[]` | tools offered when launching: a label and the command you would type |
| `janela.serverDir` | `~/.vscode-server/janela` | where the scripts, `janelas` and xpra live on the server |
| `janela.payloadMode` | `auto` | how xpra reaches the server: `auto`, `lite`, `bundled`, or `conda` |
| `janela.startCommand` | `""` | what a new session starts so it is not empty; `none` for nothing |

## Development

```sh
npm install
npm test          # parsing, ssh command construction, window routing, tunnel supervision
npm run typecheck
npm run build     # dist/extension.js
npm run package   # janela.vsix, ~31 KB
```

`scripts/janela-server` is the whole server side, and it runs standalone:

```sh
scripts/janela-server survey
scripts/janela-server new "some name"
```

Everything in `scripts/` ships inside the VSIX and is pushed to the server when it is needed:

| script | what it does |
|---|---|
| `janela-server` | every question and action on the server, in one script invoked over ssh |
| `janelas` | the wrapper: runs one command against the current session's display |
| `install-server.sh` | installs xpra into a prefix without root; idempotent |
| `xvfb-rootless` | Xvfb with `LD_LIBRARY_PATH` and `XKB_BINDIR` re-set, because a conda `run` clobbers the first and Xvfb needs the second |
| `xpra-*.txt` | the pinned package sets the offline installs use, each with a sha256 |

`docs/adr/` records the decisions the code rests on and what each of them costs — why the pixels
are drawn in VS Code rather than by a native client, why each application window gets its own
panel, and why the payload is fetched by the client. `CONTEXT.md` is the glossary; when a word
there and a word in the code disagree, one of them is wrong.

## What is vendored

`media/www` is [xpra-html5](https://github.com/Xpra-org/xpra-html5) **v20**, unmodified, under the
Mozilla Public License 2.0 — see `media/www/LICENSE`, and `media/www/VERSION` for the exact source
archive and its sha256. Janela itself is GPL-3.0-or-later.

The client is vendored rather than taken from whatever an xpra install happens to provide, because
the extension reshapes its page (`src/html.ts`) and injects `media/janela-boot.js` into it. A
version it has not been tested against can break that quietly.
