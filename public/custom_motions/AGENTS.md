# Custom motion clips

Drop `.vrma` files here to play them on the live character. They are local experiment clips, not catalog content.

- **Do not commit** these files. The directory is gitignored except this note and `.gitkeep`.
- **From WHAM:** `python pkl2vrma/wham_to_vrma.py path/to.pkl --install` writes `<stem>.vrma` here. Dragging a `.pkl` onto the live character does the same convert-and-install, then plays the stem without restarting the app. Finder / Explorer file-drags drop click-through for the gesture so the live window can receive the drop. A stem that collides with `configs/motions.json` is stored under a disambiguated id.
- **Discovery:** `pnpm tauri:dev` / `pnpm dev` scans `*.vrma` at config load. Each file stem becomes a motion id (`motion.vrma` → `motion`). Ids must not collide with `configs/motions.json`.
- **Playback:** oneshot with `root_lock_xz`, so a video walk moves the OS window instead of sliding off the canvas. A window perch stands her up first, then the clip plays as it would on the floor; she sits back when it ends, or falls if the host is gone. The stem is published as `motion_id` (`spin.vrma` → ask her to play `spin`). Character tab lists them in the Custom group; ▶ previews, the on/off switch curates whether the agent may pick them.
- **Fallback:** a missing or invalid clip recovers to `idle`, same as other gitignored motions.
