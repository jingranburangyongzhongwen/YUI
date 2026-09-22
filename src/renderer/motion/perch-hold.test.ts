/**
 * perch-hold.test.ts — pure predicate gating motion requests while a posture is held.
 *
 * The renderer can't be unit-instantiated because real THREE.WebGLRenderer needs a GL
 * context. So held-posture decisions are extracted and tested as pure functions.
 */

import { describe, expect, it } from "vitest";
import type { MotionKind } from "../../contract";
import { baselineWhileHeld, shouldLeaveSeatForMotion, suppressWhileHeld } from "./perch-hold";

const kinds: Record<string, MotionKind> = {
  happy: "oneshot",
  sit_down: "oneshot",
  stand_up: "oneshot",
  landing: "oneshot",
  walk: "reactive",
  idle: "ambient",
  peek: "state",
  window_sit: "state",
};
const kindOf = (id: string) => kinds[id];

describe("suppressWhileHeld — held postures survive incoming motion cues", () => {
  it("suppresses an implicit idle return while any posture is held", () => {
    expect(suppressWhileHeld(null, true, kindOf)).toBe(true);
  });

  it("suppresses locomotion while any posture is held", () => {
    expect(suppressWhileHeld({ id: "walk" }, true, kindOf)).toBe(true);
    expect(suppressWhileHeld({ id: "idle" }, true, kindOf)).toBe(true);
  });

  it("allows a oneshot while held so a peek or a leave-seat handler can still take it", () => {
    expect(suppressWhileHeld({ id: "happy" }, true, kindOf)).toBe(false);
  });

  it.each(["peek", "window_sit"])("allows the %s state motion while held", (id) => {
    expect(suppressWhileHeld({ id }, true, kindOf)).toBe(false);
  });

  it.each([
    null,
    { id: "happy" },
    { id: "peek" },
    { id: "missing" },
  ])("allows %j when no posture is held", (motion) => {
    expect(suppressWhileHeld(motion, false, kindOf)).toBe(false);
  });

  it("suppresses an unregistered motion while held", () => {
    expect(suppressWhileHeld({ id: "missing" }, true, kindOf)).toBe(true);
  });
});

const published = (id: string) => id !== "sit_down" && id !== "stand_up" && id !== "landing";

describe("shouldLeaveSeatForMotion — a published oneshot leaves a perch first", () => {
  it("leaves the seat for a published oneshot while perched", () => {
    expect(shouldLeaveSeatForMotion({ id: "happy" }, true, kindOf, published)).toBe(true);
  });

  it.each([
    "sit_down",
    "stand_up",
    "landing",
  ])("keeps a client-owned %s oneshot on the perch", (id) => {
    expect(shouldLeaveSeatForMotion({ id }, true, kindOf, published)).toBe(false);
  });

  it("does not leave for a held state motion", () => {
    expect(shouldLeaveSeatForMotion({ id: "window_sit" }, true, kindOf, published)).toBe(false);
  });

  it("does not leave when no posture is held", () => {
    expect(shouldLeaveSeatForMotion({ id: "happy" }, false, kindOf, published)).toBe(false);
  });

  it("does not leave for an implicit idle return", () => {
    expect(shouldLeaveSeatForMotion(null, true, kindOf, published)).toBe(false);
  });
});

describe("baselineWhileHeld — VRM reload restores held state motion", () => {
  it("uses the last state motion while a posture is held", () => {
    expect(baselineWhileHeld(true, "window_sit", "idle")).toBe("window_sit");
  });

  it("uses the baseline without a remembered state motion", () => {
    expect(baselineWhileHeld(true, null, "idle")).toBe("idle");
  });

  it("uses the baseline when no posture is held", () => {
    expect(baselineWhileHeld(false, "window_sit", "idle")).toBe("idle");
  });
});
