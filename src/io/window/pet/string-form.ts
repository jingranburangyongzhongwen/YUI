/**
 * string-form — "让一下": walk to the nearer screen edge, or flatten there.
 *
 * The phrase match and the edge choice are body commands. What she says about
 * the request stays on the chat turn the input already sent.
 */

export interface EdgeSpan {
  x: number;
  width: number;
}

export interface ScreenRectLite {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type YieldSide = "left" | "right";

export type YieldAction =
  | { kind: "walk"; side: YieldSide; toX: number }
  | { kind: "flatten"; side: YieldSide; toX: number };

export interface YieldMeasure {
  /** Character center, logical px. */
  bodyX: number;
  /** Character center's offset inside the pet window, logical px. */
  anchorX: number;
  /** Live standing width. Absent → the configured body width. */
  bodyWidth?: number;
  monitor: EdgeSpan;
  /** Frontmost window overlapping the monitor, or null when nothing blocks it. */
  window: EdgeSpan | null;
}

/** Trimmed text is the configured phrase and nothing else. */
export function isYieldPhrase(text: string, phrase: string): boolean {
  const want = phrase.trim();
  return want.length > 0 && text.trim() === want;
}

/** The screen edge closer to her. A tie prefers the left edge. */
export function nearerSide(bodyX: number, monitor: EdgeSpan): YieldSide {
  const distLeft = bodyX - monitor.x;
  const distRight = monitor.x + monitor.width - bodyX;
  return distLeft <= distRight ? "left" : "right";
}

/**
 * Horizontal room between the screen edge and the frontmost window.
 * No window means the whole monitor is open.
 */
export function edgeGap(side: YieldSide, monitor: EdgeSpan, window: EdgeSpan | null): number {
  if (!window) return monitor.width;
  if (side === "left") return Math.max(0, window.x - monitor.x);
  return Math.max(0, monitor.x + monitor.width - (window.x + window.width));
}

/** First window, front to back, that overlaps the work area. */
export function blockingWindow<T extends ScreenRectLite>(
  windows: readonly T[],
  area: ScreenRectLite,
): T | null {
  return (
    windows.find(
      (win) =>
        win.x < area.x + area.width &&
        win.x + win.width > area.x &&
        win.y < area.y + area.height &&
        win.y + win.height > area.y,
    ) ?? null
  );
}

/**
 * Walk when the nearer gap fits a standing body; otherwise park her center on
 * that screen edge so a flattened body can sit in the gap. `toX` is the pet
 * window's logical origin.
 */
export function planYield(input: {
  bodyX: number;
  bodyWidth: number;
  anchorX: number;
  monitor: EdgeSpan;
  window: EdgeSpan | null;
}): YieldAction {
  const side = nearerSide(input.bodyX, input.monitor);
  const gap = edgeGap(side, input.monitor, input.window);
  const edgeX = side === "left" ? input.monitor.x : input.monitor.x + input.monitor.width;
  const targetBodyX =
    gap >= input.bodyWidth
      ? side === "left"
        ? input.monitor.x + input.bodyWidth / 2
        : input.monitor.x + input.monitor.width - input.bodyWidth / 2
      : edgeX;
  return {
    kind: gap >= input.bodyWidth ? "walk" : "flatten",
    side,
    toX: Math.round(targetBodyX - input.anchorX),
  };
}

export interface StringFormConfig {
  phrase: string;
  body_width_px: number;
  scale_x: number;
  poll_ms: number;
}

export interface StringForm {
  onText(text: string): void;
  noteDrag(): void;
  isFlat(): boolean;
  stop(): void;
}

export function createStringForm(deps: {
  getConfig: () => StringFormConfig;
  canYield: () => boolean;
  measure: () => Promise<YieldMeasure | null>;
  walkTo: (toX: number) => Promise<"arrived" | "lost">;
  moveTo: (toX: number) => Promise<void>;
  setFlat: (scaleX: number | null) => void;
  schedule: (ms: number, fn: () => void) => () => void;
}): StringForm {
  let generation = 0;
  let flatSide: YieldSide | null = null;
  let cancelPoll: (() => void) | null = null;

  function clearFlat(): void {
    cancelPoll?.();
    cancelPoll = null;
    if (flatSide === null) return;
    flatSide = null;
    deps.setFlat(null);
  }

  function armPoll(): void {
    cancelPoll?.();
    cancelPoll = deps.schedule(deps.getConfig().poll_ms, () => {
      void unfoldIfRoom();
    });
  }

  async function unfoldIfRoom(): Promise<void> {
    const side = flatSide;
    if (side === null) return;
    let measured: YieldMeasure | null;
    try {
      measured = await deps.measure();
    } catch {
      return;
    }
    if (flatSide !== side || !measured) return;
    const cfg = deps.getConfig();
    const width = measured.bodyWidth ?? cfg.body_width_px;
    if (edgeGap(side, measured.monitor, measured.window) >= width) clearFlat();
  }

  async function run(gen: number): Promise<void> {
    let measured: YieldMeasure | null;
    try {
      measured = await deps.measure();
    } catch {
      return;
    }
    if (gen !== generation || !measured || !deps.canYield()) return;
    const cfg = deps.getConfig();
    const action = planYield({
      bodyX: measured.bodyX,
      anchorX: measured.anchorX,
      bodyWidth: measured.bodyWidth ?? cfg.body_width_px,
      monitor: measured.monitor,
      window: measured.window,
    });
    if (gen !== generation) return;
    try {
      if (action.kind === "walk") {
        clearFlat();
        await deps.walkTo(action.toX);
        return;
      }
      await deps.moveTo(action.toX);
    } catch {
      return;
    }
    if (gen !== generation) return;
    flatSide = action.side;
    deps.setFlat(cfg.scale_x);
    armPoll();
  }

  return {
    onText(text) {
      if (!isYieldPhrase(text, deps.getConfig().phrase)) return;
      if (!deps.canYield()) return;
      const gen = ++generation;
      void run(gen);
    },
    noteDrag() {
      generation += 1;
      clearFlat();
    },
    isFlat: () => flatSide !== null,
    stop() {
      generation += 1;
      clearFlat();
    },
  };
}
