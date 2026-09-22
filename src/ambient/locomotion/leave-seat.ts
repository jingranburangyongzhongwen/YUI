/**
 * A published oneshot while perched stands up, plays on the ledge, then sits back.
 * The host going away — or the clip walking her off it — drops her instead.
 */

import type { WindowRect } from "../../contract";
import { createLogger } from "../../logger";
import type { TickFn } from "../../renderer";
import type { RenderMotionSignal } from "../../renderer/motion/motion-controller";
import type { PercherWindow } from "./percher";
import type { Sitter } from "./sitter";

const log = createLogger("leave-seat");

export type LeaveSeatWindow = PercherWindow;

export interface LeaveSeatDeps {
  renderer: {
    playMotion(motion: RenderMotionSignal | null): void;
    getCharacterAnchor(): { x: number; y: number } | null;
    getCurrentMotion(): { id: string } | null;
    onTick(fn: TickFn): () => void;
  };
  sitter: Pick<Sitter, "standUp" | "sitDown">;
  dropSource: {
    armedSit(): { windowNumber: number; origin: "commit" | "adopt"; charHpx: number } | null;
    suspendSit(): {
      windowNumber: number;
      origin: "commit" | "adopt";
      rect: { x: number; y: number };
      charHpx: number;
    } | null;
    resumeSit(edgeLocalYpx: number): void;
    abandonSit(): void;
    release(): void;
  };
  /** Drop a perched stroll so it cannot sit her back down while this sequence owns the seat. */
  cancelPercher(): void;
  getWindow(): LeaveSeatWindow | null;
  listWindows(): Promise<WindowRect[]>;
  onSit(target: WindowRect, edgeLocalYpx: number): void;
  onHostLost(): void;
  /** Keep the perch and climb loops from starting a stroll or descent while the seat is suspended here. */
  setBusy?(busy: boolean): void;
}

/**
 * Returns a play sink: true when this sequence owns the cue. No armed sit
 * returns false so the renderer plays in place.
 */
export function createLeaveSeatThenPlay(
  deps: LeaveSeatDeps,
): (motion: RenderMotionSignal) => boolean {
  let inFlight = false;
  let pending: RenderMotionSignal | null = null;

  function waitWhilePlaying(id: string): Promise<void> {
    return new Promise((resolve) => {
      const unsub = deps.renderer.onTick(() => {
        if (deps.renderer.getCurrentMotion()?.id !== id) {
          unsub();
          resolve();
        }
      });
    });
  }

  async function run(motion: RenderMotionSignal): Promise<void> {
    deps.setBusy?.(true);
    let owned = false;
    let seated = false;
    let fell = false;
    try {
      deps.cancelPercher();
      const suspended = deps.dropSource.suspendSit();
      if (!suspended) return;
      owned = true;
      const win = deps.getWindow();
      const anchor = deps.renderer.getCharacterAnchor();
      if (!win || !anchor) {
        deps.dropSource.release();
        deps.onHostLost();
        fell = true;
        return;
      }
      const scaleFactor = await win.scaleFactor();
      const scale = scaleFactor > 0 ? scaleFactor : 1;
      const toY = Math.round((suspended.rect.y - anchor.y) * scale);
      if ((await deps.sitter.standUp(win, toY)) !== "done") {
        const [pos, windows] = await Promise.all([win.outerPosition(), deps.listWindows()]);
        const host = windows.find((w) => w.windowNumber === suspended.windowNumber);
        if (!host) {
          deps.dropSource.release();
          deps.onHostLost();
          fell = true;
          return;
        }
        const edgeLocalYpx = Math.round(host.y - pos.y / scale);
        deps.dropSource.resumeSit(edgeLocalYpx);
        deps.onSit(host, edgeLocalYpx);
        seated = true;
        return;
      }
      let current = motion;
      for (;;) {
        if (pending) {
          current = pending;
          pending = null;
        }
        deps.renderer.playMotion(current);
        if (deps.renderer.getCurrentMotion()?.id === current.id) {
          await waitWhilePlaying(current.id);
        }
        if (!pending) break;
      }
      const [pos, windows] = await Promise.all([win.outerPosition(), deps.listWindows()]);
      const feet = deps.renderer.getCharacterAnchor() ?? anchor;
      const feetX = pos.x / scale + feet.x;
      const host = windows.find((w) => w.windowNumber === suspended.windowNumber);
      if (!host || feetX < host.x || feetX >= host.x + host.width) {
        deps.dropSource.release();
        deps.onHostLost();
        fell = true;
        return;
      }
      if ((await deps.sitter.sitDown({ win, scale })) !== "done") return;
      const seatedPos = await win.outerPosition();
      const edgeLocalYpx = host.y - seatedPos.y / scale;
      deps.dropSource.resumeSit(edgeLocalYpx);
      deps.onSit(host, edgeLocalYpx);
      seated = true;
    } finally {
      if (owned && !seated && !fell) deps.dropSource.abandonSit();
      deps.setBusy?.(false);
      inFlight = false;
    }
    const next = pending;
    pending = null;
    if (next && seated) {
      inFlight = true;
      await run(next);
    }
  }

  return (motion) => {
    if (!deps.dropSource.armedSit()) return false;
    if (inFlight) {
      pending = motion;
      return true;
    }
    inFlight = true;
    void run(motion).catch((err) => {
      log.warn("leave_seat_failed", { degrade: true, error: String(err) });
      inFlight = false;
      deps.setBusy?.(false);
    });
    return true;
  };
}
