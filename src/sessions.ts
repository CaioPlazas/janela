/**
 * What sessions exist on this machine.
 *
 * A session is an xpra server on its own display, owned by the user and
 * outliving every viewer (see CONTEXT.md). This module is the only place that
 * knows how to ask xpra about them, and it does so with the same commands
 * `scripts/xpra-tab` uses, so the extension and the script never disagree.
 *
 * The parsing is separated from the running so it can be tested against
 * captured output instead of a live server.
 */


export type SessionState = "LIVE" | "DEAD" | "UNKNOWN";

export interface Session {
  /** ":100". The identity of a session. */
  display: string;
  state: SessionState;
  /** From --session-name. Absent until the session is asked. */
  name?: string;
  /** Windows currently on the display. 0 is an empty desktop, not a dead one. */
  windows?: number;
  /** Viewers attached right now, from anywhere - not just this VS Code. */
  clients?: number;
  /** What is open on it. Filled from the same `xpra info` the counts come from,
   *  so listing the tools costs no extra round trip. */
  open?: RemoteWindow[];
}

/**
 * Parse `xpra list`. It prints one line per socket, and the same display
 * appears once per socket directory, so the same session shows up two or three
 * times:
 *
 *     Found the following xpra sessions:
 *     /run/user/1000/xpra/100:
 *         LIVE session at :100
 *     /home/you/.xpra:
 *         LIVE session at :100
 *
 * A display is LIVE if any of its sockets is: a stale socket left behind next
 * to a working one must not make a running session look dead.
 */
export function parseSessionList(output: string): Session[] {
  const states = new Map<string, SessionState>();
  const rank: Record<SessionState, number> = { LIVE: 3, UNKNOWN: 2, DEAD: 1 };
  for (const line of output.split("\n")) {
    const match = line.match(/\b(LIVE|DEAD|UNKNOWN)\s+session\s+at\s+(:\d+)/);
    if (!match) {
      continue;
    }
    const [, state, display] = match as unknown as [string, SessionState, string];
    const known = states.get(display);
    if (!known || rank[state] > rank[known]) {
      states.set(display, state);
    }
  }
  return [...states.entries()]
    .map(([display, state]) => ({ display, state }))
    .sort((a, b) => Number(a.display.slice(1)) - Number(b.display.slice(1)));
}

/** Pull the few things worth showing in a tree out of `xpra info`. */
export function parseSessionInfo(info: string): Pick<Session, "name" | "windows" | "clients"> {
  const value = (key: string): string | undefined =>
    info.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const asNumber = (raw: string | undefined) => {
    const parsed = Number(raw);
    return raw !== undefined && Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    // `session.name`, not `session-name`: the latter is what the option is
    // called, and it is not what `xpra info` reports it under.
    name: value("session.name") || undefined,
    windows: asNumber(value("state.windows")),
    clients: asNumber(value("clients")),
  };
}





/**
 * One window on the session's display.
 *
 * `xpra info` reports these as `windows.<id>.<key>`, which is the only place
 * the extension can learn what is open without connecting a client first.
 */
export interface RemoteWindow {
  id: number;
  title: string;
  /** Where it sits on the session's display, in its pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Menus, tooltips and dropdowns. X11 gives these no decoration and no window
   * manager involvement, and they belong over the window they cover - never in
   * an OS window of their own, which would arrive with a title bar and steal
   * focus from the menu it is supposed to be part of.
   */
  overrideRedirect: boolean;
  /** `NORMAL`, `DIALOG`, `MENU`... empty when the application did not say. */
  type: string;
  /** The process behind it, when the application said. Absent means the only
   *  way to end it is to ask it politely, or to kill the whole session. */
  pid?: number;
  /** What was run, as a readable line. `xpra info` gives argv NUL-separated. */
  command?: string;
  /** The application's own name for itself, from WM_CLASS. Steadier than the
   *  title, which changes with the open file. */
  application?: string;
}

/**
 * Read the windows out of `xpra info`.
 *
 * Values arrive as python literals - `(0, 0, 800, 600)`, `False`, `('NORMAL',)`
 * - so each is read for the one shape it actually has rather than parsed in
 * general.
 */
export function parseWindows(info: string): RemoteWindow[] {
  const fields = new Map<number, Map<string, string>>();
  for (const line of info.split("\n")) {
    const match = /^windows\.(\d+)\.([a-z-]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const id = Number(match[1]);
    if (!fields.has(id)) {
      fields.set(id, new Map());
    }
    fields.get(id)!.set(match[2], match[3]);
  }

  const windows: RemoteWindow[] = [];
  for (const [id, keys] of [...fields].sort((a, b) => a[0] - b[0])) {
    const numbers = (key: string): number[] =>
      (keys.get(key) ?? "").match(/-?\d+/g)?.map(Number) ?? [];
    const geometry = numbers("geometry");
    const size = numbers("size");
    const pid = Number(keys.get("pid"));
    windows.push({
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
      // `'/usr/bin/xterm\x00-T\x00alpha'` - quoted, and NUL-separated as the
      // literal four characters rather than an actual NUL.
      command: (keys.get("command") ?? "")
        .replace(/^'|'$/g, "")
        .split("\\x00")
        .filter(Boolean)
        .join(" ") || undefined,
      application: /'([^']+)'/.exec(keys.get("class-instance") ?? "")?.[1] || undefined,
      id,
      title: keys.get("title") ?? "",
      x: geometry[0] ?? 0,
      y: geometry[1] ?? 0,
      width: geometry[2] ?? size[0] ?? 0,
      height: geometry[3] ?? size[1] ?? 0,
      overrideRedirect: keys.get("override-redirect") === "True",
      type: /'([A-Z_]+)'/.exec(keys.get("window-type") ?? "")?.[1] ?? "",
    });
  }
  return windows;
}

/**
 * Which windows deserve an OS window of their own.
 *
 * Only this decision is made here. Whether a *menu* belongs inside a given
 * window is decided in the browser, by `media/janela-boot.js`, because that is
 * where the geometry is known as it changes.
 */
export function windowsNeedingPanels(windows: RemoteWindow[]): RemoteWindow[] {
  return windows.filter((window) => !window.overrideRedirect && window.width > 0 && window.height > 0);
}

/** Everything the sidebar shows, from one call. */
export interface Status {
  sessions: Session[];
  /** The display `janelas` sends things to, so the sidebar can say which. */
  current?: string;
}

/**
 * Parse `janela-server status`.
 *
 * One round trip instead of one for the list plus one per session. Over ssh
 * that mattered: every call is a whole connection, because Windows OpenSSH has
 * no `ControlMaster` to multiplex through, and the sidebar polls.
 *
 *     --- :107 LIVE
 *     session.name=Janela
 *     state.windows=4
 *     windows.1.title=...
 *     --- current :107
 */
export function parseStatus(text: string): Status {
  const status: Status = { sessions: [] };
  const blocks = text.split(/^--- /m).slice(1);
  for (const block of blocks) {
    const newline = block.indexOf("\n");
    const header = (newline === -1 ? block : block.slice(0, newline)).trim();
    const body = newline === -1 ? "" : block.slice(newline + 1);

    if (header.startsWith("current")) {
      const value = header.slice("current".length).trim();
      status.current = value && value !== "none" ? value : undefined;
      continue;
    }
    const [display, state] = header.split(/\s+/);
    if (!/^:\d+$/.test(display ?? "")) {
      continue;
    }
    const session: Session = {
      display,
      state: state === "LIVE" || state === "DEAD" ? state : "UNKNOWN",
    };
    if (session.state === "LIVE") {
      Object.assign(session, parseSessionInfo(body));
      session.open = windowsNeedingPanels(parseWindows(body));
    }
    status.sessions.push(session);
  }
  return status;
}

/** What `scripts/janela-server` returns, however it was reached. */
export type ServerRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Registry {
  list(): Promise<Session[]>;
  /** The same information, plus which session is current. One round trip. */
  status(): Promise<Status>;
  create(name: string): Promise<string | undefined>;
  kill(display: string): Promise<boolean>;
}

/**
 * The registry, over whatever runner it is given.
 *
 * The runner is injected rather than built here because the same code has to
 * work over ssh in production and locally in a spike, and because nothing about
 * parsing `xpra list` cares which of those it is.
 */
export function registry(run: ServerRunner, log: (message: string) => void): Registry {
  return {
    async list() {
      return (await this.status()).sessions;
    },

    async status() {
      const result = await run(["status"]);
      return parseStatus(result.stdout);
    },

    async create(name: string) {
      const result = await run(["new", name]);
      log(result.stdout.trim() || result.stderr.trim() || "(no output)");
      // "display :137" on success; the server also reports which X backend it
      // chose, which is the first thing to look at when a machine surprises us.
      return /^display\s+(:\d+)/m.exec(result.stdout)?.[1];
    },

    async kill(display: string) {
      log(`killing the session on ${display}`);
      const result = await run(["kill", display]);
      log(result.stdout.trim() || result.stderr.trim() || "(no output)");
      return result.code === 0;
    },
  };
}
