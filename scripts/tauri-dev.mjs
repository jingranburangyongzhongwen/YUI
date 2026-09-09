#!/usr/bin/env node
import { buildDevUrl, findFreePort, resolvePort, tauriConfigArg } from "./dev-port.mjs";
import { cargoOnPath, spawnLocalCli, wireDetachedChild } from "./spawn-local.mjs";

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
wireDetachedChild(child, "[YUI] failed to start tauri dev");
