#!/usr/bin/env python3
"""WHAM pkl → VRMA. BVH is a temp file, not an output."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

import bvh
from wham import (
    JOINT_NAMES,
    SMPL_PARENTS,
    extract_pose_trans,
    load_wham,
    pick_subject,
    pose_to_euler_zyx,
    rest_offsets_cm,
)

ROOT = os.path.dirname(os.path.abspath(__file__))
CUSTOM_MOTIONS = os.path.abspath(os.path.join(ROOT, "..", "public", "custom_motions"))
BVH_TO_VRMA = os.path.join(ROOT, "bvh_to_vrma.mjs")


def _write_bvh(pkl, out_bvh, fps, use_world=True):
    sid, body = pick_subject(load_wham(pkl))
    pose, trans, pose_key, trans_key = extract_pose_trans(body, use_world=use_world)
    n = len(pose)
    rotations = pose_to_euler_zyx(pose)
    offsets = rest_offsets_cm()
    pos = np.repeat(offsets[None], n, axis=0)
    pos[:, 0] += trans * 100.0
    if pos[0, 0, 1] <= 1.0:
        pos[:, 0, 1] += 90.0
    os.makedirs(os.path.dirname(os.path.abspath(out_bvh)) or ".", exist_ok=True)
    bvh.save(out_bvh, {
        "rotations": rotations,
        "positions": pos,
        "offsets": offsets,
        "parents": SMPL_PARENTS,
        "names": JOINT_NAMES,
        "order": "zyx",
        "frametime": 1.0 / fps,
    })
    return {
        "subject": str(sid),
        "frames": int(n),
        "fps": float(fps),
        "pose_key": pose_key,
        "trans_key": trans_key,
    }


def convert(pkl, out_vrma, fps, use_world=True):
    os.makedirs(os.path.dirname(os.path.abspath(out_vrma)) or ".", exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(prefix="wham_", suffix=".bvh", delete=False)
    tmp.close()
    try:
        meta = _write_bvh(pkl, tmp.name, fps, use_world=use_world)
        node = shutil.which("node")
        if not node:
            raise SystemExit("node is required (vrm-c/bvh2vrma runs on THREE.GLTFExporter)")
        subprocess.run([node, BVH_TO_VRMA, tmp.name, "-o", out_vrma], check=True)
        meta["output"] = out_vrma
        return meta
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("pkl")
    p.add_argument("-o", "--output", help="Output .vrma (default: <pkl stem>.vrma)")
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--camera", action="store_true", help="Use camera-space pose/trans")
    p.add_argument("--install", action="store_true",
                    help="Write public/custom_motions/<stem>.vrma")
    args = p.parse_args(argv)

    stem = os.path.splitext(os.path.basename(args.pkl))[0]
    if args.output:
        out = args.output
    elif args.install:
        os.makedirs(CUSTOM_MOTIONS, exist_ok=True)
        out = os.path.join(CUSTOM_MOTIONS, stem + ".vrma")
    else:
        out = os.path.splitext(args.pkl)[0] + ".vrma"
    if not out.lower().endswith(".vrma"):
        out = out + ".vrma"

    meta = convert(args.pkl, out, args.fps, use_world=not args.camera)
    print("wrote", meta["output"], "frames", meta["frames"], "fps", meta["fps"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
