import { describe, expect, it, vi } from "vitest";
import { registerRendererAndAmbientDisposal } from "./bootstrap-disposal";

describe("bootstrap disposal", () => {
  it("stops ambient before disposing the renderer", () => {
    const order: string[] = [];
    const register = (dispose: () => void) => {
      order.push("registered");
      disposers.push(dispose);
    };
    const disposers: Array<() => void> = [];
    const ambient = { stop: vi.fn(() => order.push("ambient")) };
    const renderer = { dispose: vi.fn(() => order.push("renderer")) };

    registerRendererAndAmbientDisposal(register, renderer, ambient);
    for (const dispose of disposers.reverse()) dispose();

    expect(ambient.stop).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(["registered", "registered", "ambient", "renderer"]);
  });
});
