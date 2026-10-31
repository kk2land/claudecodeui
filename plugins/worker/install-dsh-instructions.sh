#!/bin/sh
# Install the Worker rules reference in ${DSH_HOME:-$HOME/.dsh}/AGENTS.md.
set -eu
worker_script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec sh "$worker_script_dir/install-instructions.sh" dsh "$@"
