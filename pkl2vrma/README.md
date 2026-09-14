# WHAM pkl → VRMA

```bash
python pkl2vrma/wham_to_vrma.py path/to/wham.pkl --install
```

Writes `public/custom_motions/<stem>.vrma`. Dragging the same `.pkl` onto the live character runs this convert-and-install and plays the stem without restarting. A CLI install still needs the next config poll (or a restart) before the stem is a `motion_id`. Needs `numpy` and `node` (repo `three`).

```bash
python pkl2vrma/wham_to_vrma.py path/to/wham.pkl -o dance.vrma --fps 30
```

pkl → temp BVH → [vrm-c/bvh2vrma](https://github.com/vrm-c/bvh2vrma) (End Sites are not used as `head`).
