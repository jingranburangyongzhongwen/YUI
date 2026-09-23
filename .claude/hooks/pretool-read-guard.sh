#!/usr/bin/env bash
# PreToolUse(Read) guard: keeps .env.local (VITE_YUI_CHAT_KEY) out of the
# transcript. Fails OPEN on any error.
set -u

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/json.sh"

input=$(cat 2>/dev/null) || exit 0
fp=$(json_get '.tool_input.file_path // empty') || exit 0

case "$fp" in
  *.env.local)
    json_deny ".env.local holds VITE_YUI_CHAT_KEY — reading it into the transcript is blocked. Check existence with ls instead."
    ;;
esac

exit 0
