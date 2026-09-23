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

  it("walks to the screen edge when the nearer gap fits a body", () => {
    const action = planYield({
      bodyX: 300,
      bodyWidth: 100,
      anchorX,
      monitor,
      window: { x: 400, width: 600 },
    });
    expect(edgeGap("left", monitor, { x: 400, width: 600 })).toBe(400);
    expect(action).toEqual({ kind: "walk", side: "left", toX: 50 - anchorX });
  });

  it("flattens onto the edge when the gap is narrower than a body", () => {
    const action = planYield({
      bodyX: 200,
      bodyWidth: 100,
      anchorX,
      monitor,
      window: { x: 40, width: 960 },
    });
    expect(action).toEqual({ kind: "flatten", side: "left", toX: 0 - anchorX });
  });

  it("walks when nothing is in front", () => {
    const action = planYield({
      bodyX: 800,
      bodyWidth: 100,
      anchorX,
      monitor,
      window: null,
    });
    expect(action.kind).toBe("walk");
    expect(action.side).toBe("right");
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
  const walkTo = vi.fn(async () => "arrived" as const);
  const moveTo = vi.fn(async () => {});
  const setFlat = vi.fn();
  const polls: Array<() => void> = [];
  let can = true;
  let current = measured;
  const form = createStringForm({
    getConfig: () => ({ phrase: "让一下", body_width_px: 100, scale_x: 0.12, poll_ms: 700 }),
    canYield: () => can,
    measure: async () => current,
    walkTo,
    moveTo,
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
    moveTo,
    setFlat,
    polls,
    setCan(next: boolean) {
      can = next;
    },
    setMeasured(next: YieldMeasure | null) {
      current = next;
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
    expect(h.moveTo).not.toHaveBeenCalled();
  });

  it("walks when the gap fits and does not flatten", async () => {
    const h = harness();
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.walkTo).toHaveBeenCalledWith(50 - anchorX));
    expect(h.setFlat).not.toHaveBeenCalled();
    expect(h.form.isFlat()).toBe(false);
  });

  it("moves to the edge and flattens when the gap is too narrow", async () => {
    const h = harness(narrow());
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.moveTo).toHaveBeenCalledWith(0 - anchorX));
    expect(h.setFlat).toHaveBeenCalledWith(0.12);
    expect(h.walkTo).not.toHaveBeenCalled();
    expect(h.form.isFlat()).toBe(true);
  });

  it("drops a yield that resolves after a drag", async () => {
    let resolveMeasure: (value: YieldMeasure) => void = () => {};
    const h = harness();
    const form = createStringForm({
      getConfig: () => ({ phrase: "让一下", body_width_px: 100, scale_x: 0.12, poll_ms: 700 }),
      canYield: () => true,
      measure: () =>
        new Promise((resolve) => {
          resolveMeasure = resolve;
        }),
      walkTo: h.walkTo,
      moveTo: h.moveTo,
      setFlat: h.setFlat,
      schedule: () => () => {},
    });
    form.onText("让一下");
    form.noteDrag();
    resolveMeasure(narrow());
    await Promise.resolve();
    await Promise.resolve();
    expect(h.moveTo).not.toHaveBeenCalled();
  });

  it("unflattens in place once the gap can hold a body, and a drag unflattens immediately", async () => {
    const h = harness(narrow());
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.form.isFlat()).toBe(true));
    h.setMeasured(wide());
    h.polls[0]?.();
    await vi.waitFor(() => expect(h.form.isFlat()).toBe(false));
    expect(h.setFlat).toHaveBeenLastCalledWith(null);
    expect(h.moveTo).toHaveBeenCalledTimes(1);

    h.setMeasured(narrow());
    h.form.onText("让一下");
    await vi.waitFor(() => expect(h.form.isFlat()).toBe(true));
    h.form.noteDrag();
    expect(h.form.isFlat()).toBe(false);
    expect(h.setFlat).toHaveBeenLastCalledWith(null);
  });
});
