import { describe, expect, it, vi } from "vitest";
import type { MotionRegistryEntry } from "../contract";
import type { BusEnvelope } from "../dispatcher/event-bus";
import {
  createPklDropSource,
  firstDancePath,
  isPklPath,
  isVideoPath,
  mapTauriDragDrop,
  PKL_CONVERT_MOTION,
  PKL_CONVERT_TOOL_ID,
  PKL_DROP_MOTION,
  PKL_FAIL_MOTION,
  type PklDragDropEvent,
  physicalDropToClient,
} from "./pkl-drop-source";
import { customMotionEntry } from "./pkl-import";

function entry(): MotionRegistryEntry {
  return customMotionEntry("spin.vrma");
}

function harness(opts?: {
  perched?: boolean;
  peeking?: boolean;
  importError?: boolean;
  whamBaseUrl?: string;
}) {
  const pushed: BusEnvelope[] = [];
  const bus = {
    push: vi.fn((env: BusEnvelope) => {
      pushed.push(env);
      return true;
    }),
  };
  const renderer = {
    hitTest: vi.fn(() => true),
    playMotion: vi.fn(),
    upsertMotion: vi.fn(),
    isPerched: vi.fn(() => opts?.perched ?? false),
    isPeeking: vi.fn(() => opts?.peeking ?? false),
  };
  const surfaces = {
    showTool: vi.fn(),
    finishTool: vi.fn(),
    hideTool: vi.fn(),
  };
  const importPkl = vi.fn(async () => {
    if (opts?.importError) throw new Error("conversion failed");
    return { id: "spin", entry: entry() };
  });
  const importVideo = vi.fn(async () => {
    if (opts?.importError) throw new Error("conversion failed");
    return { id: "spin", entry: entry() };
  });
  const reloadConfig = vi.fn(async () => true);
  const holdPointerCapture = vi.fn();
  const source = createPklDropSource({
    bus,
    renderer,
    surfaces,
    getReservedIds: () => ["idle", "dance"],
    importPkl,
    importVideo,
    getWhamUrl: () => opts?.whamBaseUrl ?? "http://127.0.0.1:8767",
    reloadConfig,
    holdPointerCapture,
    now: () => 1_700,
  });
  return { source, pushed, renderer, surfaces, importPkl, importVideo, reloadConfig, holdPointerCapture };
}

const pos = { x: 40, y: 80 };

function enter(paths: string[]): PklDragDropEvent {
  return { type: "enter", paths, position: pos };
}

function drop(paths: string[]): PklDragDropEvent {
  return { type: "drop", paths, position: pos };
}

describe("pkl path helpers", () => {
  it("accepts .pkl ignoring case and Windows separators", () => {
    expect(isPklPath("C:\\\\clips\\\\Spin.PKL")).toBe(true);
    expect(isPklPath("/tmp/clip.vrma")).toBe(false);
  });

  it("picks the first pkl or video path as a dance drop", () => {
    expect(isVideoPath("C:\\\\clips\\\\Dance.MP4")).toBe(true);
    expect(isVideoPath("/tmp/clip.mov")).toBe(true);
    expect(isVideoPath("/tmp/clip.webm")).toBe(false);
    expect(isVideoPath("/tmp/clip.vrma")).toBe(false);
    expect(firstDancePath(["/a.txt", "/b.mov"])).toBe("/b.mov");
    expect(firstDancePath(["/a.webm"])).toBeNull();
    expect(firstDancePath(["/a.mp4", "/b.pkl"])).toBe("/a.mp4");
    expect(firstDancePath(["/a.pkl", "/b.mp4"])).toBe("/a.pkl");
    expect(firstDancePath(["/a.txt"])).toBeNull();
  });
});

describe("createPklDropSource", () => {
  it("does not pose while a pkl is dragged over the window", () => {
    const { source, renderer } = harness();
    source.handleEvent(enter(["/tmp/spin.pkl"]));
    source.handleEvent({ type: "over", position: { x: 90, y: 120 } });
    expect(renderer.playMotion).not.toHaveBeenCalled();
    expect(renderer.hitTest).not.toHaveBeenCalled();
  });

  it("does not pose when Explorer withholds paths on enter", () => {
    const { source, renderer } = harness();
    source.handleEvent({ type: "enter", paths: [], position: pos });
    expect(renderer.playMotion).not.toHaveBeenCalled();
  });

  it("keeps a perched pose until a silhouette drop installs the dance", async () => {
    const { source, renderer } = harness({ perched: true });
    source.handleEvent(enter(["/tmp/spin.pkl"]));
    expect(renderer.playMotion).not.toHaveBeenCalled();
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await vi.waitFor(() => expect(renderer.upsertMotion).toHaveBeenCalled());
    expect(renderer.playMotion).not.toHaveBeenCalledWith({ id: PKL_DROP_MOTION });
    expect(renderer.playMotion).toHaveBeenCalledWith({ id: "spin" });
  });

  it("keeps a peeking pose until a silhouette drop installs the dance", async () => {
    const { source, renderer } = harness({ peeking: true });
    source.handleEvent(enter(["/tmp/spin.pkl"]));
    expect(renderer.playMotion).not.toHaveBeenCalled();
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await vi.waitFor(() => expect(renderer.upsertMotion).toHaveBeenCalled());
    expect(renderer.playMotion).not.toHaveBeenCalledWith({ id: PKL_DROP_MOTION });
    expect(renderer.playMotion).toHaveBeenCalledWith({ id: "spin" });
  });

  it("does not convert a drop that misses the silhouette", async () => {
    const { source, renderer, importPkl } = harness();
    renderer.hitTest.mockReturnValue(false);
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await Promise.resolve();
    expect(importPkl).not.toHaveBeenCalled();
  });

  it("converts a pkl drop, shows the chip, plays the drop pose then the new dance", async () => {
    const { source, renderer, surfaces, importPkl, importVideo, pushed, reloadConfig } = harness();
    source.handleEvent(drop(["/tmp/note.txt", "/tmp/spin.pkl"]));
    await vi.waitFor(() => expect(importPkl).toHaveBeenCalled());
    expect(surfaces.showTool).toHaveBeenCalledWith(PKL_CONVERT_TOOL_ID);
    expect(renderer.playMotion).toHaveBeenCalledWith({ id: PKL_DROP_MOTION });
    expect(importPkl).toHaveBeenCalledWith("/tmp/spin.pkl", ["idle", "dance"]);
    expect(importVideo).not.toHaveBeenCalled();
    expect(renderer.upsertMotion).toHaveBeenCalledWith("spin", entry());
    expect(renderer.playMotion).toHaveBeenLastCalledWith({ id: "spin" });
    expect(surfaces.finishTool).toHaveBeenCalled();
    expect(reloadConfig).toHaveBeenCalled();
    expect(pushed).toEqual([
      expect.objectContaining({
        event_name: "proactive.pkl_dance",
        hint_tier: 2,
        dnd_override: true,
        payload: {
          cue_id: "pkl_dance",
          label: "new dance from a dropped motion capture",
          context: "installed as motion_id spin; now playing",
        },
      }),
    ]);
  });

  it("converts a video drop through WHAM instead of the local pkl converter", async () => {
    const { source, importPkl, importVideo, renderer, surfaces } = harness();
    source.handleEvent(drop(["/tmp/spin.mp4"]));
    await vi.waitFor(() => expect(renderer.playMotion).toHaveBeenLastCalledWith({ id: "spin" }));
    expect(importPkl).not.toHaveBeenCalled();
    expect(importVideo).toHaveBeenCalledWith("/tmp/spin.mp4", ["idle", "dance"]);
    expect(surfaces.showTool).toHaveBeenCalledWith(PKL_CONVERT_TOOL_ID);
  });

  it("does not learn from a video drop when WHAM is unset", async () => {
    const { source, importPkl, importVideo, renderer, surfaces, pushed } = harness({
      whamBaseUrl: "  ",
    });
    source.handleEvent(drop(["/tmp/spin.mp4"]));
    await Promise.resolve();
    expect(importVideo).not.toHaveBeenCalled();
    expect(importPkl).not.toHaveBeenCalled();
    expect(surfaces.showTool).not.toHaveBeenCalled();
    expect(renderer.playMotion).not.toHaveBeenCalled();
    expect(pushed).toEqual([]);
  });

  it("still converts a pkl drop when WHAM is unset", async () => {
    const { source, importPkl, importVideo } = harness({ whamBaseUrl: "" });
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await vi.waitFor(() => expect(importPkl).toHaveBeenCalled());
    expect(importVideo).not.toHaveBeenCalled();
  });

  it("switches to the converting loop when import is still running", async () => {
    let runConvertPose = () => {};
    let release: () => void = () => {};
    const pending = new Promise<{ id: string; entry: MotionRegistryEntry }>((resolve) => {
      release = () => resolve({ id: "spin", entry: entry() });
    });
    const { renderer, surfaces, importPkl, reloadConfig } = harness();
    importPkl.mockImplementation(() => pending);
    const source = createPklDropSource({
      bus: { push: vi.fn(() => true) },
      renderer,
      surfaces,
      getReservedIds: () => ["idle", "dance"],
      importPkl,
      reloadConfig,
      scheduleConvertPose: (fn) => {
        runConvertPose = fn;
        return () => {
          runConvertPose = () => {};
        };
      },
    });
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    expect(renderer.playMotion).toHaveBeenCalledWith({ id: PKL_DROP_MOTION });
    expect(surfaces.showTool).toHaveBeenCalledWith(PKL_CONVERT_TOOL_ID);
    runConvertPose();
    expect(renderer.playMotion).toHaveBeenCalledWith({ id: PKL_CONVERT_MOTION, loop: true });
    release();
    await pending;
    expect(renderer.playMotion).toHaveBeenLastCalledWith({ id: "spin" });
  });

  it("keeps a perched pose through convert and plays the dance after", async () => {
    const { source, renderer, surfaces } = harness({ perched: true });
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await vi.waitFor(() => expect(renderer.upsertMotion).toHaveBeenCalled());
    expect(surfaces.showTool).toHaveBeenCalledWith(PKL_CONVERT_TOOL_ID);
    expect(renderer.playMotion).not.toHaveBeenCalledWith({ id: PKL_DROP_MOTION });
    expect(renderer.playMotion).not.toHaveBeenCalledWith({ id: PKL_CONVERT_MOTION, loop: true });
    expect(renderer.playMotion).toHaveBeenCalledWith({ id: "spin" });
  });

  it("plays sheepish and hides the chip when conversion fails", async () => {
    const { source, renderer, surfaces, pushed } = harness({ importError: true });
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await vi.waitFor(() =>
      expect(renderer.playMotion).toHaveBeenCalledWith({ id: PKL_FAIL_MOTION }),
    );
    expect(surfaces.hideTool).toHaveBeenCalled();
    expect(surfaces.finishTool).not.toHaveBeenCalled();
    expect(pushed).toEqual([]);
  });

  it("ignores a second drop while conversion is in flight", async () => {
    let release: () => void = () => {};
    const pending = new Promise<{ id: string; entry: MotionRegistryEntry }>((resolve) => {
      release = () => resolve({ id: "spin", entry: entry() });
    });
    const { source, importPkl } = harness();
    importPkl.mockImplementation(() => pending);
    source.handleEvent(drop(["/tmp/a.pkl"]));
    source.handleEvent(drop(["/tmp/b.pkl"]));
    expect(importPkl).toHaveBeenCalledTimes(1);
    release();
    await pending;
  });

  it("holds pointer capture for the file-drag and releases on leave", () => {
    const { source, holdPointerCapture, renderer } = harness();
    source.handleEvent(enter(["/tmp/spin.pkl"]));
    expect(holdPointerCapture).toHaveBeenCalledWith(true);
    expect(renderer.playMotion).not.toHaveBeenCalled();
    holdPointerCapture.mockClear();
    source.handleEvent({ type: "leave" });
    expect(holdPointerCapture).toHaveBeenCalledWith(false);
  });

  it("releases pointer capture when conversion starts", async () => {
    const { source, holdPointerCapture } = harness();
    source.handleEvent(enter(["/tmp/spin.pkl"]));
    holdPointerCapture.mockClear();
    source.handleEvent(drop(["/tmp/spin.pkl"]));
    await vi.waitFor(() => expect(holdPointerCapture).toHaveBeenCalledWith(false));
  });

  it("holds pointer capture while a system file-drag is over the window", async () => {
    let send: (state: { over_window: boolean }) => void = () => {};
    const { holdPointerCapture, renderer, surfaces, importPkl, reloadConfig } = harness();
    const source = createPklDropSource({
      bus: { push: vi.fn(() => true) },
      renderer,
      surfaces,
      getReservedIds: () => [],
      importPkl,
      reloadConfig,
      holdPointerCapture,
      listenDragDrop: () => () => {},
      listenFileDrag: (handler) => {
        send = handler;
        return () => {};
      },
    });
    await source.start();
    send({ over_window: true });
    expect(holdPointerCapture).toHaveBeenCalledWith(true);
    expect(renderer.playMotion).not.toHaveBeenCalled();
    holdPointerCapture.mockClear();
    send({ over_window: false });
    expect(holdPointerCapture).toHaveBeenCalledWith(false);
    source.stop();
  });
});

describe("Tauri drop coordinates", () => {
  it("divides physical px by the window scale factor", () => {
    expect(physicalDropToClient({ x: 80, y: 160 }, 2)).toEqual({ x: 40, y: 80 });
    expect(physicalDropToClient({ x: 40, y: 80 }, 0)).toEqual({ x: 40, y: 80 });
  });

  it("maps enter/drop into CSS client space", () => {
    expect(
      mapTauriDragDrop({ type: "enter", paths: ["/tmp/spin.pkl"], position: { x: 80, y: 160 } }, 2),
    ).toEqual({
      type: "enter",
      paths: ["/tmp/spin.pkl"],
      position: { x: 40, y: 80 },
    });
  });

  it("maps enter without paths so a later drop can still carry CF_HDROP", () => {
    expect(mapTauriDragDrop({ type: "enter", position: { x: 80, y: 160 } }, 2)).toEqual({
      type: "enter",
      paths: [],
      position: { x: 40, y: 80 },
    });
  });
});

describe("webview navigation", () => {
  it("prevents the webview from navigating on dragover and drop", async () => {
    const listeners = new Map<string, (e: Event) => void>();
    const nav = {
      addEventListener(type: string, listener: (e: Event) => void) {
        listeners.set(type, listener);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    };
    const importPkl = vi.fn(async () => ({ id: "spin", entry: entry() }));
    const wired = createPklDropSource({
      bus: { push: vi.fn(() => true) },
      renderer: {
        hitTest: vi.fn(() => true),
        playMotion: vi.fn(),
        upsertMotion: vi.fn(),
        isPerched: vi.fn(() => false),
        isPeeking: vi.fn(() => false),
      },
      surfaces: { showTool: vi.fn(), finishTool: vi.fn(), hideTool: vi.fn() },
      getReservedIds: () => ["idle"],
      importPkl,
      listenDragDrop: () => () => {},
      preventNavigation: nav,
    });
    await wired.start();
    const preventDefault = vi.fn();
    listeners.get("dragover")!({ preventDefault } as unknown as Event);
    listeners.get("drop")!({ preventDefault } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(importPkl).not.toHaveBeenCalled();
    wired.stop();
  });
});
