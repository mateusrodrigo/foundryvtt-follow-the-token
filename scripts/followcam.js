// ===========================
// File: scripts/followcam.js  (Foundry v13.350)
// Version: 1.0.1
// Module ID: follow-the-token
// ===========================
//
// Follow The Token
//
// WHAT THIS MODULE DOES
// --------------------
// • Alt+F (client): Local Follow — toggles per-user follow of THEIR OWN selected token(s).
//   - Supports multi-select; camera targets the smoothed centroid of all selected tokens.
//   - While tokens are moving, RMB/MMB panning is suppressed to avoid conflicts.
//   - When idle, the user can pan freely; on mouse release the camera can optionally resume following.
// • Ctrl+Alt+F (GM-only): Force Follow — globally locks "follow ON" for all clients,
//   but each client still follows their own selected tokens (not the GM's).
//   - Players cannot disable local follow while Force is active.
//   - GM sees a small on-screen banner.
// • Ctrl+F (GM-only): Cinematic Lock — hard override for full GM control.
//   - All clients (players and GM) focus on the GM’s selected token(s).
//   - Players cannot move their tokens during Cinematic.
//   - On exit, each client is restored to their prior camera/flags snapshot.
//   - GM sees a small on-screen banner.
//
// DESIGN NOTES
// ------------
// • Camera movement feels natural and smooth: each frame it moves partway toward the target (like a soft follow).
// • When multiple tokens are selected, their average position is slightly smoothed to avoid jitter on the grid.
// • The animation loop stays active a bit longer with multi-select to prevent tiny start/stop stutters.
//
// TUNING
// ------
// • responsiveness (default 0.5): 0.05–0.5. Higher = snappier camera; lower = smoother/laggier.
// • maxSpeed: cap (px/s). 0 = unlimited.
// • resumeOnRelease (default false): when idle panning stops, camera resumes following after a short grace.
// • idleMs: idle threshold used to consider movement "stopped" (client setting).
// • EMA alpha (internal, 0.25) reduces centroid jitter only when multiple tokens are selected.
//
// ===========================

const MODULE_ID = "follow-the-token";

// ---------------------------
// Runtime state
// ---------------------------
let _rafHandle = null;               // requestAnimationFrame handle
let _lastTs = performance.now();     // last frame timestamp
let _lastMoveTs = 0;                 // last time we detected controlled tokens movement

// Mouse state (0=LMB, 1=MMB, 2=RMB)
const _buttonsHeld = new Set();      // tracks held buttons during idle pan
let _suppressUntilTs = 0;            // suppress follow until this time (grace after release)
const RESUME_GRACE_MS = 50;          // small grace after releasing mouse to avoid snap

// DOM listener flags/refs for cleanup
let _domBlockersBound = false;
const _domHandlers = { pointerdown: null, mousedown: null, contextmenu: null };

// Track last pointer id to safely release capture
let _lastPointerId = null;

// ---------------------------
// Helpers
// ---------------------------
const _now = () => performance.now();

/** Returns the configured idle threshold (ms). Adds a small keep-alive cushion for multi-select. */
function _idleMs() {
  const base = Number(game.settings.get(MODULE_ID, "idleMs") ?? 300);
  const n = (canvas?.tokens?.controlled ?? []).length;
  const cushion = 180; // keep RAF alive a bit longer when multi-select to avoid churn
  return n > 1 ? Math.max(base, cushion) : base;
}

const _wasIdle = (now = _now()) => (now - _lastMoveTs) > _idleMs();
const _isMoving = (now = _now()) => !_wasIdle(now);
const _isMouseHeld = () => _buttonsHeld.size > 0;

const _isForceOn = () => Boolean(game.settings.get(MODULE_ID, "gmForceFollow"));
const _isCinematicOn = () => Boolean(game.settings.get(MODULE_ID, "gmCinematic"));
const _isLocalEnabled = () => Boolean(game.settings.get(MODULE_ID, "enabled"));
const _isFollowActive = () => _isCinematicOn() || _isForceOn() || _isLocalEnabled();

const _getGMSelectionIds = () => game.settings.get(MODULE_ID, "gmSelectionIds") || [];

function _isSuppressed() {
  if (!_isFollowActive()) return true;
  if (_isMoving()) return false;
  if (_isMouseHeld()) return true;
  if (_now() < _suppressUntilTs) return true;
  return false;
}

function _forceCancelPanButtons() {
  const view = canvas?.app?.view;
  if (!view) return;

  _buttonsHeld.clear();
  _suppressUntilTs = 0;

  try {
    if (_lastPointerId != null && view.hasPointerCapture?.(_lastPointerId)) {
      view.releasePointerCapture(_lastPointerId);
    }
  } catch (_) {}

  for (const btn of [1, 2]) {
    try { view.dispatchEvent(new PointerEvent("pointerup", { button: btn, buttons: 0, bubbles: true, pointerType: "mouse" })); } catch (_) {}
    try { view.dispatchEvent(new MouseEvent("mouseup", { button: btn, bubbles: true })); } catch (_) {}
    try { canvas?.stage?.emit?.("pointerup", { data: { button: btn } }); } catch (_) {}
  }
}

// ---------------------------
// GM Banner Manager (single container, black theme, priority: Cinematic > Force)
// ---------------------------
function _getBannerHost() {
  if (!game.user?.isGM) return null;
  let host = document.getElementById("ftt-banner-host");
  if (host) return host;

  host = document.createElement("div");
  host.id = "ftt-banner-host";
  host.style.position = "fixed";
  host.style.top = "12px";
  host.style.left = "50%";
  host.style.transform = "translateX(-50%)";
  host.style.zIndex = 10000;
  host.style.pointerEvents = "none";
  document.body.appendChild(host);
  return host;
}

function _renderGMBanners() {
  if (!game.user?.isGM) return;

  const host = _getBannerHost();
  if (!host) return;

  // Clear previous content
  host.innerHTML = "";

  // Priority: Cinematic overrides Force (only show one banner at a time)
  let key = null;
  if (_isCinematicOn()) key = "CFT.Banner.Cinematic";
  else if (_isForceOn()) key = "CFT.Banner.Force";

  if (!key) return;

  const el = document.createElement("div");
  el.id = "ftt-banner";
  el.style.display = "inline-block";
  el.style.padding = "6px 12px";
  el.style.fontWeight = "700";
  el.style.fontSize = "12px";
  el.style.letterSpacing = "0.08em";
  el.style.borderRadius = "6px";
  el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
  el.style.backdropFilter = "blur(4px)";
  el.style.color = "#fff";
  el.style.background = "rgba(0,0,0,0.85)";         // BLACK theme
  el.style.border = "1px solid rgba(255,255,255,0.12)";
  el.style.pointerEvents = "auto";
  el.textContent = game.i18n.localize(key);
  host.appendChild(el);
}

function _hideAllGMBanners() {
  const host = document.getElementById("ftt-banner-host");
  if (host) host.innerHTML = "";
}

// ---------------------------
// Settings & UI
// ---------------------------
Hooks.once("init", () => {
  console.log("[FTT] init v1.0.0 (Foundry v13.350)");

  // --- Client settings (per-user) ---
  game.settings.register(MODULE_ID, "enabled", {
    name: game.i18n.localize("CFT.Enabled.name"),
    hint: game.i18n.localize("CFT.Enabled.hint"),
    scope: "client", config: true, type: Boolean, default: true,
    onChange: _onEnabledChanged
  });

  game.settings.register(MODULE_ID, "retainZoom", {
    name: game.i18n.localize("CFT.RetainZoom.name"),
    hint: game.i18n.localize("CFT.RetainZoom.hint"),
    scope: "client", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "scale", {
    name: game.i18n.localize("CFT.Scale.name"),
    hint: game.i18n.localize("CFT.Scale.hint"),
    scope: "client", config: true, type: Number, default: 1.0,
    range: { min: 0.25, max: 3, step: 0.05 }
  });

  game.settings.register(MODULE_ID, "responsiveness", {
    name: game.i18n.localize("CFT.Responsiveness.name"),
    hint: game.i18n.localize("CFT.Responsiveness.hint"),
    scope: "client", config: true, type: Number, default: 0.5,
    range: { min: 0.05, max: 0.5, step: 0.01 }
  });

  game.settings.register(MODULE_ID, "maxSpeed", {
    name: game.i18n.localize("CFT.MaxSpeed.name"),
    hint: game.i18n.localize("CFT.MaxSpeed.hint"),
    scope: "client", config: true, type: Number, default: 0,
    range: { min: 0, max: 8000, step: 50 }
  });

  game.settings.register(MODULE_ID, "idleMs", {
    name: game.i18n.localize("CFT.IdleMs.name"),
    hint: game.i18n.localize("CFT.IdleMs.hint"),
    scope: "client", config: true, type: Number, default: 300,
    range: { min: 100, max: 2000, step: 50 }
  });

  game.settings.register(MODULE_ID, "resumeOnRelease", {
    name: game.i18n.localize("CFT.ResumeOnRelease.name"),
    hint: game.i18n.localize("CFT.ResumeOnRelease.hint"),
    scope: "client", config: true, type: Boolean, default: false
  });

  game.settings.register(MODULE_ID, "cinSnapshot", {
    name: "Cinematic Snapshot",
    hint: "Client snapshot for camera & flags restore.",
    scope: "client", config: false, type: Object, default: null
  });

  // --- World settings (GM authority) ---
  game.settings.register(MODULE_ID, "gmForceFollow", {
    name: game.i18n.localize("CFT.Force.name"),
    hint: game.i18n.localize("CFT.Force.hint"),
    scope: "world", config: false, type: Boolean, default: false,
    onChange: _onForceChanged
  });

  game.settings.register(MODULE_ID, "gmCinematic", {
    name: game.i18n.localize("CFT.Cinematic.name"),
    hint: game.i18n.localize("CFT.Cinematic.hint"),
    scope: "world", config: false, type: Boolean, default: false,
    onChange: _onCinematicChanged
  });

  game.settings.register(MODULE_ID, "gmSelectionIds", {
    name: "GM Selection (IDs)",
    hint: "Internal storage of GM-selected token IDs.",
    scope: "world", config: false, type: Array, default: []
  });

  // --- Keybindings ---
  game.keybindings.register(MODULE_ID, "toggleFollow", {
    name: game.i18n.localize("CFT.Toggle.name"),
    hint: game.i18n.localize("CFT.Toggle.name"),
    editable: [{ key: "KeyF", modifiers: ["Alt"] }],
    onDown: () => {
      if (_isCinematicOn() || _isForceOn()) {
        ui?.notifications?.warn(game.i18n.localize("CFT.Force.lockedPlayer"));
        return true;
      }
      const v = !_isLocalEnabled();
      game.settings.set(MODULE_ID, "enabled", v);
      ui.notifications?.info(v ? game.i18n.localize("CFT.Toggle.on")
                               : game.i18n.localize("CFT.Toggle.off"));
      return true;
    },
    precedence: (window.CONST?.KEYBINDING_PRECEDENCE?.NORMAL) ?? 100
  });

  game.keybindings.register(MODULE_ID, "toggleForceFollow", {
    name: game.i18n.localize("CFT.Force.kbName"),
    hint: game.i18n.localize("CFT.Force.kbHint"),
    editable: [{ key: "KeyF", modifiers: ["Control", "Alt"] }],
    restricted: true,
    onDown: async () => {
      if (!game.user?.isGM) return true;
      const v = !_isForceOn();
      await game.settings.set(MODULE_ID, "gmForceFollow", v);
      return true;
    },
    precedence: (window.CONST?.KEYBINDING_PRECEDENCE?.NORMAL) ?? 100
  });

  game.keybindings.register(MODULE_ID, "toggleCinematic", {
    name: game.i18n.localize("CFT.Cinematic.kbName"),
    hint: game.i18n.localize("CFT.Cinematic.kbHint"),
    editable: [{ key: "KeyF", modifiers: ["Control"] }],
    restricted: true,
    onDown: async () => {
      if (!game.user?.isGM) return true;
      const v = !_isCinematicOn();
      await game.settings.set(MODULE_ID, "gmCinematic", v);
      return true;
    },
    precedence: (window.CONST?.KEYBINDING_PRECEDENCE?.NORMAL) ?? 100
  });
});

// ---------------------------
// DOM-level RMB/MMB suppression while MOVING
// ---------------------------
function _bindDomMouseBlockers() {
  const view = canvas?.app?.view;
  if (!view || _domBlockersBound) return;

  const blockIfMoving = (e) => {
    const btn = e.button; // 1=MMB, 2=RMB
    if (_isMoving() && (btn === 1 || btn === 2)) {
      _forceCancelPanButtons();
      try { e.stopImmediatePropagation?.(); } catch(_) {}
      try { e.stopPropagation?.(); } catch(_) {}
      try { e.preventDefault?.(); } catch(_) {}
      return false;
    }
    return true;
  };

  _domHandlers.pointerdown = (e) => { blockIfMoving(e); };
  _domHandlers.mousedown   = (e) => { blockIfMoving(e); };
  _domHandlers.contextmenu = (e) => {
    if (_isMoving()) {
      _forceCancelPanButtons();
      try { e.preventDefault?.(); e.stopImmediatePropagation?.(); } catch(_) {}
    }
  };

  view.addEventListener("pointerdown", _domHandlers.pointerdown, true);
  view.addEventListener("mousedown",   _domHandlers.mousedown,   true);
  view.addEventListener("contextmenu", _domHandlers.contextmenu, true);

  _domBlockersBound = true;
}
function _unbindDomMouseBlockers() {
  const view = canvas?.app?.view;
  if (!view || !_domBlockersBound) return;
  view.removeEventListener("pointerdown", _domHandlers.pointerdown, true);
  view.removeEventListener("mousedown",   _domHandlers.mousedown,   true);
  view.removeEventListener("contextmenu", _domHandlers.contextmenu, true);
  _domBlockersBound = false;
}

// ---------------------------
// PIXI stage pointer (idle pan / moving block)
// ---------------------------
function _bindPixiPointer() {
  const stage = canvas?.stage;
  if (!stage) return;
  try {
    stage.eventMode = stage.eventMode || "static";
    stage.on("pointerdown", _onPointerDownStage);
    stage.on("pointerup", _onPointerUpStage);
    stage.on("pointerupoutside", _onPointerUpStage);
  } catch (e) { console.warn("[FTT] stage listeners not bound:", e); }
}
function _unbindPixiPointer() {
  const stage = canvas?.stage;
  if (!stage) return;
  try {
    stage.off("pointerdown", _onPointerDownStage);
    stage.off("pointerup", _onPointerUpStage);
    stage.off("pointerupoutside", _onPointerUpStage);
  } catch (e) {}
}

function _onPointerDownStage(ev) {
  const btn = ev?.data?.button; // 0=L, 1=M, 2=R
  _lastPointerId = ev?.data?.pointerId ?? null;

  if (btn !== 0 && btn !== 1 && btn !== 2) return;

  if (_isMoving()) {
    _forceCancelPanButtons();
    try { ev.stopPropagation?.(); } catch(_) {}
    try { ev?.data?.originalEvent?.stopImmediatePropagation?.(); } catch(_) {}
    try { ev?.data?.originalEvent?.preventDefault?.(); } catch(_) {}
    return;
  }

  _buttonsHeld.add(btn);
  _suppressUntilTs = Number.POSITIVE_INFINITY;
  _stopTicker();
}

function _onPointerUpStage(ev) {
  const btn = ev?.data?.button;
  if (btn !== 0 && btn !== 1 && btn !== 2) return;

  if (_isMoving()) return;

  _buttonsHeld.delete(btn);
  if (_buttonsHeld.size > 0) return;

  _suppressUntilTs = _now() + RESUME_GRACE_MS;

  const resume = game.settings.get(MODULE_ID, "resumeOnRelease") === true;
  if (resume) {
    setTimeout(() => {
      if (_isMoving() || _isMouseHeld()) return;
      const tokens = _getFollowTokens();
      const center = _getGroupCenter(tokens);
      if (center) {
        _setCenter(center.x, center.y, /*instant*/ false);
        _lastMoveTs = _now();
        _startTicker();
      }
    }, RESUME_GRACE_MS);
  }
}

// ---------------------------
// Core follow helpers
// ---------------------------
function _getFollowTokens() {
  if (_isCinematicOn()) {
    const ids = new Set(_getGMSelectionIds());
    const tokens = canvas?.tokens?.placeables?.filter(t => ids.has(t.document.id)) ?? [];
    return tokens;
  }
  return canvas?.tokens?.controlled ?? [];
}

let _prevTarget = null;

function _getGroupCenter(tokens) {
  if (!tokens || tokens.length === 0) { _prevTarget = null; return null; }

  let sx = 0, sy = 0;
  for (const t of tokens) { const c = t.center; sx += c.x; sy += c.y; }
  const n = tokens.length;
  const raw = { x: sx / n, y: sy / n };

  if (n === 1) { _prevTarget = raw; return raw; }

  const alpha = 0.25;
  if (!_prevTarget) { _prevTarget = raw; }
  _prevTarget = {
    x: _prevTarget.x + (raw.x - _prevTarget.x) * alpha,
    y: _prevTarget.y + (raw.y - _prevTarget.y) * alpha
  };
  return _prevTarget;
}

function _setCenter(x, y, instant = false) {
  if (!canvas?.animatePan) return;

  const opts = { x, y };
  if (!game.settings.get(MODULE_ID, "retainZoom")) {
    opts.scale = Number(game.settings.get(MODULE_ID, "scale") || 1.0);
  }

  const duration = instant ? 0 : 150;
  try { canvas.animatePan({ ...opts, duration }); } catch (e) {}
}

function _currentCenterWorld() {
  const view = canvas?.app?.renderer?.screen;
  const wt = canvas?.stage?.worldTransform;
  if (!view || !wt) return canvas.scene?.dimensions?.center || { x: 0, y: 0 };
  const cx = (view.width / 2 - wt.tx) / wt.a;
  const cy = (view.height / 2 - wt.ty) / wt.d;
  return { x: cx, y: cy };
}

// ---------------------------
// RAF ticker (movement-driven)
// ---------------------------
function _startTicker() {
  if (_rafHandle) return;
  _lastTs = _now();

  const step = (ts) => {
    if (!_isFollowActive()) { _stopTicker(); return; }

    if (!_isMoving(ts) && _isSuppressed()) {
      const n = (canvas?.tokens?.controlled ?? []).length;
      if (n <= 1) { _stopTicker(); return; }
    }

    const tokens = _getFollowTokens();
    if (!tokens.length) { _stopTicker(); return; }

    const dt = Math.max(0.001, (ts - _lastTs) / 1000);
    _lastTs = ts;

    const cur = _currentCenterWorld();
    const target = _getGroupCenter(tokens);
    if (target) {
      const dx = target.x - cur.x, dy = target.y - cur.y;
      const resp = Number(game.settings.get(MODULE_ID, "responsiveness") || 0.5);
      let stepX = dx * resp, stepY = dy * resp;

      const maxSpd = Number(game.settings.get(MODULE_ID, "maxSpeed") || 0);
      if (maxSpd > 0) {
        const len = Math.hypot(stepX, stepY), cap = maxSpd * dt;
        if (len > cap && len > 0) { const k = cap / len; stepX *= k; stepY *= k; }
      }

      _setCenter(cur.x + stepX, cur.y + stepY, /*instant*/ true);
    }

    if (!_isMoving(ts) && _isSuppressed()) { _stopTicker(); return; }
    _rafHandle = requestAnimationFrame(step);
  };

  _rafHandle = requestAnimationFrame(step);
}
function _stopTicker() {
  if (_rafHandle) cancelAnimationFrame(_rafHandle);
  _rafHandle = null;
}

// ---------------------------
// Event wiring
// ---------------------------
function _onEnabledChanged(enabled) {
  try { ui?.controls?.render(); } catch (_) {}
  if (!canvas?.ready) return;

  if (enabled) {
    // starts following immediately (even if it's already moving)
    _forceCancelPanButtons();
    _suppressUntilTs = 0;

    const tokens = _getFollowTokens();
    const center = _getGroupCenter(tokens);
    if (center) _setCenter(center.x, center.y, /*instant*/ true);

    _lastMoveTs = _now();
    _startTicker();
  } else if (!_isFollowActive()) {
    _stopTicker();
  }
}


function _onForceChanged(active) {
  try { ui?.controls?.render(); } catch (_) {}

  if (active) {
    if (game.user?.isGM) {
      ui.notifications?.info(game.i18n.localize("CFT.Force.enabledGM"));
    } else {
      ui.notifications?.warn(game.i18n.localize("CFT.Force.enabledPlayer"));
    }

    const center = _getGroupCenter(_getFollowTokens());
    if (center) _setCenter(center.x, center.y, /*instant*/ true);
    _lastMoveTs = _now();
    _startTicker();
  } else {
    if (game.user?.isGM) {
      ui.notifications?.info(game.i18n.localize("CFT.Force.disabledGM"));
    } else {
      ui.notifications?.info(game.i18n.localize("CFT.Force.disabledPlayer"));
    }
    if (!_isFollowActive()) _stopTicker();
  }

  // Re-render banners with correct priority (Force vs Cinematic)
  _renderGMBanners();
}

async function _onCinematicChanged(active) {
  try { ui?.controls?.render(); } catch (_) {}

  if (active) {
    // --- Signed in to Cinematic: Save snapshot of current client state ---
    const wt = canvas?.stage?.worldTransform;
    const view = canvas?.app?.renderer?.screen;
    const center = wt && view
      ? { x: (view.width / 2 - wt.tx) / wt.a, y: (view.height / 2 - wt.ty) / wt.d }
      : (canvas.scene?.dimensions?.center || { x: 0, y: 0 });

    const snap = {
      enabled: _isLocalEnabled(),
      scaleWasRetained: Boolean(game.settings.get(MODULE_ID, "retainZoom")),
      scale: Number(game.settings.get(MODULE_ID, "scale") || 1.0),
      center
    };
    try { await game.settings.set(MODULE_ID, "cinSnapshot", snap); } catch (_) {}

    if (game.user?.isGM) {
      ui.notifications?.info(game.i18n.localize("CFT.Cinematic.enabledGM"));
    } else {
      ui.notifications?.warn(game.i18n.localize("CFT.Cinematic.enabledPlayer"));
    }

    const c = _getGroupCenter(_getFollowTokens());
    if (c) _setCenter(c.x, c.y, /*instant*/ true);
    _lastMoveTs = _now();
    _startTicker();
    _renderGMBanners();
    return;
  }

  // --- Left Cinematic: restore exactly what was before ---
  const snap = game.settings.get(MODULE_ID, "cinSnapshot") || null;
  const wasFollowEnabled = !!(snap?.enabled);

  if (game.user?.isGM) {
    // GM: não fazer rollback de câmera; apenas restaurar o flag enabled como antes
    await game.settings.set(MODULE_ID, "enabled", wasFollowEnabled);
    if (wasFollowEnabled) {
      _lastMoveTs = _now();
      _startTicker();
    } else if (!_isFollowActive()) {
      _stopTicker();
    }
  } else {
    // Player: if you didn't have a follow before, go back to the camera to the snapshot;
    // if it had, keep it glued to the token (no camera rollback)
    await game.settings.set(MODULE_ID, "enabled", wasFollowEnabled);

    if (wasFollowEnabled) {
      const tokens = _getFollowTokens();
      const center = _getGroupCenter(tokens);
      if (center) _setCenter(center.x, center.y, /*instant*/ true);
      _lastMoveTs = _now();
      _startTicker();
    } else {
      const opts = { x: snap?.center?.x ?? 0, y: snap?.center?.y ?? 0 };
      if (!snap?.scaleWasRetained) opts.scale = Number(snap?.scale || 1.0);
      try { canvas.animatePan({ ...opts, duration: 150 }); } catch (_) {}
      if (!_isFollowActive()) _stopTicker();
    }
  }

  if (game.user?.isGM) {
    ui.notifications?.info(game.i18n.localize("CFT.Cinematic.disabledGM"));
  } else {
    ui.notifications?.info(game.i18n.localize("CFT.Cinematic.disabledPlayer"));
  }

  _renderGMBanners();
}

Hooks.on("ready", () => {
  // Reflect current state when loading the world
  if (game.user?.isGM) _renderGMBanners();
});

Hooks.on("canvasReady", () => {
  _bindDomMouseBlockers();
  _bindPixiPointer();
  // Re-apply banner after canvas DOM recreation
  if (game.user?.isGM) _renderGMBanners();
});

Hooks.on("canvasTearDown", () => {
  _unbindDomMouseBlockers();
  _unbindPixiPointer();
  _stopTicker();
  _hideAllGMBanners();
});

// GM broadcasts current selection (used by Cinematic)
Hooks.on("controlToken", async () => {
  if (game.user?.isGM) {
    const ids = (canvas?.tokens?.controlled ?? []).map(t => t.document.id);
    try { await game.settings.set(MODULE_ID, "gmSelectionIds", ids); } catch (_) {}
  }
});

// Block non-GM movement during Cinematic
Hooks.on("preUpdateToken", (doc, change) => {
  if (!_isCinematicOn()) return;
  if (game.user?.isGM) return;
  if ("x" in change || "y" in change || "elevation" in change || "rotation" in change) return false;
});

// Movement follow driver
Hooks.on("updateToken", (doc, changes) => {
  if (!_isFollowActive()) return;
  if (!("x" in changes || "y" in changes)) return;

  if (_isCinematicOn()) {
    const gmIds = new Set(_getGMSelectionIds());
    if (!gmIds.has(doc.id)) return;
  } else {
    const myIds = new Set((canvas?.tokens?.controlled ?? []).map(t => t.document.id));
    if (!myIds.has(doc.id)) return;
  }

  const now = _now();
  const startingMovement = _wasIdle(now);

  if (startingMovement) {
    _forceCancelPanButtons();
    const tokens = _getFollowTokens();
    const center = _getGroupCenter(tokens);
    if (center) _setCenter(center.x, center.y, /*instant*/ true);
  }

  _lastMoveTs = now;
  _startTicker();
});

// Stop ticker if selection disappears
Hooks.on("deleteToken", () => {
  if (!_isFollowActive()) return;
  const tokens = _getFollowTokens();
  if (!tokens.length) _stopTicker();
});
