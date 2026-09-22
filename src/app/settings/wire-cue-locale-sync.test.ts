import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "../../ui/i18n";
import { wireCueLocaleSync } from "./wire-cue-locale-sync";

const unsubscribe = vi.fn();
let listener: ((locale: Locale, previous: Locale) => void) | undefined;

vi.mock("../../ui/i18n", () => ({
  subscribe: vi.fn((fn: (locale: Locale, previous: Locale) => void) => {
    listener = fn;
    return unsubscribe;
  }),
}));

describe("wireCueLocaleSync", () => {
  beforeEach(() => {
    listener = undefined;
    unsubscribe.mockClear();
  });

  it("syncs both cue stores from the previous locale to the new one", () => {
    const proactiveSettings = { syncLocale: vi.fn() };
    const scheduleSettings = { syncLocale: vi.fn() };
    const dispose = wireCueLocaleSync({ proactiveSettings, scheduleSettings });

    listener?.("en", "ko");

    expect(proactiveSettings.syncLocale).toHaveBeenCalledWith("ko", "en");
    expect(scheduleSettings.syncLocale).toHaveBeenCalledWith("ko", "en");
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
