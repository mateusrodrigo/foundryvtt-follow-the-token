## Follow The Token — Changelog

### 1.2.0 – Cinematic Camera Mode, Full Player Lock & GM Camera Sync

**New**

- Added an **alternate Cinematic mode** controlled by the world setting  
  `follow-the-token.gmCinematicFollowCamera`:
  - **Classic Mode (default):**
    - All clients focus on the GM’s selected tokens.
    - The GM is “locked” to their token while Classic is active.
  - **Camera Mode (new):**
    - The GM can freely move the camera (pan, zoom, rotate).
    - All players mirror the GM’s camera **1:1** (position, zoom, rotation).
    - Continuous synchronization via the world setting `gmCameraState`.
- **Full player input lock during any Cinematic mode** (Classic or Camera):
  - Player stage switches to `eventMode = "none"` and `interactiveChildren = false`.
  - Players cannot:
    - pan (MMB/RMB),
    - zoom (scroll wheel),
    - rotate the camera,
    - click or interact with the canvas,
    - toggle follow (Alt+F, TAB, double-click, etc.).
- **Selection lock for players in Cinematic**:
  - Initial controlled tokens are stored in `cinSnapshot.lockedTokenIds`.
  - Any attempt to change selection is reverted back to the locked set.
- **Integration with rotate-camera-8d**:
  - GM in Cinematic: any rotation updates `gmCameraState` and is reflected to all players.
  - Players in Cinematic: any attempt to rotate is immediately reverted to the GM’s current rotation.

**Changes**

- Cinematic now has two “flavors” under the same **Ctrl+F** shortcut, governed by `gmCinematicFollowCamera`:
  - Switching the setting while Cinematic is active transitions between Classic/Camera with clear rules:
    - Entering **Classic Mode**:
      - The GM’s current Alt+F state is saved to `preClassicEnabledGM`.
      - Follow may be temporarily forced ON while Classic is active.
    - Entering **Camera Mode**:
      - Does not change Alt+F; the GM’s current setting is treated as authoritative.
- When Cinematic is turned off:
  - **GM + Camera Mode:** no camera rollback; Alt+F remains as-is, ticker state is respected.
  - **GM + Classic Mode:** Alt+F is restored from `preClassicEnabledGM` (or previous snapshot).
  - **Players:** always restore:
    - position,
    - zoom (respecting `retainZoom`),
    - rotation,
    - and the `enabled` flag (Local Follow) to the pre-Cinematic snapshot.
- Player panning attempts during Cinematic:
  - In **Camera Mode:** immediately snap back to the GM’s camera using `gmCameraState`.
  - In **Classic Mode:** re-center on the GM’s followed tokens.
- Updated inline documentation and file header comments to clarify:
  - keyboard shortcuts,
  - behavior of Classic vs Camera modes,
  - and player input lock semantics.

**Fixes**

- Ensured that:
  - Player pan/zoom/rotate attempts during Cinematic are fully blocked or reverted.
  - GM entering Classic mode with Local Follow disabled is handled via snapshot and restores cleanly on exit.
- Added `_squelchCanvasPan` guard to prevent feedback loops inside `canvasPan` when reverting player cameras.

---

### 1.1.1 – Force Follow Only Affects Players, GM Remains Free

**New**

- Clear distinction between:
  - `_isForceOnGlobal()` → raw state of world setting `gmForceFollow`.
  - `_isForceOnForMe()` → effective Force state for the current user (never true for GM).
- Updated `_isFollowActive()`:
  - **GM:** depends only on Cinematic or Local Follow.
  - **Players:** depends on Force Follow + Local Follow + Cinematic.

**Changes**

- **Force Follow (Ctrl+Alt+F)**:
  - Forces only players to keep follow ON for their own tokens.
  - GM is **not forced**; retains full freedom over Alt+F.
- Distinct notifications for GM and players when enabling/disabling Force Follow:
  - `CFT.Force.enabledGM` / `CFT.Force.disabledGM`
  - `CFT.Force.enabledPlayer` / `CFT.Force.disabledPlayer`
- Alt+F (Local Follow) toggle:
  - For players: blocked while Force Follow is active.
  - For GM: never blocked by Force Follow (only by Cinematic).

**Fixes**

- Prevented scenarios where the GM could become “stuck” following tokens during Force Follow.

---

### 1.1.0 – New Center Calculation with Canvas Rotation & Ticker Improvements

**New**

- Introduced robust `_currentCenterWorld()`:
  - First tries `interaction.mapPositionToPoint` + `stage.toLocal`, fully supporting:
    - zoom,
    - pan,
    - stage rotation.
  - Falls back to explicit matrix inversion of `worldTransform` when necessary.

**Changes**

- `_startTicker()` refined to:
  - Pause follow while the user is manually panning with MMB/RMB.
  - Reduce camera “fighting” during manual input.
- `_onPointerDownStage` now only blocks RMB/MMB during token motion.

**Fixes**

- Corrected camera drift when the canvas is rotated (e.g., with rotate-camera-8d).
- Reduced jitter and unnecessary recentering during manual control.

---

### 1.0.1 – Mouse & Ticker Refinements

**New**

- Added a small “cushion” in `_idleMs()` to keep RAF active longer during multi-token selection, avoiding rapid ticker restarts.

**Changes**

- Improved RMB/MMB handling in `_bindDomMouseBlockers` and `_onPointerDownStage`:
  - Blocks only movement conflicts during token motion.
- Idle/pan improvements:
  - Optional resume of camera follow after mouse release (`resumeOnRelease`).

**Fixes**

- Reduced camera jitter during multi-select.
- Prevented aggressive snapping right after manual pan.

---

### 1.0.0 – Initial Release (Foundry v13)

**Features**

- **Local Follow (Alt+F):**
  - Per-user camera follow for their own selected tokens.
  - Multi-select support with smoothed centroid targeting.
  - Smooth camera interpolation with adjustable responsiveness.
- **Force Follow (Ctrl+Alt+F, GM-only):**
  - Forces all connected clients (including GM in v1.0.0) to keep follow ON.
- **Cinematic Lock (Ctrl+F, GM-only):**
  - All clients focus on the GM’s selected tokens.
  - Players cannot move tokens during Cinematic.
  - Restores each client’s camera and follow state on exit via `cinSnapshot`.
- **Tuning Parameters:**
  - `responsiveness`, `maxSpeed`, `idleMs`, `resumeOnRelease`, `retainZoom`, and `scale`.
- **GM Banners:**
  - Subtle on-screen indicators for active Force Follow and Cinematic modes.
