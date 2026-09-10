"""WHAM pickle → SMPL pose used by wham_to_vrma."""
from __future__ import annotations

import numpy as np

import quat

SMPL_PARENTS = np.array(
    [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21],
    dtype=np.int32,
)
JOINT_NAMES = [
    "Hips", "LeftUpLeg", "RightUpLeg", "Spine", "LeftLeg", "RightLeg", "Spine1",
    "LeftFoot", "RightFoot", "Spine2", "LeftToeBase", "RightToeBase", "Neck",
    "LeftShoulder", "RightShoulder", "Head", "LeftArm", "RightArm", "LeftForeArm",
    "RightForeArm", "LeftHand", "RightHand", "LeftHandEnd", "RightHandEnd",
]
# SMPL_NEUTRAL T-pose joints (metres), same rest pose smpl2bvh gets from smplx.create().
SMPL_REST_JOINTS = np.array(
    [
        [-0.0018, -0.2233, 0.0282], [0.0695, -0.3138, 0.0188], [-0.0722, -0.3103, 0.0189],
        [0.0019, -0.1100, -0.0015], [0.1020, -0.6885, 0.0103], [-0.1075, -0.6943, 0.0151],
        [0.0028, 0.0245, -0.0430], [0.1265, -1.0482, -0.0403], [-0.1299, -1.0516, -0.0394],
        [0.0032, 0.1237, -0.0456], [0.1452, -1.1060, 0.1030], [-0.1485, -1.1097, 0.1070],
        [0.0003, 0.2882, -0.0145], [0.0711, 0.1964, -0.0078], [-0.0823, 0.1935, -0.0065],
        [0.0027, 0.3890, -0.0382], [0.1814, 0.2408, -0.0625], [-0.1751, 0.2351, -0.0642],
        [0.4547, 0.2222, -0.0437], [-0.4494, 0.2149, -0.0407], [0.7178, 0.2202, -0.0479],
        [-0.7132, 0.2178, -0.0466], [0.8009, 0.2133, -0.0563], [-0.7983, 0.2105, -0.0561],
    ],
    dtype=np.float64,
)


def load_wham(path: str):
    try:
        import joblib
        return joblib.load(path)
    except Exception:
        import pickle
        with open(path, "rb") as f:
            return pickle.load(f)


def as_np(x):
    if hasattr(x, "detach"):
        x = x.detach().cpu().numpy()
    return np.asarray(x)


def pick_subject(results):
    if not isinstance(results, dict) or not results:
        raise SystemExit("empty WHAM pkl")

    def nframes(k):
        b = results[k]
        if not isinstance(b, dict):
            return 0
        for key in ("pose_world", "pose", "trans_world"):
            if key in b:
                return as_np(b[key]).shape[0]
        return 0

    k = max(results, key=nframes)
    return k, results[k]


def local_offsets(rest_world: np.ndarray) -> np.ndarray:
    off = rest_world - rest_world[np.clip(SMPL_PARENTS, 0, None)]
    off[0] = rest_world[0]
    return off


def rest_offsets_cm():
    return local_offsets(SMPL_REST_JOINTS) * 100.0


def extract_pose_trans(body, use_world=True):
    pose_key = "pose_world" if use_world and "pose_world" in body else "pose"
    trans_key = "trans_world" if use_world and "trans_world" in body else "trans"
    pose = as_np(body[pose_key]).astype(np.float64)
    trans = as_np(body[trans_key]).astype(np.float64).reshape(-1, 3)
    if pose.ndim == 2 and pose.shape[-1] == 72:
        pose = pose.reshape(pose.shape[0], 24, 3)
    n = min(len(pose), len(trans))
    pose, trans = pose[:n], trans[:n].copy()
    trans[:, [0, 2]] -= trans[0, [0, 2]]
    return pose, trans, pose_key, trans_key


def pose_to_euler_zyx(pose: np.ndarray) -> np.ndarray:
    aa = pose.copy()
    ang = np.linalg.norm(aa, axis=-1, keepdims=True)
    aa = np.where(ang < 1e-8, np.array([1e-8, 0.0, 0.0]), aa)
    rots = quat.from_axis_angle(aa)
    return np.degrees(quat.to_euler(rots, order="zyx"))
