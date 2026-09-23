import { describe, expect, it, vi } from "vitest";
import {
  blockingWindow,
  createStringForm,
  edgeGap,
  isYieldPhrase,
  nearerSide,
  planYield,
  type YieldMeasure,
} from "./string-form";

const monitor = { x: 0, width: 1000 };
const anchorX = 200;

describe("isYieldPhrase", () => {
  it("matches the phrase with surrounding whitespace and nothing else", () => {
    expect(isYieldPhrase("  让一下  ", "让一下")).toBe(true);
    expect(isYieldPhrase("让一下啊", "让一下")).toBe(false);
    expect(isYieldPhrase("让一下", "  ")).toBe(false);
  });
});

describe("planYield", () => {
  it("picks the nearer edge, left on a tie", () => {
    expect(nearerSide(200, monitor)).toBe("left");
    expect(nearerSide(800, monitor)).toBe("right");
    expect(nearerSide(500, monitor)).toBe("left");
  });

  it("walks standing when the nearer gap fits a body", () => {
    const action = planYield({
      bodyX: 300,
      bodyWidth: 100,
      anchorX,
      flattenLeadPx: 160,
      monitor,
      window: { x: 400, width: 600 },
    });
    expect(edgeGap("left", monitor, { x: 400, width: 600 })).toBe(400);
    expect(action).toEqual({ kind: "walk", side: "left", toX: 50 - anchorX });
  });

  it("flattens a visible stretch before the screen edge", () => {
    const action = planYield({
      bodyX: 200,
      bodyWidth: 100,
      anchorX,
      flattenLeadPx: 160,
      monitor,
      window: { x: 40, width: 960 },
    });
    expect(action).toEqual({
      kind: "walk-then-flatten",
      side: "left",
      standToX: 160 - anchorX,
      flatToX: 0 - anchorX,
    });
  });

  it("skips the standing leg when she is already inside the paper stretch", () => {
    const action = planYield({
      bodyX: 50,
      bodyWidth: 100,
      anchorX,
      flattenLeadPx: 160,
      monitor,
      window: { x: 40, width: 960 },
    });
    expect(action).toEqual({
      kind: "walk-then-flatten",
      side: "left",
      standToX: 50 - anchorX,
      flatToX: 0 - anchorX,
    });
  });

  it("walks when nothing is in front", () => {
    const action = planYield({
      bodyX: 800,
      bodyWidth: 100,
      anchorX,
      flattenLeadPx: 160,
      monitor,
      window: null,
    });
    expect(action).toEqual({ kind: "walk", side: "right", toX: 950 - anchorX });
  });
});

describe("blockingWindow", () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };

  it("returns the first overlapping window, front to back", () => {
    const front = { x: 10, y: 10, width: 100, height: 100, id: "front" };
    const back = { x: 0, y: 0, width: 1000, height: 800, id: "back" };
    const other = { x: 2000, y: 0, width: 100, height: 100, id: "other" };
    expect(blockingWindow([other, front, back], area)?.id).toBe("front");
    expect(blockingWindow([other], area)).toBeNull();
  });
});

function wide(): YieldMeasure {
  return {
    bodyX: 300,
    anchorX,
    bodyWidth: 100,
    monitor,
    window: { x: 400, width: 600 },
  };
}

function narrow(): YieldMeasure {
  return {
    bodyX: 200,
    anchorX,
    bodyWidth: 100,
    monitor,
    window: { x: 40, width: 960 },
  };
}

function harness(measured: YieldMeasure | null = wide()) {
  let releaseWalk: (outcome: "arrived" | "lost") => void = () => {};
  const walkTo = vi.fn(
    () =>
      new Promise<"arrived" | "lost">((resolve) => {
        releaseWalk = resolve;
      }),
  );
  const setFlat = vi.fn();
  const playWalk = vi.fn();
  const moveTo = vi.fn(async (x: number) => {
    pose.x = x;
  });
  const frames: Array<(dt: number) => void> = [];
  const polls: Array<() => void> = [];
  let can = true;
  let current = measured;
  const pose = { x: (measured?.bodyX ?? 0) - (measured?.anchorX ?? anchorX), y: 40 };
  const form = createStringForm({
    getConfig: () => ({
      phrase: "让一下",
      body_width_px: 100,
      scale_x: 0.12,
      flatten_lead_px: 160,
      poll_ms: 700,
    }),
    canYield: () => can,
    measure: async () => current,
    walkTo,
    readPose: async () => ({ ...pose }),
    moveTo,
    playWalk,
    onFrame(fn) {
      frames.push(fn);
      return () => {
        const index = frames.indexOf(fn);
        if (index >= 0) frames.splice(index, 1);
      };
    },
    setFlat,
    schedule(_ms, fn) {
      polls.push(fn);
      return () => {
        const index = polls.indexOf(fn);
        if (index >= 0) polls.splice(index, 1);
      };
    },
  });
  return {
    form,
    walkTo,
    setFlat,
    playWalk,
    moveTo,
    frames,
    pose,
    polls,
    setCan(next: boolean) {
      can = next;
    },
    setMeasured(next: YieldMeasure | null) {
      current = next;
    },
    finishWalk(outcome: "arrived" | "lost" = "arrived") {
      releaseWalk(outcome);
    },
  };
}

describe("createStringForm", () => {
  it("ignores other text and a yield while she cannot move", async () => {
    const h = harness();
    h.form.onText("hello");
    h.setCan(false);
    h.form.onText("让一下");
    await vi.waitFor(() => Promise.resolve());
    expect(h.walkTo).not.toHaveBeenCalled();
    expect(h.setFlat).not.toHaveBeenCalled();
  });

  it("stays standing when the gap fits", async () => {
    const h = harness();
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.walkTo).toHaveBeenCalledWith(50 - anchorX));
    expect(h.setFlat).not.toHaveBeenCalled();
    expect(h.playWalk).not.toHaveBeenCalled();
    h.finishWalk();
  });

  it("flattens only after the standing walk, then slides the paper body to the edge", async () => {
    const h = harness(narrow());
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.walkTo).toHaveBeenCalledTimes(1));
    expect(h.walkTo).toHaveBeenCalledWith(160 - anchorX);
    expect(h.setFlat).not.toHaveBeenCalled();
    h.finishWalk();
    await vi.waitFor(() => expect(h.setFlat).toHaveBeenCalledWith(0.12));
    expect(h.playWalk).toHaveBeenCalledTimes(1);
    expect(h.form.isFlat()).toBe(true);
    await vi.waitFor(() => expect(h.frames.length).toBeGreaterThan(0));
    for (let i = 0; i < 40; i++) h.frames[0]?.(0.05);
    expect(h.pose.x).toBe(0 - anchorX);
  });

  it("drops a yield that resolves after a drag", async () => {
    let resolveMeasure: (value: YieldMeasure) => void = () => {};
    const h = harness();
    const form = createStringForm({
      getConfig: () => ({
        phrase: "让一下",
        body_width_px: 100,
        scale_x: 0.12,
        flatten_lead_px: 160,
        poll_ms: 700,
      }),
      canYield: () => true,
      measure: () =>
        new Promise((resolve) => {
          resolveMeasure = resolve;
        }),
      walkTo: h.walkTo,
      readPose: async () => ({ x: 0, y: 0 }),
      moveTo: async () => {},
      playWalk: () => {},
      onFrame: () => () => {},
      setFlat: h.setFlat,
      schedule: () => () => {},
    });
    form.onText("让一下");
    form.noteDrag();
    resolveMeasure(narrow());
    await Promise.resolve();
    await Promise.resolve();
    expect(h.walkTo).not.toHaveBeenCalled();
    expect(h.setFlat).not.toHaveBeenCalled();
  });

  it("unflattens in place once the gap can hold a body, and a drag unflattens immediately", async () => {
    const h = harness(narrow());
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.walkTo).toHaveBeenCalledTimes(1));
    h.finishWalk();
    await vi.waitFor(() => expect(h.form.isFlat()).toBe(true));
    await vi.waitFor(() => expect(h.frames.length).toBeGreaterThan(0));
    for (let i = 0; i < 40; i++) h.frames[0]?.(0.05);
    await vi.waitFor(() => expect(h.polls.length).toBeGreaterThan(0));
    h.setMeasured(wide());
    h.polls[0]?.();
    await vi.waitFor(() => expect(h.form.isFlat()).toBe(false));
    expect(h.setFlat).toHaveBeenLastCalledWith(null);

    h.setMeasured(narrow());
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.walkTo).toHaveBeenCalledTimes(2));
    h.finishWalk();
    await vi.waitFor(() => expect(h.form.isFlat()).toBe(true));
    h.form.noteDrag();
    expect(h.form.isFlat()).toBe(false);
    expect(h.setFlat).toHaveBeenLastCalledWith(null);
  });
});
