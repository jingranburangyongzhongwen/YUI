/**
 * Vendored from https://github.com/vrm-c/bvh2vrma (MIT).
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { getRootBone } from "./getRootBone.js";
import { mapSkeletonToVRM } from "./mapSkeletonToVRM.js";
import { VRMAnimationExporterPlugin } from "./VRMAnimationExporterPlugin.js";

const _v3A = new THREE.Vector3();

function createSkeletonBoundingBox(skeleton) {
  const boundingBox = new THREE.Box3();
  for (const bone of skeleton.bones) {
    boundingBox.expandByPoint(bone.getWorldPosition(_v3A));
  }
  return boundingBox;
}

export async function convertBVHToVRMAnimation(bvh, options) {
  const scale = options?.scale ?? 0.01;

  const skeleton = bvh.skeleton.clone();
  const clip = bvh.clip.clone();

  const rootBone = getRootBone(skeleton);

  rootBone.traverse((bone) => {
    bone.position.multiplyScalar(scale);
  });
  rootBone.updateWorldMatrix(false, true);

  const vrmBoneMap = mapSkeletonToVRM(rootBone);
  rootBone.userData.vrmBoneMap = vrmBoneMap;

  const hipsBone = vrmBoneMap.get("hips");
  const hipsBoneName = hipsBone.name;

  const filteredTracks = [];

  for (const origTrack of bvh.clip.tracks) {
    const track = origTrack.clone();
    track.name = track.name.replace(/\.bones\[(.*)]/, "$1");

    if (track.name.endsWith(".quaternion")) {
      filteredTracks.push(track);
    }

    if (track.name === `${hipsBoneName}.position`) {
      const newTrack = track.clone();
      newTrack.values = track.values.map((v) => v * scale);
      filteredTracks.push(newTrack);

      const offset = hipsBone.position.toArray();
      for (let i = 0; i < newTrack.values.length; i++) {
        newTrack.values[i] -= offset[i % 3];
      }
    }
  }

  clip.tracks = filteredTracks;

  const boundingBox = createSkeletonBoundingBox(skeleton);
  if (boundingBox.min.y < 0) {
    rootBone.position.y -= boundingBox.min.y;
  }

  const exporter = new GLTFExporter();
  exporter.register((writer) => new VRMAnimationExporterPlugin(writer));

  const gltf = await exporter.parseAsync(rootBone, {
    animations: [clip],
    binary: true,
  });
  return gltf;
}
