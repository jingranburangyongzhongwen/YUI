/**
 * Map a BVH skeleton onto VRM humanoid bones.
 * Vendored from https://github.com/vrm-c/bvh2vrma (MIT).
 */
import * as THREE from "three";
import { pickByProbability } from "./pickByProbability.js";

const _v3A = new THREE.Vector3();

function objectBFS(root, fn) {
  const queue = [root];
  while (queue.length > 0) {
    const obj = queue.shift();
    if (fn(obj)) return obj;
    queue.push(...obj.children);
  }
  return null;
}

function objectTraverseFilter(root, fn) {
  const result = [];
  root.traverse((obj) => {
    if (fn(obj)) result.push(obj);
  });
  return result;
}

function objectSearchAncestors(root, fn) {
  let obj = root;
  while (obj != null) {
    if (fn(obj)) return obj;
    obj = obj.parent;
  }
  return null;
}

function evaluatorEqual(obj, another) {
  return obj === another ? 1 : 0;
}

function evaluatorName(obj, substring) {
  return obj.name.toLowerCase().includes(substring) ? 1 : 0;
}

function determineSpineBones(hips, chestCand) {
  const spineBones = [];
  objectSearchAncestors(chestCand, (obj) => {
    spineBones.unshift(obj);
    return obj === hips;
  });

  if (spineBones.length < 3) {
    throw new Error("Not enough spine bones.");
  } else if (spineBones.length === 3) {
    return [spineBones[1], spineBones[2], null];
  } else if (spineBones.length === 4) {
    return [spineBones[1], spineBones[2], spineBones[3]];
  }
  console.warn(
    "The skeleton has more spine bones than VRM requires. You might get an unexpected result.",
  );
  return [
    spineBones[Math.floor((spineBones.length - 1) / 3.0)],
    spineBones[Math.floor(((spineBones.length - 1) / 3.0) * 2.0)],
    spineBones[spineBones.length - 1],
  ];
}

function determineLegBones(legRoot) {
  const bones = [];
  let currentBone = legRoot;
  let currentDepth = 0;
  while (currentBone != null) {
    const firstChild = currentBone.children[0];
    bones.push({
      bone: currentBone,
      depth: currentDepth,
      len: firstChild?.position.length() ?? 0.0,
    });
    currentBone = firstChild;
    currentDepth++;
  }
  if (bones.length < 3) {
    throw new Error("Not enough leg bones.");
  }
  const [upperLeg, lowerLeg] = bones
    .concat()
    .sort((a, b) => b.len - a.len)
    .slice(0, 2)
    .sort((a, b) => a.depth - b.depth);
  const foot = bones[lowerLeg.depth + 1];
  if (foot == null) throw new Error("Could not find the foot bone.");
  const toes = bones[foot.depth + 1];
  return [upperLeg.bone, lowerLeg.bone, foot.bone, toes?.bone ?? null];
}

function determineArmBones(armRoot) {
  const bones = [];
  let currentBone = armRoot;
  let currentDepth = 0;
  while (currentBone != null) {
    const firstChild = currentBone.children[0];
    bones.push({
      bone: currentBone,
      depth: currentDepth,
      len: firstChild?.position.length() ?? 0.0,
    });
    currentBone = firstChild;
    currentDepth++;
  }
  if (bones.length < 3) {
    throw new Error("Not enough arm bones.");
  }
  const [upperArm, lowerArm] = bones
    .concat()
    .sort((a, b) => b.len - a.len)
    .slice(0, 2)
    .sort((a, b) => a.depth - b.depth);
  const hand = bones[lowerArm.depth + 1];
  if (hand == null) throw new Error("Could not find the foot bone.");
  const shoulder = upperArm.depth !== 0 ? bones[upperArm.depth - 1] : null;
  return [shoulder?.bone ?? null, upperArm.bone, lowerArm.bone, hand.bone];
}

function determineFingerBones(result) {
  const leftRights = ["left", "right"];
  const handBoneMap = {
    left: result.get("leftHand"),
    right: result.get("rightHand"),
  };
  const fingerNames = ["thumb", "index", "middle", "ring", "little"];
  const fingerBoneNamesMap = {
    left: {
      thumb: ["leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal"],
      index: ["leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal"],
      middle: ["leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal"],
      ring: ["leftRingProximal", "leftRingIntermediate", "leftRingDistal"],
      little: ["leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal"],
    },
    right: {
      thumb: ["rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal"],
      index: ["rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal"],
      middle: ["rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal"],
      ring: ["rightRingProximal", "rightRingIntermediate", "rightRingDistal"],
      little: ["rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal"],
    },
  };

  for (const leftRight of leftRights) {
    const handBone = handBoneMap[leftRight];
    const fingerRoots = handBone.children.concat();
    for (const fingerName of fingerNames) {
      const fingerBoneNames = fingerBoneNamesMap[leftRight][fingerName];
      const fingerRoot = pickByProbability(fingerRoots, [
        { func: (obj) => evaluatorName(obj, fingerName), weight: 10.0 },
        { func: (obj) => obj.getWorldPosition(_v3A).z, weight: 1.0 },
      ]);
      if (fingerRoot != null && !isEndSite(fingerRoot)) {
        fingerRoots.splice(fingerRoots.indexOf(fingerRoot), 1);
        result.set(fingerBoneNames[0], fingerRoot);
        const child1 = fingerRoot.children[0];
        if (child1 != null && !isEndSite(child1)) {
          result.set(fingerBoneNames[1], child1);
          const child2 = child1.children[0];
          if (child2 != null && !isEndSite(child2)) result.set(fingerBoneNames[2], child2);
        }
      }
    }
  }
}

function isEndSite(obj) {
  return obj != null && (obj.name === "ENDSITE" || obj.type === "ENDSITE");
}

function determineHeadBones(headRoot) {
  let head = headRoot;
  // BVH End Sites are dummy leaves. Walking into them maps `head` onto ENDSITE.
  while (head.children.length === 1 && !isEndSite(head.children[0])) {
    head = head.children[0];
  }
  const neck = headRoot === head ? null : headRoot;
  let leftEye = null;
  let rightEye = null;
  if (head.children.length === 0) {
    leftEye = pickByProbability(head.children, [
      { func: (obj) => evaluatorName(obj, "lefteye"), weight: 10.0 },
      { func: (obj) => evaluatorName(obj, "l_faceeye"), weight: 10.0 },
      { func: (obj) => evaluatorName(obj, "eye"), weight: 1.0 },
      { func: (obj) => obj.getWorldPosition(_v3A).x, weight: 1.0 },
    ]);
    rightEye = pickByProbability(head.children, [
      { func: (obj) => evaluatorEqual(obj, leftEye), weight: -100.0 },
      { func: (obj) => evaluatorName(obj, "righteye"), weight: 10.0 },
      { func: (obj) => evaluatorName(obj, "r_faceeye"), weight: 10.0 },
      { func: (obj) => evaluatorName(obj, "eye"), weight: 1.0 },
      { func: (obj) => -obj.getWorldPosition(_v3A).x, weight: 1.0 },
    ]);
  }
  return [neck, head, leftEye, rightEye];
}

export function mapSkeletonToVRM(root) {
  const result = new Map();

  const hips = objectBFS(root, (obj) => obj.children.length >= 3);
  if (hips == null) throw new Error("Cannot find hips.");
  result.set("hips", hips);

  const chestCands = objectTraverseFilter(hips, (obj) => obj !== hips && obj.children.length >= 3);
  const chestCand = pickByProbability(chestCands, [
    { func: (obj) => evaluatorName(obj, "upperchest"), weight: 1.0 },
    { func: (obj) => evaluatorName(obj, "chest"), weight: 1.0 },
  ]);
  if (chestCand == null) throw new Error("Cannot find chest.");

  const [spine, chest, upperChest] = determineSpineBones(hips, chestCand);
  result.set("spine", spine);
  result.set("chest", chest);
  if (upperChest != null) result.set("upperChest", upperChest);

  const leftLegRoot = pickByProbability(hips.children, [
    { func: (obj) => evaluatorName(obj, "leftupperleg"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "l_upperleg"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "leg"), weight: 1.0 },
    { func: (obj) => obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ]);
  const rightLegRoot = pickByProbability(hips.children, [
    { func: (obj) => evaluatorEqual(obj, leftLegRoot), weight: -100.0 },
    { func: (obj) => evaluatorName(obj, "rightupperleg"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "r_upperleg"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "leg"), weight: 1.0 },
    { func: (obj) => -obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ]);

  const [leftUpperLeg, leftLowerLeg, leftFoot, leftToes] = determineLegBones(leftLegRoot);
  result.set("leftUpperLeg", leftUpperLeg);
  result.set("leftLowerLeg", leftLowerLeg);
  result.set("leftFoot", leftFoot);
  if (leftToes != null) result.set("leftToes", leftToes);

  const [rightUpperLeg, rightLowerLeg, rightFoot, rightToes] = determineLegBones(rightLegRoot);
  result.set("rightUpperLeg", rightUpperLeg);
  result.set("rightLowerLeg", rightLowerLeg);
  result.set("rightFoot", rightFoot);
  if (rightToes != null) result.set("rightToes", rightToes);

  const leftArmRoot = pickByProbability(chestCand.children, [
    { func: (obj) => evaluatorName(obj, "leftshoulder"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "l_shoulder"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "leftupperarm"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "l_upperarm"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "shoulder"), weight: 1.0 },
    { func: (obj) => evaluatorName(obj, "arm"), weight: 1.0 },
    { func: (obj) => obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ]);
  const rightArmRoot = pickByProbability(chestCand.children, [
    { func: (obj) => evaluatorEqual(obj, leftArmRoot), weight: -100.0 },
    { func: (obj) => evaluatorName(obj, "rightshoulder"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "r_shoulder"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "rightupperarm"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "r_upperarm"), weight: 10.0 },
    { func: (obj) => evaluatorName(obj, "shoulder"), weight: 1.0 },
    { func: (obj) => evaluatorName(obj, "arm"), weight: 1.0 },
    { func: (obj) => -obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ]);
  const headRoot = pickByProbability(chestCand.children, [
    { func: (obj) => evaluatorEqual(obj, leftArmRoot), weight: -100.0 },
    { func: (obj) => evaluatorEqual(obj, rightArmRoot), weight: -100.0 },
    { func: (obj) => evaluatorName(obj, "neck"), weight: 1.0 },
    { func: (obj) => evaluatorName(obj, "head"), weight: 1.0 },
    { func: (obj) => Math.abs(obj.getWorldPosition(_v3A).x), weight: -1.0 },
  ]);

  const [leftShoulder, leftUpperArm, leftLowerArm, leftHand] = determineArmBones(leftArmRoot);
  if (leftShoulder != null) result.set("leftShoulder", leftShoulder);
  result.set("leftUpperArm", leftUpperArm);
  result.set("leftLowerArm", leftLowerArm);
  result.set("leftHand", leftHand);

  const [rightShoulder, rightUpperArm, rightLowerArm, rightHand] = determineArmBones(rightArmRoot);
  if (rightShoulder != null) result.set("rightShoulder", rightShoulder);
  result.set("rightUpperArm", rightUpperArm);
  result.set("rightLowerArm", rightLowerArm);
  result.set("rightHand", rightHand);

  determineFingerBones(result);

  const [neck, head, leftEye, rightEye] = determineHeadBones(headRoot);
  if (neck != null) result.set("neck", neck);
  result.set("head", head);
  if (leftEye != null) result.set("leftEye", leftEye);
  if (rightEye != null) result.set("rightEye", rightEye);

  return result;
}
