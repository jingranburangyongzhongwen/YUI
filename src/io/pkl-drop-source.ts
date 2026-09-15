/**
 * pkl-drop-source — OS file-drag onto the character silhouette installs a dance.
 *
 * Client firing, not judgment: the drop/convert poses are local (happy, then
 * idle_lively while converting), the converted clip plays itself, and
 * `proactive.pkl_dance` is a candidate the backend may answer or stay silent on.
 * Speech text is never invented here. Approach does not pose or gaze.
 */

import type { MotionRegistryEntry } from "../contract";
import type { EventBus } from "../dispatcher/event-bus";
import { createLogger } from "../logger";
import { importPklMotion, importVideoMotion } from "./pkl-import";
import { isTauri } from "./tauri-env";

const log = createLogger("pkl-drop-source");

export const PKL_CONVERT_TOOL_ID = "pkl_to_dance";
export const PKL_DROP_MOTION = "happy";
export const PKL_CONVERT_MOTION = "idle_lively";
export const PKL_CONVERT_POSE_DELAY_MS = 400;
export const PKL_FAIL_MOTION = "sheepish";
export const PKL_DROP_HIT_OWNER = "pkl-drop";
export const FILE_DRAG_CHANNEL = "file_drag";
export const FILE_DROP_CHANNEL = "os_file_drop";

export function isPklPath(path: string): boolean {
  return /\.pkl$/i.test(path.split(/[\\/]/).pop() ?? path);
}

export function isVideoPath(path: string): boolean {
  return /\.(mp4|mov)$/i.test(path.split(/[\\/]/).pop() ?? path);
}

export function firstDancePath(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (isPklPath(path) || isVideoPath(path)) return path;
  }
  return null;
}

/** Tauri drag positions are physical px; silhouette hit-test is CSS client px. */
export function physicalDropToClient(
  position: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  const sf = scaleFactor > 0 ? scaleFactor : 1;
  return { x: position.x / sf, y: position.y / sf };
}

export type PklDragDropEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

interface PklDropRenderer {
  hitTest(x: number, y: number): boolean;
  playMotion(motion: { id: string; loop?: boolean } | null): void;
  upsertMotion(id: string, entry: MotionRegistryEntry): void;
  isPerched(): boolean;
  isPeeking(): boolean;
}

interface PklDropSurfaces {
  showTool(toolId: string): void;
  finishTool(): void;
  hideTool(): void;
}

export interface FileDragState {
  over_window: boolean;
}

export interface PklDropSourceDeps {
  bus: Pick<EventBus, "push">;
  renderer: PklDropRenderer;
  surfaces: PklDropSurfaces;
  getReservedIds: () => string[];
  reloadConfig?: () => Promise<unknown>;
  importPkl?: (
    srcPath: string,
    reservedIds: readonly string[],
  ) => Promise<{ id: string; entry: MotionRegistryEntry }>;
  importVideo?: (
    srcPath: string,
    reservedIds: readonly string[],
  ) => Promise<{ id: string; entry: MotionRegistryEntry }>;
  getWhamUrl?: () => string;
  listenDragDrop?: (
    handler: (event: PklDragDropEvent) => void,
  ) => Promise<() => void> | (() => void);
  /** OS file-drag is in flight — drop click-through so the webview can receive it. */
  listenFileDrag?: (
    handler: (state: FileDragState) => void,
  ) => Promise<() => void> | (() => void);
  preventNavigation?: {
    addEventListener(type: string, listener: (e: Event) => void): void;
    removeEventListener(type: string, listener: (e: Event) => void): void;
  };
  /** Keep the pet window interactive for the OS file-drag lifetime (click-through off). */
  holdPointerCapture?: (hold: boolean) => void;
  scaleFactor?: () => number;
  now?: () => number;
  /** After the drop pose, switch to the converting loop if import is still running. */
  scheduleConvertPose?: (fn: () => void) => () => void;
}

export interface PklDropSource {
  start(): Promise<void>;
  stop(): void;
  handleEvent(event: PklDragDropEvent): void;
}

export function mapTauriDragDrop(
  payload: {
    type: string;
    paths?: string[];
    position?: { x: number; y: number };
  },
  scaleFactor: number,
): PklDragDropEvent | null {
  if (payload.type === "leave") return { type: "leave" };
  const raw = payload.position;
  if (!raw) return null;
  const position = physicalDropToClient(raw, scaleFactor);
  if (payload.type === "over") {
    return { type: "over", position };
  }
  if (payload.type === "enter") {
    return {
      type: "enter",
      paths: Array.isArray(payload.paths) ? payload.paths : [],
      position,
    };
  }
  if (payload.type === "drop" && Array.isArray(payload.paths)) {
    return { type: "drop", paths: payload.paths, position };
  }
  return null;
}

function onMappedDrop(
  handler: (event: PklDragDropEvent) => void,
  scaleFactor: () => number,
  payload: {
    type: string;
    paths?: string[];
    position?: { x: number; y: number };
  },
): void {
  const mapped = mapTauriDragDrop(payload, scaleFactor());
  if (mapped) handler(mapped);
}

async function defaultListen(
  handler: (event: PklDragDropEvent) => void,
  scaleFactor: () => number,
): Promise<() => void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const { listen } = await import("@tauri-apps/api/event");
  const unWebview = await getCurrentWebview().onDragDropEvent((event) => {
    onMappedDrop(handler, scaleFactor, event.payload as {
      type: string;
      paths?: string[];
      position?: { x: number; y: number };
    });
  });
  const unOs = await listen(FILE_DROP_CHANNEL, (event) => {
    onMappedDrop(
      handler,
      scaleFactor,
      event.payload as {
        type: string;
        paths?: string[];
        position?: { x: number; y: number };
      },
    );
  });
  return () => {
    unWebview();
    unOs();
  };
}

function defaultScheduleConvertPose(fn: () => void): () => void {
  const id = setTimeout(fn, PKL_CONVERT_POSE_DELAY_MS);
  return () => clearTimeout(id);
}

async function defaultListenFileDrag(handler: (state: FileDragState) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(FILE_DRAG_CHANNEL, (event) => {
    const payload = event.payload as { over_window?: boolean };
    handler({ over_window: payload.over_window === true });
  });
}

export function createPklDropSource(deps: PklDropSourceDeps): PklDropSource {
  const now = deps.now ?? Date.now;
  const getWhamUrl = deps.getWhamUrl ?? (() => "");
  const importPkl = deps.importPkl ?? importPklMotion;
  const importVideo =
    deps.importVideo ??
    ((srcPath: string, reservedIds: readonly string[]) =>
      importVideoMotion(srcPath, reservedIds, { getWhamUrl }));
  const scaleFactor =
    deps.scaleFactor ?? (() => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
  const unlistens: Array<() => void> = [];
  let navTarget: PklDropSourceDeps["preventNavigation"] | null = null;
  let converting = false;
  let holding = false;

  function setHold(next: boolean): void {
    if (holding === next) return;
    holding = next;
    deps.holdPointerCapture?.(next);
  }

  function overCharacter(position: { x: number; y: number }): boolean {
    return deps.renderer.hitTest(position.x, position.y);
  }

  function playFloorMotion(motion: { id: string; loop?: boolean }): void {
    if (deps.renderer.isPerched() || deps.renderer.isPeeking()) return;
    deps.renderer.playMotion(motion);
  }

  function importDropped(
    srcPath: string,
    reservedIds: readonly string[],
  ): Promise<{ id: string; entry: MotionRegistryEntry }> {
    if (isPklPath(srcPath)) return importPkl(srcPath, reservedIds);
    return importVideo(srcPath, reservedIds);
  }

  async function convert(srcPath: string): Promise<void> {
    converting = true;
    setHold(false);
    playFloorMotion({ id: PKL_DROP_MOTION });
    deps.surfaces.showTool(PKL_CONVERT_TOOL_ID);
    log.info("pkl_drop_released");
    const schedule = deps.scheduleConvertPose ?? defaultScheduleConvertPose;
    const cancelConvertPose = schedule(() => {
      if (!converting) return;
      playFloorMotion({ id: PKL_CONVERT_MOTION, loop: true });
      log.info("pkl_drop_converting");
    });
    try {
      const { id, entry } = await importDropped(srcPath, deps.getReservedIds());
      cancelConvertPose();
      deps.renderer.upsertMotion(id, entry);
      deps.renderer.playMotion({ id });
      deps.surfaces.finishTool();
      deps.bus.push({
        source: "os_event_watcher",
        event_name: "proactive.pkl_dance",
        ts: now(),
        hint_tier: 2,
        dnd_override: true,
        payload: {
          cue_id: "pkl_dance",
          label: "new dance from a dropped motion capture",
          context: `installed as motion_id ${id}; now playing`,
        },
      });
      void deps.reloadConfig?.();
      log.info("pkl_dance_installed", { motion_id: id });
    } catch (error) {
      cancelConvertPose();
      log.warn("pkl_dance_failed", { error: String(error) });
      deps.renderer.playMotion({ id: PKL_FAIL_MOTION });
      deps.surfaces.hideTool();
    } finally {
      converting = false;
    }
  }

  function onFileDrag(state: FileDragState): void {
    if (converting) return;
    if (state.over_window) {
      setHold(true);
      log.info("file_drag", { over_window: true });
      return;
    }
    handleEvent({ type: "leave" });
  }

  function handleEvent(event: PklDragDropEvent): void {
    try {
      if (event.type !== "over") {
        log.debug("pkl_drop_event", {
          type: event.type,
          dance: event.type === "leave" ? false : !!firstDancePath(event.paths),
        });
      }
      if (event.type === "leave") {
        setHold(false);
        return;
      }
      if (converting) return;
      setHold(true);
      if (event.type === "enter" || event.type === "over") {
        return;
      }
      const src = firstDancePath(event.paths);
      if (!src || !overCharacter(event.position)) {
        log.debug("pkl_drop_ignored", { has_dance: !!src });
        setHold(false);
        return;
      }
      if (isVideoPath(src) && !getWhamUrl().trim()) {
        log.debug("pkl_drop_ignored", { has_dance: true, wham: false });
        setHold(false);
        return;
      }
      void convert(src);
    } catch (error) {
      log.warn("pkl_drop_failed", { error: String(error) });
    }
  }

  function preventNavigation(e: Event): void {
    e.preventDefault();
  }

  return {
    handleEvent,
    async start() {
      navTarget = deps.preventNavigation ?? (typeof window !== "undefined" ? window : null);
      navTarget?.addEventListener("dragover", preventNavigation);
      navTarget?.addEventListener("drop", preventNavigation);
      try {
        if (isTauri() || deps.listenFileDrag) {
          const listen = deps.listenFileDrag ?? defaultListenFileDrag;
          unlistens.push(await listen(onFileDrag));
        }
        if (isTauri() || deps.listenDragDrop) {
          const listen = deps.listenDragDrop ?? ((handler) => defaultListen(handler, scaleFactor));
          unlistens.push(await listen(handleEvent));
        }
        if (import.meta.hot) {
          const onHot = (event: PklDragDropEvent & { scan?: boolean }) => {
            if (event.scan && event.type !== "leave") {
              for (let y = 40; y < 560; y += 16) {
                for (let x = 40; x < 360; x += 16) {
                  if (deps.renderer.hitTest(x, y)) {
                    handleEvent({ ...event, position: { x, y } });
                    return;
                  }
                }
              }
            }
            handleEvent(event);
          };
          import.meta.hot.on("yui-pkl-drop", onHot);
          unlistens.push(() => import.meta.hot?.off("yui-pkl-drop", onHot));
        }
        log.info("pkl_drop_listening");
      } catch (error) {
        log.warn("pkl_drop_listen_failed", { error: String(error) });
      }
    },
    stop() {
      for (const unlisten of unlistens) unlisten();
      unlistens.length = 0;
      navTarget?.removeEventListener("dragover", preventNavigation);
      navTarget?.removeEventListener("drop", preventNavigation);
      navTarget = null;
      converting = false;
      setHold(false);
    },
  };
}
