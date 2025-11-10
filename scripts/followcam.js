// ===========================
// File: scripts/followcam.js  (Foundry v13.350)
// Version: 1.2.0
// Module ID: follow-the-token
// ===========================
//
// Follow The Token
//
// KEYBINDINGS
// -----------
// • Alt+F (client): Local Follow
//   - Toggles camera follow on YOUR currently controlled tokens.
//   - Works for both players and GM.
// • Ctrl+Alt+F (GM-only): Force Follow
//   - Forces ALL PLAYERS to keep follow ON for their own tokens.
//   - The GM is not forced and keeps full control over their own Alt+F toggle.
// • Ctrl+F (GM-only): Cinematic Lock
//   - Classic mode (default):
//       • All clients (players + GM) focus on the GM’s selected tokens.
//       • The GM is “locked” to the token while Cinematic is active.
//   - New camera mode (world setting `gmCinematicFollowCamera`):
//       • GM is free to release the token and move the camera (pan, zoom, rotate).
//       • All players mirror the GM camera 1:1 (position, zoom, rotation).
//       • Players cannot interact with the canvas while Cinematic is active.
//
// PLAYER RESTRICTIONS IN ANY CINEMATIC (classic OR camera mode)
// -------------------------------------------------------------
// While Cinematic is ON, for all players:
//  - No pan with MMB or RMB.
//  - No zoom (mouse wheel).
//  - No follow control: Alt+F and “return to token” (TAB, double-click, etc.) are locked.
//  - No clicks or interaction on the canvas (stage eventMode="none").
//  - No camera rotation: any attempt is immediately reverted to the GM state.
// Everything is restored to normal only when the GM disables Cinematic.
//
// NOTIFICATIONS (types; GM banner is always black)
// ------------------------------------------------
//  - Alt+F (toggle follow): BLUE   -> ui.notifications.info
//  - Ctrl+Alt+F (Force Follow): YELLOW -> ui.notifications.warn
//  - Ctrl+F (Cinematic): RED -> ui.notifications.error
//
// ===========================

const MODULE_ID = "follow-the-token";

// ---------------------------
// Runtime state
// ---------------------------
let _rafHandle = null;           // requestAnimationFrame handle for the follow loop
let _lastTs = performance.now(); // last animation frame timestamp
let _lastMoveTs = 0;             // last time a followed token moved

// Mouse state (0=LMB, 1=MMB, 2=RMB) during free pan
const _buttonsHeld = new Set();
let _suppressUntilTs = 0;
const RESUME_GRACE_MS = 50;

// DOM listener flags/refs
let _domBlockersBound = false;
const _domHandlers = {
  pointerdown: null,
  mousedown: null,
  contextmenu: null,
  wheel: null
};

// Track last pointer id (for cleaning pointer capture)
let _lastPointerId = null;

// GM camera watcher (for Cinematic: keep zoom and rotation in sync for players)
let _gmCameraWatchRaf = null;
let _gmCameraWatchLast = null;

// Stage lock for players in Cinematic
let _prevStageEventMode = null;
let _prevStageInteractiveChildren = null;

// Guard to avoid feedback loops in canvasPan
let _squelchCanvasPan = false;

// Guard to avoid infinite loops when restoring locked selection in Cinematic
let _lockSelectionGuard = false;

// ---------------------------
// Helpers
// ---------------------------
const _now = () => performance.now();

/**
 * Idle threshold (ms), with a small cushion when multiple tokens are selected.
 */
function _idleMs() {
  const base = Number(game.settings.get(MODULE_ID, "idleMs") ?? 300);
  const n = (canvas?.tokens?.controlled ?? []).length;
  const cushion = 180;
  return n > 1 ? Math.max(base, cushion) : base;
}

const _wasIdle = (now = _now()) => (now - _lastMoveTs) > _idleMs();
const _isMoving = (now = _now()) => !_wasIdle(now);
const _isMouseHeld = () => _buttonsHeld.size > 0;

const _isForceOnGlobal = () => Boolean(game.settings.get(MODULE_ID, "gmForceFollow"));
const _isForceOnForMe = () => _isForceOnGlobal() && !game.user?.isGM;
const _isForceOn = _isForceOnGlobal;

const _isCinematicOn = () => Boolean(game.settings.get(MODULE_ID, "gmCinematic"));
const _isLocalEnabled = () => Boolean(game.settings.get(MODULE_ID, "enabled"));

const _getGMSelectionIds = () => game.settings.get(MODULE_ID, "gmSelectionIds") || [];

/**
 * World setting indicating if Cinematic is in "GM camera" mode or classic token-follow mode.
 */
const _isCinematicCameraMode = () =>
  Boolean(game.settings.get(MODULE_ID, "gmCinematicFollowCamera"));

/**
 * GM camera state stored as a world setting.
 */
const _getGmCameraState = () => game.settings.get(MODULE_ID, "gmCameraState") || null;

/**
 * Per-client snapshot saved before entering Cinematic.
 */
function _getCinSnapshot() {
  return game.settings.get(MODULE_ID, "cinSnapshot") || null;
}

/**
 * Determines if FOLLOW (ticker) should be active for this user.
 */
function _isFollowActive() {
  if (_isCinematicOn()) {
    if (_isCinematicCameraMode()) {
      if (game.user?.isGM) return _isLocalEnabled();
      return false;
    }
    return true;
  }

  if (game.user?.isGM) return _isLocalEnabled();
  return _isForceOnForMe() || _isLocalEnabled();
}

/**
 * Determines if follow should be temporarily suppressed (e.g. after mouse pan).
 */
function _isSuppressed() {
  if (!_isFollowActive()) return true;
  if (_isMoving()) return false;
  if (_isMouseHeld()) return true;
  if (_now() < _suppressUntilTs) return true;
  return false;
}

/**
 * Cancels any ongoing pan at DOM + PIXI level.
 */
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
    try {
      view.dispatchEvent(new PointerEvent("pointerup", {
        button: btn,
        buttons: 0,
        bubbles: true,
        pointerType: "mouse"
      }));
    } catch (_) {}
    try {
      view.dispatchEvent(new MouseEvent("mouseup", { button: btn, bubbles: true }));
    } catch (_) {}
    try {
      canvas?.stage?.emit?.("pointerup", { data: { button: btn } });
    } catch (_) {}
  }
}

// ---------------------------
// GM Banner (black, priority: Cinematic > Force)
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

/**
 * Render a single GM banner, with priority: Cinematic > Force.
 */
function _renderGMBanners() {
  if (!game.user?.isGM) return;

  const host = _getBannerHost();
  if (!host) return;

  host.innerHTML = "";

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
  el.style.background = "rgba(0,0,0,0.85)";
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
// GM CAMERA STATE (zoom and rotation for any Cinematic mode)
// ---------------------------

/**
 * Build a snapshot of the GM camera state based on the current view position.
 */
function _buildGmCameraState(reason = "pan") {
  const scene = canvas?.scene;
  if (!scene) return null;
  const vp = scene._viewPosition || {};
  const stage = canvas.stage;

  return {
    sceneId: scene.id,
    x: vp.x ?? 0,
    y: vp.y ?? 0,
    scale: vp.scale ?? 1,
    rotation: stage?.rotation ?? 0,
    reason
  };
}

/**
 * Store the GM camera state in the world setting while Cinematic is on.
 */
async function _pushGmCameraState(reason = "pan") {
  if (!game.user?.isGM) return;
  if (!_isCinematicOn()) return;

  const state = _buildGmCameraState(reason);
  if (!state) return;

  try {
    await game.settings.set(MODULE_ID, "gmCameraState", state);
  } catch (e) {
    console.error("[FTT] set gmCameraState failed", e);
  }
}

/**
 * Start a loop that watches the GM camera for changes and broadcasts them to players.
 */
function _startGmCameraWatcher() {
  if (!game.user?.isGM) return;
  if (!_isCinematicOn()) return;
  if (_gmCameraWatchRaf) return;

  const loop = () => {
    if (!game.user?.isGM || !_isCinematicOn()) {
      _stopGmCameraWatcher();
      return;
    }

    const state = _buildGmCameraState("watch");
    if (state) {
      const prev = _gmCameraWatchLast;
      const epsPos = 0.25;
      const epsScale = 1e-4;
      const epsRot = 1e-4;
      let changed = false;

      if (!prev) changed = true;
      else if (Math.hypot(state.x - prev.x, state.y - prev.y) > epsPos) changed = true;
      else if (Math.abs(state.scale - prev.scale) > epsScale) changed = true;
      else if (Math.abs(state.rotation - prev.rotation) > epsRot) changed = true;

      if (changed) {
        _gmCameraWatchLast = state;
        game.settings.set(MODULE_ID, "gmCameraState", state).catch(e => {
          console.error("[FTT] set gmCameraState (watch) failed:", e);
        });
      }
    }

    _gmCameraWatchRaf = requestAnimationFrame(loop);
  };

  _gmCameraWatchRaf = requestAnimationFrame(loop);
}

function _stopGmCameraWatcher() {
  if (_gmCameraWatchRaf) cancelAnimationFrame(_gmCameraWatchRaf);
  _gmCameraWatchRaf = null;
  _gmCameraWatchLast = null;
}

/**
 * Apply a GM camera state to a player client.
 */
function _applyGmCameraState(state, { instant = false } = {}) {
  if (!state) return;
  if (!_isCinematicOn()) return;
  if (game.user?.isGM) return;
  if (!canvas?.scene || canvas.scene.id !== state.sceneId) return;

  const x = state.x ?? 0;
  const y = state.y ?? 0;
  const scale = state.scale ?? 1;
  const rotation = state.rotation ?? 0;

  try {
    if (_isCinematicCameraMode()) {
      canvas.animatePan({
        x,
        y,
        scale,
        duration: instant ? 0 : 0
      });
    } else {
      canvas.animatePan({
        scale,
        duration: instant ? 0 : 0
      });
    }
  } catch (e) {
    console.error("[FTT] animatePan (gmCameraState) failed", e);
  }

  try {
    if (canvas.stage) {
      canvas.stage.rotation = rotation;
    }
  } catch (e) {
    console.warn("[FTT] stage rotation apply failed:", e);
  }

  // Notify rotate-camera-8d / compass about the effective rotation on this client
  try {
    const angleRad = rotation;
    const angleDeg = (angleRad * 180) / Math.PI;

    // Map angle to 0..7 steps of 45°
    const cameraStep = ((Math.round(angleDeg / 45) % 8) + 8) % 8;

    // Best-effort center in world coordinates
    const center = _currentCenterWorld();

    // Optional: keep RotatingCamera8D internal state in sync on players
    const rc = window.RotatingCamera8D;
    if (rc) {
      rc.displayAngleDeg = angleDeg;
      rc.cameraStep = cameraStep;
    }

    // Main hook used by your compass overlay
    Hooks.callAll("rotateCamera8dRotated", {
      angleDeg,
      angleRad,
      cameraStep,
      center
    });
  } catch (e) {
    console.warn("[FTT] notify rotate-camera-8d failed:", e);
  }
}

/**
 * Listener for gmCameraState changes: used by players to sync with the GM camera.
 */
function _onGmCameraStateChanged(state) {
  if (!_isCinematicOn()) return;
  if (game.user?.isGM) return;
  if (!state) return;

  _applyGmCameraState(state, { instant: false });
}

// ---------------------------
// Core follow helpers
// ---------------------------

/**
 * Determine which tokens we should follow based on current mode.
 */
function _getFollowTokens() {
  if (_isCinematicOn() && !_isCinematicCameraMode()) {
    const ids = new Set(_getGMSelectionIds());
    const tokens = canvas?.tokens?.placeables?.filter(t => ids.has(t.document.id)) ?? [];
    return tokens;
  }
  return canvas?.tokens?.controlled ?? [];
}

let _prevTarget = null;

/**
 * Compute the smoothed center of the followed tokens (EMA when multi-select).
 */
function _getGroupCenter(tokens) {
  if (!tokens || tokens.length === 0) { _prevTarget = null; return null; }

  let sx = 0, sy = 0;
  for (const t of tokens) {
    const c = t.center;
    sx += c.x;
    sy += c.y;
  }
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

/**
 * Soft pan the camera toward (x, y). Optionally instant.
 */
function _setCenter(x, y, instant = false) {
  if (!canvas?.animatePan) return;

  const opts = { x, y };

  // Respect retainZoom, except in Cinematic camera mode (GM camera drives zoom).
  if (!game.settings.get(MODULE_ID, "retainZoom") && !(_isCinematicOn() && _isCinematicCameraMode())) {
    opts.scale = Number(game.settings.get(MODULE_ID, "scale") || 1.0);
  }

  const duration = instant ? 0 : 150;
  try {
    canvas.animatePan({ ...opts, duration });
  } catch (e) {}

  // In any Cinematic, GM camera moves should be propagated to players.
  if (game.user?.isGM && _isCinematicOn()) {
    _pushGmCameraState("follow").catch(() => {});
  }
}

/**
 * Compute the world coordinate of the current screen center, robust to rotation.
 */
function _currentCenterWorld() {
  const view = canvas?.app?.renderer?.screen;
  const interaction = canvas?.app?.renderer?.plugins?.interaction
    || canvas?.app?.renderer?.plugins?.eventSystem;
  const stage = canvas?.stage;

  if (!view || !stage) return canvas.scene?.dimensions?.center || { x: 0, y: 0 };

  try {
    if (interaction && typeof interaction.mapPositionToPoint === "function" &&
        typeof stage.toLocal === "function") {
      const px = view.width / 2;
      const py = view.height / 2;
      const p = new PIXI.Point();
      interaction.mapPositionToPoint(p, px, py);
      if (typeof stage.updateTransform === "function") stage.updateTransform();
      const worldPoint = stage.toLocal(p);
      return { x: worldPoint.x, y: worldPoint.y };
    }
  } catch (err) {
    console.warn("[FTT] robust center mapping failed:", err);
  }

  try {
    const wt = stage.worldTransform;
    const sx = view.width / 2;
    const sy = view.height / 2;
    const dx = sx - wt.tx;
    const dy = sy - wt.ty;
    const a = wt.a, b = wt.b, c = wt.c, d = wt.d;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-8) return canvas.scene?.dimensions?.center || { x: 0, y: 0 };
    const lx = (d * dx - c * dy) / det;
    const ly = (-b * dx + a * dy) / det;
    return { x: lx, y: ly };
  } catch (err) {
    console.warn("[FTT] center fallback failed:", err);
    return canvas.scene?.dimensions?.center || { x: 0, y: 0 };
  }
}

// ---------------------------
// RAF ticker (smoothed follow)
// ---------------------------
function _startTicker() {
  if (_rafHandle) return;
  _lastTs = _now();

  const step = (ts) => {
    if (!_isFollowActive()) { _stopTicker(); return; }

    if (_isMouseHeld()) {
      _rafHandle = requestAnimationFrame(step);
      return;
    }

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
      const dx = target.x - cur.x;
      const dy = target.y - cur.y;
      const resp = Number(game.settings.get(MODULE_ID, "responsiveness") || 0.5);
      let stepX = dx * resp;
      let stepY = dy * resp;

      const maxSpd = Number(game.settings.get(MODULE_ID, "maxSpeed") || 0);
      if (maxSpd > 0) {
        const len = Math.hypot(stepX, stepY);
        const cap = maxSpd * dt;
        if (len > cap && len > 0) {
          const k = cap / len;
          stepX *= k;
          stepY *= k;
        }
      }

      _setCenter(cur.x + stepX, cur.y + stepY, true);
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
// DOM-level RMB/MMB + zoom blocking
// ---------------------------
function _bindDomMouseBlockers() {
  const view = canvas?.app?.view;
  if (!view || _domBlockersBound) return;

  const blockIfMovingOrCinematic = (e) => {
    const btn = e.button;

    // In any Cinematic, prevent MMB/RMB pans for players
    if (_isCinematicOn() && !game.user?.isGM && (btn === 1 || btn === 2)) {
      try { e.stopImmediatePropagation?.(); } catch (_) {}
      try { e.stopPropagation?.(); } catch (_) {}
      try { e.preventDefault?.(); } catch (_) {}
      return false;
    }

    // While a followed token is moving, kill RMB/MMB pans
    if (_isMoving() && (btn === 1 || btn === 2)) {
      _forceCancelPanButtons();
      try { e.stopImmediatePropagation?.(); } catch (_) {}
      try { e.stopPropagation?.(); } catch (_) {}
      try { e.preventDefault?.(); } catch (_) {}
      return false;
    }
    return true;
  };

  _domHandlers.pointerdown = (e) => { blockIfMovingOrCinematic(e); };
  _domHandlers.mousedown   = (e) => { blockIfMovingOrCinematic(e); };
  _domHandlers.contextmenu = (e) => {
    if (_isCinematicOn() && !game.user?.isGM) {
      try { e.preventDefault?.(); e.stopImmediatePropagation?.(); } catch (_) {}
      return;
    }
    if (_isMoving()) {
      _forceCancelPanButtons();
      try { e.preventDefault?.(); e.stopImmediatePropagation?.(); } catch (_) {}
    }
  };

  // Mouse wheel: block zoom for players in Cinematic
  _domHandlers.wheel = (e) => {
    if (_isCinematicOn() && !game.user?.isGM) {
      try { e.preventDefault?.(); } catch (_) {}
      try { e.stopImmediatePropagation?.(); } catch (_) {}
      try { e.stopPropagation?.(); } catch (_) {}
      return false;
    }
    return true;
  };

  view.addEventListener("pointerdown", _domHandlers.pointerdown, true);
  view.addEventListener("mousedown",   _domHandlers.mousedown,   true);
  view.addEventListener("contextmenu", _domHandlers.contextmenu, true);
  view.addEventListener("wheel",       _domHandlers.wheel,       { capture: true, passive: false });

  _domBlockersBound = true;
}

function _unbindDomMouseBlockers() {
  const view = canvas?.app?.view;
  if (!view || !_domBlockersBound) return;
  view.removeEventListener("pointerdown", _domHandlers.pointerdown, true);
  view.removeEventListener("mousedown",   _domHandlers.mousedown,   true);
  view.removeEventListener("contextmenu", _domHandlers.contextmenu, true);
  view.removeEventListener("wheel",       _domHandlers.wheel,       { capture: true });
  _domBlockersBound = false;
}

// ---------------------------
// PIXI stage pointer handlers
// ---------------------------
function _bindPixiPointer() {
  const stage = canvas?.stage;
  if (!stage) return;
  try {
    stage.eventMode = stage.eventMode || "static";
    stage.on("pointerdown", _onPointerDownStage);
    stage.on("pointerup", _onPointerUpStage);
    stage.on("pointerupoutside", _onPointerUpStage);
  } catch (e) {
    console.warn("[FTT] stage listeners not bound:", e);
  }
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

/**
 * Stage-level pointerdown: used to detect pans and block them when necessary.
 */
function _onPointerDownStage(ev) {
  const btn = ev?.data?.button;
  _lastPointerId = ev?.data?.pointerId ?? null;

  if (btn !== 0 && btn !== 1 && btn !== 2) return;

  // In Cinematic, players cannot pan with MMB/RMB
  if (_isCinematicOn() && !game.user?.isGM && (btn === 1 || btn === 2)) {
    try { ev.stopPropagation?.(); } catch (_) {}
    try { ev?.data?.originalEvent?.stopImmediatePropagation?.(); } catch (_) {}
    try { ev?.data?.originalEvent?.preventDefault?.(); } catch (_) {}
    return;
  }

  // While a followed token is moving, kill RMB/MMB pans
  if (_isMoving() && (btn === 1 || btn === 2)) {
    _forceCancelPanButtons();
    try { ev.stopPropagation?.(); } catch (_) {}
    try { ev?.data?.originalEvent?.stopImmediatePropagation?.(); } catch (_) {}
    try { ev?.data?.originalEvent?.preventDefault?.(); } catch (_) {}
    return;
  }

  _buttonsHeld.add(btn);
  _suppressUntilTs = Number.POSITIVE_INFINITY;
  _stopTicker();
}

/**
 * Stage-level pointerup: used to resume follow after idle pan if configured.
 */
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
        _setCenter(center.x, center.y, false);
        _lastMoveTs = _now();
        _startTicker();
      }
    }, RESUME_GRACE_MS);
  }
}

// ---------------------------
// Event wiring (enabled, force, cinematic, mode)
// ---------------------------

/**
 * Local enabled/disabled (Alt+F) changed.
 */
function _onEnabledChanged(enabled) {
  try { ui?.controls?.render(); } catch (_) {}
  if (!canvas?.ready) return;

  if (enabled) {
    _forceCancelPanButtons();
    _suppressUntilTs = 0;

    const tokens = _getFollowTokens();
    const center = _getGroupCenter(tokens);
    if (center) _setCenter(center.x, center.y, true);

    _lastMoveTs = _now();
    _startTicker();
  } else if (!_isFollowActive()) {
    _stopTicker();
  }
}

/**
 * Force Follow (GM world toggle) changed.
 */
function _onForceChanged(active) {
  try { ui?.controls?.render(); } catch (_) {}

  if (active) {
    if (game.user?.isGM) {
      ui.notifications?.warn(game.i18n.localize("CFT.Force.enabledGM"));
      if (_isLocalEnabled()) {
        const center = _getGroupCenter(_getFollowTokens());
        if (center) _setCenter(center.x, center.y, true);
        _lastMoveTs = _now();
        _startTicker();
      }
    } else {
      ui.notifications?.warn(game.i18n.localize("CFT.Force.enabledPlayer"));
      const center = _getGroupCenter(_getFollowTokens());
      if (center) _setCenter(center.x, center.y, true);
      _lastMoveTs = _now();
      _startTicker();
    }
  } else {
    if (game.user?.isGM) {
      ui.notifications?.warn(game.i18n.localize("CFT.Force.disabledGM"));
    } else {
      ui.notifications?.warn(game.i18n.localize("CFT.Force.disabledPlayer"));
    }

    if (!_isFollowActive()) _stopTicker();
  }

  _renderGMBanners();
}

/**
 * World setting gmCinematicFollowCamera changed (switch between classic vs GM camera mode).
 */
function _onCinematicModeChanged(isCameraMode) {
  const camMode = Boolean(isCameraMode);

  if (!game.settings.get(MODULE_ID, "gmCinematic")) return;

  if (!game.user?.isGM) {
    const state = _getGmCameraState();
    if (state) _applyGmCameraState(state, { instant: true });
    return;
  }

  let snap = _getCinSnapshot() || {};
  const currentlyEnabled = _isLocalEnabled();

  if (!camMode) {
    snap.preClassicEnabledGM = currentlyEnabled;
    try { game.settings.set(MODULE_ID, "cinSnapshot", snap); } catch (_) {}

    if (!currentlyEnabled) {
      game.settings.set(MODULE_ID, "enabled", true);
    }

    const c = _getGroupCenter(_getFollowTokens());
    if (c) _setCenter(c.x, c.y, true);
    _lastMoveTs = _now();
    _startTicker();

    _pushGmCameraState("modeSwitchClassic").catch(() => {});
    _startGmCameraWatcher();
  } else {
    if (!currentlyEnabled) {
      _stopTicker();
    }
    _pushGmCameraState("modeSwitchCamera").catch(() => {});
    _startGmCameraWatcher();
  }
}

/**
 * World toggle gmCinematic changed (Cinematic on/off).
 */
async function _onCinematicChanged(active) {
  try { ui?.controls?.render(); } catch (_) {}

  const camMode = _isCinematicCameraMode();

  if (active) {
    const center = _currentCenterWorld();
    const rotation = canvas?.stage?.rotation ?? 0;
    const beforeEnabled = _isLocalEnabled();
    const lockedTokenIds = (canvas?.tokens?.controlled ?? []).map(t => t.document.id);

    const controlsState = ui?.controls ? {
      collapsed: ui.controls._collapsed ?? false,
      activeControl: ui.controls.activeControl ?? null
    } : null;

    const snap = {
      enabled: beforeEnabled,
      scaleWasRetained: Boolean(game.settings.get(MODULE_ID, "retainZoom")),
      scale: Number(game.settings.get(MODULE_ID, "scale") || 1.0),
      center,
      rotation,
      modeAtStart: camMode ? "camera" : "classic",
      preClassicEnabledGM: (game.user?.isGM && !camMode) ? beforeEnabled : null,
      lockedTokenIds,
      controls: controlsState
    };
    try { await game.settings.set(MODULE_ID, "cinSnapshot", snap); } catch (_) {}

    if (game.user?.isGM) {
      ui.notifications?.error(game.i18n.localize("CFT.Cinematic.enabledGM"));
    } else {
      ui.notifications?.error(game.i18n.localize("CFT.Cinematic.enabledPlayer"));
    }

    // Player path: lock canvas interaction and sync to GM camera
    if (!game.user?.isGM) {
      const stage = canvas?.stage;
      if (stage) {
        _prevStageEventMode = stage.eventMode ?? "static";
        _prevStageInteractiveChildren = stage.interactiveChildren;
        stage.eventMode = "none";
        stage.interactiveChildren = false;
      }

      if (ui?.controls) {
        ui.controls._collapsed = true;
        ui.controls.activeControl = null;
        ui.controls.render(true);
      }

      const state = _getGmCameraState();
      _applyGmCameraState(state, { instant: true });
      _renderGMBanners();
      return;
    }

    // GM path
    if (camMode) {
      await _pushGmCameraState("cinCameraOn");
      _startGmCameraWatcher();
      _renderGMBanners();
      return;
    }

    if (!beforeEnabled) {
      await game.settings.set(MODULE_ID, "enabled", true);
    }

    const c = _getGroupCenter(_getFollowTokens());
    if (c) _setCenter(c.x, c.y, true);
    _lastMoveTs = _now();
    _startTicker();

    await _pushGmCameraState("cinClassicOn");
    _startGmCameraWatcher();
    _renderGMBanners();
    return;
  }

  // Turning Cinematic OFF
  _stopGmCameraWatcher();

  const snap = _getCinSnapshot();
  const wasFollowEnabled = !!(snap?.enabled);
  const snapRotation = typeof snap?.rotation === "number" ? snap.rotation : 0;

  if (game.user?.isGM) {
    const camModeNow = _isCinematicCameraMode();
    const preClassic = (snap && typeof snap.preClassicEnabledGM === "boolean")
      ? snap.preClassicEnabledGM
      : wasFollowEnabled;

    if (camModeNow) {
      const stillEnabled = _isLocalEnabled();
      if (stillEnabled) {
        _lastMoveTs = _now();
        _startTicker();
      } else {
        _stopTicker();
      }
    } else {
      await game.settings.set(MODULE_ID, "enabled", preClassic);
      if (preClassic) {
        _lastMoveTs = _now();
        _startTicker();
      } else {
        _stopTicker();
      }
    }

    ui.notifications?.error(game.i18n.localize("CFT.Cinematic.disabledGM"));
    if (_isForceOn()) {
      ui.notifications?.warn(game.i18n.localize("CFT.Cinematic.reminderForceGM"));
    }
  } else {
    // Player restore path
    const stage = canvas?.stage;
    if (stage) {
      stage.eventMode = _prevStageEventMode ?? "static";
      stage.interactiveChildren = (_prevStageInteractiveChildren ?? true);
      stage.rotation = snapRotation;
    }

    try {
      const angleRad = stage?.rotation ?? 0;
      const angleDeg = (angleRad * 180) / Math.PI;

      // Converte o ângulo atual de volta para 0..7 steps de 45°
      const cameraStep = ((Math.round(angleDeg / 45) % 8) + 8) % 8;

      // Pode usar o centro salvo no snapshot ou o centro atual
      const center = snap?.center ?? _currentCenterWorld?.() ?? { x: 0, y: 0 };

      // Mantém o estado interno do rotate-camera-8d em sincronia
      const rc = window.RotatingCamera8D;
      if (rc) {
        rc.displayAngleDeg = angleDeg;
        rc.cameraStep = cameraStep;
      }

      // Notifica a bússola / overlays que a rotação “voltou” para o jogador
      Hooks.callAll("rotateCamera8dRotated", {
        angleDeg,
        angleRad,
        cameraStep,
        center
      });
    } catch (e) {
      console.warn("[FTT] restore rotate-camera-8d after Cinematic failed:", e);
    }

    await game.settings.set(MODULE_ID, "enabled", wasFollowEnabled);

    const opts = { x: snap?.center?.x ?? 0, y: snap?.center?.y ?? 0 };
    if (!snap?.scaleWasRetained) opts.scale = Number(snap?.scale || 1.0);
    try { canvas.animatePan({ ...opts, duration: 150 }); } catch (_) {}

    if (wasFollowEnabled) {
      _lastMoveTs = _now();
      _startTicker();
    } else if (!_isFollowActive()) {
      _stopTicker();
    }

    ui.notifications?.error(game.i18n.localize("CFT.Cinematic.disabledPlayer"));
    if (_isForceOnForMe()) {
      ui.notifications?.warn(game.i18n.localize("CFT.Cinematic.reminderForcePlayer"));
    }
  }

  _renderGMBanners();
}

// ---------------------------
// Settings and UI
// ---------------------------
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: game.i18n.localize("CFT.Enabled.name"),
    hint: game.i18n.localize("CFT.Enabled.hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: _onEnabledChanged
  });

  game.settings.register(MODULE_ID, "retainZoom", {
    name: game.i18n.localize("CFT.RetainZoom.name"),
    hint: game.i18n.localize("CFT.RetainZoom.hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "scale", {
    name: game.i18n.localize("CFT.Scale.name"),
    hint: game.i18n.localize("CFT.Scale.hint"),
    scope: "client",
    config: true,
    type: Number,
    default: 1.0,
    range: { min: 0.25, max: 3, step: 0.05 }
  });

  game.settings.register(MODULE_ID, "responsiveness", {
    name: game.i18n.localize("CFT.Responsiveness.name"),
    hint: game.i18n.localize("CFT.Responsiveness.hint"),
    scope: "client",
    config: true,
    type: Number,
    default: 0.5,
    range: { min: 0.05, max: 0.5, step: 0.01 }
  });

  game.settings.register(MODULE_ID, "maxSpeed", {
    name: game.i18n.localize("CFT.MaxSpeed.name"),
    hint: game.i18n.localize("CFT.MaxSpeed.hint"),
    scope: "client",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 8000, step: 50 }
  });

  game.settings.register(MODULE_ID, "idleMs", {
    name: game.i18n.localize("CFT.IdleMs.name"),
    hint: game.i18n.localize("CFT.IdleMs.hint"),
    scope: "client",
    config: true,
    type: Number,
    default: 300,
    range: { min: 100, max: 2000, step: 50 }
  });

  game.settings.register(MODULE_ID, "resumeOnRelease", {
    name: game.i18n.localize("CFT.ResumeOnRelease.name"),
    hint: game.i18n.localize("CFT.ResumeOnRelease.hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "cinSnapshot", {
    name: "Cinematic Snapshot",
    hint: "Client snapshot for camera and flags restore.",
    scope: "client",
    config: false,
    type: Object,
    default: null
  });

  // World settings

  game.settings.register(MODULE_ID, "gmCinematicFollowCamera", {
    name: game.i18n.localize("CFT.CinematicCamera.name"),
    hint: game.i18n.localize("CFT.CinematicCamera.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: _onCinematicModeChanged
  });

  game.settings.register(MODULE_ID, "gmForceFollow", {
    name: game.i18n.localize("CFT.Force.name"),
    hint: game.i18n.localize("CFT.Force.hint"),
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: _onForceChanged
  });

  game.settings.register(MODULE_ID, "gmCinematic", {
    name: game.i18n.localize("CFT.Cinematic.name"),
    hint: game.i18n.localize("CFT.Cinematic.hint"),
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: _onCinematicChanged
  });

  game.settings.register(MODULE_ID, "gmSelectionIds", {
    name: "GM Selection (IDs)",
    hint: "Internal storage of GM-selected token IDs.",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "gmCameraState", {
    name: "GM Camera State (FTT)",
    hint: "Internal state storing GM camera for Cinematic modes.",
    scope: "world",
    config: false,
    type: Object,
    default: null,
    onChange: _onGmCameraStateChanged
  });

  // Keybindings

  game.keybindings.register(MODULE_ID, "toggleFollow", {
    name: game.i18n.localize("CFT.Toggle.name"),
    hint: game.i18n.localize("CFT.Toggle.name"),
    editable: [{ key: "KeyF", modifiers: ["Alt"] }],
    onDown: () => {
      const camMode = _isCinematicCameraMode();

      if (_isCinematicOn()) {
        // In Cinematic, only GM in camera mode can toggle their own follow
        if (!(camMode && game.user?.isGM)) {
          ui?.notifications?.warn(game.i18n.localize("CFT.Force.lockedPlayer"));
          return true;
        }
      }

      if (_isForceOnForMe()) {
        ui?.notifications?.warn(game.i18n.localize("CFT.Force.lockedPlayer"));
        return true;
      }

      const v = !_isLocalEnabled();
      game.settings.set(MODULE_ID, "enabled", v);
      ui.notifications?.info(
        v ? game.i18n.localize("CFT.Toggle.on")
          : game.i18n.localize("CFT.Toggle.off")
      );
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
      const turningOn = !_isCinematicOn();

      if (turningOn) {
        const state = _buildGmCameraState("cinToggleOn");
        if (state) {
          await game.settings.set(MODULE_ID, "gmCameraState", state);
        }
      }

      await game.settings.set(MODULE_ID, "gmCinematic", turningOn);
      return true;
    },
    precedence: (window.CONST?.KEYBINDING_PRECEDENCE?.NORMAL) ?? 100
  });
});

// ---------------------------
// Canvas lifecycle hooks
// ---------------------------
Hooks.on("ready", () => {
  if (game.user?.isGM) _renderGMBanners();
});

Hooks.on("canvasReady", () => {
  _bindDomMouseBlockers();
  _bindPixiPointer();
  if (game.user?.isGM) _renderGMBanners();

  if (game.user?.isGM && _isCinematicOn()) {
    _pushGmCameraState("canvasReady");
    _startGmCameraWatcher();
  }

  if (!game.user?.isGM && _isCinematicOn()) {
    const stage = canvas?.stage;
    if (stage) {
      _prevStageEventMode = stage.eventMode ?? "static";
      _prevStageInteractiveChildren = stage.interactiveChildren;
      stage.eventMode = "none";
      stage.interactiveChildren = false;
    }
    const state = _getGmCameraState();
    _applyGmCameraState(state, { instant: true });
  }
});

Hooks.on("canvasTearDown", () => {
  _unbindDomMouseBlockers();
  _unbindPixiPointer();
  _stopTicker();
  _stopGmCameraWatcher();
  _hideAllGMBanners();
});

// GM broadcasts current selection (for classic Cinematic)
Hooks.on("controlToken", async () => {
  if (game.user?.isGM) {
    const ids = (canvas?.tokens?.controlled ?? []).map(t => t.document.id);
    try { await game.settings.set(MODULE_ID, "gmSelectionIds", ids); } catch (_) {}

    if (_isCinematicOn() && !_isCinematicCameraMode()) {
      await _pushGmCameraState("gmControlToken");
    }
  }
});

/**
 * Player selection lock during Cinematic:
 * any attempt to change selection is reverted to the locked token set.
 */
Hooks.on("controlToken", (token, controlled) => {
  if (!_isCinematicOn()) return;
  if (game.user?.isGM) return;
  if (_lockSelectionGuard) return;

  const snap = _getCinSnapshot();
  const lockedIds = Array.isArray(snap?.lockedTokenIds) ? snap.lockedTokenIds : null;
  if (!lockedIds || !lockedIds.length) return;

  setTimeout(() => {
    if (!_isCinematicOn()) return;
    if (game.user?.isGM) return;

    _lockSelectionGuard = true;
    try {
      const tokens = canvas?.tokens?.placeables?.filter(t => lockedIds.includes(t.document.id)) ?? [];
      canvas.tokens.releaseAll();
      for (const t of tokens) t.control({ releaseOthers: false });
    } finally {
      _lockSelectionGuard = false;
    }
  }, 0);
});

/**
 * Any pan by a player in Cinematic is immediately reverted to GM camera.
 */
Hooks.on("canvasPan", () => {
  if (!_isCinematicOn()) return;
  if (game.user?.isGM) return;
  if (_squelchCanvasPan) return;

  try {
    _squelchCanvasPan = true;

    const camMode = _isCinematicCameraMode();

    if (camMode) {
      const state = _getGmCameraState();
      _applyGmCameraState(state, { instant: true });
    } else {
      const tokens = _getFollowTokens();
      const center = _getGroupCenter(tokens);
      if (center) _setCenter(center.x, center.y, true);
    }
  } catch (e) {
    console.warn("[FTT] canvasPan lock in Cinematic failed:", e);
  } finally {
    _squelchCanvasPan = false;
  }
});

// Block token movement by players during any Cinematic
Hooks.on("preUpdateToken", (doc, change) => {
  if (!_isCinematicOn()) return;
  if (game.user?.isGM) return;
  if ("x" in change || "y" in change || "elevation" in change || "rotation" in change) return false;
});

// Main follow driver based on token movement
Hooks.on("updateToken", (doc, changes) => {
  if (!_isFollowActive()) return;
  if (!("x" in changes || "y" in changes)) return;

  if (_isCinematicOn() && !_isCinematicCameraMode()) {
    const gmIds = new Set(_getGMSelectionIds());
    if (!gmIds.has(doc.id)) return;
  } else if (!_isCinematicOn()) {
    const myIds = new Set((canvas?.tokens?.controlled ?? []).map(t => t.document.id));
    if (!myIds.has(doc.id)) return;
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
    if (center) _setCenter(center.x, center.y, true);
  }

  _lastMoveTs = now;
  _startTicker();
});

// Stop ticker if there is nothing left to follow
Hooks.on("deleteToken", () => {
  if (!_isFollowActive()) return;
  const tokens = _getFollowTokens();
  if (!tokens.length) _stopTicker();
});

// Integration with rotate-camera-8d: keep GM camera rotation synced in Cinematic
Hooks.on("rotateCamera8dRotated", async () => {
  if (!_isCinematicOn()) return;

  if (game.user?.isGM) {
    await _pushGmCameraState("rotate");
  } else {
    const state = _getGmCameraState();
    if (state) _applyGmCameraState(state, { instant: true });
  }
});

// Simple public API for other modules/macros
window.FollowTheTokenAPI = {
  isFollowActive: _isFollowActive,
  getCurrentCenterWorld: _currentCenterWorld
};
