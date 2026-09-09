import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** Resolve `pkg`'s file `binRel` via package.json — bins are often outside `exports`. */
export function resolveCliScript(pkg, binRel) {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), binRel);
}

/** True when `cargo` is invokable (shell so Windows `.cmd` shims resolve). */
export function cargoOnPath() {
  const result = spawnSync("cargo --version", {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  return result.status === 0;
}

/**
 * Run a local package CLI with the current node binary.
 * Windows `spawn("pnpm")` does not see Corepack's `pnpm.cmd` (ENOENT) even when PATH is set.
 */
export function spawnLocalCli(pkg, binRel, args, options = {}) {
  const isWin = process.platform === "win32";
  return spawn(process.execPath, [resolveCliScript(pkg, binRel), ...args], {
    ...options,
    // Detached children on Windows get a new console; cargo/tauri errors vanish from the parent terminal.
    detached: isWin ? false : Boolean(options.detached),
  });
}

/** Detached child + group-signal forwarding used by the port-picking launchers. */
export function wireDetachedChild(child, failMessage) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(sig, () => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    });
  child.on("error", (err) => {
    console.error(`${failMessage}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) =>
    process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 0)),
  );
}
