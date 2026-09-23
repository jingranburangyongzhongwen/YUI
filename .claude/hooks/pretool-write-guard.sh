#!/usr/bin/env bash
# PreToolUse(Write|Edit|NotebookEdit) guard. Protects purchased_motions
# (resources/ or public/) from agent edits/overwrites — purchased motion files
# must not be modified (purchased_motions/AGENTS.md). Reading is unaffected.
# YUI_ALLOW_MOTIONS=1 bypasses for human-approved curation. Fails OPEN on any error.
set -u

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json.sh"

[ "${YUI_ALLOW_MOTIONS:-}" = "1" ] && exit 0

input=$(cat 2>/dev/null) || exit 0
fp=$(json_get '.tool_input.file_path // empty') || exit 0
[ -z "$fp" ] && exit 0

case "$fp" in
  *purchased_motions/*)
    json_deny "purchased_motions is protected — purchased motion files must not be edited or overwritten by the agent (purchased_motions/AGENTS.md). Reading is fine. If you are human-approved to curate these, re-run with YUI_ALLOW_MOTIONS=1."
    ;;
esac

exit 0
