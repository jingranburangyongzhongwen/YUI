#!/usr/bin/env node
/**
 * BVH → VRMA using vrm-c/bvh2vrma (THREE.BVHLoader + GLTFExporter).
 *
 *   node pkl2vrma/bvh_to_vrma.mjs motion.bvh -o motion.vrma
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "./node-filereader.js";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { convertBVHToVRMAnimation } from "./vendor/bvh2vrma/convertBVHToVRMAnimation.js";

function parseArgs(argv) {
  const args = { scale: 0.01, input: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--output") args.output = argv[++i];
    else if (a === "--scale") args.scale = Number(argv[++i]);
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else args.input = a;
  }
  if (!args.input) throw new Error("usage: bvh_to_vrma.mjs <file.bvh> -o <out.vrma>");
  if (!args.output) args.output = args.input.replace(/\.bvh$/i, "") + ".vrma";
  return args;
}

const args = parseArgs(process.argv.slice(2));
const text = readFileSync(resolve(args.input), "utf8");
const bvh = new BVHLoader().parse(text);
const buffer = await convertBVHToVRMAnimation(bvh, { scale: args.scale });
writeFileSync(resolve(args.output), Buffer.from(buffer));
console.log("wrote", args.output);
