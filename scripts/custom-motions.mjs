import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Logical URL prefix for dropped-in clips (Vite `public/` + Tauri public dir). */
export const CUSTOM_MOTIONS_PREFIX = "/custom_motions/";

export const CUSTOM_MOTIONS_DIR = "public/custom_motions";

/**
 * Default registry row for a file in `public/custom_motions/`.
 * The file stem is the motion id (`spin.vrma` → `spin`) and is published so the agent
 * can pick it via `generate_express` `motion_id`. `root_lock_xz` so a video walk
 * moves the OS window instead of sliding off the canvas.
 */
export function overlayFromVrmaFilenames(files) {
  /** @type {Record<string, {
    vrma_path: string,
    kind: "oneshot",
    loop: false,
    priority: number,
    interrupt_policy: "replace",
    root_lock_xz: true,
  }>} */
  const overlay = {};
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".vrma")) continue;
    const id = file.slice(0, -".vrma".length);
    if (!id) continue;
    overlay[id] = {
      vrma_path: `${CUSTOM_MOTIONS_PREFIX}${file}`,
      kind: "oneshot",
      loop: false,
      priority: 70,
      interrupt_policy: "replace",
      root_lock_xz: true,
    };
  }
  return overlay;
}

/** Scan `public/custom_motions/*.vrma`. */
export function readLocalMotionsOverlay(cwd = process.cwd()) {
  const dir = resolve(cwd, CUSTOM_MOTIONS_DIR);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return overlayFromVrmaFilenames(files);
}

/**
 * Merge folder-scanned clips onto the shipped catalog. Colliding ids fail loud.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} [overlay]
 */
export function mergeCustomMotions(base, overlay) {
  const extra = overlay && typeof overlay === "object" ? overlay : {};
  const ids = Object.keys(extra);
  if (ids.length === 0) return base;
  const collisions = ids.filter((id) => Object.hasOwn(base, id));
  if (collisions.length > 0) {
    throw new Error(collisions.map((id) => `${id}: collides with the shipped catalog`).join("; "));
  }
  return { ...base, ...extra };
}
