/**
 * leave-seat.test.ts — a published oneshot while perched stands up, plays, then sits back.
 */

import { describe, expect, it, vi } from "vitest";
import type { WindowRect } from "../contract";
import type { RenderMotionSignal, TickContext, TickFn } from "../renderer";
import { createLeaveSeatThenPlay, type LeaveSeatWindow } from "./leave-seat";
import type { SeatWindow } from "./sitter";

const DANCE: RenderMotionSignal = { id: "dance" };
const HAPPY: RenderMotionSignal = { id: "happy" };
const HOST = { x: 100, y: 800 };
const ANCHOR = { x: 200, y: 420 };

function hostRect(over: Partial<WindowRect> = {}): WindowRect {
  return {
    windowNumber: 7,
    x: HOST.x,
    y: HOST.y,
    width: 400,
    height: 300,
    name: "Chrome",
    ownerName: "Chrome",
    pid: 1,
    ...over,
  };
}

function makeHarness(
  over: {
    origin?: "commit" | "adopt";
    armed?: { windowNumber: number; origin: "commit" | "adopt"; charHpx: number } | null;
    standUp?: () => Promise<"done" | "lost">;
    sitDown?: () => Promise<"done" | "lost">;
    scale?: number;
    windows?: WindowRect[];
  } = {},
) {
  let current: { id: string } | null = { id: "window_sit" };
  let tick: TickFn | null = null;
  const positions: Array<{ x: number; y: number }> = [];
  const win: LeaveSeatWindow = {
    outerPosition: async () => ({ x: 0, y: 0 }),
    scaleFactor: async () => over.scale ?? 1,
    setPositionPhysical: async (x, y) => {
      positions.push({ x, y });
    },
  };
  const playMotion = vi.fn((motion: RenderMotionSignal | null) => {
    current = motion ? { id: motion.id } : { id: "idle" };
  });
  const cancelPercher = vi.fn();
  const abandonSit = vi.fn();
  const resumeSit = vi.fn();
  const release = vi.fn();
  const onSit = vi.fn();
  const onHostLost = vi.fn();
  const setBusy = vi.fn();
  const origin = over.origin ?? "commit";
  const armed = over.armed === undefined ? { windowNumber: 7, origin, charHpx: 400 } : over.armed;
  const suspendSit = vi.fn(() =>
    armed
      ? {
          windowNumber: armed.windowNumber,
          origin: armed.origin,
          rect: HOST,
          charHpx: armed.charHpx,
        }
      : null,
  );
  const armedSit = vi.fn(() => armed);
  const standUp = vi.fn(over.standUp ?? (async (_w: SeatWindow, _toY: number) => "done" as const));
  const sitDown = vi.fn(over.sitDown ?? (async () => "done" as const));
  const leave = createLeaveSeatThenPlay({
    renderer: {
      playMotion,
      getCharacterAnchor: () => ANCHOR,
      getCurrentMotion: () => current,
      onTick: (fn) => {
        tick = fn;
        return () => {
          tick = null;
        };
      },
    },
    sitter: { standUp, sitDown },
    dropSource: { armedSit, suspendSit, abandonSit, resumeSit, release },
    cancelPercher,
    getWindow: () => win,
    listWindows: async () => over.windows ?? [hostRect()],
    onSit,
    onHostLost,
    setBusy,
  });
  const frame = async (): Promise<void> => {
    tick?.({ vrm: {} as never, dt: 0.016, elapsed: 0 } as TickContext);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const finishOneshot = async (): Promise<void> => {
    current = { id: "idle" };
    await frame();
  };
  return {
    leave,
    playMotion,
    cancelPercher,
    abandonSit,
    resumeSit,
    release,
    suspendSit,
    standUp,
    sitDown,
    onSit,
    onHostLost,
    setBusy,
    frame,
    finishOneshot,
  };
}

describe("createLeaveSeatThenPlay", () => {
  it("stands up, plays, then sits back on the armed host", async () => {
    const h = makeHarness();
    expect(h.leave(DANCE)).toBe(true);
    await vi.waitFor(() => expect(h.playMotion).toHaveBeenCalledWith(DANCE));
    expect(h.cancelPercher).toHaveBeenCalledTimes(1);
    expect(h.suspendSit).toHaveBeenCalledTimes(1);
    expect(h.standUp).toHaveBeenCalledTimes(1);
    expect(h.standUp.mock.calls[0][1]).toBe(HOST.y - ANCHOR.y);
    expect(h.sitDown).not.toHaveBeenCalled();
    await h.finishOneshot();
    await vi.waitFor(() => expect(h.sitDown).toHaveBeenCalledTimes(1));
    expect(h.resumeSit).toHaveBeenCalledTimes(1);
    expect(h.onSit).toHaveBeenCalledTimes(1);
    expect(h.abandonSit).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.onHostLost).not.toHaveBeenCalled();
    expect(h.playMotion.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.standUp.mock.invocationCallOrder[0],
    );
    expect(h.sitDown.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.playMotion.mock.invocationCallOrder[0],
    );
  });

  it("scales standing Y into physical px", async () => {
    const h = makeHarness({ scale: 2 });
    h.leave(DANCE);
    await vi.waitFor(() => expect(h.standUp).toHaveBeenCalled());
    expect(h.standUp.mock.calls[0][1]).toBe(Math.round((HOST.y - ANCHOR.y) * 2));
    await h.finishOneshot();
    await vi.waitFor(() => expect(h.sitDown).toHaveBeenCalled());
  });

  it("puts the seat back when stand-up is lost, without playing", async () => {
    const h = makeHarness({ standUp: async () => "lost" });
    h.leave(DANCE);
    await vi.waitFor(() => expect(h.resumeSit).toHaveBeenCalled());
    expect(h.playMotion).not.toHaveBeenCalled();
    expect(h.onSit).toHaveBeenCalledTimes(1);
    expect(h.abandonSit).not.toHaveBeenCalled();
    expect(h.onHostLost).not.toHaveBeenCalled();
  });

  it("falls when the host is gone after the oneshot", async () => {
    const h = makeHarness({ windows: [] });
    h.leave(DANCE);
    await vi.waitFor(() => expect(h.playMotion).toHaveBeenCalledWith(DANCE));
    await h.finishOneshot();
    await vi.waitFor(() => expect(h.onHostLost).toHaveBeenCalledTimes(1));
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.sitDown).not.toHaveBeenCalled();
    expect(h.resumeSit).not.toHaveBeenCalled();
    expect(h.abandonSit).not.toHaveBeenCalled();
  });

  it("falls when the oneshot walked her off the host", async () => {
    const h = makeHarness({ windows: [hostRect({ x: 1000, width: 50 })] });
    h.leave(DANCE);
    await vi.waitFor(() => expect(h.playMotion).toHaveBeenCalledWith(DANCE));
    await h.finishOneshot();
    await vi.waitFor(() => expect(h.onHostLost).toHaveBeenCalledTimes(1));
    expect(h.sitDown).not.toHaveBeenCalled();
  });

  it("stands up from a climb-owned seat and sits back", async () => {
    const h = makeHarness({ origin: "adopt" });
    expect(h.leave(DANCE)).toBe(true);
    await vi.waitFor(() => expect(h.playMotion).toHaveBeenCalledWith(DANCE));
    await h.finishOneshot();
    await vi.waitFor(() => expect(h.sitDown).toHaveBeenCalledTimes(1));
    expect(h.resumeSit).toHaveBeenCalledTimes(1);
    expect(h.abandonSit).not.toHaveBeenCalled();
  });

  it("a newer oneshot waits for the same stand-up instead of replaying it", async () => {
    let releaseFirst!: (outcome: "done" | "lost") => void;
    const firstStand = new Promise<"done" | "lost">((resolve) => {
      releaseFirst = resolve;
    });
    const h = makeHarness({
      standUp: () => firstStand,
    });
    h.leave(DANCE);
    await vi.waitFor(() => expect(h.standUp).toHaveBeenCalledTimes(1));
    expect(h.leave(HAPPY)).toBe(true);
    releaseFirst("done");
    await vi.waitFor(() => expect(h.playMotion).toHaveBeenCalledWith(HAPPY));
    expect(h.playMotion).not.toHaveBeenCalledWith(DANCE);
    expect(h.standUp).toHaveBeenCalledTimes(1);
    await h.finishOneshot();
    await vi.waitFor(() => expect(h.sitDown).toHaveBeenCalledTimes(1));
  });
});
