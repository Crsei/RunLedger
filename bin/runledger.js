#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  echo "[runledger] Bun >= 1.3.0 is required for the OpenTUI renderer. Install Bun and retry." >&2
  exit 127
fi

script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=$(command -v "$script_path") ;;
esac
while [ -L "$script_path" ]; do
  link_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)
  link_target=$(readlink "$script_path")
  case "$link_target" in
    /*) script_path=$link_target ;;
    *) script_path=$link_dir/$link_target ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
exec bun "$package_dir/dist/cli/cli.js" "$@"
