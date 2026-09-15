/**
 * WHAM pkl/video → custom_motions install. Thin invoke wrappers over the native
 * `import_pkl_motion` / `import_video_motion` commands; registry row matches
 * scripts/custom-motions.mjs.
 */

import type { MotionRegistryEntry } from "../contract";
import { CUSTOM_MOTIONS_PREFIX } from "./broker-client";

export interface ImportedPklMotion {
  id: string;
  fileName: string;
}

export interface PklImportDeps {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export interface VideoImportDeps extends Partial<PklImportDeps> {
  getWhamUrl: () => string;
}

async function defaultDeps(): Promise<PklImportDeps> {
  const { invoke } = await import("@tauri-apps/api/core");
  return { invoke };
}

/** Registry row for a dropped-in `/custom_motions` clip. Stem is the motion id. */
export function customMotionEntry(fileName: string): MotionRegistryEntry {
  return {
    vrma_path: `${CUSTOM_MOTIONS_PREFIX}${fileName}`,
    kind: "oneshot",
    loop: false,
    priority: 70,
    interrupt_policy: "replace",
    root_lock_xz: true,
  };
}

export async function importPklMotion(
  srcPath: string,
  reservedIds: readonly string[],
  deps?: PklImportDeps,
): Promise<{ id: string; entry: MotionRegistryEntry }> {
  const d = deps ?? (await defaultDeps());
  const { id, fileName } = await d.invoke<ImportedPklMotion>("import_pkl_motion", {
    srcPath,
    reservedIds: [...reservedIds],
  });
  return { id, entry: customMotionEntry(fileName) };
}

export async function importVideoMotion(
  srcPath: string,
  reservedIds: readonly string[],
  deps: VideoImportDeps,
): Promise<{ id: string; entry: MotionRegistryEntry }> {
  const baseUrl = deps.getWhamUrl().trim();
  if (!baseUrl) throw new Error("wham not configured");
  const invoke = deps.invoke ?? (await defaultDeps()).invoke;
  const { id, fileName } = await invoke<ImportedPklMotion>("import_video_motion", {
    srcPath,
    reservedIds: [...reservedIds],
    whamBaseUrl: baseUrl,
  });
  return { id, entry: customMotionEntry(fileName) };
}
