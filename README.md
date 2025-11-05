# Follow The Token (v1.1.0)

![Foundry Version](https://img.shields.io/badge/Foundry-v13.350%2B-blue)
![Version](https://img.shields.io/badge/Version-1.1.0-green)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

A lightweight and configurable **camera-follow** system for **Foundry VTT (v13.350+)**.  
Keeps the camera centered on your tokens **only while they move**, with three distinct modes: **Local**, **Force**, and **Cinematic**.  
Works seamlessly alongside [Rotate Camera 8D](https://github.com/mateusrodrigo/foundryvtt-rotate-camera-8d) for full dynamic camera control.

---

## Features
- **Three modes**
  - **Local Follow (Alt+F):** Each player follows their own selected tokens.
  - **Force Follow (Ctrl+Alt+F, GM):** Forces Follow to stay ON for all clients.
  - **Cinematic Lock (Ctrl+F, GM):** All clients focus on the GM’s selected tokens.
- **Smooth motion**
  - Adjustable responsiveness (0.05–0.5), speed limit, and zoom options.
  - EMA smoothing for multi-token centroids to reduce jitter.
- **Smart pan control**
  - Automatically blocks middle/right mouse drag during movement.
  - Optional “resume on release” and idle time configuration.
- **GM interface**
  - On-screen banners showing active mode (priority: Cinematic > Force).
- **Client and World settings**
  - Per-user preferences; GM authority for Force/Cinematic modes.
- **Bilingual**
  - English and Portuguese (Brazil) translations included.
- **No dependencies**
  - Uses only native Foundry canvas and Hooks API.

---

## Installation
**Manifest URLs:**  
- jsDelivr: https://cdn.jsdelivr.net/gh/mateusrodrigo/foundryvtt-follow-the-token@main/module.json  
- GitHub: https://raw.githubusercontent.com/mateusrodrigo/foundryvtt-follow-the-token/main/module.json  

1. In Foundry VTT, go to **Add-on Modules → Install Module**  
2. Paste one of the URLs above and click **Install**  
3. Enable the module in your World  
4. Configure in **Game Settings → Module Settings → Follow The Token**

---

## Usage
- Move one or more tokens — the camera will follow smoothly.  
- When movement stops, you can freely pan the camera.  
- Default shortcuts:
  - **Alt+F** → Local Follow  
  - **Ctrl+Alt+F** → Force Follow (GM only)  
  - **Ctrl+F** → Cinematic Lock (GM only)  
- Rebind keys in **Game Settings → Configure Controls → Keybinds**.

---

## Compatibility
- Tested on **Foundry VTT v13.350**.
- Compatible with [Rotate Camera 8D](https://github.com/mateusrodrigo/foundryvtt-rotate-camera-8d).
- May conflict with other modules that modify the camera or panning behavior.

---

## Credits
Developed by [Mateus Rodrigo](https://github.com/mateusrodrigo)  
License: [MIT](LICENSE)
