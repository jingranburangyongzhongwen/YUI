import { describe, expect, it, vi } from "vitest";
import { overlayFromVrmaFilenames } from "../../scripts/custom-motions.mjs";
import { customMotionEntry, importPklMotion, type PklImportDeps } from "./pkl-import";

describe("customMotionEntry", () => {
  it("matches the folder-scan overlay row for the same filename", () => {
    expect(customMotionEntry("spin.vrma")).toEqual(overlayFromVrmaFilenames(["spin.vrma"]).spin);
  });
});

describe("importPklMotion", () => {
  it("invokes import_pkl_motion and returns the overlay entry", async () => {
    const invoke = vi.fn(async () => ({
      id: "spin",
      fileName: "spin.vrma",
    })) as unknown as PklImportDeps["invoke"];
    const out = await importPklMotion("/tmp/spin.pkl", ["idle", "dance"], { invoke });
    expect(invoke).toHaveBeenCalledWith("import_pkl_motion", {
      srcPath: "/tmp/spin.pkl",
      reservedIds: ["idle", "dance"],
    });
    expect(out).toEqual({ id: "spin", entry: customMotionEntry("spin.vrma") });
  });
});
