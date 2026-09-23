import { describe, expect, it } from "vitest";
import type { BusEnvelope } from "./event-bus";
import { selfStartWhileTucked } from "./classify";

function env(event_name: string): BusEnvelope {
  return { source: "timer_scheduler", event_name, ts: 0 };
}

describe("selfStartWhileTucked", () => {
  it("drops a proactive fire while she is paper and keeps a typed turn", () => {
    expect(selfStartWhileTucked(true, env("proactive.idle"))).toBe(true);
    expect(selfStartWhileTucked(true, env("user.text_submitted"))).toBe(false);
    expect(selfStartWhileTucked(false, env("proactive.idle"))).toBe(false);
  });
});
