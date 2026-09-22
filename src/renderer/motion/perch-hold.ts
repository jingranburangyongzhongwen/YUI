import type { MotionKind, MotionSignal } from "../../contract";

/** A held posture ignores idle returns and locomotion, not express oneshots. */
export function suppressWhileHeld(
  requested: MotionSignal | null,
  held: boolean,
  kindOf: (id: string) => MotionKind | undefined,
): boolean {
  if (!held) return false;
  if (requested === null) return true;
  const kind = kindOf(requested.id);
  return kind !== "state" && kind !== "oneshot";
}

/** A published oneshot while perched stands up, plays on the floor path, then sits back. */
export function shouldLeaveSeatForMotion(
  requested: MotionSignal | null,
  perched: boolean,
  kindOf: (id: string) => MotionKind | undefined,
  isPublished: (id: string) => boolean,
): boolean {
  if (!perched || requested === null) return false;
  return kindOf(requested.id) === "oneshot" && isPublished(requested.id);
}

/** A held posture restores its last state motion instead of the ambient baseline. */
export function baselineWhileHeld(
  held: boolean,
  lastStateId: string | null,
  baseline: string,
): string {
  return held && lastStateId ? lastStateId : baseline;
}
