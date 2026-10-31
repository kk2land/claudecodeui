#!/bin/sh
# Shared installer for the Codex and DSH global AGENTS.md entry points.
set -eu

if [ "$#" -ne 1 ]; then
  printf 'usage: %s codex|dsh\n' "$0" >&2
  exit 1
fi
case "$1" in
  codex) worker_agents_dir=${CODEX_HOME:-${HOME:?HOME is not set}/.codex} ;;
  dsh) worker_agents_dir=${DSH_HOME:-${HOME:?HOME is not set}/.dsh} ;;
  *) printf 'unsupported provider: %s\n' "$1" >&2; exit 1 ;;
esac

worker_start_marker='<!-- cloudcli-workers:start -->'
worker_end_marker='<!-- cloudcli-workers:end -->'

worker_agents_file=$worker_agents_dir/AGENTS.md

worker_script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
worker_doc=$worker_script_dir/CLOUDCLI-WORKERS.md

if [ ! -f "$worker_doc" ]; then
  printf 'install-instructions: missing %s\n' "$worker_doc" >&2
  exit 1
fi

mkdir -p "$worker_agents_dir"
if [ ! -e "$worker_agents_file" ]; then
  : > "$worker_agents_file"
fi

worker_block_file=$worker_agents_file.cloudcli-workers-block.$$
worker_tmp_file=$worker_agents_file.cloudcli-workers-tmp.$$
trap 'rm -f "$worker_block_file" "$worker_tmp_file"' 0
trap 'exit 1' HUP INT TERM

{
  printf '%s\n' "$worker_start_marker"
  printf '开始任务时，请先阅读并遵循 `%s` 中的技能禁用规则与 CloudCLI Worker 使用说明（含计划阶段的分工要求）。\n' "$worker_doc"
  printf '%s\n' "$worker_end_marker"
} > "$worker_block_file"

if awk -v start="$worker_start_marker" -v end="$worker_end_marker" -v blockfile="$worker_block_file" '
BEGIN {
  block = ""
  while ((getline line < blockfile) > 0) block = block line "\n"
  close(blockfile)
}
{
  marker = $0
  sub(/\r$/, "", marker)
}
marker == start {
  seen = 1
  inblock = 1
  printf "%s", block
  next
}
marker == end {
  inblock = 0
  next
}
{
  if (!inblock) print
}
END {
  if (inblock) {
    print "install-instructions: start marker without end marker" > "/dev/stderr"
    exit 1
  }
  if (!seen) {
    if (NR) printf "\n"
    printf "%s", block
  }
}
' "$worker_agents_file" > "$worker_tmp_file"; then
  cat "$worker_tmp_file" > "$worker_agents_file"
  printf 'updated %s\n' "$worker_agents_file"
else
  worker_status=$?
  printf 'install-instructions: %s was left unchanged\n' "$worker_agents_file" >&2
  exit "$worker_status"
fi
