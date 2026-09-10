# Vendored from https://github.com/KosukeFukazawa/smpl2bvh (MIT)
# Originally based on Daniel Holden, Motion Matching:
# https://github.com/orangeduck/Motion-Matching

import re
import numpy as np

channelmap = {
    "Xrotation": "x",
    "Yrotation": "y",
    "Zrotation": "z",
}

channelmap_inv = {
    "x": "Xrotation",
    "y": "Yrotation",
    "z": "Zrotation",
}


def save_joint(f, data, t, i, save_order, order="zyx", save_positions=False):
    save_order.append(i)
    f.write("%sJOINT %s\n" % (t, data["names"][i]))
    f.write("%s{\n" % t)
    t += "\t"
    f.write("%sOFFSET %f %f %f\n" % (t, data["offsets"][i, 0], data["offsets"][i, 1], data["offsets"][i, 2]))
    if save_positions:
        f.write(
            "%sCHANNELS 6 Xposition Yposition Zposition %s %s %s \n"
            % (t, channelmap_inv[order[0]], channelmap_inv[order[1]], channelmap_inv[order[2]])
        )
    else:
        f.write(
            "%sCHANNELS 3 %s %s %s\n"
            % (t, channelmap_inv[order[0]], channelmap_inv[order[1]], channelmap_inv[order[2]])
        )
    end_site = True
    for j in range(len(data["parents"])):
        if data["parents"][j] == i:
            t = save_joint(f, data, t, j, save_order, order=order, save_positions=save_positions)
            end_site = False
    if end_site:
        f.write("%sEnd Site\n" % t)
        f.write("%s{\n" % t)
        t += "\t"
        f.write("%sOFFSET %f %f %f\n" % (t, 0.0, 0.0, 0.0))
        t = t[:-1]
        f.write("%s}\n" % t)
    t = t[:-1]
    f.write("%s}\n" % t)
    return t


def save(filename, data, save_positions=False):
    order = data["order"]
    frametime = data["frametime"]
    with open(filename, "w") as f:
        t = ""
        f.write("%sHIERARCHY\n" % t)
        f.write("%sROOT %s\n" % (t, data["names"][0]))
        f.write("%s{\n" % t)
        t += "\t"
        f.write("%sOFFSET %f %f %f\n" % (t, data["offsets"][0, 0], data["offsets"][0, 1], data["offsets"][0, 2]))
        f.write(
            "%sCHANNELS 6 Xposition Yposition Zposition %s %s %s \n"
            % (t, channelmap_inv[order[0]], channelmap_inv[order[1]], channelmap_inv[order[2]])
        )
        save_order = [0]
        for i in range(len(data["parents"])):
            if data["parents"][i] == 0:
                t = save_joint(f, data, t, i, save_order, order=order, save_positions=save_positions)
        t = t[:-1]
        f.write("%s}\n" % t)
        rots, poss = data["rotations"], data["positions"]
        f.write("MOTION\n")
        f.write("Frames: %i\n" % len(rots))
        f.write("Frame Time: %f\n" % frametime)
        for i in range(rots.shape[0]):
            for j in save_order:
                if save_positions or j == 0:
                    f.write(
                        "%f %f %f %f %f %f "
                        % (
                            poss[i, j, 0],
                            poss[i, j, 1],
                            poss[i, j, 2],
                            rots[i, j, 0],
                            rots[i, j, 1],
                            rots[i, j, 2],
                        )
                    )
                else:
                    f.write("%f %f %f " % (rots[i, j, 0], rots[i, j, 1], rots[i, j, 2]))
            f.write("\n")
