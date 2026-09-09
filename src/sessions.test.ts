import assert from "node:assert/strict";
import test from "node:test";

import { parseSessionInfo, parseSessionList, parseStatus, parseWindows, windowsNeedingPanels } from "./sessions.ts";

// Captured verbatim from `xpra list` on 2026-08-29. The same display appears
// once per socket directory, which is the whole reason this needs a parser.
const LIST = `Found the following xpra sessions:
/run/user/1000/xpra/100:
\tLIVE session at :100
/run/user/1000/xpra:
\tLIVE session at :100
/home/you/.xpra:
\tLIVE session at :100
`;

test("a display listed once per socket directory is one session", () => {
  const sessions = parseSessionList(LIST);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], { display: ":100", state: "LIVE" });
});

test("dead and unknown sessions are kept, because they are what needs killing", () => {
  const mixed = parseSessionList(
    ["\tLIVE session at :100", "\tDEAD session at :101", "\tUNKNOWN session at :102"].join("\n"),
  );
  assert.deepEqual(
    mixed.map((s) => [s.display, s.state]),
    [
      [":100", "LIVE"],
      [":101", "DEAD"],
      [":102", "UNKNOWN"],
    ],
  );
});

test("a stale socket next to a working one does not make a session look dead", () => {
  const sessions = parseSessionList(["\tDEAD session at :100", "\tLIVE session at :100"].join("\n"));
  assert.deepEqual(sessions, [{ display: ":100", state: "LIVE" }]);
});

test("sessions come back in display order, not socket order", () => {
  const sessions = parseSessionList(
    ["\tLIVE session at :137", "\tLIVE session at :100", "\tLIVE session at :102"].join("\n"),
  );
  assert.deepEqual(
    sessions.map((s) => s.display),
    [":100", ":102", ":137"],
  );
});

test("noise that is not a session line is ignored", () => {
  assert.deepEqual(parseSessionList("Found the following xpra sessions:\n/run/user/1000/xpra:\n"), []);
  assert.deepEqual(parseSessionList(""), []);
});

// Captured from `xpra info :100`.
const INFO = [
  "session.name=Janela 2",
  "state.windows=3",
  "clients=1",
  "server.argv=('xpra', 'start', ':100')",
].join("\n");

test("info yields the name, the window count and how many clients are attached", () => {
  assert.deepEqual(parseSessionInfo(INFO), { name: "Janela 2", windows: 3, clients: 1 });
});

test("an empty session is not a broken one", () => {
  const empty = parseSessionInfo(["session.name=Janela 1", "state.windows=0", "clients=0"].join("\n"));
  assert.equal(empty.windows, 0, "zero windows must survive as 0, never become undefined");
  assert.equal(empty.clients, 0);

});

test("a session with no name at all is still parsed", () => {
  assert.deepEqual(parseSessionInfo("state.windows=1"), { name: undefined, windows: 1, clients: undefined });
});




// Captured from a real `xpra info :107`, including the tuple and python-bool
// shapes that made a general parser the wrong idea.
const WINDOWS_INFO = `state.windows=4
windows.1.geometry=(0, 0, 800, 600)
windows.1.iconic=False
windows.1.override-redirect=False
windows.1.size=(800, 600)
windows.1.title=Alacritty
windows.1.window-type=('NORMAL',)
windows.2.geometry=(120, 80, 484, 316)
windows.2.override-redirect=False
windows.2.size=(484, 316)
windows.2.title=multi arg form
windows.2.window-type=('DIALOG',)
windows.7.geometry=(200, 140, 160, 220)
windows.7.override-redirect=True
windows.7.title=
windows.7.window-type=('MENU',)`;

test("windows come out of xpra info with identity and geometry", () => {
  const windows = parseWindows(WINDOWS_INFO);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map((w) => w.id), [1, 2, 7]);
  assert.equal(windows[0].title, "Alacritty");
  assert.equal(windows[0].width, 800);
  assert.equal(windows[1].x, 120);
  assert.equal(windows[1].type, "DIALOG");
});

test("a menu is marked override-redirect", () => {
  const menu = parseWindows(WINDOWS_INFO).find((w) => w.id === 7)!;
  assert.equal(menu.overrideRedirect, true);
  assert.equal(menu.title, "");
});

test("menus never get an OS window of their own", () => {
  const panels = windowsNeedingPanels(parseWindows(WINDOWS_INFO));
  assert.deepEqual(panels.map((w) => w.id), [1, 2]);
});

test("a window with no size yet is not given a panel", () => {
  const pending = parseWindows("windows.3.override-redirect=False\nwindows.3.title=starting");
  assert.equal(pending.length, 1);
  assert.equal(windowsNeedingPanels(pending).length, 0);
});

test("info with no windows parses to nothing rather than failing", () => {
  assert.deepEqual(parseWindows("state.windows=0\nclients=0"), []);
});

// Also captured from a real session: argv arrives quoted and NUL-separated as
// the four literal characters, not as a NUL.
const WITH_PROCESS = String.raw`windows.3.class-instance=('xterm', 'XTerm')
windows.3.command='/home/you/bin/xterm\x00-T\x00alpha\x00-e\x00sleep\x009000'
windows.3.geometry=(0, 0, 484, 316)
windows.3.override-redirect=False
windows.3.pid=2014597
windows.3.title=alpha
windows.4.geometry=(0, 0, 300, 200)
windows.4.override-redirect=False
windows.4.title=no process`;

test("a window says which process is behind it, when it knows", () => {
  const [alpha, orphan] = parseWindows(WITH_PROCESS);
  assert.equal(alpha.pid, 2014597);
  assert.equal(alpha.application, "xterm");
  assert.equal(alpha.command, "/home/you/bin/xterm -T alpha -e sleep 9000");
  // Nothing to signal. The UI must offer closing rather than killing.
  assert.equal(orphan.pid, undefined);
  assert.equal(orphan.command, undefined);
});

// Captured from a real `janela-server status`: two sessions, one with windows,
// and the display janelas would send things to.
const STATUS = `--- :107 LIVE
clients=1
session.name=Janela
state.windows=2
windows.1.class-instance=('xterm', 'XTerm')
windows.1.geometry=(0, 0, 800, 600)
windows.1.override-redirect=False
windows.1.pid=774201
windows.1.title=Alacritty
windows.5.geometry=(10, 20, 300, 200)
windows.5.override-redirect=True
windows.5.title=
--- :160 DEAD
--- current :107
`;

test("one call describes every session and its windows", () => {
  const status = parseStatus(STATUS);
  assert.deepEqual(status.sessions.map((s) => s.display), [":107", ":160"]);
  assert.equal(status.sessions[0].state, "LIVE");
  assert.equal(status.sessions[0].name, "Janela");
  assert.equal(status.sessions[0].clients, 1);
  // The menu is parsed but never gets a panel of its own.
  assert.deepEqual(status.sessions[0].open?.map((w) => w.id), [1]);
});

test("a dead session is reported without pretending to know its windows", () => {
  const dead = parseStatus(STATUS).sessions[1];
  assert.equal(dead.state, "DEAD");
  assert.equal(dead.open, undefined);
});

test("status says which session janelas would use", () => {
  assert.equal(parseStatus(STATUS).current, ":107");
  assert.equal(parseStatus("--- current none\n").current, undefined);
});

test("status with nothing running parses to nothing", () => {
  assert.deepEqual(parseStatus("--- current none\n").sessions, []);
  assert.deepEqual(parseStatus("").sessions, []);
});
