import type { Tier1Engine } from "../ambient/liveliness/tier1";
import type { Renderer } from "../renderer";

export function registerRendererAndAmbientDisposal(
  register: (dispose: () => void) => void,
  renderer: Pick<Renderer, "dispose">,
  ambient: Pick<Tier1Engine, "stop">,
): void {
  register(() => renderer.dispose());
  register(() => ambient.stop());
}
