/**
 * WHAM pkl → custom_motions install. Thin invoke wrapper over the native
 * `import_pkl_motion` command; registry row matches scripts/custom-motions.mjs.
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
