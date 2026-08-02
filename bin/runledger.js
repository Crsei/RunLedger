#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  echo "[runledger] Bun >= 1.3.0 is required for the OpenTUI renderer. Install Bun and retry." >&2
  exit 127
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$script_dir/../dist/cli/cli.js" "$@"
