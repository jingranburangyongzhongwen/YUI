/** Composes the travel frame, the five locomotion loops and the window sources into one handle. */
import {
  CLIMB_DOWN_LANDING_MOTION_ID,
  CLIMB_DOWN_MOTION_ID,
  CLIMB_UP_DONE_MOTION_ID,
  CLIMB_UP_MOTION_ID,
} from "../../ambient/locomotion/climber";
import { FALL_MOTION_ID, LAND_MOTION_ID } from "../../ambient/locomotion/faller";
import { createSitter, type Sitter } from "../../ambient/locomotion/sitter";
import { onFloor, WALK_MOTION_ID } from "../../ambient/locomotion/walker";
import {
  wireClimber,
  wireFaller,
  wireLeaveSeatThenPlay,
  wirePercher,
  wireRootMover,
  wireStrollReflexCancel,
  wireTravelFrame,
  wireWalker,
} from "../../ambient/locomotion/wire";
import type { AppConfig, DescendConfig, FallConfig } from "../../config/load";
import type { WindowRect } from "../../contract";
import type { EventBus } from "../../dispatcher/core/event-bus";
import type { Dispatcher } from "../../dispatcher/dispatcher";
import type { createVrmSelection } from "../../io/assets/vrm-selection";
import {
  type DescentEdge,
  floorPx,
  logicalWorkArea,
  monitorAt,
  toScreenMonitor,
} from "../../io/window/geometry/screen-geometry";
import type { HitTestController } from "../../io/window/pet/hit-test";
import {
  blockingWindow,
  createStringForm,
  type YieldMeasure,
} from "../../io/window/pet/string-form";
import type { Logger } from "../../logger";
import type { Renderer } from "../../renderer";
import type { createAgentNotifySettings } from "../../settings/backend/agent-notify-settings";
import type { FlagSettingsStore } from "../../settings/persisted-store";
import { wireWindowSources } from "../turn/wire-sources";

/** With the fall off, a perched stroll never steps off the ledge: nothing would catch her. */
export function fallConfigFor(fall: FallConfig, enabled: boolean): FallConfig {
  return enabled ? fall : { ...fall, step_off_probability: 0 };
}

/** With the fall off, a monitor descent always climbs down: nothing would catch a drop. */
export function descendConfigFor(descend: DescendConfig, enabled: boolean): DescendConfig {
  return enabled ? descend : { ...descend, climb_down_chance: 1 };
}

/**
 * The fall a lost sit starts. A descent still inside its window survey resumes on a stale
 * list and moves the window from under the faller, so the climb lets go before the drop.
 */
export function createSitLossFall(deps: {
  getClimber: () => { cancel(): void } | null;
  faller: { drop(): Promise<void> };
}): () => void {
  return () => {
    deps.getClimber()?.cancel();
    void deps.faller.drop();
  };
}

export function wireLocomotion(deps: {
  bus: EventBus;
  renderer: Renderer;
  getConfig: () => AppConfig;
  dispatcher: Dispatcher;
  hitTest: Pick<HitTestController, "setMoving">;
  peekActive: () => boolean;
  fallSettings: FlagSettingsStore;
  climbSettings: FlagSettingsStore;
  agentNotifySettings: ReturnType<typeof createAgentNotifySettings>;
  vrmSelection: Pick<ReturnType<typeof createVrmSelection>, "getActive">;
  onStrollEnd: (bodyReleased: boolean) => void;
  register: (teardown: () => void) => void;
  log: Logger;
  /** She became a paper strip, or stood back up. */
  onFlat?: (flat: boolean) => void;
}): {
  walker: { isStrolling(): boolean };
  sitter: Sitter;
  dropSource: { noteUserDrag(): void; noteUserDragEnd(): void };
  setDragging(dragging: boolean): void;
  /** Typed step-aside. No-op unless the phrase matches and she is free on the floor. */
  yieldOnText(text: string): void;
  /** Cancels the five loops in the order a drag start and an agent move cancel them. */
  cancel(): void;
  abortTravel(): Promise<void>;
} {
  const {
    bus,
    renderer,
    getConfig,
    dispatcher,
    hitTest,
    peekActive,
    fallSettings,
    climbSettings,
    agentNotifySettings,
    vrmSelection,
    onStrollEnd,
    register,
    log,
  } = deps;

  // Set once the drop source exists — the travel frame pauses its keep-on-screen guard
  // while it parks the window itself.
  let windowSourcesRef: { setKeepOnScreenPaused(paused: boolean): void } | null = null;
  const travelFrame = wireTravelFrame({
    renderer,
    setKeepOnScreenPaused: (paused) => windowSourcesRef?.setKeepOnScreenPaused(paused),
    log,
  });
  register(travelFrame.dispose);

  // Ambient walking outranks nothing: a drag, an agent command or a reflex turn cancels a
  // stroll at once; an ordinary turn walks on.
  let dragging = false;
  let stringFlat = false;
  const yieldBlocked = new Set([
    FALL_MOTION_ID,
    LAND_MOTION_ID,
    CLIMB_UP_MOTION_ID,
    CLIMB_UP_DONE_MOTION_ID,
    CLIMB_DOWN_MOTION_ID,
    CLIMB_DOWN_LANDING_MOTION_ID,
  ]);
  const bodyYields = (): boolean => peekActive() || stringFlat;
  let climberRef: { cancel(): void; descend(edge: DescentEdge): Promise<void> } | null = null;
  const walker = wireWalker({
    bus,
    renderer,
    travelFrame,
    getWalkConfig: () => getConfig().avatar.walk,
    getDescendConfig: () => getConfig().avatar.descend,
    getMotionKind: (id) => getConfig().motions[id]?.kind,
    isPeeking: bodyYields,
    isDragging: () => dragging,
    setHitTestMoving: (moving) => hitTest.setMoving(moving),
    onStrollEnd,
    onDescend: (edge) => climberRef?.descend(edge),
    log,
  });
  register(walker.dispose);
  register(wireStrollReflexCancel({ dispatcher, walker }));

  const rootMover = wireRootMover({
    renderer,
    isDragging: () => dragging,
    isPeeking: bodyYields,
    isHeld: () => walker.isWalkingTo() || travelFrame.travel.current() != null,
    setHitTestMoving: (moving) => hitTest.setMoving(moving),
    log,
  });
  register(rootMover.dispose);

  // Set once each loop exists — the drop source and the faller are built before them.
  let percherRef: { cancel(): void; landOn(target: WindowRect): void } | null = null;

  // The seat transitions every seat entry and voluntary exit plays; one body, one sitter.
  const sitter = createSitter({
    renderer,
    currentMotionKind: () => {
      const current = renderer.getCurrentMotion();
      return current ? (getConfig().motions[current.id]?.kind ?? null) : null;
    },
  });
  sitter.start();
  register(sitter.stop);

  // A character left mid-air drops to the first surface below her; the user outranks it.
  const faller = wireFaller({
    bus,
    renderer,
    travelFrame,
    isEnabled: () => fallSettings.get().enabled,
    getFallConfig: () => getConfig().avatar.fall,
    getMotionKind: (id) => getConfig().motions[id]?.kind,
    getFloorTolerancePx: () => getConfig().avatar.walk.floor_tolerance_px,
    getGestureCues: () => getConfig().avatar.gesture_cues,
    setHitTestMoving: (moving) => hitTest.setMoving(moving),
    onWindowLand: (target) => percherRef?.landOn(target),
    log,
  });
  register(faller.dispose);

  const windowSources = wireWindowSources({
    bus,
    renderer,
    peekActive: () => peekActive(),
    getPeekConfig: () => getConfig().avatar.peek,
    getGestureCues: () => getConfig().avatar.gesture_cues,
    agentNotifySettings,
    getPosture: () => dispatcher.getPosture(),
    getVrm: () => {
      const active = vrmSelection.getActive();
      return { id: active.id, label: active.label ?? active.id };
    },
    noteAvatarMoved: () => dispatcher.noteAvatarMoved(),
    noteAgentMove: () => {
      walker.cancel();
      rootMover.cancel();
      faller.cancel();
      climberRef?.cancel();
      percherRef?.cancel();
      sitter.cancel();
      // A cancelled climb or stroll may still be unparking its travel.
      return travelFrame.abort();
    },
    onDragMiss: () => faller.drop({ landOnSeam: true }),
    onSitLost: createSitLossFall({ getClimber: () => climberRef, faller }),
    sitDown: () => sitter.sitDown(null),
    log,
  });
  windowSourcesRef = windowSources;
  register(windowSources.dispose);

  let leaveSeatBusy = false;
  const percher = wirePercher({
    bus,
    renderer,
    getPerchWalkConfig: () => getConfig().avatar.perch_walk,
    getJumpConfig: () => getConfig().avatar.jump,
    getFallConfig: () => fallConfigFor(getConfig().avatar.fall, fallSettings.get().enabled),
    getMotionKind: (id) => getConfig().motions[id]?.kind,
    isBusy: () => dispatcher.isPipelineBusy() || leaveSeatBusy,
    walker,
    sitter,
    dropSource: windowSources,
    onHostLost: () => faller.drop(),
    // A jump that loses its target leaves her mid-air, the same as a lost host does.
    onTargetLost: () => faller.drop(),
    // She walked past the edge on purpose; the drop is what she walked off for.
    onStepOff: () => faller.drop(),
    setHitTestMoving: (moving) => hitTest.setMoving(moving),
    log,
  });
  percherRef = percher;
  register(percher.dispose);
  register(
    wireLeaveSeatThenPlay({
      bus,
      renderer,
      sitter,
      dropSource: windowSources,
      cancelPercher: () => percherRef?.cancel(),
      onHostLost: () => faller.drop(),
      setBusy: (busy) => {
        leaveSeatBusy = busy;
      },
      log,
    }),
  );

  // Ambient climbing: a wall now and then, a sit on top, then back down to the floor.
  const climber = wireClimber({
    bus,
    renderer,
    travelFrame,
    getClimbConfig: () => getConfig().avatar.climb,
    getDescendConfig: () =>
      descendConfigFor(getConfig().avatar.descend, fallSettings.get().enabled),
    getFallConfig: () => getConfig().avatar.fall,
    getWalkConfig: () => getConfig().avatar.walk,
    getMotionKind: (id) => getConfig().motions[id]?.kind,
    isPeeking: bodyYields,
    isDragging: () => dragging,
    isBusy: () => dispatcher.isPipelineBusy() || leaveSeatBusy,
    walker,
    faller,
    sitter,
    dropSource: windowSources,
    setHitTestMoving: (moving) => hitTest.setMoving(moving),
    log,
  });
  climberRef = climber;
  climber.setEnabled(climbSettings.get().enabled);
  register(climbSettings.subscribe((state) => climber.setEnabled(state.enabled)));
  register(climber.dispose);

  async function measureYield(): Promise<YieldMeasure | null> {
    const anchor = renderer.getCharacterAnchor();
    if (!anchor) return null;
    const win = travelFrame.getWindow();
    const { invoke } = await import("@tauri-apps/api/core");
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const [pos, sf, monitors, windows] = await Promise.all([
      win.outerPosition(),
      win.scaleFactor(),
      availableMonitors().then((list) => list.map(toScreenMonitor)),
      invoke<WindowRect[]>("list_windows"),
    ]);
    const scale = sf > 0 ? sf : 1;
    const originX = pos.x / scale;
    const originY = pos.y / scale;
    const monitor = monitorAt(monitors, pos.x, pos.y);
    if (!monitor) return null;
    const tolerance = getConfig().avatar.walk.floor_tolerance_px;
    if (!onFloor(originY + anchor.y, floorPx(monitor), tolerance)) return null;
    const work = logicalWorkArea(monitor);
    const blocking = blockingWindow(windows, work);
    const liveWidth = renderer.getCharacterWidthPx();
    return {
      bodyX: originX + anchor.x,
      anchorX: anchor.x,
      ...(liveWidth !== null && liveWidth > 0 ? { bodyWidth: liveWidth } : {}),
      monitor: { x: work.x, width: work.width },
      window: blocking ? { x: blocking.x, width: blocking.width } : null,
    };
  }

  const stringForm = createStringForm({
    getConfig: () => getConfig().avatar.string_form,
    canYield: () => {
      if (dragging || peekActive() || renderer.isPerched() || renderer.isPeeking()) return false;
      if (dispatcher.getPosture().state !== "standing") return false;
      if (walker.isStrolling() || walker.isWalkingTo()) return false;
      const id = renderer.getCurrentMotion()?.id;
      return id === undefined || !yieldBlocked.has(id);
    },
    measure: measureYield,
    walkTo: (toX, opts) => walker.walkTo(toX, undefined, false, opts),
    readPose: async () => {
      const win = travelFrame.getWindow();
      const [pos, sf] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
      const scale = sf > 0 ? sf : 1;
      return { x: pos.x / scale, y: pos.y / scale };
    },
    moveTo: async (x, y) => {
      const win = travelFrame.getWindow();
      await win.setPositionLogical(Math.round(x), Math.round(y));
    },
    playWalk: () => {
      renderer.playMotion({ id: WALK_MOTION_ID });
    },
    onFrame: (fn) => renderer.onTick((ctx) => fn(ctx.dt)),
    setFlat(scaleX) {
      const flat = scaleX !== null;
      stringFlat = flat;
      renderer.setStringFlat(scaleX);
      deps.onFlat?.(flat);
    },
    holdEdge: (held) => windowSourcesRef?.setKeepOnScreenPaused(held),
    schedule(ms, fn) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  });
  register(stringForm.stop);

  return {
    walker,
    sitter,
    dropSource: windowSources,
    setDragging(next) {
      dragging = next;
      if (next) stringForm.noteDrag();
    },
    yieldOnText: (text) => stringForm.onText(text),
    cancel: () => {
      walker.cancel();
      rootMover.cancel();
      faller.cancel();
      climber.cancel();
      percher.cancel();
      sitter.cancel();
    },
    abortTravel: () => travelFrame.abort(),
  };
}
