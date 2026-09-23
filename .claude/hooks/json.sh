# jq when it is on PATH, otherwise node (json-tool.mjs).
_json_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

_have_jq() { command -v jq >/dev/null 2>&1; }

json_get() {
  if _have_jq; then
    printf '%s' "$input" | jq -r "$1" 2>/dev/null
  else
    printf '%s' "$input" | node "$_json_dir/json-tool.mjs" get "$1"
  fi
}

# Two fields from one process. Separated by ASCII RS.
json_pair() {
  if _have_jq; then
    local first second
    first=$(printf '%s' "$input" | jq -r "$1" 2>/dev/null) || return 1
    second=$(printf '%s' "$input" | jq -r "$2" 2>/dev/null) || return 1
    printf '%s\036%s' "$first" "$second"
  else
    printf '%s' "$input" | node "$_json_dir/json-tool.mjs" pair "$1" "$2"
  fi
}

json_deny() {
  if _have_jq; then
    jq -cn --arg r "$1" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  else
    JSON_ARG="$1" node "$_json_dir/json-tool.mjs" deny
  fi
}

json_block() {
  if _have_jq; then
    jq -cn --arg b "$1" \
      '{decision:"block",reason:("Intentional guard: LLMs habitually narrate the diff — \"was X, now Y\", \"previously\", \"no longer\", \"제거했다\" — and this hook deliberately blocks that. Docs here are current-state only: describe what the system IS now, declaratively, as if it had always been this way. No before/after, no change history (rule: yui-dev-workflow skill). Flagged:\n" + $b)}'
  else
    JSON_ARG="$1" node "$_json_dir/json-tool.mjs" block
  fi
}

json_context() {
  if _have_jq; then
    jq -Rs '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:.}}'
  else
    node "$_json_dir/json-tool.mjs" context
  fi
}
