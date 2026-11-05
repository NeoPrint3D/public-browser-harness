#!/bin/sh
# Install commands directly from this checkout. No npm or sudo required.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest=${1:-"$HOME/.local/bin"}
mkdir -p "$dest"
for name in pb-harness public-browser-harness; do
  target="$dest/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "Refusing to overwrite non-symlink: $target" >&2
    exit 1
  fi
done
for name in pb-harness public-browser-harness; do
  ln -sfn "$here/harness.mjs" "$dest/$name"
done
printf 'Installed pb-harness and public-browser-harness in %s\n' "$dest"
case ":$PATH:" in
  *":$dest:"*) ;;
  *) printf 'Add this directory to PATH: export PATH="%s:$PATH"\n' "$dest" ;;
esac
