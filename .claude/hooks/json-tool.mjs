/**
 * The same JSON reads and hook replies the shell scripts ask of jq, for a machine
 * that has node and not jq.
 */
import { readFileSync } from "node:fs";

function lookup(obj, expr) {
  if (!expr.startsWith(".")) return undefined;
  let cur = obj;
  for (const key of expr.slice(1).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function query(obj, filter) {
  for (const alt of filter.split(" // ").map((part) => part.trim())) {
    if (alt === "empty") return "";
    const value = lookup(obj, alt);
    if (value != null && value !== false) return String(value);
  }
  return "";
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const [cmd, filter] = process.argv.slice(2);

if (cmd === "get" || cmd === "pair") {
  let parsed;
  try {
    parsed = JSON.parse(readStdin());
  } catch {
    process.exit(1);
  }
  if (cmd === "get") {
    process.stdout.write(`${query(parsed, filter)}\n`);
  } else {
    const second = process.argv[4] ?? "";
    process.stdout.write(`${query(parsed, filter)}\u001e${query(parsed, second)}`);
  }
} else if (cmd === "deny") {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: process.env.JSON_ARG ?? "",
      },
    })}\n`,
  );
} else if (cmd === "block") {
  process.stdout.write(
    `${JSON.stringify({
      decision: "block",
      reason: `Intentional guard: LLMs habitually narrate the diff — "was X, now Y", "previously", "no longer", "제거했다" — and this hook deliberately blocks that. Docs here are current-state only: describe what the system IS now, declaratively, as if it had always been this way. No before/after, no change history (rule: yui-dev-workflow skill). Flagged:\n${process.env.JSON_ARG ?? ""}`,
    })}\n`,
  );
} else if (cmd === "context") {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: readStdin(),
      },
    })}\n`,
  );
} else {
  process.exit(1);
}
