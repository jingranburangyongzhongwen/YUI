# Vendored from https://github.com/KosukeFukazawa/smpl2bvh (MIT)
# Originally based on Daniel Holden, Motion Matching:
# https://github.com/orangeduck/Motion-Matching

import numpy as np


def mul(x, y):
    x0, x1, x2, x3 = x[..., 0:1], x[..., 1:2], x[..., 2:3], x[..., 3:4]
    y0, y1, y2, y3 = y[..., 0:1], y[..., 1:2], y[..., 2:3], y[..., 3:4]
    return np.concatenate(
        [
            y0 * x0 - y1 * x1 - y2 * x2 - y3 * x3,
            y0 * x1 + y1 * x0 - y2 * x3 + y3 * x2,
            y0 * x2 + y1 * x3 + y2 * x0 - y3 * x1,
            y0 * x3 - y1 * x2 + y2 * x1 + y3 * x0,
        ],
        axis=-1,
    )


def from_angle_axis(angle, axis):
    c = np.cos(angle / 2.0)[..., None]
    s = np.sin(angle / 2.0)[..., None]
    return np.concatenate([c, s * axis], axis=-1)


def from_axis_angle(rots):
    angle = np.linalg.norm(rots, axis=-1)
    axis = rots / np.clip(angle[..., None], 1e-8, None)
    return from_angle_axis(angle, axis)


def to_euler(x, order="zyx"):
    q0 = x[..., 0:1]
    q1 = x[..., 1:2]
    q2 = x[..., 2:3]
    q3 = x[..., 3:4]
    if order == "zyx":
        return np.concatenate(
            [
                np.arctan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3)),
                np.arcsin((2 * (q0 * q2 - q3 * q1)).clip(-1, 1)),
                np.arctan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2)),
            ],
            axis=-1,
        )
    raise NotImplementedError("Cannot convert from ordering %s" % order)
