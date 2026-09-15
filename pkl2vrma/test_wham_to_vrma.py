"""WHAM pkl → VRMA."""
from __future__ import annotations

import json
import os
import pickle
import struct
import sys
import tempfile
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from wham import pick_subject  # noqa: E402
from wham_to_vrma import convert  # noqa: E402


def parse_glb(data: bytes):
    magic, version, length = struct.unpack_from("<III", data, 0)
    offset = 12
    json_bytes = None
    while offset < length:
        clen, ctype = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + clen]
        offset += clen
        if ctype == 0x4E4F534A:
            json_bytes = chunk
    return magic, version, json.loads(json_bytes)


def synthetic_pkl(path: str, n=8):
    pose = np.zeros((n, 24, 3), dtype=np.float64)
    trans = np.zeros((n, 3), dtype=np.float64)
    trans[:, 2] = np.linspace(0.0, 0.4, n)
    with open(path, "wb") as f:
        pickle.dump({0: {"pose_world": pose, "trans_world": trans}}, f)


class TestWhamToVrma(unittest.TestCase):
    def test_pick_subject_longest(self):
        sid, body = pick_subject(
            {
                "short": {"pose": np.zeros((3, 72))},
                "long": {"pose_world": np.zeros((10, 24, 3))},
            }
        )
        self.assertEqual(sid, "long")
        self.assertEqual(body["pose_world"].shape[0], 10)

    def test_convert_maps_head_not_endsite(self):
        with tempfile.TemporaryDirectory() as td:
            pkl = os.path.join(td, "clip.pkl")
            out = os.path.join(td, "clip.vrma")
            synthetic_pkl(pkl)
            meta = convert(pkl, out, fps=30.0, use_world=True)
            self.assertEqual(meta["frames"], 8)
            with open(out, "rb") as f:
                _, _, gltf = parse_glb(f.read())
            bones = gltf["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"]
            self.assertEqual(gltf["nodes"][bones["head"]["node"]]["name"], "Head")
            self.assertNotEqual(gltf["nodes"][bones["head"]["node"]]["name"], "ENDSITE")

    def test_convert_fps_scales_clip_duration(self):
        with tempfile.TemporaryDirectory() as td:
            pkl = os.path.join(td, "clip.pkl")
            synthetic_pkl(pkl, n=8)
            slow = os.path.join(td, "slow.vrma")
            fast = os.path.join(td, "fast.vrma")
            convert(pkl, slow, fps=10.0, use_world=True)
            convert(pkl, fast, fps=30.0, use_world=True)

            def duration(path):
                with open(path, "rb") as f:
                    _, _, gltf = parse_glb(f.read())
                acc = gltf["accessors"][gltf["animations"][0]["samplers"][0]["input"]]
                return acc["max"][0]

            self.assertAlmostEqual(duration(slow) / duration(fast), 3.0, places=2)


if __name__ == "__main__":
    unittest.main()
