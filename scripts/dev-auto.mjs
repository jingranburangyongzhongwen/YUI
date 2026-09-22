#!/usr/bin/env node
import os from "node:os";
import { buildDevUrl, findFreePort, resolvePort } from "./dev-port.mjs";
import { stopProcessTree } from "./package-manager.mjs";
import { spawnLocalCli } from "./spawn-local.mjs";

const port = await resolvePort({ env: process.env, isPortFree: findFreePort });
console.log(`[YUI] vite dev → ${buildDevUrl(port)} (browser only, YUI_DEV_PORT=${port})`);
const child = spawnLocalCli("vite", "bin/vite.js", [], {
  stdio: "inherit",
  detached: true,
  env: { ...process.env, YUI_DEV_PORT: String(port) },
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => stopProcessTree(child, sig));
child.on("error", (err) => {
  console.error(`[YUI] failed to start vite dev: ${err.message}`);
  process.exit(1);
});
// signal death exits 128+signum (130 for SIGINT), preserving the failure-vs-Ctrl-C distinction.
child.on("exit", (code, signal) =>
  process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 0)),
);
