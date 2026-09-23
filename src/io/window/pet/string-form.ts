/**
 * string-form — "让一下": walk to the nearer screen edge.
 *
 * She walks to the nearer screen edge. A gap that fits her stays standing.
 * A gap that does not is flattened for the last stretch, which moves on its
 * own so the paper form is seen walking. The phrase match is a body command.
 * What she says stays on the chat turn the input already sent.
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
  | {
      kind: "walk-then-flatten";
      side: YieldSide;
      /** Window origin where a standing body meets the narrow gap. */
      standToX: number;
      /** Window origin with her center on the screen edge. */
      flatToX: number;
    };

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

function originFor(bodyX: number, anchorX: number): number {
  return Math.round(bodyX - anchorX);
}

/**
 * A gap that fits a body is walked standing, and she stops there in 3D.
 * A narrower gap is walked standing until `flattenLeadPx` remains, then that
 * last stretch is a paper slide. Origins are the pet window's logical x.
 */
export function planYield(input: {
  bodyX: number;
  bodyWidth: number;
  anchorX: number;
  /** How far before the screen edge the body flattens, logical px. */
  flattenLeadPx: number;
  monitor: EdgeSpan;
  window: EdgeSpan | null;
}): YieldAction {
  const side = nearerSide(input.bodyX, input.monitor);
  const gap = edgeGap(side, input.monitor, input.window);
  const edgeX = side === "left" ? input.monitor.x : input.monitor.x + input.monitor.width;
  const standAtEdge =
    side === "left"
      ? input.monitor.x + input.bodyWidth / 2
      : input.monitor.x + input.monitor.width - input.bodyWidth / 2;
  if (gap >= input.bodyWidth) {
    return { kind: "walk", side, toX: originFor(standAtEdge, input.anchorX) };
  }
  const standBody = side === "left" ? edgeX + input.flattenLeadPx : edgeX - input.flattenLeadPx;
  const beforeLead = side === "left" ? input.bodyX > standBody : input.bodyX < standBody;
  return {
    kind: "walk-then-flatten",
    side,
    standToX: originFor(beforeLead ? standBody : input.bodyX, input.anchorX),
    flatToX: originFor(edgeX, input.anchorX),
  };
}

export interface StringFormConfig {
  phrase: string;
  body_width_px: number;
  scale_x: number;
  /** Last stretch walked as paper, logical px. */
  flatten_lead_px: number;
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
  walkTo: (toX: number, opts?: { clamp?: boolean }) => Promise<"arrived" | "lost">;
  /** Window origin in logical px. */
  readPose: () => Promise<{ x: number; y: number }>;
  moveTo: (x: number, y: number) => Promise<void>;
  /** Keep the walk clip playing under the paper slide. */
  playWalk: () => void;
  onFrame: (fn: (dt: number) => void) => () => void;
  setFlat: (scaleX: number | null) => void;
  /** Keep the off-screen guard from pulling a paper body back onto the monitor. */
  holdEdge?: (held: boolean) => void;
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
    deps.holdEdge?.(false);
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
      flattenLeadPx: cfg.flatten_lead_px,
      monitor: measured.monitor,
      window: measured.window,
    });
    if (gen !== generation) return;
    if (action.kind === "walk") {
      clearFlat();
      try {
        await deps.walkTo(action.toX);
      } catch {
        return;
      }
      return;
    }
    clearFlat();
    const originX = measured.bodyX - measured.anchorX;
    if (Math.round(originX) !== action.standToX) {
      let stood: "arrived" | "lost";
      try {
        stood = await deps.walkTo(action.standToX);
      } catch {
        return;
      }
      if (gen !== generation || stood === "lost") return;
    }
    flatSide = action.side;
    deps.setFlat(cfg.scale_x);
    deps.holdEdge?.(true);
    deps.playWalk();
    const outcome = await slideToEdge(gen, action.flatToX);
    if (gen !== generation || outcome === "lost") {
      clearFlat();
      return;
    }
    armPoll();
  }

  /** Paper travel. Independent of the floor walk, which stops at the monitor edge. */
  async function slideToEdge(gen: number, toX: number): Promise<"arrived" | "lost"> {
    const speed = 180;
    let pose: { x: number; y: number };
    try {
      pose = await deps.readPose();
    } catch {
      return "lost";
    }
    if (gen !== generation) return "lost";
    let x = pose.x;
    const y = pose.y;
    if (x === toX) return "arrived";
    return new Promise((resolve) => {
      const stop = deps.onFrame((dt) => {
        if (gen !== generation) {
          stop();
          resolve("lost");
          return;
        }
        const step = speed * Math.min(Math.max(dt, 0), 0.05);
        const remain = toX - x;
        x = Math.abs(remain) <= step ? toX : x + Math.sign(remain) * step;
        void deps.moveTo(x, y).catch(() => {
          stop();
          resolve("lost");
        });
        if (x === toX) {
          stop();
          resolve("arrived");
        }
      });
    });
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
