import { describe, expect, it, vi } from "vitest";
import { overlayFromVrmaFilenames } from "../../scripts/custom-motions.mjs";
import { customMotionEntry, importPklMotion, importVideoMotion, type PklImportDeps } from "./pkl-import";

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

describe("importVideoMotion", () => {
  it("invokes import_video_motion with the WHAM URL and returns the overlay entry", async () => {
    const invoke = vi.fn(async () => ({
      id: "spin",
      fileName: "spin.vrma",
    })) as unknown as PklImportDeps["invoke"];
    const out = await importVideoMotion("/tmp/spin.mp4", ["idle", "dance"], {
      invoke,
      getWhamUrl: () => "http://127.0.0.1:8767",
    });
    expect(invoke).toHaveBeenCalledWith("import_video_motion", {
      srcPath: "/tmp/spin.mp4",
      reservedIds: ["idle", "dance"],
      whamBaseUrl: "http://127.0.0.1:8767",
    });
    expect(out).toEqual({ id: "spin", entry: customMotionEntry("spin.vrma") });
  });

  it("does not invoke when WHAM is unset", async () => {
    const invoke = vi.fn();
    await expect(
      importVideoMotion("/tmp/spin.mp4", [], {
        invoke: invoke as unknown as PklImportDeps["invoke"],
        getWhamUrl: () => "  ",
      }),
    ).rejects.toThrow("wham not configured");
    expect(invoke).not.toHaveBeenCalled();
  });
});
