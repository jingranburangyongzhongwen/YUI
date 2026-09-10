/**
 * Vendored from https://github.com/vrm-c/bvh2vrma (MIT).
 */
const EXTENSION_NAME = "VRMC_vrm_animation";

export class VRMAnimationExporterPlugin {
  constructor(writer) {
    this.writer = writer;
    this.name = EXTENSION_NAME;
  }

  afterParse(input) {
    const root = Array.isArray(input) ? input[0] : input;
    if (root == null) return;

    const vrmBoneMap = root.userData?.vrmBoneMap;
    if (vrmBoneMap == null) return;

    const humanBones = {};
    for (const [boneName, bone] of vrmBoneMap) {
      const node = this.writer.nodeMap.get(bone);
      if (node != null) {
        humanBones[boneName] = { node };
      }
    }

    const gltfDef = this.writer.json;
    gltfDef.extensionsUsed ??= [];
    gltfDef.extensionsUsed.push(EXTENSION_NAME);
    gltfDef.extensions ??= {};
    gltfDef.extensions[EXTENSION_NAME] = {
      specVersion: "1.0",
      humanoid: { humanBones },
    };
  }
}
