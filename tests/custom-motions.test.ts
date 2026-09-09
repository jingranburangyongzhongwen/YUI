import { describe, expect, it } from "vitest";
import { mergeCustomMotions, overlayFromVrmaFilenames } from "../scripts/custom-motions.mjs";

describe("overlayFromVrmaFilenames", () => {
  it("turns each .vrma stem into a published xz-locked oneshot", () => {
    expect(overlayFromVrmaFilenames(["motion.vrma", "wave.VRMA", "notes.txt", ".vrma"])).toEqual({
      motion: {
        vrma_path: "/custom_motions/motion.vrma",
        kind: "oneshot",
        loop: false,
        priority: 70,
        interrupt_policy: "replace",
        root_lock_xz: true,
      },
      wave: {
        vrma_path: "/custom_motions/wave.VRMA",
        kind: "oneshot",
        loop: false,
        priority: 70,
        interrupt_policy: "replace",
        root_lock_xz: true,
      },
    });
  });

  it("returns an empty object when the folder has no clips", () => {
    expect(overlayFromVrmaFilenames([])).toEqual({});
    expect(overlayFromVrmaFilenames([".gitkeep"])).toEqual({});
  });
});

describe("mergeCustomMotions", () => {
  const shipped = {
    idle: { vrma_path: "/motions/calm.vrma", kind: "ambient", loop: true, priority: 0 },
  };

  it("leaves the catalog alone when the folder is empty", () => {
    expect(mergeCustomMotions(shipped, {})).toBe(shipped);
  });

  it("merges a clip that is absent from the shipped catalog", () => {
    const overlay = overlayFromVrmaFilenames(["motion.vrma"]);
    expect(mergeCustomMotions(shipped, overlay).motion).toEqual(overlay.motion);
    expect(mergeCustomMotions(shipped, overlay).idle).toBe(shipped.idle);
  });

  it("rejects an id that collides with the shipped catalog", () => {
    expect(() => mergeCustomMotions(shipped, overlayFromVrmaFilenames(["idle.vrma"]))).toThrow(
      /collides with the shipped catalog/,
    );
  });
});
