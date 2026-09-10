# Custom motion clips

Drop `.vrma` files here to play them on the live character. They are local experiment clips, not catalog content.

- **Do not commit** these files. The directory is gitignored except this note and `.gitkeep`.
- **From WHAM:** `python pkl2vrma/wham_to_vrma.py path/to.pkl --install` writes `<stem>.vrma` here.
- **Discovery:** `pnpm tauri:dev` / `pnpm dev` scans `*.vrma` at config load. Each file stem becomes a motion id (`motion.vrma` → `motion`). Ids must not collide with `configs/motions.json`.
- **Playback:** oneshot with `root_lock_xz`, so a video walk moves the OS window instead of sliding off the canvas. The stem is published as `motion_id` (`spin.vrma` → ask her to play `spin`). Character tab lists them in the Custom group; ▶ previews, the on/off switch curates whether the agent may pick them.
- **Fallback:** a missing or invalid clip recovers to `idle`, same as other gitignored motions.
