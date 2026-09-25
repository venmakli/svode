#!/bin/sh
# Svode standalone installer for the current user, from a local archive made
# by scripts/standalone-archive.mjs. Installs the runtime into ~/.svode and
# adds ~/.svode/bin to PATH; with Svode Desktop installed its runtime stays
# active. Running it again with a newer archive updates the runtime.
#
#   sh install.sh <svode-<version>-<target>.tar.gz>
#   sh install.sh --uninstall
set -eu

usage() {
  echo "usage: sh install.sh <svode archive .tar.gz> | --uninstall" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage

if [ "$1" = "--uninstall" ]; then
  # The installation code of the active runtime, or of the standalone
  # runtime a removed desktop app left behind.
  for installer in "$HOME/.svode/current/bin/svode-launcher" \
    "$HOME/.svode/standalone/bin/svode-launcher"; do
    if [ -x "$installer" ]; then
      exec "$installer" uninstall
    fi
  done
  echo "No standalone Svode runtime is installed." >&2
  exit 1
fi

archive=$1
[ -f "$archive" ] || usage
unpacked=$(mktemp -d "${TMPDIR:-/tmp}/svode-install.XXXXXX")
trap 'rm -rf "$unpacked"' EXIT
tar -xzf "$archive" -C "$unpacked"
for root in "$unpacked"/svode-*; do
  if [ -x "$root/bin/svode-launcher" ]; then
    "$root/bin/svode-launcher" install
    exit
  fi
done
echo "$archive is not a Svode runtime archive." >&2
exit 1
