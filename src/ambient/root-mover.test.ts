/**
 * root-mover.test.ts — the OS window follows an xz-locked clip's hips floor path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScreenMonitor } from "../io/screen-geometry";
import type { TickContext, TickFn } from "../renderer";
import {
  clampRootFollow,
  createRootMover,
  type RootMoverDeps,
  windowDeltaFromHipsX,
} from "./root-mover";

const MONITOR: ScreenMonitor = {
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1600 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1500 } },
  scaleFactor: 1,
};

const WINDOW_POS = { x: 500, y: 1080 };
const PX_PER_METRE = 300;

describe("windowDeltaFromHipsX", () => {
  it("maps hips +X to window +X", () => {
    expect(windowDeltaFromHipsX(1, 200)).toBe(200);
  });

  it("keeps a leftward step signed", () => {
    expect(windowDeltaFromHipsX(-0.25, 400)).toBe(-100);
  });
});

describe("clampRootFollow", () => {
  const work = { x: 0, y: 0, width: 1920, height: 1500 };

  it("clamps X so the window stays in the work area horizontally", () => {
    expect(clampRootFollow(-100, 1080, 400, work).x).toBe(0);
    expect(clampRootFollow(3000, 1080, 400, work).x).toBe(1520);
  });

  it("does not yank a floor-standing window up to fit its full height", () => {
    expect(clampRootFollow(500, 1080, 400, work)).toEqual({ x: 500, y: 1080 });
  });

  it("clamps Y so the origin stays inside the work-area span", () => {
    expect(clampRootFollow(500, -20, 400, work).y).toBe(0);
    expect(clampRootFollow(500, 4000, 400, work).y).toBe(1500);
  });
});

function makeHarness(
  over: {
    position?: { x: number; y: number };
    windowScale?: number;
    pxPerMetre?: number | null;
    perched?: boolean;
    peeking?: boolean;
    dragging?: boolean;
    currentId?: string | null;
    timeS?: number | null;
    curve?: number | null;
    monitors?: ScreenMonitor[];
  } = {},
) {
  let tick: TickFn | null = null;
  const positions: Array<{ x: number; y: number }> = [];
  const starts = vi.fn();
  const ends = vi.fn();
  let currentId: string | null = over.currentId === undefined ? "motion" : over.currentId;
  let timeS: number | null = over.timeS === undefined ? 0 : over.timeS;
  let curve: number | null = over.curve === undefined ? 0 : over.curve;
  let dragging = over.dragging ?? false;
  let peeking = over.peeking ?? false;
  let perched = over.perched ?? false;
  let position = { ...(over.position ?? WINDOW_POS) };

  const deps: RootMoverDeps = {
    renderer: {
      onTick: (fn) => {
        tick = fn;
        return () => {
          tick = null;
        };
      },
      getCurrentMotion: () =>
        currentId ? { id: currentId, vrma_path: `/motions/${currentId}.vrma` } : null,
      getCurrentMotionTime: () => timeS,
      getMotionTravelXAt: (id) => {
        if (id !== "motion") return null;
        return curve;
      },
      getPxPerMetre: () => (over.pxPerMetre === undefined ? PX_PER_METRE : over.pxPerMetre),
      isPerched: () => perched,
    },
    getWindow: () => ({
      outerPosition: async () => position,
      outerSize: async () => ({ width: 400, height: 600 }),
      scaleFactor: async () => over.windowScale ?? 1,
      setPositionLogical: async (x, y) => {
        positions.push({ x, y });
      },
    }),
    listMonitors: async () => over.monitors ?? [MONITOR],
    isDragging: () => dragging,
    isPeeking: () => peeking,
    onStart: starts,
    onEnd: ends,
  };

  const mover = createRootMover(deps);
  let elapsed = 0;
  const frame = async (dt = 1 / 60): Promise<void> => {
    elapsed += dt;
    tick?.({ vrm: {} as never, dt, elapsed } as TickContext);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  return {
    mover,
    positions,
    starts,
    ends,
    frame,
    setCurrent: (id: string | null) => {
      currentId = id;
    },
    setTime: (t: number | null) => {
      timeS = t;
    },
    setCurve: (next: number | null) => {
      curve = next;
    },
    setDragging: (v: boolean) => {
      dragging = v;
    },
    setPeeking: (v: boolean) => {
      peeking = v;
    },
    setPerched: (v: boolean) => {
      perched = v;
    },
    setWindowPos: (next: { x: number; y: number }) => {
      position = { ...next };
    },
    hasTick: () => tick !== null,
  };
}

describe("createRootMover", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers a tick hook on start and unregisters it on stop", () => {
    const h = makeHarness();
    expect(h.hasTick()).toBe(false);
    h.mover.start();
    expect(h.hasTick()).toBe(true);
    h.mover.stop();
    expect(h.hasTick()).toBe(false);
  });

  it("slides the window sideways and leaves the floor line alone", async () => {
    const h = makeHarness();
    h.mover.start();
    await h.frame();
    await h.frame();
    expect(h.starts).toHaveBeenCalledTimes(1);
    h.setTime(1);
    h.setCurve(1);
    await h.frame();
    expect(h.positions.at(-1)).toEqual({ x: 800, y: 1080 });
  });

  it("moves through setPositionLogical in logical points on a scaled screen", async () => {
    const SCALE2: ScreenMonitor = {
      position: { x: 0, y: 0 },
      size: { width: 3840, height: 3200 },
      workArea: { position: { x: 0, y: 0 }, size: { width: 3840, height: 3000 } },
      scaleFactor: 2,
    };
    const h = makeHarness({
      position: { x: WINDOW_POS.x * 2, y: WINDOW_POS.y * 2 },
      monitors: [SCALE2],
      windowScale: 2,
    });
    h.mover.start();
    await h.frame();
    await h.frame();
    h.setTime(1);
    h.setCurve(1);
    await h.frame();
    expect(h.positions.at(-1)).toEqual({ x: 800, y: 1080 });
  });

  it("clamps the window inside the work area", async () => {
    const h = makeHarness();
    h.mover.start();
    await h.frame();
    await h.frame();
    h.setTime(1);
    h.setCurve(20);
    await h.frame();
    expect(h.positions.at(-1)).toEqual({ x: 1520, y: 1080 });
  });

  it("leaves the window where the clip ended", async () => {
    const h = makeHarness();
    h.mover.start();
    await h.frame();
    await h.frame();
    h.setTime(1);
    h.setCurve(1);
    await h.frame();
    h.setCurrent("idle");
    h.setCurve(null);
    await h.frame();
    expect(h.ends).toHaveBeenCalledTimes(1);
    expect(h.positions.at(-1)).toEqual({ x: 800, y: 1080 });
  });

  it("does not drive the window for a clip without an xz curve", async () => {
    const h = makeHarness({ currentId: "idle", curve: null });
    h.mover.start();
    await h.frame();
    await h.frame();
    expect(h.positions).toEqual([]);
    expect(h.starts).not.toHaveBeenCalled();
  });

  it("yields the window when the user starts a drag", async () => {
    const h = makeHarness();
    h.mover.start();
    await h.frame();
    await h.frame();
    expect(h.starts).toHaveBeenCalledTimes(1);
    const last = h.positions.length;
    h.setDragging(true);
    await h.frame();
    expect(h.ends).toHaveBeenCalledTimes(1);
    h.setTime(1);
    h.setCurve(1);
    await h.frame();
    expect(h.positions.length).toBe(last);
  });

  it("resumes the floor path from a new window origin after cancel", async () => {
    const h = makeHarness();
    h.mover.start();
    await h.frame();
    await h.frame();
    h.setTime(1);
    h.setCurve(1);
    await h.frame();
    expect(h.positions.at(-1)).toEqual({ x: 800, y: 1080 });
    h.mover.cancel();
    h.setWindowPos({ x: 200, y: 1080 });
    await h.frame();
    await h.frame();
    h.setTime(2);
    h.setCurve(2);
    await h.frame();
    expect(h.positions.at(-1)).toEqual({ x: 500, y: 1080 });
  });

  it("does not start following while perched", async () => {
    const h = makeHarness({ perched: true });
    h.mover.start();
    await h.frame();
    await h.frame();
    expect(h.starts).not.toHaveBeenCalled();
    expect(h.positions).toEqual([]);
  });
});
