# WHAM pkl → VRMA

```bash
python pkl2vrma/wham_to_vrma.py path/to/wham.pkl --install
```

Writes `public/custom_motions/<stem>.vrma`. Restart `pnpm tauri:dev` so the stem is published as `motion_id`. Needs `numpy` and `node` (repo `three`).

```bash
python pkl2vrma/wham_to_vrma.py path/to/wham.pkl -o dance.vrma --fps 30
```

pkl → temp BVH → [vrm-c/bvh2vrma](https://github.com/vrm-c/bvh2vrma) (End Sites are not used as `head`).
