#!/usr/bin/env bash
#
# Install xpra into a prefix, without root and without assuming conda exists.
#
#   scripts/install-server.sh --prefix DIR
#
# Idempotent: if DIR already runs xpra it prints the version and exits 0, so
# the extension can call it on every open without thinking about it.
#
# This is the one implementation of "get xpra onto this machine". The
# extension's `Janela: Install Server Components` runs it, the EDA server
# wizard runs it, and it works on its own from a shell.
set -euo pipefail

PREFIX=""
CHANNEL="conda-forge"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    *) printf 'install-server: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$PREFIX" ]] || { printf 'install-server: --prefix is required\n' >&2; exit 2; }

die() { printf 'install-server: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

# ── already done? ────────────────────────────────────────────────────────────
if [[ -x "$PREFIX/bin/xpra" ]] && "$PREFIX/bin/xpra" --version >/dev/null 2>&1; then
  say "xpra is already installed: $("$PREFIX/bin/xpra" --version 2>&1 | head -1)"
  say "prefix: $PREFIX"
  exit 0
fi

# ── something that can install conda packages ────────────────────────────────
TOOLS="$(dirname "$PREFIX")/tools"
MICROMAMBA="${JANELA_MICROMAMBA:-}"
if [[ -z "$MICROMAMBA" ]]; then
  for candidate in "$TOOLS/bin/micromamba" "$HOME/opt/micromamba/bin/micromamba"; do
    [[ -x "$candidate" ]] && { MICROMAMBA="$candidate"; break; }
  done
fi
if [[ -z "$MICROMAMBA" ]] && command -v micromamba >/dev/null 2>&1; then
  MICROMAMBA=$(command -v micromamba)
fi

if [[ -z "$MICROMAMBA" ]]; then
  say "downloading micromamba (one static binary, no root, ~18 MB)"
  mkdir -p "$TOOLS"
  curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest \
    | tar -xj -C "$TOOLS" bin/micromamba \
    || die "could not download micromamba. This machine may have no outbound HTTPS; use the bundled build of the extension instead."
  MICROMAMBA="$TOOLS/bin/micromamba"
  chmod +x "$MICROMAMBA"
fi
say "using $MICROMAMBA"

# ── the env ──────────────────────────────────────────────────────────────────
# `tk` is deliberately absent: it belongs to the test fixtures, not to xpra.
say "installing xpra from $CHANNEL into $PREFIX"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$(dirname "$PREFIX")/mamba-root}"
"$MICROMAMBA" create -y -p "$PREFIX" -c "$CHANNEL" xpra \
  || die "the install failed. The output above names the reason - a blocked conda-forge mirror is the usual one."

[[ -x "$PREFIX/bin/xpra" ]] || die "no xpra at $PREFIX/bin/xpra after a successful install - the env landed somewhere unexpected"
say "installed: $("$PREFIX/bin/xpra" --version 2>&1 | head -1)"
say "prefix: $PREFIX"
