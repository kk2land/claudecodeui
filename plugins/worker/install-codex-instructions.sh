#!/bin/sh
# Preserve the existing Codex installation entry point.
set -eu
worker_script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec sh "$worker_script_dir/install-instructions.sh" codex "$@"
