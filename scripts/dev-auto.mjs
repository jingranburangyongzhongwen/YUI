#!/usr/bin/env node
import { buildDevUrl, findFreePort, resolvePort } from "./dev-port.mjs";
import { spawnLocalCli, wireDetachedChild } from "./spawn-local.mjs";

const port = await resolvePort({ env: process.env, isPortFree: findFreePort });
console.log(`[YUI] vite dev → ${buildDevUrl(port)} (browser only, YUI_DEV_PORT=${port})`);
const child = spawnLocalCli("vite", "bin/vite.js", [], {
  stdio: "inherit",
  detached: true,
  env: { ...process.env, YUI_DEV_PORT: String(port) },
});
wireDetachedChild(child, "[YUI] failed to start vite dev");
