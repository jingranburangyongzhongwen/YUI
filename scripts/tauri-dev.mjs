#!/usr/bin/env node
import os from "node:os";
import { buildDevUrl, findFreePort, resolvePort, tauriConfigArg } from "./dev-port.mjs";
import { stopProcessTree } from "./package-manager.mjs";
import { cargoOnPath, spawnLocalCli } from "./spawn-local.mjs";

const port = await resolvePort({ env: process.env, isPortFree: findFreePort });
console.log(`[YUI] tauri dev → ${buildDevUrl(port)} (YUI_DEV_PORT=${port})`);
if (!cargoOnPath()) {
  console.error(`[YUI] cargo not found. tauri:dev needs the Rust toolchain.
  1. Visual Studio Build Tools (C++ workload): https://visualstudio.microsoft.com/visual-cpp-build-tools/
  2. Rust (MSVC): https://www.rust-lang.org/tools/install
  3. Open a NEW terminal, then: pnpm tauri:dev
Until then, browser-only preview: pnpm dev`);
  process.exit(1);
}
const child = spawnLocalCli(
  "@tauri-apps/cli",
  "tauri.js",
  ["dev", "--config", tauriConfigArg(port)],
  {
    stdio: "inherit",
    detached: true,
    env: { ...process.env, YUI_DEV_PORT: String(port) },
  },
);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => stopProcessTree(child, sig));
child.on("error", (err) => {
  console.error(`[YUI] failed to start tauri dev: ${err.message}`);
  process.exit(1);
});
// signal death exits 128+signum (130 for SIGINT), preserving the failure-vs-Ctrl-C distinction.
child.on("exit", (code, signal) =>
  process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 0)),
);
