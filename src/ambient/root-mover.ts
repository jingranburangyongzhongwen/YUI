/**
 * Horizontal root-motion replay — the VRM plays an in-place clip at scene origin while
 * the OS window supplies the hips X travel.
 *
 * Mapping: hips +X (camera-facing right) → window +X (screen right). hips +Z (toward
 * the camera) is dropped — desktop pets keep a stable on-screen size; scale-as-depth
 * reads as the model growing. Forward steps stay in the clip as in-place footwork,
 * same as Mixamo / MateEngine dances. The window stays on its floor line and is left
 * where the clip's lateral travel ended.
 *
 * Presentation only: the mover never requests a clip. It follows whatever xz-locked
 * motion the renderer is already playing, yields the window to a drag/perch/peek, a
 * directed walkTo, or a travel frame, and no-ops when the clip is not yet cached. A
 * published oneshot leaves the perch before it plays, so the follow can start once she
 * is standing; she sits back when the clip ends. A peek oneshot still plays in place.
 */

import {
  logicalWorkArea,
  monitorAt,
  type PetWindow,
  type ScreenMonitor,
} from "../io/screen-geometry";
import { createLogger } from "../logger";
import type { Renderer } from "../renderer";

const log = createLogger("root-mover");

/** Hips +X metres → window +X logical px. Depth is not a window axis. */
export function windowDeltaFromHipsX(travelX: number, pxPerMetre: number): number {
  return travelX * pxPerMetre;
}

/**
 * Keep the window origin inside the work area. The pet window hangs below the floor by
 * its framing margin, so requiring the whole box to fit would yank a floor-standing pet
 * upward on the first frame.
 */
export function clampRootFollow(
  x: number,
  y: number,
  width: number,
  work: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.max(work.x, Math.min(x, work.x + work.width - width)),
    y: Math.max(work.y, Math.min(y, work.y + work.height)),
  };
}

export interface RootMoverDeps {
  renderer: Pick<
    Renderer,
    | "onTick"
    | "getCurrentMotion"
    | "getCurrentMotionTime"
    | "getMotionTravelXAt"
    | "getPxPerMetre"
    | "isPerched"
  >;
  getWindow(): PetWindow;
  listMonitors(): Promise<ScreenMonitor[]>;
  isDragging(): boolean;
  isPeeking(): boolean;
  /** A directed walkTo or a travel frame already owns window translation. */
  isHeld(): boolean;
  /** The window is translating — keep the hit-test cursor mapping accurate. */
  onStart(): void;
  /** Follow ended; the window stays where the clip left it. */
  onEnd(): void;
}

export interface RootMover {
  start(): void;
  /** Stop driving the window now; leave it where it is. */
  cancel(): void;
  stop(): void;
}

interface Follow {
  id: string;
  originX: number;
  originY: number;
  travel0X: number;
  pxPerMetre: number;
  win: PetWindow;
  width: number;
  work: { x: number; y: number; width: number; height: number };
}

export function createRootMover(deps: RootMoverDeps): RootMover {
  const { renderer } = deps;

  let unsub: (() => void) | null = null;
  let follow: Follow | null = null;
  let starting = false;
  let generation = 0;
  let stopped = true;
  let startedFollow = false;

  function held(): boolean {
    return deps.isDragging() || deps.isPeeking() || renderer.isPerched() || deps.isHeld();
  }

  function release(): void {
    generation += 1;
    if (!follow && !startedFollow) return;
    follow = null;
    if (startedFollow) {
      startedFollow = false;
      deps.onEnd();
    }
  }

  async function begin(id: string): Promise<void> {
    const startedAt = generation;
    const win = deps.getWindow();
    const [pos, size, sf, monitors] = await Promise.all([
      win.outerPosition(),
      win.outerSize(),
      win.scaleFactor(),
      deps.listMonitors(),
    ]);
    if (stopped || generation !== startedAt) return;
    if (renderer.getCurrentMotion()?.id !== id) return;
    if (held()) return;

    const t = renderer.getCurrentMotionTime();
    const travel0 = renderer.getMotionTravelXAt(id, t ?? 0);
    const pxPerMetre = renderer.getPxPerMetre();
    if (travel0 === null || pxPerMetre === null || !(pxPerMetre > 0)) return;

    const scale = sf > 0 ? sf : 1;
    const monitor = monitorAt(monitors, pos.x, pos.y);
    if (!monitor) return;

    follow = {
      id,
      originX: pos.x / scale,
      originY: pos.y / scale,
      travel0X: travel0,
      pxPerMetre,
      win,
      width: size.width / scale,
      work: logicalWorkArea(monitor),
    };
    startedFollow = true;
    deps.onStart();
  }

  function tick(): void {
    const current = renderer.getCurrentMotion();
    const id = current?.id;
    const xReady = id != null && renderer.getMotionTravelXAt(id, 0) !== null;

    if (!id || !xReady) {
      if (follow || startedFollow) release();
      return;
    }
    if (held()) {
      if (follow || startedFollow) release();
      return;
    }

    if (!follow || follow.id !== id) {
      if (follow && follow.id !== id) release();
      if (!starting) {
        starting = true;
        generation += 1;
        void begin(id)
          .catch((err) => log.warn("follow_start_failed", { degrade: true, error: String(err) }))
          .finally(() => {
            starting = false;
          });
      }
      return;
    }

    const t = renderer.getCurrentMotionTime();
    const sample = t === null ? null : renderer.getMotionTravelXAt(id, t);
    if (sample === null) return;

    const dx = windowDeltaFromHipsX(sample - follow.travel0X, follow.pxPerMetre);
    const next = clampRootFollow(follow.originX + dx, follow.originY, follow.width, follow.work);
    void follow.win
      .setPositionLogical(Math.round(next.x), Math.round(next.y))
      .catch((err) => log.warn("move_failed", { degrade: true, error: String(err) }));
  }

  return {
    start() {
      if (unsub) return;
      stopped = false;
      unsub = renderer.onTick(tick);
    },
    cancel() {
      release();
    },
    stop() {
      stopped = true;
      release();
      unsub?.();
      unsub = null;
    },
  };
}
