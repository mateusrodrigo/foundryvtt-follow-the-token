# Follow The Token (v1.2.0)

![Foundry Version](https://img.shields.io/badge/Foundry-v13.350%2B-blue)
![Version](https://img.shields.io/badge/Version-1.2.0-green)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

A lightweight and highly configurable **camera-follow** system for **Foundry VTT (v13.350+)**.  
Keeps the camera centered on your tokens **only while they move**, with advanced Cinematic modes, multi-token smoothing, and full player input locking.  
Works seamlessly with [Rotate Camera 8D](https://github.com/mateusrodrigo/foundryvtt-rotate-camera-8d) for dynamic, rotation-aware control.

---

## Features

- **Three core modes**
  - **Local Follow (Alt+F):** Each player follows their own selected tokens.
  - **Force Follow (Ctrl+Alt+F, GM):** Forces Follow to stay ON for all *players*, while the GM remains free to toggle Local Follow independently.
  - **Cinematic Lock (Ctrl+F, GM):** Two sub-modes available:
    - **Classic Mode:** All clients focus on the GM’s selected tokens. The GM’s camera is locked to the token(s).
    - **Camera Mode (new):** The GM can freely pan, zoom, and rotate the camera, while all players mirror the GM’s camera **1:1** (position, zoom, rotation).
- **Full player input lock during Cinematic**
  - Players cannot pan (MMB/RMB), zoom (scroll), rotate the camera, click, or interact with the canvas.
  - Stage event mode automatically switches to `"none"` while Cinematic is active.
- **Smooth and natural motion**
  - Adjustable responsiveness (0.05–0.5), speed cap, and zoom handling.
  - EMA smoothing for multi-token centroids to eliminate jitter.
- **Smart pan control**
  - Automatically suppresses middle/right mouse panning during token movement.
  - Optional “resume on release” for re-centering after manual camera control.
- **Cinematic synchronization**
  - Real-time GM camera state sharing via `gmCameraState` (position, scale, rotation).
  - Perfect sync with **Rotate Camera 8D**.
- **Enhanced GM interface**
  - Black on-screen banners (priority: Cinematic > Force).
  - Separate notifications for GM and Players (Info, Warn, Error levels).
- **Client & World settings**
  - Per-user preferences for responsiveness, zoom, and follow behavior.
  - World settings for Force Follow and Cinematic control.
- **Multilingual**
  - English and Portuguese (Brazil) translations included.
- **Zero dependencies**
  - Built entirely with native Foundry VTT canvas and Hooks API.

---

## Installation

**Manifest URLs:**
- GitHub: https://raw.githubusercontent.com/mateusrodrigo/foundryvtt-follow-the-token/v1.2.0/module.json
- jsDelivr: https://cdn.jsdelivr.net/gh/mateusrodrigo/foundryvtt-follow-the-token@v1.2.0/module.json

1. In Foundry VTT, go to **Add-on Modules → Install Module**  
2. Paste one of the URLs above and click **Install**  
3. Enable the module in your World  
4. Configure in **Game Settings → Module Settings → Follow The Token**

---

## Usage

- Move one or more tokens — the camera follows smoothly in real time.  
- When tokens stop, you regain manual pan control.  
- Default shortcuts:
  - **Alt+F** → Local Follow  
  - **Ctrl+Alt+F** → Force Follow (GM only)  
  - **Ctrl+F** → Cinematic Lock (GM only)
- Cinematic behavior can be switched between **Classic** and **Camera Mode** in the world setting  
  **“Cinematic Follow Camera”** while the mode is active.
- Keybindings can be customized in  
  **Game Settings → Configure Controls → Keybinds**.

---

## Compatibility

- Verified for **Foundry VTT v13.350**.  
- Fully compatible with [Rotate Camera 8D](https://github.com/mateusrodrigo/foundryvtt-rotate-camera-8d).  
- May conflict with other modules that alter canvas panning or camera control.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full release notes.  
Latest: **v1.2.0 — Cinematic Camera Mode, Full Player Lock & Rotation Sync**

---

## Credits

Developed by [Mateus Rodrigo](https://github.com/mateusrodrigo)  
License: [MIT](LICENSE)
