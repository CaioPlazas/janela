# 3. The payload is fetched by the client, not by the server

Date: 2026-08-30

## Status

Accepted.

## Context

The server this is built for cannot reach the internet, has no conda, and grants no root. It needs
xpra, which is ~200 MB of Python, GTK, GStreamer and ffmpeg - xpra itself is 11.9 MB of that.

Three ways to get it there, measured rather than estimated:

| route | over the wire to the server | carried to the client machine |
|---|---|---|
| packed environment inside the VSIX | 211 MB | a 200 MB VSIX |
| packages downloaded on the client | **201 MB**, 181 files | a 35 KB VSIX |
| xpra.org's el8 RPMs | ~10-30 MB | a 35 KB VSIX |

The first two move the same bytes. The third is genuinely smaller because the RPM contains only
xpra and assumes the machine already has python3, gtk3 and gstreamer - which a RHEL8 EDA
workstation probably does, but nobody here can see that machine to check.

## Decision

Both of the first two ship. The client machine downloads what the server cannot, either from the
VSIX it already carries or from conda-forge, and copies it over the ssh connection that is already
open and already authenticated. `janela.payloadMode` chooses; `auto` uses whatever the build has.

The RPM route stays unbuilt until `Janela: Survey the Server` reports what that machine actually
has. It is the only route that would be smaller, and building it on an assumption about a machine
nobody has surveyed is how the launcher came to require Ubuntu binaries on a RHEL8 server.

## Consequences

A 35 KB VSIX is possible, and the payload is whatever the pinned list says rather than whatever
was packed months ago. The cost is a download step at setup time and a pinned list that must be
regenerated whenever the environment is rebuilt - `RELEASE.md` carries that step, because a
release shipping a stale list installs an environment nobody has run.

**Every file is verified against a sha256 from the list.** This is not caution for its own sake:
the first working version of this shipped a silently truncated package, and the offline install
failed three steps later with an error naming a different file entirely. Downloads resume rather
than restart, so an interrupted 201 MB fetch costs only what is missing.

The measurement is recorded here because the reason for the lite installer is a small VSIX and a
current payload - not bandwidth. Anyone reaching for it to save transfer will be disappointed, and
should read the table above first.
