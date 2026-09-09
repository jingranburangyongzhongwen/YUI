import { describe, expect, it } from "vitest";

import { cargoOnPath, resolveCliScript } from "../scripts/spawn-local.mjs";

describe("resolveCliScript", () => {
  it("resolves the Tauri CLI entry", () => {
    expect(resolveCliScript("@tauri-apps/cli", "tauri.js")).toMatch(/tauri\.js$/);
  });

  it("resolves the Vite CLI entry", () => {
    expect(resolveCliScript("vite", "bin/vite.js")).toMatch(/vite\.js$/);
  });
});

describe("cargoOnPath", () => {
  it("returns a boolean", () => {
    expect(typeof cargoOnPath()).toBe("boolean");
  });
});
