# 4. The server decides which payload it gets

Date: 2026-08-30

## Status

Accepted. Amends [0003](0003-the-payload-is-fetched-by-the-client.md), which left the RPM route
unbuilt "until `Janela: Survey the Server` reports what that machine actually has".

## Context

0003 measured three routes and shipped two, both moving about 200 MB. The third - xpra's own el8
packages - was the only genuinely smaller one, and was left out because it depends on facts about
a machine nobody here can see. That reasoning was right and the conclusion has not changed. What
changed is who answers the question.

Reading the repository metadata rather than guessing gives the exact shape of the dependency:

- every el8 build needs **python3.11** or **python3.12**, never RHEL 8's own python3.6
- xpra.org ships the awkward parts itself - `python3.11-gobject`, `-pillow`, `-cairo`, `libyuv`,
  `openh264` - so those are not prerequisites, they are payload
- what remains is the interpreter, the GTK typelibs PyGObject loads through, and 45 shared
  libraries that a machine running EDA GUIs already has

The closure is **13 packages, 15.3 MB** (python3.11, xpra 6.4.4) or **15.7 MB** (python3.12,
xpra 6.5.3), against 201 MB for the environment. That is the whole argument for building it.

The objection to building it was never the size. It was that a second install path whose success
depends on an unseen machine will half-install and fail confusingly. That is answered below, not
dismissed.

## Decision

Both payloads ship, and **the server chooses between them at install time**.
`janela-server rpm-check <python> <soname>...` reports what it finds; the extension sends the
15 MB payload when the answer is yes and the 201 MB environment when it is not.

Three properties make the second path safe to attempt first:

1. **The check is exact and generated.** `scripts/build-rpm-list.sh` resolves the dependency
   closure against the repository's own metadata and writes both the packages to fetch and the
   sonames that must already be present. Neither list is written by hand, and the server script
   keeps no copy of them - it is told what to look for, so there is one place to be wrong.
2. **It is checked in the right place.** Only the server can see its own filesystem, which is the
   same reason `janela-server` exists at all.
3. **A failed attempt leaves nothing behind.** `bootstrap-rpm` runs `xpra --version` from the tree
   it just extracted and deletes the whole prefix if that fails, keeping the downloaded packages.
   A prefix that exists but does not work is worse than no prefix: it satisfies `find_prefix`, and
   every later command fails instead of the install failing.

## Consequences

On a machine that qualifies, setting up is a 15 MB transfer instead of 200 - which is the
difference between a coffee and a lunch break on a corporate VPN. On a machine that does not,
nothing is lost but one ssh round-trip, and the log says exactly which library or interpreter was
missing.

The cost is a second generated list to keep current. `RELEASE.md` carries the regeneration step
for the same reason it carries the conda one.

Two facts are load-bearing and easy to break:

- **`XPRA_COMMAND` must name the wrapper.** xpra re-executes itself to daemonise and to start
  children; without it the daemon looks for `/usr/bin/xpra`, which is not installed.
- **Both site-packages directories must be on `PYTHONPATH`.** RHEL splits PyGObject across
  `/usr/lib64` (the extension modules) and `/usr/lib` (the GTK overrides), and `gi/__init__.py`
  merges them with `pkgutil.extend_path` only if both are visible.

This route was chosen over teaching the server to run `dnf --downloadonly` or `rpm --relocate`:
both need either network access or root on the machine that has neither.
