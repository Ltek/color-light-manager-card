// ============================================================================
// Color Light & Scene Manager for Home Assistant
//
// Control colored lights and author Home Assistant scenes — with reusable Fixture Profiles,
// live-linked Color entities, and a full GUI editor. Backed by the Color helper (the `color`
// domain; legacy `input_color.*` entities are still supported for existing configs).
//
// Version: v2026.09.08.239
//
// Author:  LTek
// Card:    https://github.com/Ltek/color-light-manager-card
//
// ============================================================================

const BUILD_NUMBER = 'v2026.09.08.239';
const CARD_NAME = 'Color Light & Scene Manager';
const LOG_PREFIX = '[ColorLightManagerCard]';
let DEBUG = false;

function debugLog(...args) {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}

// Normalizes the many shapes a Home Assistant WebSocket / service error can take
// (Error objects, {code, message} rejection payloads, plain strings) into a single
// human-readable reason string suitable for logging and user-facing alerts.
function formatWsError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message && err.code) return `${err.message} (code: ${err.code})`;
  if (err.message) return err.message;
  if (err.code) return `code: ${err.code}`;
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

// ============ input_select HELPER MANAGEMENT (WebSocket collection API) ============
// Thin wrappers over HA's input_select collection commands. These manage UI/storage helpers (the
// same ones under Settings → Devices & Services → Helpers). REQUIRE ADMIN — non-admins get a
// rejected promise from HA (callers gate the UI on hass.user.is_admin). Helpers defined in YAML are
// NOT editable here (they have no collection id in the list) and are surfaced read-only.
//   list   → [{ id, name, options[], icon?, initial? }]   (id = collection id, NOT entity_id)
//   create → { name, options[], initial?, icon? }          returns the created item
//   update → { input_select_id, name?, options?, icon?, initial? }
//   delete → { input_select_id }
function wsInputSelectList(hass) {
  if (!hass || !hass.connection || typeof hass.connection.sendMessagePromise !== 'function') return Promise.reject(new Error('No connection'));
  return hass.connection.sendMessagePromise({ type: 'input_select/list' });
}
function wsInputSelectCreate(hass, { name, options, initial, icon }) {
  const msg = { type: 'input_select/create', name, options: Array.isArray(options) ? options : [] };
  if (initial != null && initial !== '') msg.initial = initial;
  if (icon) msg.icon = icon;
  return hass.connection.sendMessagePromise(msg);
}
function wsInputSelectUpdate(hass, id, patch) {
  const msg = { type: 'input_select/update', input_select_id: id };
  if (patch.name != null) msg.name = patch.name;
  if (Array.isArray(patch.options)) msg.options = patch.options;
  if (patch.initial !== undefined) msg.initial = patch.initial;
  if (patch.icon !== undefined) msg.icon = patch.icon;
  return hass.connection.sendMessagePromise(msg);
}
function wsInputSelectDelete(hass, id) {
  return hass.connection.sendMessagePromise({ type: 'input_select/delete', input_select_id: id });
}
// Map a helper's collection id → its runtime entity_id (input_select.<slug>). HA doesn't return the
// entity_id in list(), but the slug is derived from the ORIGINAL name at create time; the reliable
// link is to match by scanning hass.states for an input_select whose friendly options match, OR — the
// robust approach — read the entity_registry. For our needs we match the collection item to a state
// by comparing the item id against the entity_id suffix when possible, else by name. See
// _sceneHelperRows which reconciles list() with hass.states.

// ============ STORAGE ============
const FAVORITES_STORAGE_KEY = 'color_light_manager_favorites';
const FAVORITES_SYNC_EVENT = 'color-light-manager-card-favorites-changed';

function safeGetItem(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function safeSetItem(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
}

class FavoritesService {
  constructor() {
    this._favorites = [];
    this._listeners = new Set();
    this._load();
    window.addEventListener('storage', e => {
      if (e.key === FAVORITES_STORAGE_KEY) { this._load(); this._notify(); }
    });
    window.addEventListener(FAVORITES_SYNC_EVENT, () => { this._load(); this._notify(); });
  }
  _load() {
    try {
      const raw = safeGetItem(FAVORITES_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      this._favorites = Array.isArray(parsed) ? parsed : [];
    } catch (e) { this._favorites = []; }
  }
  _save() {
    safeSetItem(FAVORITES_STORAGE_KEY, JSON.stringify(this._favorites));
    window.dispatchEvent(new Event(FAVORITES_SYNC_EVENT));
  }
  _notify() { this._listeners.forEach(cb => { try { cb(this.getFavorites()); } catch (e) {} }); }
  subscribe(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  getFavorites() { return [...this._favorites].sort((a, b) => a.order - b.order); }
  addFavorite(name, value) {
    const fav = { id: 'fav-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), name: (name || '').trim() || 'Unnamed', value, order: this._favorites.length };
    this._favorites.push(fav); this._save(); this._notify(); return fav;
  }
  updateFavorite(id, updates) {
    const fav = this._favorites.find(f => f.id === id);
    if (!fav) return false; Object.assign(fav, updates); this._save(); this._notify(); return true;
  }
  deleteFavorite(id) { this._favorites = this._favorites.filter(f => f.id !== id); this._save(); this._notify(); return true; }
  reorderFavorites(orderedIds) { orderedIds.forEach((id, index) => { const f = this._favorites.find(x => x.id === id); if (f) f.order = index; }); this._save(); this._notify(); }
  clearAll() { this._favorites = []; this._save(); this._notify(); }
}
const favoritesService = new FavoritesService();

// ============ COLOR MATH ============
const ColorUtils = {
  rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => { const h = Math.round(Math.max(0, Math.min(255, x))).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
  },
  hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  },
  rgbToHs(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0; const s = max === 0 ? 0 : (max - min) / max;
    if (max !== min) { const d = max - min; switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; } h /= 6; }
    return [Math.round(h * 360), Math.round(s * 100)];
  },
  hsToRgb(h, s) {
    h /= 360; s /= 100; const v = 1;
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) { case 0:[r,g,b]=[v,t,p];break; case 1:[r,g,b]=[q,v,p];break; case 2:[r,g,b]=[p,v,t];break; case 3:[r,g,b]=[p,q,v];break; case 4:[r,g,b]=[t,p,v];break; case 5:[r,g,b]=[v,p,q];break; default:[r,g,b]=[0,0,0]; }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  },
  rgbToXy(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const sum = X + Y + Z; if (sum === 0) return [0.3127, 0.329];
    return [Math.round((X / sum) * 10000) / 10000, Math.round((Y / sum) * 10000) / 10000];
  },
  xyToRgb(x, y) {
    // Mirrors Home Assistant's color_xy_to_RGB: full brightness, then NORMALIZE by the max
    // component (not clamp) so hue/saturation are preserved. Clamping each channel
    // independently distorts the ratios and shifts the hue (e.g. blue → cyan), which broke
    // the RGB→XY→RGB round-trip. xy carries no brightness, so we return the brightest RGB
    // for that chromaticity.
    if (y <= 0) return [255, 255, 255];
    const Y = 1, X = (Y / y) * x, Z = (Y / y) * (1 - x - y);
    let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
    let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
    let b = X * 0.0557 + Y * -0.204 + Z * 1.057;
    // Bring any negative (out-of-gamut) channel up to 0 before gamma, per HA.
    const minC = Math.min(r, g, b);
    if (minC < 0) { r -= minC; g -= minC; b -= minC; }
    // Normalize so the brightest channel is 1 (preserves hue/saturation).
    const maxC = Math.max(r, g, b);
    if (maxC > 0) { r /= maxC; g /= maxC; b /= maxC; }
    const gamma = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    r = clamp(gamma(r), 0, 1); g = clamp(gamma(g), 0, 1); b = clamp(gamma(b), 0, 1);
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  },
  kelvinToMired(kelvin) { return Math.round(1000000 / kelvin); },
  miredToKelvin(mired) { return Math.round(1000000 / mired); },
  kelvinToRgb(kelvin) {
    const temp = kelvin / 100; let r, g, b;
    if (temp <= 66) { r = 255; } else { r = 329.698727446 * Math.pow(temp - 60, -0.1332047592); r = Math.max(0, Math.min(255, r)); }
    if (temp <= 66) { g = 99.4708025861 * Math.log(temp) - 161.1195681661; } else { g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492); }
    g = Math.max(0, Math.min(255, g));
    if (temp >= 66) { b = 255; } else if (temp <= 19) { b = 0; } else { b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307; b = Math.max(0, Math.min(255, b)); }
    return [Math.round(r), Math.round(g), Math.round(b)];
  },
  miredToRgb(mired) { return this.kelvinToRgb(this.miredToKelvin(mired)); },
  // Accurate blackbody-locus CIE 1931 xy for a color temperature (Kranz/CIE approximation,
  // valid ~1667K–25000K). This maps a true white point rather than round-tripping through
  // the lossy Tanner-Helland RGB, so it's the best-fidelity way to express a Kelvin white
  // as xy for controllers whose native color_temp handling is off.
  kelvinToXy(kelvin) {
    const T = clamp(kelvin, 1667, 25000);
    const inv = 1000 / T, inv2 = inv * inv, inv3 = inv2 * inv;
    let x;
    if (T <= 4000) {
      x = -0.2661239 * inv3 - 0.2343589 * inv2 + 0.8776956 * inv + 0.179910;
    } else {
      x = -3.0258469 * inv3 + 2.1070379 * inv2 + 0.2226347 * inv + 0.240390;
    }
    const x2 = x * x, x3 = x2 * x;
    let y;
    if (T <= 2222) {
      y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
    } else if (T <= 4000) {
      y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    } else {
      y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
    }
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  },
  // Kelvin → hue/saturation, via the blackbody RGB approximation. HS can't represent a
  // neutral white precisely (S=0 loses the tint), so this is a best-effort for controllers
  // that prefer hs_color; xy is generally the more faithful choice for whites.
  kelvinToHs(kelvin) {
    const [r, g, b] = this.kelvinToRgb(kelvin);
    return this.rgbToHs(r, g, b);
  },
  // Kelvin → rgbw_color [r,g,b,w]. RGBW lights have a single (fixed-temperature) white LED,
  // so a "white" request lights the white channel fully and leaves rgb at 0.
  kelvinToRgbw(kelvin) { return [0, 0, 0, 255]; },
  // Kelvin → rgbww_color [r,g,b,cw,ww]. RGBWW lights have separate cold-white and warm-white
  // channels; we mix them by where `kelvin` sits between warmK (all warm) and coolK (all
  // cold), leaving rgb at 0 so the dedicated white LEDs render the temperature.
  kelvinToRgbww(kelvin, warmK, coolK) {
    const wK = warmK || 2000, cK = coolK || 6500;
    const t = clamp((kelvin - wK) / (cK - wK), 0, 1); // 0 = fully warm, 1 = fully cold
    return [0, 0, 0, Math.round(t * 255), Math.round((1 - t) * 255)];
  },
  hexToRgba(hex, alpha) {
    const rgb = this.hexToRgb(hex) || [0, 0, 0];
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  },
  mixRgb(rgbA, rgbB, t) {
    t = clamp(t, 0, 1);
    return [
      Math.round(rgbA[0] + (rgbB[0] - rgbA[0]) * t),
      Math.round(rgbA[1] + (rgbB[1] - rgbA[1]) * t),
      Math.round(rgbA[2] + (rgbB[2] - rgbA[2]) * t),
    ];
  },
};

// ============ SHARED HELPERS ============
function getLightEntities(hass) {
  if (!hass || !hass.states) return [];
  return Object.keys(hass.states).filter(id => id.startsWith('light.')).sort();
}
function getSceneEntities(hass) {
  if (!hass || !hass.states) return [];
  return Object.keys(hass.states).filter(id => id.startsWith('scene.')).sort();
}

// ---- Scene capture: per-domain settable-attribute whitelist ----
// A Home Assistant scene stores {entity_id: {state, ...attributes}} and restores it via each
// domain's reproduce_state. We must capture ONLY attributes a domain can actually accept back —
// blindly copying every attribute (supported_features, friendly_name, all three color formats
// at once, etc.) makes HA reject or misapply the scene. This whitelist mirrors what the core
// domains' reproduce_state supports. `light` is handled specially (native color format).
const SCENE_CAPTURE_DOMAINS = {
  light:        ['brightness', 'effect', 'color_temp_kelvin', 'rgb_color', 'rgbw_color', 'rgbww_color', 'xy_color', 'hs_color'],
  switch:       [],
  fan:          ['percentage', 'preset_mode', 'oscillating', 'direction'],
  cover:        ['current_position', 'current_tilt_position'],
  climate:      ['temperature', 'target_temp_low', 'target_temp_high', 'hvac_mode', 'fan_mode', 'preset_mode', 'swing_mode', 'humidity'],
  media_player: ['volume_level', 'source', 'sound_mode'],
  input_boolean:[],
  input_number: [],
  input_select: [],
  select:       [],
  lock:         [],
  humidifier:   ['humidity', 'mode'],
};
function sceneDomainOf(entityId) { return String(entityId || '').split('.')[0]; }
function sceneDomainSupported(entityId) { return Object.prototype.hasOwnProperty.call(SCENE_CAPTURE_DOMAINS, sceneDomainOf(entityId)); }
// Entities eligible to be added to a scene capture set — those whose domain we can safely
// snapshot. Sorted by friendly name for the picker.
function getSceneCapturableEntities(hass) {
  if (!hass || !hass.states) return [];
  return Object.keys(hass.states).filter(sceneDomainSupported).sort();
}
function friendlyName(hass, entityId) {
  const st = hass && hass.states && hass.states[entityId];
  return (st && st.attributes && st.attributes.friendly_name) || entityId;
}
// A light's advertised color modes, e.g. ['color_temp','xy']. Empty if unknown.
function getSupportedColorModes(hass, entityId) {
  const st = hass && hass.states && hass.states[entityId];
  const modes = st && st.attributes && st.attributes.supported_color_modes;
  return Array.isArray(modes) ? modes : [];
}
// Union of supported color modes across several entities (for the preset format hints).
function getUnionColorModes(hass, entityIds) {
  const set = new Set();
  (entityIds || []).forEach(id => getSupportedColorModes(hass, id).forEach(m => set.add(m)));
  return [...set];
}
// Union of effect names (effect_list) across several light entities, for the effect picker.
function getUnionEffectList(hass, entityIds) {
  const set = new Set();
  (entityIds || []).forEach(id => {
    const st = hass && hass.states && hass.states[id];
    const list = st && st.attributes && st.attributes.effect_list;
    if (Array.isArray(list)) list.forEach(e => set.add(e));
  });
  return [...set];
}
// Maps our preset/output format keys to the HA color_mode name a light advertises, so we
// can tell whether a chosen format is actually supported by the target(s).
const FORMAT_TO_COLOR_MODE = {
  kelvin: 'color_temp', mired: 'color_temp',
  xy: 'xy', hs: 'hs', rgb: 'rgb', rgbw: 'rgbw', rgbww: 'rgbww',
};
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Modern HA reports (and light.turn_on only accepts) color_temp_kelvin; the legacy
// mired-based color_temp attribute/parameter is no longer used, so this card works
// exclusively in Kelvin. Older states that only report the legacy attribute are
// still converted for read purposes.
function attrsToKelvin(attrs) {
  if (attrs.color_temp_kelvin !== undefined && attrs.color_temp_kelvin !== null) return attrs.color_temp_kelvin;
  if (attrs.color_temp !== undefined && attrs.color_temp !== null) return ColorUtils.miredToKelvin(attrs.color_temp);
  return undefined;
}

// Coalesces rapid calls (e.g. slider drag) to at most one per `wait` ms, trailing.
// The returned function exposes .cancel() to discard any pending trailing call —
// callers MUST call this before sending a final/authoritative value, otherwise a
// stale queued call can land after release and briefly snap the UI backwards.
function throttle(fn, wait) {
  let lastCall = 0;
  let pendingArgs = null;
  let timeoutId = null;
  const invoke = () => {
    lastCall = Date.now();
    timeoutId = null;
    if (pendingArgs) { const args = pendingArgs; pendingArgs = null; fn(...args); }
  };
  const wrapped = (...args) => {
    const now = Date.now();
    const remaining = wait - (now - lastCall);
    if (remaining <= 0) { lastCall = now; fn(...args); }
    else { pendingArgs = args; if (!timeoutId) timeoutId = setTimeout(invoke, remaining); }
  };
  wrapped.cancel = () => { if (timeoutId) clearTimeout(timeoutId); timeoutId = null; pendingArgs = null; };
  return wrapped;
}

function getEntityLabels(hass, entityId) {
  if (!hass || !hass.entities) return [];
  const reg = hass.entities[entityId];
  return (reg && Array.isArray(reg.labels)) ? reg.labels : [];
}

// The legacy `group.*` domain is rarely populated on modern HA installs (most
// grouping now happens via Areas), so "Group" filtering uses Areas instead —
// reliably available through the entity/device/area registries.
function getEntityAreaId(hass, entityId) {
  if (!hass || !hass.entities) return null;
  const reg = hass.entities[entityId];
  if (!reg) return null;
  if (reg.area_id) return reg.area_id;
  if (reg.device_id && hass.devices && hass.devices[reg.device_id]) {
    return hass.devices[reg.device_id].area_id || null;
  }
  return null;
}

function getAreas(hass) {
  if (!hass || !hass.areas) return [];
  return Object.values(hass.areas)
    .map(a => ({ id: a.area_id, name: a.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getAllLabels(hass) {
  if (!hass || !hass.entities) return [];
  const set = new Set();
  Object.values(hass.entities).forEach(e => { if (Array.isArray(e.labels)) e.labels.forEach(l => set.add(l)); });
  return [...set].sort();
}

// The Color helper's entities. As of the integration's v0.2.0, the domain is `color`
// (e.g. color.theater_golden). Older installs used `input_color` (HA reserved input_* for
// its YAML helpers, forcing the rename — with NO in-place migration). We therefore support
// BOTH: new entities/creation default to `color`, while any legacy `input_color.*` entity a
// config still references keeps working. The correct service domain is derived per-entity.
const COLOR_DOMAIN = 'color';               // primary (v0.2.0+)
const COLOR_HELPER_DOMAINS = ['color', 'input_color']; // recognized helper domains (new + legacy)
// Kept for backward reference in older comments; primary domain for new work.
const INPUT_COLOR_DOMAIN = COLOR_DOMAIN;

// The service/helper domain for a given color-helper entity id (color.* or input_color.*).
function colorEntityDomain(entityId) {
  const dot = (entityId || '').indexOf('.');
  const d = dot > 0 ? entityId.slice(0, dot) : '';
  return COLOR_HELPER_DOMAINS.includes(d) ? d : COLOR_DOMAIN;
}

function getInputColorEntities(hass) {
  if (!hass || !hass.states) return [];
  return Object.keys(hass.states)
    .filter(id => COLOR_HELPER_DOMAINS.some(d => id.startsWith(d + '.')))
    .sort();
}

function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'preset';
}

// Reads a color.* / input_color.* entity's current value into our preset value shape.
//
// PREFERRED (Color integration v0.3.0+): the `color_params` attribute is the EXACT authored
// input as a light.turn_on-ready dict — e.g. {xy_color:[0.154,0.168]} or {color_temp_kelvin:
// 2000, brightness:179}. Reading it preserves the native format with NO lossy xy→rgb round-trip
// (the old path below re-derived rgb, which drifted). color_params keys are exactly our own
// color keys, except its temperature key is `color_temp_kelvin` while our preset key is
// `color_kelvin` — we translate that one.
//
// FALLBACK (pre-0.3.0 / legacy input_color.*): derive from kind/rgb/hex/xy attributes as before.
function inputColorStateToPresetValue(state) {
  const attrs = (state && state.attributes) || {};
  const value = {};

  // ---- v0.3.0 exact path: color_params ----
  const cp = attrs.color_params;
  if (cp && typeof cp === 'object') {
    if (cp.brightness !== undefined && cp.brightness !== null) value.brightness = cp.brightness;
    else if (attrs.brightness !== undefined && attrs.brightness !== null) value.brightness = attrs.brightness;
    if (cp.color_temp_kelvin !== undefined && cp.color_temp_kelvin !== null) {
      value.color_kelvin = cp.color_temp_kelvin;
      return value;
    }
    // Copy whichever native color key is present, verbatim (rgb/xy/hs/rgbw/rgbww).
    for (const key of ALL_PRESET_COLOR_KEYS) {
      if (Array.isArray(cp[key])) { value[key] = cp[key].slice(); return value; }
    }
    // color_params present but no recognized color key — fall through to legacy derivation.
  }

  // ---- Legacy fallback ----
  if (attrs.brightness !== undefined && attrs.brightness !== null && value.brightness === undefined) value.brightness = attrs.brightness;
  if (attrs.kind === 'white' && attrs.color_temp_kelvin) {
    value.color_kelvin = attrs.color_temp_kelvin;
    return value;
  }
  if (Array.isArray(attrs.rgb_color) && attrs.rgb_color.length === 3) { value.rgb_color = attrs.rgb_color; return value; }
  const rgb = ColorUtils.hexToRgb(state && state.state);
  if (rgb) { value.rgb_color = rgb; return value; }
  if (Array.isArray(attrs.xy) && attrs.xy.length === 2) { value.rgb_color = ColorUtils.xyToRgb(attrs.xy[0], attrs.xy[1]); return value; }
  value.rgb_color = [255, 255, 255];
  return value;
}

function inputColorEntitySwatch(hass, entityId) {
  const state = hass && hass.states && hass.states[entityId];
  if (!state) return '#888';
  const value = inputColorStateToPresetValue(state);
  if (value.color_kelvin) return ColorUtils.rgbToHex(...ColorUtils.kelvinToRgb(value.color_kelvin));
  // value may carry any native color key (rgb/xy/hs/…) — derive rgb for the swatch.
  if (presetColorFormat(value)) return ColorUtils.rgbToHex(...presetColorToRgb(value));
  return '#888';
}

// Builds the payload for input_color.set_color from a preset's stored value. Exactly
// one of hex_value/rgb_color/hs_color/xy_color/color_temp_kelvin/color_name is
// required per the service schema; brightness is optional and independent of color.
// The native turn_on color keys a preset may store its color in, by format. A preset holds
// its color in exactly one of these (its "color format"), sent verbatim so typed values
// (especially xy) never drift through a lossy rgb round-trip.
const PRESET_COLOR_KEYS = {
  rgb: 'rgb_color', xy: 'xy_color', hs: 'hs_color', rgbw: 'rgbw_color', rgbww: 'rgbww_color',
};
const ALL_PRESET_COLOR_KEYS = Object.values(PRESET_COLOR_KEYS);

// ---- Fixture Profile ----
// A "fixture profile" is the reusable LOOK a preset applies: its color (any format) or
// temperature, plus brightness/transition/effect, or the turn-off action. It deliberately
// EXCLUDES button/orchestration fields (name shown on button, icon, section, target lights,
// scenes, turn-off set, glow, link) — those stay on the button. Profiles can be saved to a
// shared library and referenced by many buttons (see FIXTURE LIBRARY below).
const PROFILE_LOOK_KEYS = [...ALL_PRESET_COLOR_KEYS, 'color_kelvin', 'brightness', 'transition', 'effect', 'action', 'look_none'];

// Extracts just the look/profile fields from a preset (or any object). Returns a new object
// containing only the keys present, so it round-trips cleanly through the library.
function extractProfileLook(src) {
  const out = {};
  if (!src) return out;
  PROFILE_LOOK_KEYS.forEach(k => { if (src[k] !== undefined && src[k] !== null) out[k] = src[k]; });
  return out;
}
// Applies a profile look onto a preset: clears all existing look fields first (so switching
// profiles doesn't leave stale color/temperature keys), then copies the profile's look in.
function applyProfileLook(preset, look) {
  const p = { ...preset };
  PROFILE_LOOK_KEYS.forEach(k => delete p[k]);
  Object.assign(p, extractProfileLook(look || {}));
  return p;
}

// Which color format a preset is stored in (rgb/xy/hs/rgbw/rgbww), or null if it has no
// color component (temp-only or off).
function presetColorFormat(preset) {
  if (!preset) return null;
  for (const [fmt, key] of Object.entries(PRESET_COLOR_KEYS)) {
    if (Array.isArray(preset[key])) return fmt;
  }
  return null;
}
// The stored native color array for a preset (or null).
function presetColorValue(preset) {
  const fmt = presetColorFormat(preset);
  return fmt ? preset[PRESET_COLOR_KEYS[fmt]] : null;
}
// An RGB approximation of a preset's color, for swatches / the wheel preview / tiles.
function presetColorToRgb(preset) {
  const fmt = presetColorFormat(preset);
  const v = presetColorValue(preset);
  if (!v) {
    if (preset && preset.color_kelvin != null) return ColorUtils.kelvinToRgb(preset.color_kelvin);
    return [255, 255, 255];
  }
  switch (fmt) {
    case 'rgb': return v.slice(0, 3);
    case 'rgbw': return v.slice(0, 3);   // preview from the rgb channels
    case 'rgbww': return v.slice(0, 3);
    case 'xy': return ColorUtils.xyToRgb(v[0], v[1]);
    case 'hs': return ColorUtils.hsToRgb(v[0], v[1]);
    default: return [255, 255, 255];
  }
}

// Classifies a preset into one of: 'none' | 'off' | 'temp' | 'color'.
//   none  = applies NO color/temp to any light (scene-only / turn-off-only button)
//   off   = turns the color-control lights off
//   temp  = color temperature only
//   color = a color (any format); the default for a new preset
// (Legacy "both" presets — a color AND a kelvin — collapse to 'color', preferring the color.)
function presetMode(preset) {
  if (!preset) return 'color';
  if (preset.look_none === true) return 'none';
  if (preset.action === 'turn_off') return 'off';
  if (presetColorFormat(preset) !== null) return 'color';
  if (preset.color_kelvin !== undefined && preset.color_kelvin !== null) return 'temp';
  return 'color';
}
// The editor-facing Button mode: 'off' | 'profile' | 'scene' | 'temp' | 'color'.
//   off     = Light Off (turn_off action)
//   profile = uses a Fixture Profile from the library (profile_ref)
//   scene   = scene / orchestration only, applies no color of its own (look_none)
//   temp    = Custom Temperature (inline color_kelvin)
//   color   = Custom Color (inline color, any format) — default
// A persisted `preset.mode` (set when the user picks a mode) is authoritative; older presets
// with no `mode` are inferred from their data so nothing breaks. NOTE: this drives EDITOR
// visibility only — the runtime look is classified by presetMode() on the effective look.
function buttonMode(preset) {
  if (!preset) return 'color';
  if (['off', 'profile', 'scene', 'temp', 'color'].includes(preset.mode)) return preset.mode;
  if (fixtureRefSlug(preset.profile_ref)) return 'profile';
  if (preset.action === 'turn_off') return 'off';
  if (preset.look_none === true) return 'scene';
  if (presetColorFormat(preset) !== null) return 'color';
  if (preset.color_kelvin !== undefined && preset.color_kelvin !== null) return 'temp';
  return 'color';
}
// The default button icon for a mode (used when a preset has no explicit icon, and as the
// seed icon when creating/switching a button). Each mode gets a recognizable glyph.
const MODE_DEFAULT_ICON = {
  off: 'mdi:lightbulb-off',
  profile: 'mdi:palette-swatch',
  scene: 'mdi:ticket',
  temp: 'mdi:thermometer',
  color: 'mdi:palette-outline',
};
function modeDefaultIcon(mode) { return MODE_DEFAULT_ICON[mode] || 'mdi:lightbulb'; }
// Normalize a user-typed icon: a bare name with no namespace assumes the `mdi:` set (the HA
// default). Prefixed icons (mdi:/si:/hass:/custom sets) are left untouched. Empty → ''.
function normalizeIcon(icon) {
  const s = String(icon || '').trim();
  if (!s) return '';
  return s.includes(':') ? s : `mdi:${s}`;
}

// Common preset gradient patterns for dividers. `stops` use `null` color as a placeholder for
// "the accent color" — filled in with the current base color when the pattern is applied, so a
// pattern adapts to whatever color the user picks. 'transparent' is literal.
const DIVIDER_GRADIENT_PATTERNS = [
  { name: 'Solid → Transparent (fade out right)', stops: [{ pos: 0, color: null }, { pos: 100, color: 'transparent' }] },
  { name: 'Transparent → Solid (fade in right)', stops: [{ pos: 0, color: 'transparent' }, { pos: 100, color: null }] },
  { name: 'Transparent → Solid → Transparent (center glow)', stops: [{ pos: 0, color: 'transparent' }, { pos: 50, color: null }, { pos: 100, color: 'transparent' }] },
  { name: 'Solid → Transparent → Solid (center gap)', stops: [{ pos: 0, color: null }, { pos: 50, color: 'transparent' }, { pos: 100, color: null }] },
  { name: 'Solid → Transparent → Solid (mirror center)', stops: [{ pos: 0, color: null }, { pos: 35, color: 'transparent' }, { pos: 65, color: 'transparent' }, { pos: 100, color: null }] },
  { name: 'Transparent → Solid → Transparent (mirror center)', stops: [{ pos: 0, color: 'transparent' }, { pos: 35, color: null }, { pos: 65, color: null }, { pos: 100, color: 'transparent' }] },
  { name: 'Two-color (left → right)', stops: [{ pos: 0, color: '#2196F3' }, { pos: 100, color: '#e91e63' }] },
  { name: 'Two-color (mirror center)', stops: [{ pos: 0, color: '#2196F3' }, { pos: 50, color: '#e91e63' }, { pos: 100, color: '#2196F3' }] },
  { name: 'Rainbow', stops: [{ pos: 0, color: '#ff0000' }, { pos: 25, color: '#ffff00' }, { pos: 50, color: '#00ff00' }, { pos: 75, color: '#00ffff' }, { pos: 100, color: '#ff00ff' }] },
  { name: 'Rainbow (mirror center)', stops: [{ pos: 0, color: '#ff0000' }, { pos: 17, color: '#ffff00' }, { pos: 34, color: '#00ff00' }, { pos: 50, color: '#00ffff' }, { pos: 66, color: '#00ff00' }, { pos: 83, color: '#ffff00' }, { pos: 100, color: '#ff0000' }] },
];

// Builds a gradient-border as background-image LAYERS (the card_mod technique) so it respects
// border-radius and composes with box-shadow glow + the element's own background. Given a
// gradient-border spec { enabled, width, sides:{top,bottom,left,right}, stops:[{pos,color}] },
// returns { image, size, position, repeat } CSS strings for one background shorthand, or null.
// Top/bottom lines run left→right; left/right lines run top→bottom.
function gradientBorderBackground(g, matchColor) {
  if (!g || !g.enabled) return null;
  // A stop color of 'match' resolves to the border's own color (matchColor) — usually what you
  // want, so it's the default for new stops. Falls back to the accent if no matchColor given.
  const resolveMatch = matchColor || '#2196F3';
  const stops = (Array.isArray(g.stops) ? g.stops : [])
    .map(s => ({ pos: clamp(Number(s.pos) || 0, 0, 100), color: s.color === 'match' ? resolveMatch : String(s.color || 'transparent') }))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length < 2) return null;
  const w = Number(g.width) || 2;
  const sides = g.sides || {};
  const horiz = `linear-gradient(to right, ${stops.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
  const vert = `linear-gradient(to bottom, ${stops.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
  const imgs = [], sizes = [], positions = [];
  const add = (on, img, size, pos) => { if (on) { imgs.push(img); sizes.push(size); positions.push(pos); } };
  add(sides.top, horiz, `100% ${w}px`, 'top');
  add(sides.bottom, horiz, `100% ${w}px`, 'bottom');
  add(sides.left, vert, `${w}px 100%`, 'left');
  add(sides.right, vert, `${w}px 100%`, 'right');
  if (!imgs.length) return null;
  return { image: imgs.join(', '), size: sizes.join(', '), position: positions.join(', '), repeat: imgs.map(() => 'no-repeat').join(', ') };
}

// A divider's gradient stops → a `linear-gradient(to right, …)` CSS string. Stops are
// {pos 0-100, color}; sorted by position. Falls back to the single divider color when there
// are fewer than 2 stops (a gradient needs at least two). Returns null if not gradient-usable.
function dividerGradientCss(section, fallbackColor, reverse) {
  // A stop color of 'theme' resolves to the theme divider color; 'transparent' stays transparent;
  // anything else is used verbatim (hex).
  const stops = (Array.isArray(section && section.stops) ? section.stops : [])
    .map(s => ({ pos: clamp(Number(s.pos) || 0, 0, 100), color: s.color === 'theme' ? 'var(--divider-color)' : String(s.color || 'transparent') }))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length < 2) return null;
  // `reverse` mirrors the gradient horizontally (used for the right segment of a centered divider
  // so the two halves are symmetric around the text/icon instead of both fading the same way).
  const dir = reverse ? 'to left' : 'to right';
  return `linear-gradient(${dir}, ${stops.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
}
// Shared divider renderer (used by both the card and the editor preview). Draws the line and,
// when a label and/or icon is set, places that content over the line at the chosen position:
//   - center: content centered with line segments on both sides
//   - left / right: content at that end, line filling the rest
// Text/icon size, color, and weight are configurable per-divider (fall back to sensible defaults).
function dividerLineHtml(section, cfg) {
  cfg = cfg || {};
  const color = section.color || cfg.divider_color || 'var(--divider-color)';
  const thickness = Number(section.thickness) || Number(cfg.divider_thickness) || 1;
  const length = clamp(Number(section.length) || Number(cfg.divider_length) || 100, 5, 100);
  const style = section.line_style || 'solid';
  const justify = section.justify || 'center';            // where the LINE sits
  const scale = Number(cfg.scale) || 1.0;
  const flexJustify = justify === 'left' ? 'flex-start' : justify === 'right' ? 'flex-end' : 'center';
  const grad = section.gradient ? dividerGradientCss(section, color) : null;
  let lineStyle;
  if (grad) {
    lineStyle = `height:${thickness}px;background:${grad};border-radius:${thickness}px;`;
  } else if (style === 'dashed' || style === 'dotted') {
    lineStyle = `height:0;border-top:${thickness}px ${style} ${color};`;
  } else {
    lineStyle = `height:${thickness}px;background:${color};border-radius:${thickness}px;`;
  }
  // Visibility toggles.
  const hideLine = section.hide_line === true;
  const hideText = section.hide_text === true;
  const hideIcon = section.hide_icon === true;
  const label = (!hideText && section.label != null) ? String(section.label) : '';
  const icon = (!hideIcon && section.icon) ? normalizeIcon(section.icon) : '';
  const pad = `padding:calc(8px * ${scale}) 0;`;
  const position = section.text_position || 'on';         // above | on | below
  const contentJustify = section.content_justify || justify;   // where text/icon sits
  const cFlex = contentJustify === 'left' ? 'flex-start' : contentJustify === 'right' ? 'flex-end' : 'center';
  const indent = clamp(Number(section.indent) || 0, 0, 200);
  const lineRow = hideLine ? '' : `<div style="display:flex;justify-content:${flexJustify};"><div style="width:${length}%;${lineStyle}"></div></div>`;
  // No content → just the (maybe hidden) line, original behavior.
  if (!label && !icon) {
    return `<div style="${pad}">${lineRow || '<div style="height:0;"></div>'}</div>`;
  }
  // Content styling. Color modes:
  //   text_color_mode: 'line' (the divider's line color) | 'theme' (theme text color) | 'fixed'
  //   icon_color_mode: 'text' (match resolved text color) | 'theme' | 'fixed'
  // Back-compat: no mode + a stored *_color hex → 'fixed'; else the sensible default.
  const tSize = Number(section.text_size) || 13;
  const tWeight = section.text_weight || '600';
  const tMode = section.text_color_mode || (section.text_color ? 'fixed' : 'line');
  // 'line' = match the line color. For a GRADIENT line there's no single color, so
  // pick the first real gradient stop (skip transparent/theme); if none, fall back
  // to the base line color. (Fixes "match line color" doing nothing on gradients.)
  let lineColor = color;
  if (tMode === 'line' && section.gradient && Array.isArray(section.stops)) {
    const realStop = section.stops.find(s => s && s.color && s.color !== 'transparent' && s.color !== 'theme');
    if (realStop) lineColor = realStop.color;
    else { const themeStop = section.stops.find(s => s && s.color === 'theme'); if (themeStop) lineColor = 'var(--divider-color)'; }
  }
  const tColor = tMode === 'fixed' ? (section.text_color || '#ffffff')
    : tMode === 'theme' ? 'var(--primary-text-color)'
    : lineColor;   // 'line'
  const iSize = Number(section.icon_size) || (tSize + 4);
  const iMode = section.icon_color_mode || (section.icon_color ? 'fixed' : 'text');
  const iColor = iMode === 'fixed' ? (section.icon_color || '#ffffff')
    : iMode === 'theme' ? 'var(--primary-text-color)'
    : tColor;   // 'text'
  const gap = 8;
  const contentHtml = `<span style="display:inline-flex;align-items:center;gap:calc(${gap}px * ${scale});flex-shrink:0;white-space:nowrap;">
    ${icon ? `<ha-icon icon="${escapeHtml(icon)}" style="--mdc-icon-size:calc(${iSize}px * ${scale});color:${iColor};"></ha-icon>` : ''}
    ${label ? `<span style="font-size:calc(${tSize}px * ${scale});font-weight:${tWeight};color:${tColor};">${escapeHtml(label)}</span>` : ''}
  </span>`;
  // Indent shifts the content away from its justified edge.
  const indentStyle = indent ? (contentJustify === 'right' ? `padding-right:${indent}px;` : contentJustify === 'center' ? '' : `padding-left:${indent}px;`) : '';
  const contentRow = `<div style="display:flex;justify-content:${cFlex};${indentStyle}">${contentHtml}</div>`;
  // "On the line": overlay content into the line (center = segments both sides; else at an end).
  if (position === 'on' && !hideLine) {
    const seg = `<div style="flex:1;${lineStyle}"></div>`;
    // For a centered gradient line, the RIGHT segment uses a horizontally-mirrored gradient so the
    // two halves fade symmetrically around the content (e.g. both ends solid, both inner ends
    // faded) instead of both running the same direction.
    let segRight = seg;
    if (grad && contentJustify === 'center' && section.mirror_center) {
      const gradR = dividerGradientCss(section, color, true);
      segRight = `<div style="flex:1;height:${thickness}px;background:${gradR};border-radius:${thickness}px;"></div>`;
    }
    const inner = contentJustify === 'left' ? `${contentHtml}${seg}`
      : contentJustify === 'right' ? `${seg}${contentHtml}`
      : `${seg}${contentHtml}${segRight}`;
    return `<div style="display:flex;justify-content:${flexJustify};${pad}">
      <div style="width:${length}%;display:flex;align-items:center;gap:calc(${gap}px * ${scale});${indent ? `padding:0 ${indent}px;` : ''}">${inner}</div>
    </div>`;
  }
  // Above / below (or "on" with the line hidden) → stack the content and the line.
  const stack = (position === 'above') ? `${contentRow}${lineRow}` : `${lineRow}${contentRow}`;
  return `<div style="display:flex;flex-direction:column;gap:calc(4px * ${scale});${pad}">${stack}</div>`;
}
// Icons we treat as "not user-customized" — the generic old defaults plus every mode default.
// A preset carrying one of these gets the CURRENT mode's default at render time, so buttons
// created before per-mode icons (all saved as mdi:lightbulb) still reflect their Mode.
const GENERIC_DEFAULT_ICONS = new Set(['mdi:lightbulb', 'mdi:lightbulb-off', ...Object.values(MODE_DEFAULT_ICON)]);
// The icon a button should display: the user's custom icon if they set a non-generic one,
// otherwise the default glyph for its mode.
function resolvePresetIcon(preset, mode) {
  const icon = preset && preset.icon;
  if (icon && !GENERIC_DEFAULT_ICONS.has(icon)) return normalizeIcon(icon);   // bare name → mdi:
  return modeDefaultIcon(mode || buttonMode(preset));
}
// Resolves a preset's color-control targeting mode: 'all' | 'specific' | 'none'.
// Back-compat: presets without target_mode use the old rule (empty target_entities = all).
function presetTargetMode(preset) {
  if (preset && (preset.target_mode === 'all' || preset.target_mode === 'specific' || preset.target_mode === 'none')) return preset.target_mode;
  return (Array.isArray(preset && preset.target_entities) && preset.target_entities.length) ? 'specific' : 'all';
}

// A preset's color-control targeting spec, in the current model:
//   useDefault → include the card's live Default Entities pool
//   useCustom  → include this button's own list (target_entities), which may be ANY HA light
// Effective targets = union of the two. Migrated on read from the legacy target_mode:
//   'all' (or absent + empty list) → {useDefault:true,  useCustom:false}
//   'specific'                     → {useDefault:false, useCustom:true}
//   'none'                         → {useDefault:false, useCustom:false}
//   legacy absent + non-empty list → {useDefault:false, useCustom:true}
function presetTargetSpec(preset) {
  const p = preset || {};
  const custom = Array.isArray(p.target_entities) ? p.target_entities : [];
  // New explicit fields take precedence when either is present.
  if (p.use_default_entities !== undefined || p.use_custom_entities !== undefined) {
    return { useDefault: p.use_default_entities !== false, useCustom: p.use_custom_entities === true, custom };
  }
  // Legacy migration.
  const tm = presetTargetMode(p);
  if (tm === 'none') return { useDefault: false, useCustom: false, custom };
  if (tm === 'specific') return { useDefault: false, useCustom: true, custom };
  return { useDefault: true, useCustom: false, custom };   // 'all'
}

// ---- Sections ----
// The card body is a list of user-defined sections. Each section is one of:
//   { id, type:'buttons', name }                — holds preset buttons (presets pick a section)
//   { id, type:'sliders', name, sliders:{brightness,temperature,rgb}, target_entities }
//   { id, type:'values', name }                 — the color-value readout
// Older configs have none of this; buildSections() migrates them into a default layout so
// nothing breaks: one Buttons section (all existing presets), one Sliders section (using the
// old global show_*_slider flags), and one Values section.
let SECTION_UID = 0;
// Unique id per new section. Combines a monotonic counter with a timestamp so ids don't
// collide across editor reloads (the counter resets on reload, the timestamp doesn't).
function newSectionId(prefix) { SECTION_UID += 1; return `${prefix}-${Date.now().toString(36)}${SECTION_UID}`; }
// Unique preset id. NOTE: plain Date.now() collides when presets are created in the same
// millisecond, producing duplicate ids — which broke per-button glow lookups (find() by id
// resolved duplicates to the first match). The counter guarantees uniqueness.
let PRESET_UID = 0;
function newPresetId() { PRESET_UID += 1; return `p-${Date.now().toString(36)}${PRESET_UID}`; }
// Unique id for a new HA scene config (the scene config API keys scenes by an opaque id string).
let SCENE_UID = 0;
function newSceneConfigId() { SCENE_UID += 1; return `${Date.now()}${SCENE_UID}`; }
// Returns presets with any duplicate/missing ids reassigned to fresh unique ones, so
// per-button lookups (glow, click) resolve to the right preset.
function dedupePresetIds(presets) {
  if (!Array.isArray(presets)) return presets;
  const seen = new Set();
  return presets.map(p => {
    if (!p || !p.id || seen.has(p.id)) { const np = { ...p, id: newPresetId() }; seen.add(np.id); return np; }
    seen.add(p.id); return p;
  });
}

// ============================================================================
// FIXTURE PROFILE LIBRARY (live, shared, install-free store)
//
// A shared store of reusable "looks" (fixture profiles). A preset/button can reference a
// library profile by `profile_ref: 'lib:<slug>'` instead of holding inline look values, so
// one profile powers many buttons and editing it updates them all. Backed by Home Assistant's
// built-in frontend key-value store (frontend/{get,set,subscribe}_{user,system}_data) — the
// same API HA's own frontend uses — so NO custom component is required. Two scopes:
//   'user'   -> per-user (any user may write)
//   'system' -> shared across users (admin write)
// Ported from the Easy Entity Styler card's proven Frame Style Library.
// ============================================================================
const FIXTURE_LIB_KEY = 'color_light_manager_fixture_library';
const FIXTURE_LIB_VERSION = 1;
const FIXTURE_LIBRARY = {
  user: { map: null, loaded: false, loading: false, subscribed: false },
  system: { map: null, loaded: false, loading: false, subscribed: false },
};
function _fixtureLibWs(scope, verb) {
  return `frontend/${verb}_${scope === 'system' ? 'system' : 'user'}_data`;
}
// A url/id-safe slug from a profile name — its library key.
function fixtureLibSlug(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'profile';
}
// Turn a raw stored value into a clean { slug: profileEntry } map. Tolerates the versioned
// envelope, a bare map, or null/garbage. Each entry is { name, look:{...} } with a lib: id.
function _fixtureLibParseValue(value) {
  const map = {};
  if (!value || typeof value !== 'object') return map;
  const profiles = ('color_light_manager_fixtures' in value && value.profiles && typeof value.profiles === 'object')
    ? value.profiles : value;
  Object.keys(profiles).forEach(slug => {
    const p = profiles[slug];
    if (p && typeof p === 'object') {
      const look = extractProfileLook(p.look || p);
      map[slug] = { id: 'lib:' + slug, slug, name: p.name || slug, look, ...(p.note != null && String(p.note).trim() ? { note: String(p.note) } : {}) };
    }
  });
  return map;
}
// Fetch (once) + subscribe to a library scope. onChange fires on initial load and every live
// update. Safe to call repeatedly.
function ensureFixtureLibrary(hass, scope, onChange) {
  scope = scope === 'system' ? 'system' : 'user';
  const st = FIXTURE_LIBRARY[scope];
  if (!hass || !hass.connection) return;
  const conn = hass.connection;
  if (st.subscribed) return;
  if (typeof conn.subscribeMessage === 'function') {
    st.subscribed = true; st.loading = true;
    try {
      conn.subscribeMessage(
        (ev) => {
          st.map = _fixtureLibParseValue(ev && ev.value);
          st.loaded = true; st.loading = false;
          if (typeof onChange === 'function') { try { onChange(); } catch (e) {} }
        },
        { type: _fixtureLibWs(scope, 'subscribe'), key: FIXTURE_LIB_KEY }
      );
    } catch (e) { st.subscribed = false; st.loading = false; }
    return;
  }
  if (st.loaded || st.loading) return;
  if (typeof conn.sendMessagePromise !== 'function') return;
  st.loading = true;
  conn.sendMessagePromise({ type: _fixtureLibWs(scope, 'get'), key: FIXTURE_LIB_KEY })
    .then(res => {
      st.map = _fixtureLibParseValue(res && res.value);
      st.loaded = true; st.loading = false;
      if (typeof onChange === 'function') { try { onChange(); } catch (e) {} }
    })
    .catch(() => { st.loading = false; st.loaded = true; st.map = {}; });
}
// The current cached library map for a scope (slug -> entry), or {}.
function fixtureLibraryMap(scope) {
  const st = FIXTURE_LIBRARY[scope === 'system' ? 'system' : 'user'];
  return st.map || {};
}
// Persist the full library map back to the store. `map` is slug -> {name, look}.
function saveFixtureLibrary(hass, scope, map) {
  scope = scope === 'system' ? 'system' : 'user';
  if (!hass || !hass.connection || typeof hass.connection.sendMessagePromise !== 'function') {
    return Promise.reject(new Error('No connection'));
  }
  const profiles = {};
  Object.keys(map || {}).forEach(slug => {
    const e = map[slug] || {};
    profiles[slug] = { name: e.name || slug, look: extractProfileLook(e.look || {}), ...(e.note ? { note: e.note } : {}) };
  });
  const value = { color_light_manager_fixtures: FIXTURE_LIB_VERSION, profiles };
  return hass.connection.sendMessagePromise({ type: _fixtureLibWs(scope, 'set'), key: FIXTURE_LIB_KEY, value });
}
// Is a value a library reference (lib:<slug>)? Returns the slug or null.
function fixtureRefSlug(ref) {
  return (typeof ref === 'string' && ref.startsWith('lib:')) ? ref.slice(4) : null;
}

// ============================================================================
// BUTTON APPEARANCE PRESETS (shared, install-free store — same infra as Fixture Library)
// A named bundle of the card's button-appearance settings (layout + style + border + gradient
// border + glow + sizing). Saved to HA's system frontend store so it's reusable across all
// Color Light & Scene Manager cards, and exportable as JSON for pasting into other cards.
// ============================================================================
// The exact config keys a Button Appearance preset captures/applies. A preset fully reproduces
// the button look (layout included) — nothing else on the card is touched.
const BUTTON_APPEARANCE_KEYS = [
  'layout', 'columns', 'gap', 'wrap',
  'button_style',
  'button_border_enabled', 'button_border_width', 'button_border_color', 'button_border_color_mode', 'button_border_radius', 'button_border_sides',
  'button_border_gradient', 'button_border_gradient_color_mode',
  'button_glow_enabled', 'button_glow_color', 'button_glow_color_mode', 'button_glow_intensity', 'button_glow_condition',
  'button_glow_blur', 'button_glow_spread', 'button_glow_opacity',
  'button_shadow_enabled', 'button_shadow_color', 'button_shadow_x', 'button_shadow_y', 'button_shadow_blur', 'button_shadow_spread', 'button_shadow_opacity',
  'button_font_size', 'button_name_weight', 'button_name_color', 'button_name_color_mode', 'button_height', 'button_icon_gap', 'button_name_wrap', 'button_max_width',
  'button_icon', 'button_icon_size', 'button_icon_color', 'button_icon_color_mode',
];
// Button-appearance keys grouped by feature (mirrors the Frame model's whole-group layering).
// A layer "owns" a group when it carries that group's keys; on flatten a later owning layer
// REPLACES the whole group, and groups it doesn't own fall through — no per-key deltas. The
// Builder subpanels map 1:1 to these groups, each with an include toggle on overlay layers.
const BUTTON_STYLE_GROUPS = {
  layout:   ['layout', 'columns', 'gap', 'wrap'],
  background: ['button_style'],
  border:   ['button_border_enabled', 'button_border_width', 'button_border_color', 'button_border_color_mode', 'button_border_sides'],
  gradient: ['button_border_gradient', 'button_border_gradient_color_mode'],
  glow:     ['button_glow_enabled', 'button_glow_color', 'button_glow_color_mode', 'button_glow_intensity', 'button_glow_condition', 'button_glow_blur', 'button_glow_spread', 'button_glow_opacity'],
  shadow:   ['button_shadow_enabled', 'button_shadow_color', 'button_shadow_x', 'button_shadow_y', 'button_shadow_blur', 'button_shadow_spread', 'button_shadow_opacity'],
  text:     ['button_font_size', 'button_name_weight', 'button_name_color', 'button_name_color_mode', 'button_name_wrap', 'button_icon_gap'],
  icon:     ['button_icon', 'button_icon_size', 'button_icon_color', 'button_icon_color_mode'],
  sizing:   ['button_border_radius', 'button_height', 'button_max_width'],
};
const BUTTON_STYLE_GROUP_KEYS = ['layout','background','border','gradient','glow','shadow','text','icon','sizing'];
// Which group a given appearance key belongs to (reverse map).
const BUTTON_KEY_GROUP = (() => { const m = {}; BUTTON_STYLE_GROUP_KEYS.forEach(g => BUTTON_STYLE_GROUPS[g].forEach(k => { m[k] = g; })); return m; })();
// The set of groups a layer's `groups` object owns (has at least one key of). Layer 1 (the base)
// typically owns all; overlays own only the groups they define.
function layerOwnedGroups(groups) {
  const owned = new Set();
  Object.keys(groups || {}).forEach(k => { const g = BUTTON_KEY_GROUP[k]; if (g) owned.add(g); });
  return owned;
}
function extractButtonAppearance(cfg) {
  const out = {};
  BUTTON_APPEARANCE_KEYS.forEach(k => { if (cfg && cfg[k] !== undefined) out[k] = JSON.parse(JSON.stringify(cfg[k])); });
  return out;
}
// The button-border sides selected in config (defaults to all four when unset —
// backward compatible with pre-per-side configs that only carried a uniform border).
const BUTTON_BORDER_SIDES = ['top', 'bottom', 'left', 'right'];
function buttonBorderSides(cfg) {
  const s = cfg && cfg.button_border_sides;
  return Array.isArray(s) ? BUTTON_BORDER_SIDES.filter(k => s.includes(k)) : BUTTON_BORDER_SIDES.slice();
}
// Build the solid-border CSS for a button honoring per-side toggles. `width`/`color`
// are already resolved. Emits `border-<side>` only for the chosen sides (others none),
// or the shorthand `border:none` when nothing is selected.
function buttonBorderCss(width, color, sides) {
  const on = new Set(Array.isArray(sides) ? sides : BUTTON_BORDER_SIDES);
  if (!on.size) return 'border:none;';
  if (on.size === 4) return `border:${width}px solid ${color};`;
  return BUTTON_BORDER_SIDES.map(s => `border-${s}:${on.has(s) ? `${width}px solid ${color}` : 'none'};`).join('');
}
// Resolve the CSS color for a button's label from the name-color settings.
//   mode 'fixed'  → the configured hex (button_name_color)
//   mode 'match'  → `matchColor` (the button's own display color, passed by the caller)
//   mode 'inherit'/unset → '' (inherit the surrounding text color — the pre-v181 behavior)
// Returns '' when nothing should be forced, so callers can omit the `color:` declaration entirely
// (keeps existing configs byte-identical in output).
function buttonNameColorCss(cfg, matchColor) {
  const mode = (cfg && cfg.button_name_color_mode) || 'inherit';
  if (mode === 'fixed') return (cfg && cfg.button_name_color) || '';
  if (mode === 'match') return matchColor || '';
  return '';
}
// General 3-way color-mode resolver shared by border / glow / gradient / icon (and, via the
// helper above, text). Returns the resolved CSS color, or `null` meaning "disable this effect".
//   mode 'match' → `matchColor` (the button's own display color); null if the button has none
//                  (e.g. an Off/colorless button) → caller disables the effect.
//   mode 'fixed' → the configured `fixedColor` hex.
//   mode 'none'  → null → caller disables the effect entirely.
// `fallbackMode` is used when the style predates this field (back-compat: old border/glow used
// 'fixed'|'match' only, so unset stays whatever the feature defaulted to).
function resolveButtonColor(mode, fixedColor, matchColor, fallbackMode) {
  const m = mode || fallbackMode || 'fixed';
  if (m === 'none') return null;
  if (m === 'match') return matchColor != null ? matchColor : null;
  return fixedColor || null;
}
const BTN_STYLE_LIB_KEY = 'color_light_manager_button_styles';
const BTN_STYLE_LIB_VERSION = 1;
const BTN_STYLE_LIBRARY = { system: { map: null, loaded: false, loading: false, subscribed: false, defaultSlug: null } };
// Normalize a stored entry into the unified STACK shape:
//   { slug, name, kind, _default?, layers: [ { groups:{...}, when?:{...} }, … ] }
// Back-compat: a v108 preset { settings:{...} } (flat appearance, no layers) becomes a
// single-layer stack whose one layer's groups = those settings, no condition.
function _btnStyleNormalize(slug, p) {
  const name = p.name || slug;
  const kind = (p.kind === 'frame') ? 'frame' : 'button';
  const _default = p._default === true || slug === '__default__';
  let layers;
  if (Array.isArray(p.layers)) {
    layers = p.layers.map(l => ({
      groups: (l && l.groups && typeof l.groups === 'object') ? l.groups : {},
      ...(l && l.when && typeof l.when === 'object' ? { when: l.when } : {}),
      ...(l && l.hidden ? { hidden: true } : {}),
      ...(l && l.label != null && String(l.label).trim() ? { label: String(l.label) } : {}),
    }));
  } else {
    // Legacy single-preset → one always-on layer.
    layers = [{ groups: (p.settings && typeof p.settings === 'object') ? p.settings : {} }];
  }
  // MIGRATION (per-key delta → whole-group ownership): older overlay layers stored partial deltas
  // (e.g. just button_glow_color). The new model owns WHOLE groups. For each layer, any group it
  // partially touched is completed from the EFFECTIVE look at that layer (base beneath + its own
  // keys), so a touched group carries its full key-set. Base (idx 0) keeps its full look as-is.
  if (kind === 'button' && layers.length) {
    const effBelow = {};   // running effective look beneath the current layer
    layers = layers.map((l, idx) => {
      const owned = layerOwnedGroups(l.groups);
      const effHere = { ...effBelow, ...l.groups };
      let groups = l.groups;
      if (idx > 0 && owned.size) {
        groups = {};
        owned.forEach(g => BUTTON_STYLE_GROUPS[g].forEach(k => { if (effHere[k] !== undefined) groups[k] = effHere[k]; }));
      }
      Object.keys(l.groups).forEach(k => { effBelow[k] = l.groups[k]; });   // advance the running base
      return { ...l, groups };
    });
  }
  const out = { slug, name, kind, _default, layers };
  if (p.note != null && String(p.note).trim()) out.note = String(p.note);   // optional freeform note
  if (p.starter != null && String(p.starter).trim()) out.starter = String(p.starter);           // provenance: source slug
  if (p.starter_name != null && String(p.starter_name).trim()) out.starter_name = String(p.starter_name);  // provenance: source display name
  return out;
}
function _btnStyleParseValue(value) {
  const map = {};
  if (!value || typeof value !== 'object') return map;
  const presets = ('color_light_manager_button_styles' in value && value.presets && typeof value.presets === 'object') ? value.presets : value;
  Object.keys(presets).forEach(slug => {
    const p = presets[slug];
    if (p && typeof p === 'object') map[slug] = _btnStyleNormalize(slug, p);
  });
  // Legacy: an old envelope may still carry a system-wide-default pointer. We no longer use it for
  // rendering, but keep it readable so a one-time section migration can preserve the prior look.
  BTN_STYLE_LIBRARY.system.legacyDefaultSlug = (value && typeof value.default_slug === 'string') ? value.default_slug : null;
  return map;
}
function ensureButtonStyleLibrary(hass, onChange) {
  const st = BTN_STYLE_LIBRARY.system;
  if (!hass || !hass.connection || st.subscribed) return;
  const conn = hass.connection;
  if (typeof conn.subscribeMessage === 'function') {
    st.subscribed = true;
    try {
      conn.subscribeMessage((ev) => { st.map = _btnStyleParseValue(ev && ev.value); st.loaded = true; if (typeof onChange === 'function') { try { onChange(); } catch (e) {} } },
        { type: 'frontend/subscribe_system_data', key: BTN_STYLE_LIB_KEY });
    } catch (e) { st.subscribed = false; }
    return;
  }
  if (st.loaded || st.loading || typeof conn.sendMessagePromise !== 'function') return;
  st.loading = true;
  conn.sendMessagePromise({ type: 'frontend/get_system_data', key: BTN_STYLE_LIB_KEY })
    .then(res => { st.map = _btnStyleParseValue(res && res.value); st.loaded = true; st.loading = false; if (typeof onChange === 'function') { try { onChange(); } catch (e) {} } })
    .catch(() => { st.loading = false; st.loaded = true; st.map = {}; });
}
function buttonStyleLibraryMap() { return BTN_STYLE_LIBRARY.system.map || {}; }
function saveButtonStyleLibrary(hass, map) {
  if (!hass || !hass.connection || typeof hass.connection.sendMessagePromise !== 'function') return Promise.reject(new Error('No connection'));
  const presets = {};
  Object.keys(map || {}).forEach(slug => {
    const e = map[slug] || {};
    const layers = (Array.isArray(e.layers) ? e.layers : []).map(l => ({ groups: l.groups || {}, ...(l.when ? { when: l.when } : {}), ...(l.hidden ? { hidden: true } : {}), ...(l.label != null && String(l.label).trim() ? { label: String(l.label) } : {}) }));
    // `starter`/`starter_name` record which style this one was created FROM (provenance shown in the
    // Library). Purely informational — never affects rendering.
    presets[slug] = { name: e.name || slug, kind: e.kind === 'frame' ? 'frame' : 'button', layers, ...(e.note ? { note: e.note } : {}), ...(e.starter ? { starter: e.starter } : {}), ...(e.starter_name ? { starter_name: e.starter_name } : {}) };
  });
  const value = { color_light_manager_button_styles: BTN_STYLE_LIB_VERSION, presets };
  return hass.connection.sendMessagePromise({ type: 'frontend/set_system_data', key: BTN_STYLE_LIB_KEY, value });
}
// Legacy reserved slug for the old baked-in Default stack. No longer special — kept only so the
// migration can recognize it and point the (new) system-wide-default pointer at it.
const BTN_STYLE_DEFAULT_SLUG = '__default__';
// The synthetic, read-only built-in presets. They're never stored — always rendered from these
// hardcoded groups, so they can't drift. Users can Duplicate one or set it as the system-wide
// default. There are two:
//   Basic Theme (__basic_theme__) — a clean "theme surface" look with NO decoration; its own stack
//     adds an active-glow overlay so the selected button glows. Its Layer-1 groups double as the
//     FLATTEN FLOOR (the neutral fallback for any group a style leaves unset).
//   Neon Lux (__neon_lux__) — the decorative blue look (transparent tiles, gradient edge lines,
//     drop shadow, active glow). A single self-contained layer (glow gated by when_active).
const BTN_STYLE_BASIC_SLUG = '__basic_theme__';
const BTN_STYLE_NEON_SLUG = '__neon_lux__';
// Legacy slug for the old single Built-In. Kept only so an existing default pointer still resolves
// (→ Basic Theme, the safe neutral floor).
const BTN_STYLE_BUILTIN_SLUG = '__builtin__';
// Basic Theme — Layer 1 (the neutral floor). Every group present, all decoration OFF. This exact
// object is also the flatten floor used when a style leaves a group unset (see flattenButtonStack),
// so it must stay decoration-free (glow disabled here; the active glow lives in the overlay below).
const BUILTIN_BASIC_THEME_GROUPS = {
  layout: 'columns', columns: 3, gap: 8, wrap: true,
  button_style: 'theme',
  button_border_enabled: false, button_border_width: 1, button_border_color: '#2196F3', button_border_color_mode: 'fixed', button_border_sides: ['top', 'bottom', 'left', 'right'],
  button_border_gradient: { enabled: false, width: 1, sides: { top: false, bottom: true, left: false, right: false }, stops: [{ pos: 0, color: 'transparent' }, { pos: 50, color: 'match' }, { pos: 100, color: 'transparent' }] },
  button_border_gradient_color_mode: 'fixed',
  button_glow_enabled: false, button_glow_color: '#2196F3', button_glow_color_mode: 'fixed', button_glow_intensity: 1, button_glow_condition: 'when_active', button_glow_blur: 8, button_glow_spread: 2, button_glow_opacity: 0.5,
  button_shadow_enabled: false, button_shadow_color: '#000000', button_shadow_x: 0, button_shadow_y: 4, button_shadow_blur: 12, button_shadow_spread: 0, button_shadow_opacity: 0.35,
  button_font_size: 14, button_name_weight: '400', button_name_color: '', button_name_color_mode: 'inherit', button_height: 44, button_icon_gap: 8, button_name_wrap: true, button_max_width: 0,
  button_icon: '', button_icon_size: 0, button_icon_color: '', button_icon_color_mode: '',
  button_border_radius: 8,
};
// Basic Theme — Layer 2: an active-only overlay that turns the glow ON for the selected button, so
// the plain theme buttons still signal "active". Owns only the Glow group; applies via button_active.
const BUILTIN_BASIC_THEME_ACTIVE_GLOW = {
  button_glow_enabled: true, button_glow_color: '#2196F3', button_glow_color_mode: 'fixed', button_glow_intensity: 1, button_glow_condition: 'when_active', button_glow_blur: 8, button_glow_spread: 2, button_glow_opacity: 0.5,
};
// Neon Lux — a single self-contained look (the user-provided JSON). glow_condition 'when_active'
// already restricts the glow to the active button, so no separate overlay layer is needed.
const BUILTIN_NEON_LUX_GROUPS = {
  layout: 'columns', columns: 6, gap: 7, wrap: true,
  button_style: 'transparent',
  button_border_enabled: false, button_border_width: 1, button_border_color: '#2196F3', button_border_color_mode: 'match', button_border_sides: ['top', 'bottom'],
  button_border_gradient: { enabled: true, width: 1, sides: { top: true, bottom: true, left: false, right: false }, stops: [{ pos: 0, color: 'transparent' }, { pos: 50, color: 'match' }, { pos: 100, color: 'transparent' }] },
  button_border_gradient_color_mode: 'fixed',
  button_glow_enabled: true, button_glow_color: '#2196F3', button_glow_color_mode: 'fixed', button_glow_intensity: 1, button_glow_condition: 'when_active', button_glow_blur: 8, button_glow_spread: 2, button_glow_opacity: 0.5,
  button_shadow_enabled: true, button_shadow_color: '#000000', button_shadow_x: 0, button_shadow_y: 4, button_shadow_blur: 12, button_shadow_spread: 4, button_shadow_opacity: 0.56,
  button_font_size: 14, button_name_weight: '400', button_name_color: '', button_name_color_mode: 'inherit', button_name_wrap: true, button_icon_gap: 4,
  button_icon: 'mdi:power', button_icon_size: 0, button_icon_color: '#2196F3', button_icon_color_mode: '',
  button_border_radius: 8, button_height: 30, button_max_width: 115,
};
// Registry of the built-in stacks by slug. Order here is the order shown in the library list.
const BUILTIN_BUTTON_STYLES = {
  [BTN_STYLE_BASIC_SLUG]: { name: 'Basic Theme', layers: [
    { groups: BUILTIN_BASIC_THEME_GROUPS },
    { groups: BUILTIN_BASIC_THEME_ACTIVE_GLOW, when: { type: 'button_active' }, label: 'Active glow' },
  ] },
  [BTN_STYLE_NEON_SLUG]: { name: 'Neon Lux', layers: [{ groups: BUILTIN_NEON_LUX_GROUPS }] },
};
// Normalize any built-in slug (incl. the legacy alias) to a current registry slug, or null if not
// a built-in. The legacy Built-In maps to Basic Theme (the safe neutral floor).
function builtinButtonSlug(slug) {
  if (slug === BTN_STYLE_BUILTIN_SLUG) return BTN_STYLE_BASIC_SLUG;
  return BUILTIN_BUTTON_STYLES[slug] ? slug : null;
}
function isBuiltinButtonSlug(slug) { return builtinButtonSlug(slug) !== null; }
// A built-in as a normal stack shape. Deep-cloned on read so callers can't mutate the shared
// constants. `slug` defaults to Basic Theme (the fail-safe). Unknown slug → Basic Theme.
function builtinButtonStack(slug) {
  const key = builtinButtonSlug(slug) || BTN_STYLE_BASIC_SLUG;
  const def = BUILTIN_BUTTON_STYLES[key];
  return { slug: key, name: def.name, kind: 'button', builtin: true, layers: JSON.parse(JSON.stringify(def.layers)) };
}
// Resolve a stack by slug: a synthetic built-in, else a stored preset (or undefined).
function buttonStyleStack(slug) {
  if (isBuiltinButtonSlug(slug)) return builtinButtonStack(slug);
  return buttonStyleLibraryMap()[slug];
}
// LEGACY-ONLY: what the old system-wide-default pointer resolved to, used solely by the one-time
// section migration to preserve appearance (sections that stored "(system default)" get pinned to
// this concrete slug). Returns a slug that resolves to a built-in or an existing preset, else Basic
// Theme. Not used for any live rendering — the section resolver falls back to Basic Theme directly.
function legacyDefaultResolvedSlug() {
  const st = BTN_STYLE_LIBRARY.system;
  const map = buttonStyleLibraryMap();
  if (st.legacyDefaultSlug && (isBuiltinButtonSlug(st.legacyDefaultSlug) || map[st.legacyDefaultSlug])) return builtinButtonSlug(st.legacyDefaultSlug) || st.legacyDefaultSlug;
  if (map[BTN_STYLE_DEFAULT_SLUG]) return BTN_STYLE_DEFAULT_SLUG;
  return BTN_STYLE_BASIC_SLUG;
}
// Condition catalog for conditional style layers. `kinds` limits a condition to button and/or
// frame stacks so the picker can hide context-inappropriate options (e.g. section_* are frame-only,
// evaluated true for buttons). The first entry (type '') is the unconditional / base layer.
const BTN_STYLE_CONDITIONS = [
  { type: '', label: 'Always', kinds: ['button', 'frame'] },
  { type: 'button_active', label: 'Button Active', kinds: ['button'] },
  { type: 'button_off', label: 'Off button only', kinds: ['button'] },
  { type: 'light_on', label: 'Light On', kinds: ['button', 'frame'] },
  { type: 'light_off', label: 'Light Off', kinds: ['button', 'frame'] },
  { type: 'light_unavailable', label: 'Light unavailable/unknown', kinds: ['button', 'frame'] },
  { type: 'entity_state', label: 'Entity state / attribute…', kinds: ['button', 'frame'] },
  { type: 'section_has_entities', label: 'Section has entities', kinds: ['frame'] },
  { type: 'section_empty', label: 'Section is empty', kinds: ['frame'] },
];
function btnStyleConditionLabel(when) {
  if (!when || !when.type) return 'Always';
  if (when.type === 'entity_state') {
    const e = when.entity || '(entity)';
    if (when.attr) return `${e}.${when.attr} ${when.op || '=='} ${when.value != null ? when.value : ''}`.trim();
    return `${e} is ${when.state != null ? when.state : 'on'}`;
  }
  const found = BTN_STYLE_CONDITIONS.find(c => c.type === when.type);
  return found ? found.label : when.type;
}
// Flatten a stack's ACTIVE layers into one appearance-settings object (last-writer-wins per
// group). `isActive(when)` decides each layer's conditional application (always-on if no when).
// Returns a flat cfg-style object (the same keys _renderPresetButton reads).
function flattenButtonStack(stack, isActive) {
  if (!stack || !Array.isArray(stack.layers)) return { ...BUILTIN_BASIC_THEME_GROUPS };
  // Is there an active UNCONDITIONAL (Always) base layer contributing the full look? If not (no
  // base, or the base is hidden/inactive), seed from the curated Built-In look so overlays land on
  // a real starting look instead of the card's raw stub defaults (which render as an unstyled pill).
  const hasActiveBase = stack.layers.some(l => !l.hidden && (!l.when || !l.when.type)
    && (typeof isActive !== 'function' || !l.when || isActive(l.when)) && l.groups && Object.keys(l.groups).length);
  const acc = hasActiveBase ? {} : { ...BUILTIN_BASIC_THEME_GROUPS };
  stack.layers.forEach(l => {
    if (l.hidden) return;                                                 // hidden layers are skipped entirely
    if (l.when && typeof isActive === 'function' && !isActive(l.when)) return;
    const g = l.groups || {};
    Object.keys(g).forEach(k => { acc[k] = g[k]; });
  });
  return acc;
}
// The appearance keys, EXCLUDING a candidate look, that the layers UNDER `idx` already establish.
// Used so "Capture" on a conditional layer stores only what DIFFERS from the base beneath it —
// a true overlay of just-what-changes, not a full 29-key snapshot.
function buttonStackBaseBelow(layers, idx) {
  const acc = {};
  for (let i = 0; i < idx && i < layers.length; i++) {
    const g = (layers[i] && layers[i].groups) || {};
    Object.keys(g).forEach(k => { acc[k] = g[k]; });
  }
  return acc;
}
// Reduce a full appearance object to only the keys that differ from `base` (deep-equal compare).
// The base (idx 0 / Always) layer keeps its full look; overlay layers keep only their deltas.
function buttonStyleDelta(full, base) {
  const out = {};
  Object.keys(full || {}).forEach(k => {
    if (JSON.stringify(full[k]) !== JSON.stringify((base || {})[k])) out[k] = full[k];
  });
  return out;
}
// Resolves a preset's effective look: if it references a library profile, use the library
// look (falling back to the preset's inline look if the ref is missing); else inline.
function resolvePresetLook(preset, scope) {
  const slug = fixtureRefSlug(preset && preset.profile_ref);
  if (slug) {
    const entry = fixtureLibraryMap(scope)[slug];
    if (entry && entry.look) return entry.look;
  }
  return extractProfileLook(preset || {});
}

function buildSections(cfg) {
  // Already migrated? Use as-is (filtered to known types — including standalone dividers).
  if (Array.isArray(cfg.sections) && cfg.sections.length) {
    return cfg.sections.filter(s => s && ['buttons', 'sliders', 'values', 'divider', 'scene_tracker'].includes(s.type));
  }
  // Legacy migration from flat config.
  const sliders = {
    brightness: cfg.show_brightness_slider !== false,
    temperature: cfg.show_temperature_slider !== false,
    rgb: cfg.show_rgb_slider !== false,
  };
  const out = [
    { id: 'buttons-1', type: 'buttons', name: 'Buttons' },
    { id: 'sliders-1', type: 'sliders', name: 'Sliders', sliders, target_entities: [] },
  ];
  // Only seed a Color Values section if the legacy flag had it enabled — a values section
  // now renders by existing, so we mustn't force one on for configs that had it off.
  if (cfg.show_current_values) out.push({ id: 'values-1', type: 'values', name: 'Color Values', target_entities: [] });
  return out;
}

// Converts a white color temperature (Kelvin) into a light.turn_on parameter object,
// per the configured output format. This is the workaround for controllers whose native
// color_temp handling is wrong — the same warm white can be sent as xy/hs/rgb/mired
// instead of Kelvin. Returns e.g. { color_temp_kelvin: 2700 } or { xy_color: [.., ..] }.
function kelvinToServiceData(kelvin, format, opts) {
  const k = Math.round(kelvin);
  const warmK = (opts && opts.warmK) || 2000, coolK = (opts && opts.coolK) || 6500;
  switch (format) {
    case 'xy': return { xy_color: ColorUtils.kelvinToXy(k) };
    case 'hs': return { hs_color: ColorUtils.kelvinToHs(k) };
    case 'rgb': return { rgb_color: ColorUtils.kelvinToRgb(k) };
    case 'rgbw': return { rgbw_color: ColorUtils.kelvinToRgbw(k) };
    case 'rgbww': return { rgbww_color: ColorUtils.kelvinToRgbww(k, warmK, coolK) };
    case 'kelvin':
    default: return { color_temp_kelvin: k };
  }
}

function presetValueToSetColorData(preset, tempFormat, tempOpts) {
  const mode = presetMode(preset);
  let data = null;
  const fmt = presetColorFormat(preset);
  // Color is sent in its own native format verbatim (no lossy conversion); temperature via
  // the configured send-method. A light is in one color mode at a time, so a preset sends one.
  if (mode === 'temp') {
    data = kelvinToServiceData(preset.color_kelvin, tempFormat, tempOpts);
  } else if (mode === 'color') {
    data = fmt ? { [PRESET_COLOR_KEYS[fmt]]: preset[PRESET_COLOR_KEYS[fmt]] } : null;
  }
  if (!data) return null;
  if (preset.brightness !== undefined && preset.brightness !== null) data.brightness = preset.brightness;
  return data;
}

// On load, link each preset lacking an explicit input_color_entity to an input_color.*
// entity whose id matches the preset's slugified name (e.g. preset "Sunset" ->
// color.sunset), when one exists and isn't already claimed by another preset.
// Returns { presets: <updated array>, unmatched: <input_color.* ids not claimed by any preset> }.
function matchPresetsToInputColorEntities(presets, hass, excluded) {
  const skip = excluded instanceof Set ? excluded : new Set();
  const allEntities = getInputColorEntities(hass).filter(id => !skip.has(id));
  const claimed = new Set(presets.map(p => p.input_color_entity).filter(Boolean));
  const updated = presets.map(preset => {
    if (preset.input_color_entity) return preset;
    const slug = slugify(preset.name);
    // Prefer the new `color.` domain, but also match a legacy `input_color.` helper by name.
    const candidate = COLOR_HELPER_DOMAINS.map(d => `${d}.${slug}`).find(id => allEntities.includes(id) && !claimed.has(id));
    if (candidate) {
      claimed.add(candidate);
      return { ...preset, input_color_entity: candidate };
    }
    return preset;
  });
  const unmatched = allEntities.filter(id => !claimed.has(id));
  return { presets: updated, unmatched, all: allEntities };
}


// ============ FRAME PRESET ENGINE (ported) ============
// ====================================================================
// FRAME PRESET ENGINE (ported from EESC v132 — System + Built-In model)
// Self-contained: data model, versioned export/import, shared HA
// frontend/*_data library store, Built-In fallback, and CSS builders.
// Conditions (when/when_entity) are stored & round-tripped but NOT
// evaluated here (the value-resolution engine is EESC-only); Color-card
// frames apply unconditionally in this first cut.
// ====================================================================
function normalizeValueRef(ref) {
  ref = ref || {};
  const out = {
    source: ref.source || 'state',
    attribute: ref.attribute || '',
    transform: ref.transform || 'none',
    unit: ref.unit || ''
  };
  // Array-element field (attribute-array table rows). Emitted only when set so
  // entity-sourced value refs stay byte-stable.
  if (ref.source === 'field' || ref.field) { out.source = 'field'; out.field = ref.field || ''; }
  // 'related' pairs the row with a sibling entity (e.g. temp row -> its
  // humidity sensor). Preserve the match spec + the nested value ref.
  if (ref.source === 'related' && ref.related) {
    out.related = {
      match: ref.related.match === 'name_replace' ? 'name_replace' : 'device',
      device_class: ref.related.device_class || '',
      find: ref.related.find || '',
      replace: ref.related.replace || '',
      value: normalizeValueRef(ref.related.value)
    };
  }
  return out;
}

function normalizeCondition(c) {
  c = c || {};
  // Compound condition: all/any of sub-conditions (value + time combos).
  if (Array.isArray(c.all)) return { all: c.all.map(normalizeCondition) };
  if (Array.isArray(c.any)) return { any: c.any.map(normalizeCondition) };
  const out = { op: c.op || 'eq' };
  if (c.ref) out.ref = normalizeValueRef(c.ref);
  // Array-field condition: names the element field to test (attribute-array
  // rows). Preserved only when set, so entity conditions stay byte-stable.
  if (c.field) out.field = c.field;
  if (c.value !== undefined) out.value = c.value;
  if (c.value2 !== undefined) out.value2 = c.value2;
  if (Array.isArray(c.values)) out.values = [...c.values];
  if (c.op2) out.op2 = c.op2;
  if (c.case_insensitive === false) out.case_insensitive = false;
  return out;
}

let _fxSeq = 0;
function _fxId() { _fxSeq += 1; return 'fx_gen_' + _fxSeq.toString(36) + Math.random().toString(36).slice(2, 6); }

// One edge side: enabled + thickness + gradient stops ({pos 0-100, color}).
// Gradient-border quick-preset stop sets (shared with EESC). A 'match' stop
// resolves to the frame's border/icon color at render time.
// Edge gradient pattern presets. `match` = follow the border/icon color; literal
// hex / `transparent` are used verbatim. MUST stay byte-identical to the Easy
// Entity Styler card's copy so a frame round-trips between cards (normalizeEdgeSide
// only keeps a `pattern` field whose key exists here). Mirrors DIVIDER_GRADIENT_PATTERNS.
const EDGE_GRADIENT_PATTERNS = {
  center_fade: [{ pos: 0, color: 'transparent' }, { pos: 50, color: 'match' }, { pos: 100, color: 'transparent' }],
  solid: [{ pos: 0, color: 'match' }, { pos: 100, color: 'match' }],
  fade_in: [{ pos: 0, color: 'transparent' }, { pos: 100, color: 'match' }],
  fade_out: [{ pos: 0, color: 'match' }, { pos: 100, color: 'transparent' }],
  center_gap: [{ pos: 0, color: 'match' }, { pos: 50, color: 'transparent' }, { pos: 100, color: 'match' }],
  mirror_fade: [{ pos: 0, color: 'transparent' }, { pos: 35, color: 'match' }, { pos: 65, color: 'match' }, { pos: 100, color: 'transparent' }],
  mirror_gap: [{ pos: 0, color: 'match' }, { pos: 35, color: 'transparent' }, { pos: 65, color: 'transparent' }, { pos: 100, color: 'match' }],
  two_color: [{ pos: 0, color: '#2196F3' }, { pos: 100, color: '#e91e63' }],
  two_color_mirror: [{ pos: 0, color: '#2196F3' }, { pos: 50, color: '#e91e63' }, { pos: 100, color: '#2196F3' }],
  rainbow: [{ pos: 0, color: '#ff0000' }, { pos: 25, color: '#ffff00' }, { pos: 50, color: '#00ff00' }, { pos: 75, color: '#00ffff' }, { pos: 100, color: '#ff00ff' }],
  rainbow_mirror: [{ pos: 0, color: '#ff0000' }, { pos: 17, color: '#ffff00' }, { pos: 34, color: '#00ff00' }, { pos: 50, color: '#00ffff' }, { pos: 66, color: '#00ff00' }, { pos: 83, color: '#ffff00' }, { pos: 100, color: '#ff0000' }]
};
// Ordered [key,label] list for the edge pattern dropdown (shared by both cards).
const EDGE_GRADIENT_PATTERN_LIST = [
  ['', 'Custom (edit stops below)'],
  ['center_fade', 'Center fade (transparent → color → transparent)'],
  ['solid', 'Solid'],
  ['fade_in', 'Fade in'],
  ['fade_out', 'Fade out'],
  ['center_gap', 'Center gap (color → transparent → color)'],
  ['mirror_fade', 'Mirror fade (transparent → color → color → transparent)'],
  ['mirror_gap', 'Mirror gap (color → transparent → transparent → color)'],
  ['two_color', 'Two-color (left → right)'],
  ['two_color_mirror', 'Two-color (mirror center)'],
  ['rainbow', 'Rainbow'],
  ['rainbow_mirror', 'Rainbow (mirror center)']
];
function normalizeEdgeSide(e) {
  e = e || {};
  const stops = (Array.isArray(e.stops) ? e.stops : [])
    .map(s => ({ pos: Math.max(0, Math.min(100, Number(s.pos) || 0)), color: String(s.color || 'transparent') }))
    .sort((a, b) => a.pos - b.pos);
  // gradient:false → solid line of `color`; gradient:true → the stops.
  // Back-compat: stops-present + no explicit flag → gradient:true (renders same).
  const gradient = e.gradient === false ? false : (e.gradient === true ? true : stops.length > 0);
  const out = {
    enabled: e.enabled === true,
    thickness: Number(e.thickness) > 0 ? Math.floor(Number(e.thickness)) : 1,
    gradient,
    color: e.color || 'match',
    stops
  };
  if (e.pattern && EDGE_GRADIENT_PATTERNS[e.pattern]) out.pattern = e.pattern;
  return out;
}
function normalizeEdges(edges) {
  edges = edges || {};
  const out = {
    top: normalizeEdgeSide(edges.top),
    bottom: normalizeEdgeSide(edges.bottom),
    left: normalizeEdgeSide(edges.left),
    right: normalizeEdgeSide(edges.right)
  };
  // all_same: the `top` side's STYLE is mirrored to every side; each side keeps
  // its own `enabled`. Render treats sides independently.
  if (edges.all_same === true) {
    out.all_same = true;
    const src = out.top;
    ['bottom', 'left', 'right'].forEach(side => {
      const en = out[side].enabled;
      out[side] = JSON.parse(JSON.stringify(src));
      out[side].enabled = en;
    });
  }
  return out;
}

// Full normalizer for one effect preset. All visual sub-objects are optional
// and emitted only when present, so a preset carries only what it uses.
// A Frame Style (formerly "effect preset"): a SPARSE bundle of frame styling.
// Only the groups the user set are present; an absent group means "don't touch"
// (critical for layering — see _resolveFrame). Groups: glow / shadow / border /
// background / edges, plus an optional `when`/`when_entity` condition.
function normalizeFramePreset(fx) {
  fx = fx || {};
  const out = {
    id: fx.id || _fxId(),
    name: fx.name != null && String(fx.name).trim() ? String(fx.name) : 'Frame Style'
  };
  // Optional freeform note (shown in the library UI). Byte-stable when unset.
  if (fx.note != null && String(fx.note).trim()) out.note = String(fx.note).trim();
  if (fx.glow) out.glow = {
    color: fx.glow.color || '#2196F3',
    intensity: Number(fx.glow.intensity) || 1.0,
    borders_only: fx.glow.borders_only === true,
    ...(fx.glow.follow_icon ? { follow_icon: true } : {})
  };
  if (fx.shadow) out.shadow = {
    color: fx.shadow.color || '#000000',
    ...(fx.shadow.follow_icon ? { follow_icon: true } : {}),
    x: Number(fx.shadow.x) || 0, y: fx.shadow.y != null ? Number(fx.shadow.y) : 4,
    blur: fx.shadow.blur != null ? Number(fx.shadow.blur) : 12,
    spread: Number(fx.shadow.spread) || 0,
    opacity: fx.shadow.opacity != null ? Number(fx.shadow.opacity) : 0.35
  };
  if (fx.border) out.border = {
    color: fx.border.color || '#2196F3',
    width: fx.border.width != null ? Number(fx.border.width) : 1,
    radius: fx.border.radius != null ? Number(fx.border.radius) : 12,
    // Per-corner radius [TL, TR, BR, BL]; false = square corner. Kept in sync
    // with the EESC frame model so shared presets round-trip identically.
    corners: Array.isArray(fx.border.corners) && fx.border.corners.length === 4
      ? fx.border.corners.map(c => c !== false) : [true, true, true, true],
    follow_icon: fx.border.follow_icon === true,
    sides: Array.isArray(fx.border.sides) ? fx.border.sides.filter(s => ['top', 'bottom', 'left', 'right'].includes(s)) : ['top', 'bottom', 'left', 'right']
  };
  // Background: 'custom' (a solid color), 'transparent', or 'theme' (inherit
  // the HA card/theme background). Legacy values were a bare string or
  // { color } object (custom only), which migrate to mode:'custom'.
  if (fx.background != null) {
    const bg = (typeof fx.background === 'object') ? fx.background : { color: String(fx.background) };
    const mode = ['transparent', 'theme', 'custom'].includes(bg.mode) ? bg.mode : 'custom';
    out.background = mode === 'custom'
      ? { mode: 'custom', color: String(bg.color != null ? bg.color : '#1c1c1c') }
      : { mode };
  }
  if (fx.edges) out.edges = normalizeEdges(fx.edges);
  // Conditional application. Two kinds:
  //  - entity (default): `when` (condition) + `when_entity` (watched entity id)
  //  - section membership: `when_kind` = 'section_has_entities' | 'section_empty'
  //    + `when_section` (target section id) — the preset applies only when that
  //    section currently has (or lacks) visible entities.
  if (fx.when_kind === 'section_has_entities' || fx.when_kind === 'section_empty') {
    out.when_kind = fx.when_kind;
    out.when_section = String(fx.when_section || '');
  } else {
    if (fx.when) out.when = normalizeCondition(fx.when);
    // The entity a conditional preset watches (paired with `when`).
    if (fx.when_entity) out.when_entity = String(fx.when_entity);
  }
  return out;
}
function normalizeFramePresets(list) {
  return Array.isArray(list) ? list.map(normalizeFramePreset) : [];
}

// ---------------------------------------------------------------------------
// Built-In frame — the card's internal read-only fallback, so a fresh card
// always has a sensible starting frame with nothing configured. It is NEVER
// stored (mirrors the Color card's Built-In Button Style): always rendered
// from this constant, so it can't drift or be deleted. Its id is a reserved
// library id so section/card frame refs can point at it like any other.
// The Frame Library is otherwise System-only (shared HA store) — there is no
// "Local" (card-only) frame concept.
const BUILTIN_FRAME_SLUG = '__builtin__';
const BUILTIN_FRAME_ID = 'lib:' + BUILTIN_FRAME_SLUG;
// A clean, neutral starting frame: a thin border that follows the icon color,
// gently rounded, with a soft matching glow. Sparse — touches only border+glow
// so it layers cleanly under anything the user adds on top.
const BUILTIN_FRAME_GROUPS = {
  border: { follow_icon: true, width: 1, radius: 12, sides: ['top', 'bottom', 'left', 'right'] },
  glow: { follow_icon: true, intensity: 1.0, borders_only: true }
};
// The Built-In as a normalized preset object (fresh each call so callers can't
// mutate the shared constant).
function builtinFramePreset() {
  const p = normalizeFramePreset({ name: 'Built-In', ...JSON.parse(JSON.stringify(BUILTIN_FRAME_GROUPS)) });
  p.id = BUILTIN_FRAME_ID;
  p._builtin = true;   // read-only marker for the editor
  return p;
}

// ---------------------------------------------------------------------------
// Frame Style portability (share/export/import + library store).
//
// One serializer feeds two destinations: (1) a plain-text envelope the user
// copies between systems, and (2) the frontend key-value store used as a live
// shared library. Both consume the same versioned envelope so a preset made in
// either path is valid in the other.
// ---------------------------------------------------------------------------
const SEED_FRAME_EXPORT_VERSION = 1;

// Strip a preset down to its portable core: id + name + the sparse frame
// groups. `keepConditions` decides whether the when/when_entity/when_section
// keys travel — they reference system-local entities/sections, so the default
// is to drop them (portable visuals only). Runs through normalizeFramePreset
// so the output is always schema-clean.
function portableFramePreset(fx, keepConditions) {
  const norm = normalizeFramePreset(fx);
  if (!keepConditions) {
    delete norm.when; delete norm.when_entity;
    delete norm.when_kind; delete norm.when_section;
  }
  return norm;
}

// A stable content key for dedupe: everything that defines the preset's look
// (and, when kept, its condition) but NOT its id or name. Two presets with the
// same key are considered identical for import-dedupe purposes.
function framePresetContentKey(fx) {
  const norm = normalizeFramePreset(fx);
  const copy = {};
  Object.keys(norm).sort().forEach(k => {
    if (k === 'id' || k === 'name') return;
    copy[k] = norm[k];
  });
  return JSON.stringify(copy);
}

// Serialize one or more presets into the versioned text envelope. `exported`
// is an ISO date string supplied by the caller (Date.now() is unavailable in
// some contexts, so it's passed in). Conditions are dropped unless asked for.
function serializeFramePresets(presets, opts) {
  opts = opts || {};
  const list = (Array.isArray(presets) ? presets : [presets])
    .filter(Boolean)
    .map(fx => portableFramePreset(fx, opts.keepConditions === true));
  const env = { seed_frame_presets: SEED_FRAME_EXPORT_VERSION, presets: list };
  if (opts.exported) env.exported = String(opts.exported);
  return JSON.stringify(env, null, 2);
}

// Parse + validate a pasted envelope. Returns { ok, presets, error }. Accepts
// either the full envelope or a bare array/object of presets (lenient inbound,
// strict about producing clean output). Every returned preset is normalized
// and given a FRESH id so imports never collide with existing presets.
function parseFramePresetBlob(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { ok: false, error: 'Not valid JSON.' }; }

  let list;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'seed_frame_presets' in raw) {
    if (Number(raw.seed_frame_presets) > SEED_FRAME_EXPORT_VERSION) {
      return { ok: false, error: 'Made by a newer version of the card. Update the card first.' };
    }
    if (!Array.isArray(raw.presets)) return { ok: false, error: 'Envelope has no presets list.' };
    list = raw.presets;
  } else if (Array.isArray(raw)) {
    list = raw;                      // bare array of presets
  } else if (raw && typeof raw === 'object' && (raw.glow || raw.shadow || raw.border || raw.background || raw.edges)) {
    list = [raw];                    // a single bare preset object
  } else {
    return { ok: false, error: 'Unrecognized format — expected exported Frame Style text.' };
  }

  const presets = [];
  list.forEach(p => {
    if (!p || typeof p !== 'object') return;
    // Must carry at least one visual group to be a meaningful preset.
    if (!(p.glow || p.shadow || p.border || p.background || p.edges)) return;
    const norm = normalizeFramePreset(p);
    norm.id = _fxId();               // fresh id — never collide on import
    presets.push(norm);
  });
  if (!presets.length) return { ok: false, error: 'No usable presets found in the text.' };
  return { ok: true, presets };
}

// Merge imported presets into an existing list, skipping any whose content is
// byte-identical to one already present. Returns { list, added, skipped }.
function mergeFramePresets(existing, incoming) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(out.map(framePresetContentKey));
  let added = 0, skipped = 0;
  (incoming || []).forEach(p => {
    const key = framePresetContentKey(p);
    if (seen.has(key)) { skipped += 1; return; }
    seen.add(key); out.push(p); added += 1;
  });
  return { list: out, added, skipped };
}

// ---------------------------------------------------------------------------
// SECTION EXPORT/IMPORT — a whole section + its buttons as a portable payload.
// A section's structure travels inline; its buttons (which have no shared library
// — they live in cfg.presets) are bundled in the payload so an import lands a
// complete, working section. Library-backed refs (Button Style style_preset,
// Fixture Profile profile_ref, Frame/Header refs) and HA entity ids (selects,
// targets, tracker areas, default_scene_group) are NOT copied — they resolve on
// the same instance and degrade gracefully cross-instance (missing style → Basic
// Theme, missing entity → binding just doesn't match), exactly like a Button
// Style import that references a missing profile.
// ---------------------------------------------------------------------------
const SECTION_EXPORT_VERSION = 1;

// Serialize a section + its buttons into the versioned text envelope. `presets`
// is the list of button objects belonging to this section (caller resolves them).
function serializeSection(section, presets, exportedIso) {
  const env = {
    seed_section: SECTION_EXPORT_VERSION,
    section: JSON.parse(JSON.stringify(section)),
    presets: (Array.isArray(presets) ? presets : []).map(p => JSON.parse(JSON.stringify(p))),
  };
  if (exportedIso) env.exported = String(exportedIso);
  return JSON.stringify(env, null, 2);
}

// Parse + validate a pasted section envelope. Returns { ok, section, presets, error }.
// The returned section keeps its stored fields but its id/section_id linkage is left
// for the caller to re-key (so ids never collide with the target card).
function parseSectionBlob(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { ok: false, error: 'Not valid JSON.' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('seed_section' in raw)) {
    return { ok: false, error: 'Unrecognized format — expected an exported Section.' };
  }
  if (Number(raw.seed_section) > SECTION_EXPORT_VERSION) {
    return { ok: false, error: 'Made by a newer version of the card. Update the card first.' };
  }
  const section = raw.section;
  if (!section || typeof section !== 'object' || !section.type) {
    return { ok: false, error: 'Envelope has no valid section.' };
  }
  const presets = Array.isArray(raw.presets) ? raw.presets.filter(p => p && typeof p === 'object') : [];
  return { ok: true, section: JSON.parse(JSON.stringify(section)), presets: presets.map(p => JSON.parse(JSON.stringify(p))) };
}

// A url/id-safe slug from a preset name, used as its library key.
function frameLibSlug(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'preset';
}

// ---------------------------------------------------------------------------
// Frame Style LIBRARY (live, shared, install-free store).
//
// Backed by Home Assistant's built-in frontend key-value store — the same WS
// API HA's own frontend uses (frontend/{get,set,subscribe}_{user,system}_data).
// No custom component required. Two scopes:
//   'user'   -> frontend/*_user_data  (per-user, any user may write)
//   'system' -> frontend/*_system_data (shared across users, admin write)
// We keep the whole library under ONE namespaced key so it never collides with
// core's own keys (core/sidebar/home/energy). The stored value is a versioned
// envelope { seed_frame_presets:1, presets:{ slug: preset } }.
// Mirrors ensureLabelRegistry: fetch once over WS into a module cache, then
// subscribe for live cross-card updates.
// ---------------------------------------------------------------------------
// Shared, brand-neutral 'ltek' family key so every ltek card reads/writes the
// SAME frame library. `seed_frame_library` is the legacy key (pre-rename); it's
// read once for one-time forward-migration so existing frames aren't orphaned.
const SEED_FRAME_LIB_KEY = 'ltek_frame_library';
const SEED_FRAME_LIB_KEY_LEGACY = 'seed_frame_library';
// scope -> { map: {slug:preset}|null, loaded, loading, subscribed }
const SEED_FRAME_LIBRARY = {
  user: { map: null, loaded: false, loading: false, subscribed: false, migrated: false },
  system: { map: null, loaded: false, loading: false, subscribed: false, migrated: false }
};

function _frameLibWs(scope, verb) {
  // verb: 'get' | 'set' | 'subscribe' ; scope: 'user' | 'system'
  return `frontend/${verb}_${scope === 'system' ? 'system' : 'user'}_data`;
}

// Turn a raw stored value into a clean { slug: preset } map. Tolerates the
// envelope, a bare map, or null/garbage (-> empty map).
function _frameLibParseValue(value) {
  const map = {};
  if (!value || typeof value !== 'object') return map;
  const presets = ('seed_frame_presets' in value && value.presets && typeof value.presets === 'object')
    ? value.presets : value;
  Object.keys(presets).forEach(slug => {
    const p = presets[slug];
    if (p && typeof p === 'object' && (p.glow || p.shadow || p.border || p.background || p.edges)) {
      const norm = normalizeFramePreset(p);
      norm.id = 'lib:' + slug;       // library presets carry a lib: id
      map[slug] = norm;
    }
  });
  return map;
}

// One-time forward-migration: if the new `ltek_frame_library` key is empty,
// pull any frames from the legacy `seed_frame_library` key and write them into
// the new key. Runs at most once per scope per session (st.migrated). Existing
// `lib:<slug>` refs keep working because slugs are unchanged. Best-effort — a
// failure just leaves the new key empty (no data lost; legacy key untouched).
function _migrateLegacyFrameLibrary(hass, scope, st, onChange) {
  if (st.migrated) return;
  st.migrated = true;
  const conn = hass && hass.connection;
  if (!conn || typeof conn.sendMessagePromise !== 'function') return;
  conn.sendMessagePromise({ type: _frameLibWs(scope, 'get'), key: SEED_FRAME_LIB_KEY_LEGACY })
    .then(res => {
      const legacy = _frameLibParseValue(res && res.value);
      if (!legacy || !Object.keys(legacy).length) return;   // nothing to migrate
      if (st.map && Object.keys(st.map).length) return;      // don't clobber newer data
      st.map = legacy;
      if (typeof onChange === 'function') { try { onChange(); } catch (e) {} }
      saveFrameLibrary(hass, scope, legacy).catch(() => {});
    })
    .catch(() => {});
}

// Fetch (once) + subscribe to a library scope. onChange fires on initial load
// AND on every live update, so callers re-render. Safe to call repeatedly.
function ensureFrameLibrary(hass, scope, onChange) {
  scope = scope === 'system' ? 'system' : 'user';
  const st = SEED_FRAME_LIBRARY[scope];
  if (!hass || !hass.connection) return;
  const conn = hass.connection;
  if (st.subscribed) return;         // subscription drives all future updates
  if (typeof conn.subscribeMessage === 'function') {
    st.subscribed = true; st.loading = true;
    try {
      conn.subscribeMessage(
        (ev) => {
          st.map = _frameLibParseValue(ev && ev.value);
          st.loaded = true; st.loading = false;
          if (typeof onChange === 'function') { try { onChange(); } catch (e) {} }
          if (!Object.keys(st.map).length) _migrateLegacyFrameLibrary(hass, scope, st, onChange);
        },
        { type: _frameLibWs(scope, 'subscribe'), key: SEED_FRAME_LIB_KEY }
      );
    } catch (e) { st.subscribed = false; st.loading = false; }
    return;
  }
  // Fallback: one-shot get if subscribe isn't available.
  if (st.loaded || st.loading) return;
  if (typeof conn.sendMessagePromise !== 'function') return;
  st.loading = true;
  conn.sendMessagePromise({ type: _frameLibWs(scope, 'get'), key: SEED_FRAME_LIB_KEY })
    .then(res => {
      st.map = _frameLibParseValue(res && res.value);
      st.loaded = true; st.loading = false;
      if (typeof onChange === 'function') { try { onChange(); } catch (e) {} }
      if (!Object.keys(st.map).length) _migrateLegacyFrameLibrary(hass, scope, st, onChange);
    })
    .catch(() => { st.loading = false; st.loaded = true; st.map = {}; });
}

// Read the current cached library map for a scope (slug -> preset), or {}.
function frameLibraryMap(scope) {
  const st = SEED_FRAME_LIBRARY[scope === 'system' ? 'system' : 'user'];
  return st.map || {};
}

// Persist the full library map back to the store. Returns the WS promise (or a
// rejected promise if we can't reach the connection). `map` is slug -> preset.
function saveFrameLibrary(hass, scope, map) {
  scope = scope === 'system' ? 'system' : 'user';
  if (!hass || !hass.connection || typeof hass.connection.sendMessagePromise !== 'function') {
    return Promise.reject(new Error('No connection'));
  }
  // Strip volatile ids; the slug is the key and the id is re-derived on load.
  const presets = {};
  Object.keys(map || {}).forEach(slug => {
    const clean = normalizeFramePreset(map[slug]);
    delete clean.id;
    presets[slug] = clean;
  });
  const value = { seed_frame_presets: SEED_FRAME_EXPORT_VERSION, presets };
  return hass.connection.sendMessagePromise({
    type: _frameLibWs(scope, 'set'), key: SEED_FRAME_LIB_KEY, value
  });
}

// A section/card frame reference: which presets apply and how they layer.
//   presets - ordered list of Frame Style ids (last writer wins per group)
// Legacy migration: older configs had a `default` preset + `apply_defaults_prior`
// toggle (the Default was a bottom base layer). That's redundant with the
// ordered list, so we fold an active Default into the FRONT of `presets` and
// drop both fields — the resolved look is unchanged.
function normalizeFrameRef(f) {
  f = f || {};
  let presets = Array.isArray(f.presets) ? f.presets.map(String).filter(Boolean) : [];
  if (f.default && f.apply_defaults_prior !== false) {
    const dflt = String(f.default);
    // Prepend the old Default as the base layer (unless already listed).
    if (!presets.includes(dflt)) presets = [dflt, ...presets];
  }
  const out = { presets };
  // Optional: ids the user has temporarily disabled (kept in the list but not
  // applied) — lets them preview the look without/with a preset. Emitted only
  // when non-empty, and pruned to ids actually in the list.
  if (Array.isArray(f.disabled)) {
    const dis = f.disabled.map(String).filter(id => presets.includes(id));
    if (dis.length) out.disabled = dis;
  }
  // Optional: ids whose OWN condition (when/when_entity) is ignored on THIS
  // application — the layer always applies here regardless of its condition.
  // Emitted only when non-empty, pruned to ids in the list.
  if (Array.isArray(f.ignore_conditions)) {
    const ign = f.ignore_conditions.map(String).filter(id => presets.includes(id));
    if (ign.length) out.ignore_conditions = ign;
  }
  // Optional: per-location condition OVERRIDES, keyed by preset id — a full rule
  // override that replaces the preset's own condition where it's applied (the
  // shared library preset is untouched). Fields: `when_entity` (rebind the tested
  // entity) and `when: { op, value }` (change the operator/value). Each is
  // optional; a blank field inherits the preset's condition. Emitted only when it
  // holds a non-empty override for an id actually in the list (byte-stable).
  if (f.overrides && typeof f.overrides === 'object') {
    const ov = {};
    Object.keys(f.overrides).forEach(id => {
      if (!presets.includes(id)) return;
      const o = f.overrides[id] || {};
      const clean = {};
      if (o.when_entity) clean.when_entity = String(o.when_entity);
      if (o.when && typeof o.when === 'object' && o.when.op) {
        const w = { op: String(o.when.op) };
        if (o.when.value !== undefined && o.when.value !== '') w.value = o.when.value;
        clean.when = w;
      }
      if (Object.keys(clean).length) ov[id] = clean;
    });
    if (Object.keys(ov).length) out.overrides = ov;
  }
  return out;
}

function buildEdgeBackground(edges, matchColor) {
  if (!edges) return null;
  const accent = matchColor || '#2196F3';
  // 'match' → the border/icon accent; 'theme' → the HA theme divider color; else literal.
  const col = c => (c === 'match' ? accent : (c === 'theme' ? 'var(--divider-color, #333)' : c));
  const imgs = [], sizes = [], positions = [];
  const sideDir = { top: 'to right', bottom: 'to right', left: 'to bottom', right: 'to bottom' };
  ['top', 'bottom', 'left', 'right'].forEach(side => {
    const e = edges[side];
    if (!e || !e.enabled) return;
    let stopStr;
    if (e.gradient === false) {
      const c = col(e.color || 'match');
      stopStr = `${c} 0%, ${c} 100%`;
    } else {
      if (!Array.isArray(e.stops) || !e.stops.length) return;
      stopStr = (e.stops.length === 1)
        ? `${col(e.stops[0].color)} 0%, ${col(e.stops[0].color)} 100%`
        : e.stops.map(s => `${col(s.color)} ${s.pos}%`).join(', ');
    }
    imgs.push(`linear-gradient(${sideDir[side]}, ${stopStr})`);
    const th = e.thickness || 1;
    sizes.push(side === 'top' || side === 'bottom' ? `100% ${th}px` : `${th}px 100%`);
    positions.push(side);
  });
  if (!imgs.length) return null;
  return { image: imgs.join(', '), size: sizes.join(', '), position: positions.join(', '), repeat: imgs.map(() => 'no-repeat').join(', ') };
}


// Per-section slider STYLE keys — visual/layout settings a user may vary per
// slider section. Kelvin range + debounce are EXCLUDED (card-global: physical
// light range + performance tuning). Shared by the renderer AND editor classes.
const SLIDER_STYLE_KEYS = [
  'slider_orientation',
  'slider_width_horizontal', 'slider_length_horizontal',
  'slider_width_vertical', 'slider_length_vertical',
  'slider_font_size', 'slider_text_color', 'slider_border_radius',
  'slider_handle_color', 'slider_handle_opacity', 'slider_handle_shape',
  'slider_text_placement_horizontal', 'slider_text_placement_vertical',
  'brightness_start_color', 'brightness_end_color_mode', 'brightness_end_color',
  'brightness_gradient_strength',
];
// Resolve a slider section's effective style: card-global cfg value with any
// per-section override on top (only when the section is in 'custom' mode AND has
// stored the key). Returns a plain object with every style key. `sectionId` may
// be null → pure card defaults. Backward-compatible: sections without
// slider_style resolve to the card defaults, so old configs render unchanged.
function resolveSliderStyle(cfg, sectionId) {
  // Slider style is card-global (set in the "Sliders" panel), like Buttons. Every
  // slider section uses the same card defaults. (sectionId kept for signature
  // compatibility; per-section slider_style overrides were removed.)
  const out = {};
  for (const k of SLIDER_STYLE_KEYS) out[k] = cfg[k];
  return out;
}

// ===========================================================================
// HEADER RULES — a shared, state-driven header-styling overlay ported from the
// Easy Entity Styler card. A Header Rule Set is a named, ENTITY-FREE list of
// rules; each rule is a condition (op + value against an entity's state/attr)
// that, when it matches, sets any/all of: icon color, MDI glyph, text color,
// icon size, text size, and a secondary-info line. Rules carry NO entity — the
// card/section binds one at apply-time. Sets live in the shared System library
// keyed `ltek_header_library` (SAME key as the Easy Entity Styler card), so a
// set authored in either card is available in the other.
//
// This overlay LAYERS on top of the Color card's own header logic
// (_headerIconColorCss etc.): a rule only overrides an item it explicitly sets;
// anything left unset ("Not set") falls through to the existing logic. Applies
// only where a set is applied (card_header_rules / section.header_rule_refs).
// ---------------------------------------------------------------------------

// ---- Value/condition engine (pure; ported verbatim from Easy Entity Styler) ----
function _hdrDomainOf(entityId) { return String(entityId || '').split('.')[0]; }
function _hdrFormatDurationShort(sec) {
  if (sec == null || Number.isNaN(sec)) return '';
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return sec + ' s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return h + ' h ' + m + ' m';
  if (h > 0) return h + ' h';
  return m + ' m';
}
function _hdrEntityArea(entityId, hass) {
  const reg = hass && hass.entities ? hass.entities[entityId] : null;
  let areaId = reg && reg.area_id ? reg.area_id : null;
  if (!areaId && reg && reg.device_id && hass.devices) {
    const dev = hass.devices[reg.device_id];
    if (dev && dev.area_id) areaId = dev.area_id;
  }
  if (!areaId) return '';
  const area = hass.areas && hass.areas[areaId];
  return area && area.name ? area.name : areaId;
}
// Resolve a ValueRef against one entity into { raw, num, display, seconds,
// badState }. `num` is null when the value isn't numeric; `display` is the
// human string (with the "time ago" form for last_changed_ago).
function resolveValueRef(entityId, ref, hass) {
  ref = ref || {};
  const source = ref.source || 'state';
  const st = hass && hass.states ? hass.states[entityId] : null;
  const attrs = st && st.attributes ? st.attributes : {};

  let raw = null;
  if (source === 'attribute') raw = attrs[ref.attribute];
  else if (source === 'last_changed_ago') raw = (st && st.last_changed)
    ? Math.max(0, Math.floor((Date.now() - new Date(st.last_changed).getTime()) / 1000)) : null;
  else if (source === 'last_changed_time') {
    if (st && st.last_changed) {
      const d = new Date(st.last_changed);
      let h = d.getHours(); const m = d.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12; if (h === 0) h = 12;
      raw = `${h}:${m < 10 ? '0' + m : m} ${ampm}`;
    } else raw = null;
  }
  else if (source === 'name') raw = attrs.friendly_name || entityId;
  else if (source === 'entity_id') raw = entityId;
  else if (source === 'domain') raw = _hdrDomainOf(entityId);
  else if (source === 'area') raw = _hdrEntityArea(entityId, hass);
  else if (source === 'integration') {
    const reg = hass && hass.entities ? hass.entities[entityId] : null;
    raw = reg && reg.platform ? reg.platform : '';
  } else raw = st ? st.state : null;

  const badState = raw === null || raw === undefined || raw === 'unknown' || raw === 'unavailable';

  let num = badState ? null : Number(raw);
  if (Number.isNaN(num)) num = null;

  const t = ref.transform || 'none';
  if (num != null) {
    if (t === 'pct_of_255') num = Math.round((num / 255) * 100);
    else if (t === 'multiply100') num = num * 100;
    else if (t === 'round1') num = Math.round(num * 10) / 10;
    else if (t === 'int') num = Math.trunc(num);
  }

  let display;
  if (source === 'last_changed_ago') {
    display = _hdrFormatDurationShort(raw);
  } else if (badState) {
    display = '—';
  } else if (num != null && t !== 'none' && t !== 'lower') {
    display = String(num);
  } else {
    display = String(raw);
    if (t === 'lower') display = display.toLowerCase();
  }
  if (ref.unit && display !== '—' && display !== '') display = display + ref.unit;

  return { raw, num, display, seconds: source === 'last_changed_ago' ? raw : null, badState };
}
// Apply a Condition's operator to an already-resolved ValueRef.
function applyOp(resolved, cond) {
  const op = cond.op || 'eq';
  const { raw, num, badState } = resolved;
  const ci = cond.case_insensitive !== false; // default case-insensitive
  const norm = v => (ci ? String(v).trim().toLowerCase() : String(v).trim());
  const vals = () => (Array.isArray(cond.values) && cond.values.length ? cond.values : [cond.value]);
  switch (op) {
    case 'is_on':  return String(raw).toLowerCase() === 'on' || raw === true;
    case 'is_off': return String(raw).toLowerCase() === 'off' || raw === false;
    case 'truthy': return !badState && !['off', '0', '', 'false', 'closed', 'locked'].includes(String(raw).toLowerCase());
    case 'unavailable': return badState;
    case 'eq':  return norm(raw) === norm(cond.value);
    case 'ne':  return norm(raw) !== norm(cond.value);
    case 'contains': {
      const hay = norm(raw);
      const list = vals();
      return cond.op2 === 'all' ? list.every(v => hay.includes(norm(v))) : list.some(v => hay.includes(norm(v)));
    }
    case 'not_contains': { const hay = norm(raw); return !vals().some(v => hay.includes(norm(v))); }
    case 'in':     return vals().map(norm).includes(norm(raw));
    case 'not_in': return !vals().map(norm).includes(norm(raw));
    case 'regex':  { try { return new RegExp(cond.value, ci ? 'i' : '').test(String(raw)); } catch (e) { return false; } }
    case 'lt': return num != null && num <  Number(cond.value);
    case 'le': return num != null && num <= Number(cond.value);
    case 'gt': return num != null && num >  Number(cond.value);
    case 'ge': return num != null && num >= Number(cond.value);
    case 'between': return num != null && num >= Number(cond.value) && num <= Number(cond.value2);
    default: return false;
  }
}
// Evaluate a Condition against an entity. Compound all/any supported.
function evalCondition(entityId, cond, hass, fallbackRef) {
  if (!cond) return false;
  if (Array.isArray(cond.all)) return cond.all.every(c => evalCondition(entityId, c, hass, fallbackRef));
  if (Array.isArray(cond.any)) return cond.any.some(c => evalCondition(entityId, c, hass, fallbackRef));
  const STATE_OPS = ['is_on', 'is_off', 'truthy', 'unavailable'];
  const ref = cond.ref || (STATE_OPS.includes(cond.op) ? { source: 'state' } : (fallbackRef || { source: 'state' }));
  return applyOp(resolveValueRef(entityId, ref, hass), cond);
}

// ---- Header Rule Set data model (byte-stable; emits keys only when set) ----
const HEADER_RULE_OUTPUT_KEYS = [
  'set_icon_color', 'set_icon', 'set_text_color', 'set_icon_size', 'set_text_size', 'set_secondary'
];
function normalizeHeaderSecondary(si) {
  si = si || {};
  const SOURCES = ['attribute', 'state', 'last_changed_ago', 'last_changed_time', 'area', 'entity_id', 'integration'];
  return {
    enabled: si.enabled === true,
    source: SOURCES.includes(si.source) ? si.source : 'attribute',
    attribute: si.attribute || '',
    transform: si.transform || 'none',
    unit: si.unit || '',
    prefix: si.prefix || '',
  };
}
// Normalize one rule: a condition (`when`) + a sparse set of outputs. Any output
// left unset ("Not set") is omitted, so the card's own logic keeps that item.
function normalizeHeaderRule(r) {
  r = r || {};
  const out = { when: normalizeCondition(r.when) };
  if (r.when_entity) out.when_entity = String(r.when_entity);
  if (r.set_icon_color !== undefined && r.set_icon_color !== '') out.set_icon_color = r.set_icon_color;
  if (r.set_icon !== undefined && r.set_icon !== '') out.set_icon = r.set_icon;
  if (r.set_text_color !== undefined && r.set_text_color !== '') out.set_text_color = r.set_text_color;
  // Size sliders use 0 as the "Not set" position (a real size is always > 0).
  if (Number.isFinite(Number(r.set_icon_size)) && Number(r.set_icon_size) > 0) out.set_icon_size = Number(r.set_icon_size);
  if (Number.isFinite(Number(r.set_text_size)) && Number(r.set_text_size) > 0) out.set_text_size = Number(r.set_text_size);
  if (r.set_secondary && typeof r.set_secondary === 'object' && r.set_secondary.enabled) {
    out.set_secondary = normalizeHeaderSecondary(r.set_secondary);
  }
  return out;
}
function normalizeHeaderRuleSet(hs) {
  hs = hs || {};
  const set = {
    name: hs.name || 'Header Rules',
    rules: Array.isArray(hs.rules) ? hs.rules.map(normalizeHeaderRule) : [],
  };
  if (hs.id) set.id = String(hs.id);
  if (hs.default_entity) set.default_entity = String(hs.default_entity);
  if (hs.default && typeof hs.default === 'object') {
    const d = normalizeHeaderRule({ ...hs.default, when: { op: 'eq' } });
    delete d.when;
    if (Object.keys(d).length) set.default = d;
  }
  return set;
}
function headerRuleSetContentKey(hs) {
  const norm = normalizeHeaderRuleSet(hs);
  const copy = {}; Object.keys(norm).sort().forEach(k => { if (k === 'id' || k === 'name') return; copy[k] = norm[k]; });
  return JSON.stringify(copy);
}
function headerLibSlug(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'header_rules';
}
// Read-only Built-In: on → accent icon+text; off → muted. Never stored.
const BUILTIN_HEADER_SLUG = 'builtin_header';
const BUILTIN_HEADER_ID = 'lib:' + BUILTIN_HEADER_SLUG;
function builtinHeaderRuleSet() {
  const s = normalizeHeaderRuleSet({
    name: 'Built-In',
    rules: [
      { when: { op: 'is_on' }, set_icon_color: 'var(--primary-color)', set_text_color: 'var(--primary-text-color)' },
      { when: { op: 'is_off' }, set_icon_color: 'var(--secondary-text-color)', set_text_color: 'var(--secondary-text-color)' },
    ],
  });
  s.id = BUILTIN_HEADER_ID;
  s._builtin = true;
  return s;
}
// An applied ref: { ref:'lib:<slug>'|BUILTIN_HEADER_ID, entity:'' }. Blank
// entity = the card/section's own primary entity. Emitted only when non-empty.
function normalizeHeaderRuleRefs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(r => (typeof r === 'string' ? { ref: r, entity: '' } : r))
    .filter(r => r && r.ref)
    .map(r => ({ ref: String(r.ref), entity: r.entity ? String(r.entity) : '' }));
}

// ---- Header Rule Set LIBRARY (shared ltek store; mirrors the Frame library) ----
const SEED_HEADER_LIB_KEY = 'ltek_header_library';
const SEED_HEADER_EXPORT_VERSION = 1;
const SEED_HEADER_LIBRARY = {
  user: { map: null, loaded: false, loading: false, subscribed: false },
  system: { map: null, loaded: false, loading: false, subscribed: false }
};
function _headerLibWs(scope, verb) { return `frontend/${verb}_${scope === 'system' ? 'system' : 'user'}_data`; }
function _headerLibParseValue(value) {
  const map = {};
  if (!value || typeof value !== 'object') return map;
  const sets = ('seed_header_rules' in value && value.sets && typeof value.sets === 'object') ? value.sets : value;
  Object.keys(sets).forEach(slug => {
    const s = sets[slug];
    if (s && typeof s === 'object' && Array.isArray(s.rules)) {
      const norm = normalizeHeaderRuleSet(s);
      norm.id = 'lib:' + slug;
      map[slug] = norm;
    }
  });
  return map;
}
function ensureHeaderLibrary(hass, scope, onChange) {
  scope = scope === 'system' ? 'system' : 'user';
  const st = SEED_HEADER_LIBRARY[scope];
  if (!hass || !hass.connection) return;
  const conn = hass.connection;
  if (st.subscribed) return;
  if (typeof conn.subscribeMessage === 'function') {
    st.subscribed = true; st.loading = true;
    try {
      conn.subscribeMessage(
        (ev) => { st.map = _headerLibParseValue(ev && ev.value); st.loaded = true; st.loading = false; if (typeof onChange === 'function') { try { onChange(); } catch (e) {} } },
        { type: _headerLibWs(scope, 'subscribe'), key: SEED_HEADER_LIB_KEY }
      );
    } catch (e) { st.subscribed = false; st.loading = false; }
    return;
  }
  if (st.loaded || st.loading) return;
  if (typeof conn.sendMessagePromise !== 'function') return;
  st.loading = true;
  conn.sendMessagePromise({ type: _headerLibWs(scope, 'get'), key: SEED_HEADER_LIB_KEY })
    .then(res => { st.map = _headerLibParseValue(res && res.value); st.loaded = true; st.loading = false; if (typeof onChange === 'function') { try { onChange(); } catch (e) {} } })
    .catch(() => { st.loading = false; st.loaded = true; st.map = {}; });
}
function headerLibraryMap(scope) {
  const st = SEED_HEADER_LIBRARY[scope === 'system' ? 'system' : 'user'];
  return st.map || {};
}
function saveHeaderLibrary(hass, scope, map) {
  scope = scope === 'system' ? 'system' : 'user';
  if (!hass || !hass.connection || typeof hass.connection.sendMessagePromise !== 'function') return Promise.reject(new Error('No connection'));
  const sets = {};
  Object.keys(map || {}).forEach(slug => { const clean = normalizeHeaderRuleSet(map[slug]); delete clean.id; sets[slug] = clean; });
  const value = { seed_header_rules: SEED_HEADER_EXPORT_VERSION, sets };
  return hass.connection.sendMessagePromise({ type: _headerLibWs(scope, 'set'), key: SEED_HEADER_LIB_KEY, value });
}
// Serialize one or more Header Rule Sets to a portable JSON envelope (for the
// Export button). Mirrors serializeFramePresets — a versioned wrapper the Import
// path validates. Ids/_builtin are dropped (regenerated on import).
function serializeHeaderRuleSets(sets) {
  const clean = (Array.isArray(sets) ? sets : [sets]).map(s => {
    const c = normalizeHeaderRuleSet(s); delete c.id; delete c._builtin; return c;
  });
  return JSON.stringify({ seed_header_rules: SEED_HEADER_EXPORT_VERSION, sets: clean }, null, 2);
}
// Parse an exported Header Rule Set blob → { ok, sets, error }. Accepts the
// versioned envelope, a bare array, or a single set object. Validate-on-load.
function parseHeaderRuleSetBlob(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, error: 'Not valid JSON.' }; }
  let raw;
  if (data && typeof data === 'object' && 'seed_header_rules' in data) raw = data.sets;
  else raw = data;
  // Envelope.sets may be an array (export) or a slug→set map (library value).
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') list = Object.keys(raw).map(k => raw[k]);
  else return { ok: false, error: 'No rule sets found.' };
  const sets = list.filter(s => s && typeof s === 'object' && Array.isArray(s.rules)).map(normalizeHeaderRuleSet);
  if (!sets.length) return { ok: false, error: 'No valid rule sets found (each needs a rules array).' };
  return { ok: true, sets };
}
// Does any of these refs point at the shared library (lib:<slug>, not Built-In)?
function _usesHeaderLibRef(list) {
  return Array.isArray(list) && list.some(r => {
    const ref = typeof r === 'string' ? r : (r && r.ref);
    return typeof ref === 'string' && ref.startsWith('lib:') && ref !== BUILTIN_HEADER_ID;
  });
}

// ============ SHARED BUTTON RENDERER (module-level) ============
// The card element and the editor's live PREVIEW are separate custom elements, so button-render
// logic lives in module functions both call (never as a method one class can't reach). This is
// what guarantees the editor preview matches the live card byte-for-byte.

// Is `preset` the currently-active scene on `state`? (color/temp match, or off-state for off presets)
// `tempOutFmt` is the card's temperature_output_format (for temp presets driven in a color mode).
// A button's input_select "scene selects": the ordered list of { entity, option } bindings it sets
// on press and tracks for "active". Sanitized to well-formed string pairs. Empty when none.
function presetSelects(preset) {
  const raw = preset && preset.selects;
  if (!Array.isArray(raw)) return [];
  return raw.filter(b => b && typeof b === 'object' && typeof b.entity === 'string' && b.entity
    && typeof b.option === 'string' && b.option).map(b => ({ entity: b.entity, option: b.option }));
}
// Deterministic "active" from a button's scene selects: true when EVERY binding currently matches
// (hass.states[entity].state === option). Returns null when the button has NO selects (so callers
// fall back to the legacy color/state/last-pressed logic). This is the single-winner signal that
// replaces the fuzzy proxies for any button bound to input_select helpers.
function presetSelectsActive(preset, hass) {
  const binds = presetSelects(preset);
  if (!binds.length) return null;                 // no bindings → not applicable
  if (!hass || !hass.states) return false;
  const result = binds.every(b => { const st = hass.states[b.entity]; return !!st && String(st.state) === String(b.option); });
  return result;
}
// `selectsActive` (optional): when a boolean, it OVERRIDES all other active logic (the button has
// input_select bindings and this is their all-match result). null/undefined → legacy behavior.
function isPresetActiveFor(preset, state, tempOutFmt, activeId, selectsActive) {
  if (selectsActive === true) return true;
  if (selectsActive === false) return false;
  // Scene-only (mode 'none') buttons apply no color, so there's nothing to color-match against the
  // light. They're "active" when this is the last-pressed preset in the section (the only signal we
  // have; session-only — resets on reload until pressed again).
  if (presetMode(preset) === 'none') return !!(activeId && preset && preset.id === activeId);
  if (!state) return false;
  const attrs = state.attributes || {};
  const mode = presetMode(preset);
  if (mode === 'off') return state.state === 'off';
  if (state.state !== 'on') return false;
  const fmt = presetColorFormat(preset);
  const near = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const colorMatches = () => {
    if (fmt === 'xy' && Array.isArray(attrs.xy_color)) return near(preset.xy_color, attrs.xy_color, 0.05);
    if (fmt === 'hs' && Array.isArray(attrs.hs_color)) return near(preset.hs_color, attrs.hs_color, 8);
    const target = presetColorToRgb(preset);
    const cur = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
      : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
    return near(target, cur, 32);
  };
  const tempMatches = () => {
    const k = attrsToKelvin(attrs);
    if (k !== undefined) return Math.abs(k - preset.color_kelvin) <= 40;
    if (tempOutFmt === 'xy' && Array.isArray(attrs.xy_color)) return near(ColorUtils.kelvinToXy(preset.color_kelvin), attrs.xy_color, 0.05);
    if (tempOutFmt === 'hs' && Array.isArray(attrs.hs_color)) return near(ColorUtils.kelvinToHs(preset.color_kelvin), attrs.hs_color, 8);
    const target = ColorUtils.kelvinToRgb(preset.color_kelvin);
    const cur = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
      : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
    return near(target, cur, 32);
  };
  if (mode === 'color') return colorMatches();
  if (mode === 'temp') return tempMatches();
  return false;
}

// Resolve a button's border + glow (box-shadow) CSS from its style cfg + the light's state.
// `btnColor` is the button's own display color hex (null for a colorless/Off button). Border/glow
// resolve their match against it; 'none' or an unresolvable match disables that effect.
function presetBorderAndGlowCssFor(preset, state, cfg, tempOutFmt, btnColor, activeId, selectsActive, glowColorOverride) {
  const parts = { border: '', boxShadow: 'none' };
  if (cfg.button_border_enabled) {
    const w = Number(cfg.button_border_width) || 1;
    // Match = a lighter shade of the button's own color (room-card look); fixed = configured hex;
    // none = no border. Back-compat: pre-3-way border defaulted to 'fixed'.
    const matchShade = btnColor ? ColorUtils.rgbToHex(...ColorUtils.mixRgb(ColorUtils.hexToRgb(btnColor), [255, 255, 255], 0.45)) : null;
    const color = resolveButtonColor(cfg.button_border_color_mode, cfg.button_border_color || '#2196F3', matchShade, 'fixed');
    if (color) parts.border = buttonBorderCss(w, color, buttonBorderSides(cfg));
    else parts.border = 'border:none;';
  }
  const shadows = [];
  if (cfg.button_glow_enabled) {
    const condition = cfg.button_glow_condition || 'never';
    const shouldGlow = condition === 'always' || (condition === 'when_active' && isPresetActiveFor(preset, state, tempOutFmt, activeId, selectsActive));
    if (shouldGlow) {
      let color;
      // `glowColorOverride` (scene/follow buttons): the glow color is resolved by the caller — a
      // fixed Glow Color, else the live follow-light color, else a neutral. It's independent of the
      // button-body color (change: a fixed button color no longer forces the glow, and vice-versa).
      if (glowColorOverride) {
        color = glowColorOverride;
      } else {
        // Match = the light's CURRENT color (live), falling back to the button's own color; fixed =
        // configured hex; none = no glow. Back-compat: pre-3-way glow defaulted to 'fixed'.
        const attrs = (state && state.attributes) || {};
        let liveRgb = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
          : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
        if (!liveRgb) { const k = attrsToKelvin(attrs); if (k !== undefined) liveRgb = ColorUtils.kelvinToRgb(k); }
        const liveHex = (liveRgb && state && state.state === 'on') ? ColorUtils.rgbToHex(...liveRgb) : (btnColor || null);
        color = resolveButtonColor(cfg.button_glow_color_mode, cfg.button_glow_color || '#2196F3', liveHex, 'fixed');
        // MATCH-mode fallback: when there's no color to match, don't drop the glow — fall back to the
        // style's configured glow color.
        if (!color && cfg.button_glow_color_mode === 'match') color = cfg.button_glow_color || '#2196F3';
      }
      if (color) {
        // Blur/spread/opacity are explicit when set; else derived from the legacy single "intensity"
        // (blur = 12×intensity, spread = −2×intensity, opacity = 1) so old styles render unchanged.
        const intensity = Number(cfg.button_glow_intensity) || 1.0;
        const blur = Number.isFinite(Number(cfg.button_glow_blur)) ? Number(cfg.button_glow_blur) : 12 * intensity;
        const spread = Number.isFinite(Number(cfg.button_glow_spread)) ? Number(cfg.button_glow_spread) : -2 * intensity;
        const op = Number.isFinite(Number(cfg.button_glow_opacity)) ? clamp(Number(cfg.button_glow_opacity), 0, 1) : 1;
        shadows.push(`0 0 ${blur}px ${spread}px ${op < 1 ? ColorUtils.hexToRgba(color, op) : color}`);
      }
    }
  }
  if (cfg.button_shadow_enabled) {
    const op = clamp(Number(cfg.button_shadow_opacity), 0, 1);
    shadows.push(`${Number(cfg.button_shadow_x)||0}px ${Number(cfg.button_shadow_y)||0}px ${Number(cfg.button_shadow_blur)||0}px ${Number(cfg.button_shadow_spread)||0}px ${ColorUtils.hexToRgba(cfg.button_shadow_color || '#000000', Number.isFinite(op) ? op : 0.35)}`);
  }
  if (shadows.length) parts.boxShadow = shadows.join(', ');
  return parts;
}

// Render one preset button's HTML. `look` is the resolved effective preset (color/action);
// `preset` supplies name/icon/id; `cfg` is the effective button style; `state` is the light state
// (for active/glow). Pure — no `this` — so the card and the editor preview render identically.
function renderPresetButtonHtml(look, preset, cfg, state, tempOutFmt, activeId, selectsActive, appearance) {
  const isOff = look.action === 'turn_off';
  // `appearance` (optional, scene/follow buttons): a pre-resolved { bodyColor, glowColor } pair so
  // the button body and its glow are colored INDEPENDENTLY (a fixed button color no longer forces
  // the glow color, and vice-versa). bodyColor drives fill + gradient + icon accents; glowColor is
  // handed to the glow resolver. Either may be null (→ fall back to the look/style-color path).
  //   IMPORTANT (change #1): the body color only reflects a LIVE follow color while the button is
  //   ACTIVE. When inactive it uses the fixed style color (or a neutral) so a scene button doesn't
  //   flicker every time its follow-light changes color in the background.
  const bodyOverrideHex = (appearance && appearance.bodyColor) || null;
  const glowOverrideHex = (appearance && appearance.glowColor) || null;
  const styleOverride = bodyOverrideHex ? ColorUtils.hexToRgb(bodyOverrideHex)
    : (preset.button_style_color ? ColorUtils.hexToRgb(preset.button_style_color) : null);
  const rgb = styleOverride || presetColorToRgb(look);
  const bg = ColorUtils.rgbToHex(...rgb);
  const hasStyleOverride = !!styleOverride;
  // The button's own display color, or null for a colorless/Off button (drives every `match` mode:
  // an unresolvable match disables that effect rather than falling back to an unrelated color).
  const btnColor = (!isOff || hasStyleOverride) ? bg : null;
  const { border, boxShadow } = presetBorderAndGlowCssFor(look, state, cfg, tempOutFmt, btnColor, activeId, selectsActive, glowOverrideHex);
  const radius = Number(cfg.button_border_radius);
  // Icon: a style-level override (cfg.button_icon) replaces the per-button icon for every button;
  // else the button's own icon. Optional fixed icon size (px).
  const icon = escapeHtml((cfg.button_icon && String(cfg.button_icon).trim()) || resolvePresetIcon(preset, buttonMode(preset)));
  const iconSize = Number(cfg.button_icon_size) || 0;
  const iconSizeCss = iconSize > 0 ? `--mdc-icon-size:${iconSize}px;` : '';
  const glowCls = boxShadow && boxShadow !== 'none' ? ' cpc-glowing' : '';
  const nameColor = buttonNameColorCss(cfg, btnColor);
  const nameWeight = cfg.button_name_weight || '600';
  const labelStyle = `font-weight:${nameWeight};${nameColor ? `color:${nameColor};` : ''}`;
  // Gradient border lines: match = the button's own color; fixed = configured stop color; none =
  // no gradient. Back-compat: unset mode → 'match' (the old behavior, where 'match' stops resolved
  // to the border color / button color).
  const gbColor = resolveButtonColor(cfg.button_border_gradient_color_mode, cfg.button_border_color || '#2196F3', btnColor, 'match');
  const gb = gbColor ? gradientBorderBackground(cfg.button_border_gradient, gbColor) : null;
  // Icon color: match = the button's own color; fixed = configured hex; none = leave the icon its
  // default. Back-compat: unset → the historic per-style default (colored icon on tinted; theme on Off).
  const iconOverride = cfg.button_icon_color_mode ? resolveButtonColor(cfg.button_icon_color_mode, cfg.button_icon_color || '#2196F3', btnColor, 'none') : undefined;
  if (cfg.button_style === 'tinted' || cfg.button_style === 'tile') {
    const radiusCss = Number.isFinite(radius) ? `border-radius:${radius}px;` : '';
    let fillImage, iconColor;
    if (isOff && !hasStyleOverride) {
      fillImage = 'linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))';
      iconColor = 'var(--secondary-text-color)';
    } else {
      fillImage = `linear-gradient(135deg, ${ColorUtils.hexToRgba(bg, 0.35)}, ${ColorUtils.hexToRgba(bg, 0.06)})`;
      iconColor = bg;
    }
    if (iconOverride !== undefined) iconColor = iconOverride || iconColor;   // explicit mode wins; 'none' keeps default
    const bgCss = gb
      ? `background-image:${gb.image}, ${fillImage}; background-size:${gb.size}, auto; background-position:${gb.position}, center; background-repeat:${gb.repeat}, no-repeat; background-color:transparent;`
      : `background:${fillImage};`;
    const styleAttr = `style="${bgCss}${border}${radiusCss}box-shadow:${boxShadow};--cpc-tile-icon-color:${iconColor};"`;
    const tSub = preset._sublabel ? `<span class="cpc-btn-sublabel">${escapeHtml(preset._sublabel)}</span>` : '';
    const tLabel = tSub
      ? `<span class="cpc-btn-labelwrap"><span class="cpc-tile-name cpc-btn-label" style="${labelStyle}">${escapeHtml(preset.name)}</span>${tSub}</span>`
      : `<span class="cpc-tile-name cpc-btn-label" style="${labelStyle}">${escapeHtml(preset.name)}</span>`;
    return `<button class="cpc-preset-btn cpc-tile${glowCls} ${isOff ? 'off-style' : ''}" data-preset-id="${escapeHtml(preset.id)}" ${styleAttr}><ha-icon icon="${icon}" style="${iconSizeCss}"></ha-icon>${tLabel}</button>`;
  }
  const radiusCss = Number.isFinite(radius) ? `border-radius:${radius}px;` : '';
  // Background fill by style: 'transparent' → none; 'theme' → the card/theme surface color;
  // 'solid' (default) → the button's own color (none for a colorless Off button).
  let fill;
  if (cfg.button_style === 'transparent') fill = null;
  else if (cfg.button_style === 'theme') fill = 'var(--ha-card-background, var(--card-background-color, #1c1c1c))';
  else fill = (isOff && !hasStyleOverride) ? null : bg;
  let bgCss;
  if (gb) {
    bgCss = `background-image:${gb.image}; background-size:${gb.size}; background-position:${gb.position}; background-repeat:${gb.repeat}; background-color:${fill || 'transparent'};`;
  } else {
    bgCss = fill ? `background:${fill};` : '';
  }
  // Non-tinted icon: default is theme/inherited; an explicit icon-color mode can set or 'none'-skip it.
  const iconStyle = ` style="${iconSizeCss}${(iconOverride !== undefined && iconOverride) ? `color:${iconOverride};` : ''}"`;
  const styleAttr = `style="${bgCss}${border}${radiusCss}box-shadow:${boxShadow};"`;
  // Optional secondary line (used by the Scene Tracker to show the current scene under the area name).
  // Regular buttons never set `_sublabel`, so their markup is unchanged.
  const subLabel = preset._sublabel ? `<span class="cpc-btn-sublabel">${escapeHtml(preset._sublabel)}</span>` : '';
  const labelBlock = subLabel
    ? `<span class="cpc-btn-labelwrap"><span class="cpc-btn-label" style="${labelStyle}">${escapeHtml(preset.name)}</span>${subLabel}</span>`
    : `<span class="cpc-btn-label" style="${labelStyle}">${escapeHtml(preset.name)}</span>`;
  return `<button class="cpc-preset-btn${glowCls} ${isOff ? 'off-style' : ''}" data-preset-id="${escapeHtml(preset.id)}" ${styleAttr}><ha-icon icon="${icon}"${iconStyle}></ha-icon>${labelBlock}</button>`;
}

// ============ LIVE CARD ============
class ColorLightManagerCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: 'Light Color',
      show_title: true,   // show the card title text
      show_title_icon: true, // show the title icon
      // Card title text styling (0/'' = use theme defaults).
      title_font_size: 18,
      title_font_weight: '500', // 300|400|500|600|700
      title_color: '',    // '' = theme --primary-text-color
      icon: 'mdi:palette',
      icon_size: 22,
      icon_color_enabled: false, // off = theme default icon color
      icon_color_mode: 'fixed', // fixed | light | active (only relevant when icon_color_enabled)
                                // light = follow the representative light; active = last-pressed button's color
      icon_color: '#2196F3',
      // When icon_color_mode is 'light', what color the icon uses while the light is OFF:
      //   theme = theme default; fixed = the icon_off_color below.
      icon_off_color_mode: 'theme', // theme | fixed
      icon_off_color: '#666666',
      // When true, the header becomes a clickable bar that expands/collapses the card body
      // (presets + sliders + favorites). Starts collapsed. Requires a title to have a bar
      // to click. A chevron shows the state unless disabled.
      card_collapsible: false,
      card_show_chevron: true,
      entity: '',
      // Default Entities: an optional shared pool. Each button can opt to include it live
      // (use_default_entities) and/or add its own arbitrary lights (use_custom_entities +
      // target_entities). Also the reference set for card glow/header "light" mode + per-entity
      // send methods. May be empty. (Formerly the card's hard "entity scope".)
      entities: [],
      // Which shared Fixture Profile Library scope this card's lib:<slug> refs resolve against.
      // 'system' = shared across users (admin-writable), 'user' = per-user. Card editing in HA
      // is admin-only, so system is the sensible default (one library for the whole instance).
      fixture_library_scope: 'system',
      // Header Rules — a state-driven header-styling overlay (shared
      // ltek_header_library). Applies only where a set is applied: card_header_rules
      // to the card title, a section's header_rule_refs to that section's heading.
      // A rule only overrides items it explicitly sets; anything "Not set" falls
      // through to the card's own header logic. No global on/off — applying (or
      // removing) a ref is the opt-in, matching the Easy Entity Styler card.
      header_library_scope: 'system',
      layout: 'columns',
      columns: 3,
      gap: 8,
      wrap: true,
      presets: [
        { id: 'p-off', name: 'Off', icon: 'mdi:lightbulb-off', action: 'turn_off' },
        { id: 'p-cool', name: 'Cool', icon: 'mdi:lightbulb', color_kelvin: 6500 },
        { id: 'p-warm', name: 'Warm', icon: 'mdi:lightbulb', color_kelvin: 2500 },
        { id: 'p-red', name: 'Red', icon: 'mdi:lightbulb', rgb_color: [255, 0, 0] },
        { id: 'p-green', name: 'Green', icon: 'mdi:lightbulb', rgb_color: [0, 255, 0] },
        { id: 'p-blue', name: 'Blue', icon: 'mdi:lightbulb', rgb_color: [0, 0, 255] },
      ],
      // How a white color temperature is sent to the light. Some controllers (e.g. certain
      // RGBWW firmwares) mishandle color_temp_kelvin — they interpret it wrong or convert it
      // to an off-tint color. This lets you send the same Kelvin white as a different
      // parameter the controller may honor better. Options:
      //   kelvin (default) → color_temp_kelvin   (standard, correct for most lights)
      //   mired            → color_temp          (legacy mired; some old integrations)
      //   xy               → xy_color            (blackbody point; best color-mode white)
      //   hs               → hs_color
      //   rgb              → rgb_color            (approximate white via RGB channels)
      //   rgbw             → rgbw_color           (single white LED, [0,0,0,255])
      //   rgbww            → rgbww_color          (cold/warm white mix, [0,0,0,cw,ww])
      temperature_output_format: 'kelvin',
      // Visual only: also show the mired equivalent next to Kelvin on the temperature
      // slider/preset readouts and the color-value display (e.g. "2000K / 500m").
      temperature_show_mired: false,
      show_brightness_slider: true,
      show_temperature_slider: true,
      show_rgb_slider: true,
      // ---- Color Value Display Area ----
      // Read-only panel listing the light's current color values (RGB/Kelvin/HS/XY, plus
      // W/CW/WW when relevant) — handy for reading a color to save into a preset.
      show_current_values: false,
      current_values_justify: 'left',      // left | center | right
      // Order of the card body sections, top → bottom. Reorderable in the Layout editor.
      section_order: ['buttons', 'sliders', 'values'],
      // ---- Section dividers (top/bottom rule per section) ----
      divider_buttons_top: false, divider_buttons_bottom: false,
      divider_sliders_top: false, divider_sliders_bottom: false,
      divider_values_top: false, divider_values_bottom: false,
      // Divider line appearance (applies to all enabled dividers).
      divider_color: '', // '' = theme --divider-color
      divider_thickness: 1, // px
      divider_length: 100, // % of card width
      show_favorites: false,
      min_kelvin: 2000,
      max_kelvin: 6500,
      brightness_start_color: '#000000',
      brightness_end_color_mode: 'current', // current | default
      brightness_end_color: '#ffffff',
      brightness_gradient_strength: 50, // 0-100, controls how quickly the gradient lightens

      // ---- Slider handle appearance ----
      slider_orientation: 'horizontal', // horizontal | vertical
      slider_handle_color: '#ffffff',
      slider_handle_opacity: 100, // 0-100
      slider_handle_shape: 'round', // round | square | line | diamond
      slider_debounce_ms: 100, // wait time before a drag position is sent to the light
      // Per-slider text visibility (name label + live value) and placement,
      // independently toggleable/positionable per slider.
      brightness_show_label: true,
      brightness_show_value: true,
      brightness_label_position: 'left', // left | center | right
      brightness_value_position: 'right',
      temperature_show_label: true,
      temperature_show_value: true,
      temperature_label_position: 'left',
      temperature_value_position: 'right',
      rgb_show_label: true,
      rgb_show_value: true,
      rgb_label_position: 'left',
      rgb_value_position: 'right',
      // Where the label/value text sits relative to the bar itself. Horizontal
      // sliders can place text above, below, or inside the bar; vertical sliders
      // can place it inside the bar or outside (above/below the bar, like a caption).
      slider_text_placement_horizontal: 'inside', // above | below | inside
      slider_text_placement_vertical: 'inside', // inside | outside
      // Alignment of vertical sliders across the card's width (irrelevant when
      // slider_orientation is horizontal, since sliders already stack full-width).
      vertical_slider_alignment: 'left', // left | center | right | even
      // ---- Slider sizing ----
      // Width = the slider's thickness (short side); Length = the slider's travel
      // distance (long side). Tracked separately per orientation so switching
      // orientation doesn't lose your horizontal-specific vs. vertical-specific sizing.
      slider_width_horizontal: 44,
      slider_length_horizontal: 100, // percent of available card width
      slider_width_vertical: 44,
      slider_length_vertical: 180, // px
      slider_font_size: 13,
      slider_text_color: '', // '' = theme/default (white on-bar, theme off-bar); else fixed color
      slider_border_radius: 10,

      // ---- Card visual formatting ----
      card_bg_mode: 'theme', // theme | transparent | custom
      card_bg_color: '#1c1c1c', // used when card_bg_mode === 'custom'
      card_border_enabled: false,
      card_border_width: 1,
      card_border_radius: 12,
      card_border_corners: [true, true, true, true], // TL, TR, BR, BL
      card_border_color: '#2196F3',
      card_border_top: true,
      card_border_bottom: true,
      card_border_left: true,
      card_border_right: true,
      // Gradient border: when enabled, each chosen side is painted as a gradient LINE using the
      // background-layer technique (respects border-radius; composes with glow/shadow/bg). Shape:
      //   { enabled, width, sides:{top,bottom,left,right}, stops:[{pos,color}], pattern }
      // Replaces the solid border on the sides it covers; solid border still applies to the rest.
      card_border_gradient: { enabled: false, width: 2, sides: { top: false, bottom: true, left: false, right: false }, stops: [{ pos: 0, color: 'transparent' }, { pos: 50, color: 'match' }, { pos: 100, color: 'transparent' }] },
      card_glow_enabled: false,
      card_glow_condition: 'always', // always | when_light_on
      card_glow_color_mode: 'fixed', // fixed | light | active (active = last-pressed button's color)
      card_glow_color: '#2196F3',
      card_glow_intensity: 1.0,
      card_glow_borders_only: true,
      // Plain elevation drop-shadow, independent of the colored Glow effect above.
      card_shadow_enabled: false,
      card_shadow_color: '#000000',
      card_shadow_x: 0,
      card_shadow_y: 4,
      card_shadow_blur: 16,
      card_shadow_spread: 0,
      card_shadow_opacity: 0.35, // 0-1 fraction (editor shows as a percentage)

      // ---- Preset button visual formatting ----
      button_border_enabled: false,
      button_border_width: 1,
      button_border_color: '#2196F3',
      // fixed = use button_border_color; match = a lighter shade of each button's own color
      // (the "room card" look, where the border is the lightest shade of the tile's color).
      button_border_color_mode: 'fixed',
      button_border_radius: 10,
      // Gradient border for buttons (same shape/technique as the card's). Universal — applies to
      // every button. Painted as background-layer gradient lines on the chosen sides.
      button_border_gradient: { enabled: false, width: 2, sides: { top: false, bottom: true, left: false, right: false }, stops: [{ pos: 0, color: 'transparent' }, { pos: 50, color: 'match' }, { pos: 100, color: 'transparent' }] },
      button_border_gradient_color_mode: 'match', // match (button's own color) | fixed (button_border_color) | none (disable)
      button_glow_enabled: false,
      button_glow_color: '#2196F3',
      button_glow_color_mode: 'fixed', // fixed | match (match = current light color) | none (disable)
      button_glow_intensity: 1.0, // legacy single knob; blur/spread/opacity below override when set
      button_glow_blur: 12, // px — box-shadow blur radius
      button_glow_spread: 2, // px — box-shadow spread radius
      button_glow_opacity: 0.5, // 0-1 — glow color alpha
      button_glow_condition: 'always', // always | when_active (only relevant when button_glow_enabled is true)
      // ---- Button drop shadow (parity with the card's shadow; separate from the colored glow) ----
      button_shadow_enabled: false,
      button_shadow_color: '#000000',
      button_shadow_x: 0,
      button_shadow_y: 4,
      button_shadow_blur: 12,
      button_shadow_spread: 0,
      button_shadow_opacity: 0.35,
      // "Follow button color" makes the border/glow track each button's own color (a lighter
      // shade for the border), like the room-card look. Border already had a 'match' mode; these
      // extend the same idea to glow. (Buttons parity with frames' follow_icon.)
      // (border 'match' mode + glow 'match' mode already cover this; no new key needed.)
      // ---- Button appearance ----
      // solid = filled with the preset color (default); tile = large card-style tile with
      // a subtle color-tinted gradient background and a colored icon (Mushroom-room look).
      button_style: 'solid',
      // ---- Button sizing ----
      button_font_size: 14,
      button_name_weight: '600', // 300|400|500|600|700 — weight of the button label text
      button_name_color: '', // fixed hex for the label text (only when mode='fixed'); '' = inherit
      button_name_color_mode: 'inherit', // inherit (theme/default text color) | fixed | match (button's own color) | none (=inherit)
      button_icon: '', // '' = use the per-button icon; a style-level mdi:* overrides it for all buttons
      button_icon_size: 0, // 0 = default (per button_style); >0 = fixed px icon size
      button_icon_color: '#2196F3', // fixed hex for the icon (only when mode='fixed')
      button_icon_color_mode: '', // '' = historic default (colored on tinted) | match | fixed | none (leave default)
      button_height: 44, // approximate, via padding
      button_icon_gap: 8, // px gap between a button's icon and its label
      button_name_wrap: false, // allow the label to wrap to multiple lines
      button_max_width: 0, // px cap on button width (0 = Auto/no cap). With wrap on, gives
                           // uniform-size buttons; height is aligned so wrapped ones match.

      // ---- Overall size control ----
      scale: 1.0, // overall scale multiplier for buttons/sliders/text

      // ---- Light command behavior ----
      // How a button/profile that carries BOTH a color and an effect sends them:
      //   false (default) = one light.turn_on with color + effect together (fewer calls)
      //   true            = color/brightness first, then the effect in a SEPARATE turn_on
      // Some controllers (e.g. Gledopto/Zigbee via Z2M) re-trigger the effect from the color
      // jump when bundled, adding an extra flash — splitting avoids that. Controller-dependent,
      // so it's a per-install toggle. Only affects buttons that have a color AND an effect.
      effect_separate_call: false,

      // ---- Per-entity send-method overrides ----
      // Send methods (white-temp format, effect timing) compensate for a specific controller's
      // firmware, so they belong to the physical light — not the button or profile (a button can
      // target several different fixtures at once). This maps an entity_id to its overrides:
      //   { 'light.gledopto_strip': { temperature_output_format: 'xy', effect_separate_call: true } }
      // Any field absent inherits the card default above. At send time the card resolves the
      // method PER target entity and groups the service calls by resolved method.
      entity_send_methods: {},

      debug: false,
    };
  }

  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._rendered = false;
    this._favorites = [];
    this._favoritesUnsub = null;
    this._cardCollapsed = false;
    this._collapseInitialized = false;
    this._lastPressedPresetId = null; // for glow/header "active" color mode
    this._renderScheduled = false;    // coalesces rapid setConfig() calls into one render
  }

  // Coalesce full re-renders onto the next animation frame. In the editor's live preview,
  // HA calls setConfig() on EVERY keystroke/slider tick — rendering synchronously each time
  // makes the preview flicker/rebuild constantly. Batching to one rAF eliminates that.
  _scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(() => { this._renderScheduled = false; if (this._rendered) this.renderCard(); });
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    // Skip re-render when the incoming config is byte-identical to what we already have (HA can
    // re-push the same config; the editor also round-trips it). Avoids needless preview rebuilds.
    const nextRaw = JSON.stringify(config);
    if (this._rendered && nextRaw === this._lastConfigJson) { return; }
    this._lastConfigJson = nextRaw;
    this._config = { ...ColorLightManagerCard.getStubConfig(), ...config };
    // Heal any duplicate preset ids from older builds (they broke per-button glow lookups).
    this._config.presets = dedupePresetIds(this._config.presets);
    DEBUG = this._config.debug || false;
    // Collapsible cards start collapsed. Resolve the initial state only once so a later
    // config round-trip (or hass update) doesn't re-collapse a card the user has expanded.
    // EXCEPTION: in the editor's live preview (this.preview === true) always start
    // EXPANDED so edits are visible — a collapsed preview hides everything the user
    // is changing, and each keystroke re-render would otherwise re-collapse it.
    if (!this._collapseInitialized) {
      this._cardCollapsed = this.preview ? false : (this._config.card_collapsible === true);
      this._collapseInitialized = true;
    }
    // Rendering is owned by `set hass` for the FIRST paint — it must run with hass available so
    // linked-Color-Entity buttons can resolve their live colors (rendering here first, before
    // hass, painted them colorless and suppressed that first hass render). So: if we've already
    // rendered, coalesce a refresh onto one rAF (no preview flicker); otherwise defer to set hass.
    if (this._rendered) this._scheduleRender();
    return;
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    // Load + live-subscribe the shared Fixture Profile Library only if any preset references
    // one (lib:<slug>) — otherwise skip the WS traffic entirely. Re-render on library updates.
    if (this._usesFixtureLibraryRef()) {
      ensureFixtureLibrary(hass, this._config && this._config.fixture_library_scope, () => {
        if (this._rendered) this.renderCard();
      });
    }
    // Button-style presets (incl. the system-wide Default) live in the shared store and drive
    // every buttons section's look. Subscribe so the card re-renders when a preset is saved
    // elsewhere (e.g. the editor) — otherwise a saved preset wouldn't apply until a full reload.
    ensureButtonStyleLibrary(hass, () => { if (this._rendered) this.renderCard(); });
    // Frame Style library: load/subscribe only if a card/section frame ref uses
    // a lib:<slug> preset. Re-render on updates so a frame edited elsewhere applies.
    if (this._usesLibraryRef()) {
      ensureFrameLibrary(hass, (this._config && this._config.frame_library_scope) || 'system', () => {
        if (this._rendered) this.renderCard();
      });
    }
    // Header Rule library: load/subscribe only when enabled AND a card/section
    // ref uses a lib:<slug> set. Re-render on updates so a set edited elsewhere
    // (incl. in the Easy Entity Styler card — same shared library) applies.
    if (this._config
        && (_usesHeaderLibRef(this._config.card_header_rules)
          || (this._config.sections || []).some(s => _usesHeaderLibRef(s.header_rule_refs)))) {
      ensureHeaderLibrary(hass, (this._config && this._config.header_library_scope) || 'system', () => {
        if (this._rendered) this.renderCard();
      });
    }
    // First real paint — only once config is present (renderCard bails without it). Runs with
    // hass available so linked-entity buttons resolve their colors on the very first render.
    if (!this._rendered) { if (!this._config) return; this.renderCard(); this._rendered = true; return; }
    // Linked buttons take their color/brightness live from their Color Entity. A button's
    // color/tint is computed at full render (not in updateStates), so when any linked entity's
    // state changes, re-render so those buttons reflect the entity. These helper entities only
    // change on a deliberate set_color, so this is rare and cheap.
    // NOTE: these full re-renders go through _scheduleRender() (rAF-coalesced), NOT renderCard()
    // directly. A scene fade fires many light-state updates in quick succession; rebuilding the DOM
    // synchronously on each one made the buttons visibly FLICKER (their glow flashed as the DOM was
    // destroyed/recreated). Coalescing collapses a burst into one rebuild per frame — no flicker.
    if (prev && this._linkedColorEntitiesChanged(prev, hass)) { this._scheduleRender(); return; }
    // Conditional button-style layers can change a button's WHOLE look (bg/border/gradient), not
    // just glow, when a watched entity changed — those aren't recomputed by updateStates(). So if
    // any style-condition-relevant entity changed, do a full re-render.
    if (prev && this._buttonConditionEntitiesChanged(prev, hass)) { this._scheduleRender(); return; }
    // A card_frame conditional preset (when_entity) can change the whole frame
    // when its entity changes — re-render so _applyCardFrame re-evaluates it.
    if (prev && this._frameConditionEntitiesChanged(prev, hass)) { this._scheduleRender(); return; }
    // Scene Tracker tiles read input_select options (+ optional light color) — re-render when any
    // watched tracker entity changes so the board stays live.
    if (prev && this._sceneTrackerEntitiesChanged(prev, hass)) { this._scheduleRender(); return; }
    this.updateStates();
  }

  // Entity ids the Scene Tracker sections display (each Area's input_select + optional light).
  _sceneTrackerEntityIds() {
    const ids = new Set();
    ((this._config && this._config.sections) || []).forEach(s => {
      if (!s || s.type !== 'scene_tracker' || !Array.isArray(s.areas)) return;
      s.areas.forEach(a => { if (a && a.entity) ids.add(a.entity); if (a && a.light) ids.add(a.light); });
    });
    return ids;
  }
  _sceneTrackerEntitiesChanged(prevHass, hass) {
    const ids = this._sceneTrackerEntityIds();
    for (const id of ids) {
      const a = prevHass.states[id], b = hass.states[id];
      if (a === b) continue;
      if (!a || !b) return true;
      if (a.state !== b.state) return true;
      if (a.last_updated !== b.last_updated) return true;   // light color/brightness attr changes
    }
    return false;
  }

  // True if the state of any Color Entity a button links to differs between two hass snapshots.
  _linkedColorEntitiesChanged(prevHass, hass) {
    const ids = new Set((this._config.presets || []).map(p => p && p.input_color_entity).filter(Boolean));
    for (const id of ids) {
      const a = prevHass.states[id], b = hass.states[id];
      if (a === b) continue;
      if (!a || !b) return true;
      if (a.state !== b.state || a.last_updated !== b.last_updated) return true;
    }
    return false;
  }

  // The set of entity ids whose state a button-section's conditional style layers depend on:
  // each buttons section's representative light (for light_on/off/unavailable) + any entity a
  // layer's `entity_state` condition watches. Empty when no stacks use conditions.
  // Returns { ids:Set, attrSensitive:bool } | null. `attrSensitive` is true when any layer uses
  // `button_active`: matching a color/temp preset depends on the light's COLOR ATTRIBUTES, which
  // can change while `.state` stays "on" — so those watched entities need attribute-level compare.
  _buttonConditionEntityIds() {
    const ids = new Set();
    let anyCond = false;
    let attrSensitive = false;
    // Every button's scene selects: watching each bound input_select means an option change repaints
    // the buttons (their deterministic "active" flips). Independent of any conditional-layer usage.
    ((this._config && this._config.presets) || []).forEach(p => {
      presetSelects(p).forEach(b => { ids.add(b.entity); anyCond = true; });
      // NOTE: follow-lights (glow_entities / scene members) are deliberately NOT watched here. They
      // don't need a full DOM rebuild — updateStates() (the default path on every hass change) already
      // repaints follow buttons via the fast-path. Watching them here (attribute-sensitive) caused a
      // full re-render on every attribute tick of a followed light — a render storm.
    });
    // A section's default scene group flips to '-none-' on divergence — watch it so buttons bound to
    // it de-highlight immediately (covers the case where no button explicitly binds the group).
    this._orderedSectionsRaw().forEach(s => { if (s && s.default_scene_group) { ids.add(s.default_scene_group); anyCond = true; } });
    this._orderedSectionsRaw().filter(s => s.type === 'buttons').forEach(section => {
      const stack = this._sectionButtonStack(section);
      if (!stack || !Array.isArray(stack.layers)) return;
      stack.layers.forEach(l => {
        const w = l && l.when; if (!w || !w.type) return;
        anyCond = true;
        if (w.type === 'entity_state' && w.entity) ids.add(w.entity);
        else if (w.type === 'light_on' || w.type === 'light_off' || w.type === 'light_unavailable' || w.type === 'button_active') {
          // button_active depends on each button's own target; those live within the section's
          // target scope, so watching the section's targets covers them (full re-render on change).
          if (w.type === 'button_active') attrSensitive = true;
          this._sectionTargetIds(section).forEach(id => ids.add(id));
        }
      });
    });
    return anyCond ? { ids, attrSensitive } : null;
  }
  _buttonConditionEntitiesChanged(prevHass, hass) {
    const spec = this._buttonConditionEntityIds();
    if (!spec) return false;
    for (const id of spec.ids) {
      const a = prevHass.states[id], b = hass.states[id];
      if (a === b) continue;
      if (!a || !b) return true;
      if (a.state !== b.state) return true;
      // Color/temp button_active matching turns on attributes, not just state — repaint on any
      // attribute change too (last_updated moves whenever a light's attributes are re-reported).
      if (spec.attrSensitive && a.last_updated !== b.last_updated) return true;
    }
    return false;
  }

  // Entity ids the card_frame's conditional presets watch (their when_entity),
  // so a state change to any of them re-applies the frame. Null when none.
  _frameConditionEntityIds() {
    const byId = this._framePresetsById();
    const ids = new Set();
    const scan = ref => {
      if (!ref || !Array.isArray(ref.presets)) return;
      ref.presets.forEach(id => {
        const fx = byId[id];
        if (fx && fx.when && fx.when_entity) ids.add(fx.when_entity);
      });
    };
    scan(this._config && this._config.card_frame);
    ((this._config && this._config.sections) || []).forEach(s => scan(s && s.frame));
    return ids.size ? ids : null;
  }
  _frameConditionEntitiesChanged(prevHass, hass) {
    const ids = this._frameConditionEntityIds();
    if (!ids) return false;
    for (const id of ids) {
      const a = prevHass.states[id], b = hass.states[id];
      if (a === b) continue;
      if (!a || !b) return true;
      if (a.state !== b.state) return true;
    }
    return false;
  }

  // True if any preset resolves its look from a library profile (lib:<slug> ref).
  _usesFixtureLibraryRef() {
    const presets = this._config && this._config.presets;
    return Array.isArray(presets) && presets.some(p => !!fixtureRefSlug(p && p.profile_ref));
  }

  connectedCallback() {
    this._favoritesUnsub = favoritesService.subscribe(favs => { this._favorites = favs; this._renderFavoritesBar(); });
    this._favorites = favoritesService.getFavorites();
    // Re-render when a button-style preset is saved elsewhere (e.g. this card's editor), so HA's
    // live preview pane repaints immediately with the saved style — the WS store subscription
    // covers the general case, this guarantees the same-page editor→preview repaint.
    this._btnStylesSavedHandler = () => { if (this._rendered) this.renderCard(); };
    window.addEventListener('clm-button-styles-saved', this._btnStylesSavedHandler);
  }
  disconnectedCallback() {
    if (this._favoritesUnsub) { this._favoritesUnsub(); this._favoritesUnsub = null; }
    if (this._btnStylesSavedHandler) { window.removeEventListener('clm-button-styles-saved', this._btnStylesSavedHandler); this._btnStylesSavedHandler = null; }
  }
  getCardSize() { return 6; }
  static getConfigElement() { return document.createElement('color-light-manager-card-editor'); }

  _entityIds() {
    const cfg = this._config || {};
    const ids = Array.isArray(cfg.entities) && cfg.entities.length ? cfg.entities : (cfg.entity ? [cfg.entity] : []);
    return ids.filter(Boolean);
  }
  // Returns the preset with its LOOK resolved: if it references a library profile
  // (profile_ref: lib:<slug>), the library look replaces its inline look; otherwise the
  // preset is returned unchanged. All look consumers (apply, swatch, button, active-state)
  // should read through this so a referenced profile drives behavior and appearance.
  _effectivePreset(preset) {
    if (!preset) return preset;
    // A Color-Entity-linked button holds NO color of its own — the entity is the single source
    // of truth, read live. Overlay the entity's current value so behavior + appearance always
    // follow the entity (edit it once in Color Entities, every linked button updates).
    if (preset.input_color_entity) {
      const st = this._hass && this._hass.states[preset.input_color_entity];
      const value = inputColorStateToPresetValue(st);
      if (value && Object.keys(value).length) {
        // The entity owns the ENTIRE look: color + brightness only. Strip every other look
        // field — including a stale effect/transition/action left from before it was linked —
        // so a linked button never fires an old effect the entity can't store. (This is what
        // was causing "Steel Blue" to flash: a leftover effect: breathe on a linked button.)
        const p = { ...preset };
        ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]);
        delete p.color_kelvin; delete p.brightness; delete p.effect; delete p.transition;
        delete p.action; delete p.look_none;
        return { ...p, ...value };
      }
      // Entity missing/unavailable — fall through (no stored color to use).
    }
    if (!fixtureRefSlug(preset.profile_ref)) return preset;
    return applyProfileLook(preset, resolvePresetLook(preset, this._config && this._config.fixture_library_scope));
  }
  // Resolves a target spec into the actual entity ids to act on. A target_entities array
  // targets that specific subset; empty/absent targets ALL of the card's entities. The
  // result is always intersected with the card's configured entities (a target can't act
  // on something not managed by the card).
  _targetIds(targetEntities) {
    const all = this._entityIds();
    if (!Array.isArray(targetEntities) || !targetEntities.length) return all;
    const set = new Set(all);
    return targetEntities.filter(id => set.has(id));
  }
  // Resolves a targeting spec (from presetTargetSpec) into actual ids = union of the Default
  // Entities pool (if useDefault) and a custom any-light list (if useCustom). Custom entities
  // are NOT intersected with the pool. Shared by buttons and slider/values sections.
  _specTargetIds(spec) {
    const ids = [];
    if (spec.useDefault) ids.push(...this._entityIds());
    if (spec.useCustom) spec.custom.forEach(id => { if (id) ids.push(id); });
    return [...new Set(ids)];
  }
  // Color-control target ids for a preset (union of default pool + its own custom lights).
  _presetColorIds(preset) { return this._specTargetIds(presetTargetSpec(preset)); }
  // Target ids for a slider/values section (same model as buttons; any light allowed).
  _sectionTargetIds(section) { return this._specTargetIds(presetTargetSpec(section)); }

  // Resolve a slider section's effective style (module helper — shared with the
  // editor class). See resolveSliderStyle().
  _sliderStyle(sectionId) { return resolveSliderStyle(this._config, sectionId); }

  // Representative state for a section's live readout — its first target light.
  _sectionPrimaryState(section) {
    const ids = this._sectionTargetIds(section);
    if (!ids.length || !this._hass) return null;
    // Prefer the first target light that is currently ON, mirroring _presetPrimaryState. A section's
    // Button Style light_on/light_off/light_unavailable conditions must reflect "is this section's
    // lighting on" — not the fixed first id. Otherwise a scene that turns the FIRST target light off
    // (e.g. Dinner dimming the floor light) flips a light_off-gated layer and disables the whole
    // section's glow, even though the room is still lit. Falls back to the first id when none are on,
    // so genuine all-off detection still works.
    for (const id of ids) { const st = this._hass.states[id]; if (st && st.state === 'on') return st; }
    return this._hass.states[ids[0]] || null;
  }
  _primaryState(targetEntities) {
    const ids = targetEntities ? this._targetIds(targetEntities) : this._entityIds();
    if (!ids.length || !this._hass) return null;
    return this._hass.states[ids[0]] || null;
  }
  // Light ids whose live color/state this button's APPEARANCE follows (fill, glow, accents).
  // Resolution order (first non-empty wins):
  //   1. preset.glow_entities — an explicit "follow these lights for color" list. Set by the user
  //      when auto-resolution can't work (e.g. a Zigbee2MQTT scene whose scene.* entity is a proxy
  //      that lists no member lights) or to override. Applies to ANY button kind.
  //   2. Scene mode → the referenced scene's member LIGHTS, read live from the scene.* entity's
  //      `entity_id` attribute. HA-native scenes expose them; Z2M/script proxy scenes yield [] here
  //      (→ fall through to the fixed-color / grey fallback in _presetAppearance).
  //   3. Non-scene buttons → their action color targets (Default pool ∪ own lights), as before.
  // NOTE: there is deliberately NO section-Default-Entities fallback for scene buttons — that
  // fallback was the "Dinner glow dies" bug: a scene button with no targets borrowed the section's
  // representative light, so when a scene turned THAT light off the glow (and any light_on-gated
  // glow layer) collapsed even though the scene's own lights were on.
  _glowSourceIds(preset) {
    const follow = Array.isArray(preset && preset.glow_entities) ? preset.glow_entities.filter(Boolean) : [];
    if (follow.length) return follow;
    if (buttonMode(preset) === 'scene') return this._sceneMemberLightIds(preset);
    // Non-scene buttons: their action color targets, resolved from the targeting spec (Default pool
    // if "Use Default Entities" is checked ∪ any own lights). NO extra fallback to the Default pool:
    // if the user unchecks everything ("No lights selected"), the button follows NOTHING — so an Off
    // button with no targets can't be falsely "active" just because a scene turned a pool light off
    // (the "Off goes active when Dinner is active" bug). A button that wants the pool checks
    // "Use Default Entities", which already includes it in these ids.
    return this._presetColorIds(preset);
  }
  // Member light ids of a scene-mode button's referenced scene, from the scene.* entity's live
  // `entity_id` attribute (HA-native scenes only; a Z2M proxy scene lists none → []).
  _sceneMemberLightIds(preset) {
    const ref = preset && preset.scene_ref;
    const st = ref && this._hass && this._hass.states[ref];
    const members = (st && st.attributes && Array.isArray(st.attributes.entity_id)) ? st.attributes.entity_id : [];
    return members.filter(id => typeof id === 'string' && id.startsWith('light.'));
  }
  _presetPrimaryState(preset) {
    const use = this._glowSourceIds(preset);
    if (!use.length || !this._hass) return null;
    let firstOn = null;
    for (const id of use) {
      const st = this._hass.states[id];
      if (st && st.state === 'on') { firstOn = st; break; }
    }
    const chosen = firstOn || this._hass.states[use[0]] || null;
    return chosen;
  }
  // Live color of a scene/follow button's resolved glow-source light (the first-ON one), or null
  // when nothing usable is on. This is the color the button "follows".
  _presetLiveColor(state) {
    if (state && state.state === 'on') {
      const a = state.attributes || {};
      let rgb = Array.isArray(a.rgb_color) ? a.rgb_color
        : (Array.isArray(a.xy_color) ? ColorUtils.xyToRgb(a.xy_color[0], a.xy_color[1]) : null);
      if (!rgb) { const k = attrsToKelvin(a); if (k !== undefined) rgb = ColorUtils.kelvinToRgb(k); }
      if (rgb) return ColorUtils.rgbToHex(...rgb);
    }
    return null;
  }
  // Resolve the { bodyColor, glowColor } a scene/follow button renders with. The two are
  // INDEPENDENT (change #2):
  //   • body — if a fixed button Style Color is enabled → that fixed color, ALWAYS. Otherwise the
  //     live follow color, but ONLY when the button is ACTIVE (change #1: an inactive scene button
  //     must not flicker as its follow-light changes color in the background); when inactive → the
  //     button's fixed Style Color if set, else a neutral grey.
  //   • glow — if a fixed Glow Color is enabled → that fixed color. Otherwise the live follow color
  //     (→ the fixed Style Color → grey as fallbacks). The glow only actually shows when_active per
  //     the style's glow condition, so it doesn't need the active-gate the body does.
  _presetAppearance(preset, state) {
    const live = this._presetLiveColor(state);
    const active = isPresetActiveFor(this._effectivePreset(preset), state, this._config && this._config.temperature_output_format, this._lastPressedPresetId, presetSelectsActive(preset, this._hass));
    // Fixed colors follow the existing "presence = enabled" convention (the checkbox adds/removes
    // the key). button_style_color = fixed BODY color; button_glow_style_color = fixed GLOW color.
    const bodyFixed = preset.button_style_color || null;
    const glowFixed = preset.button_glow_style_color || null;
    const bodyColor = bodyFixed
      ? bodyFixed
      : (active && live ? live : '#424242');
    const glowColor = glowFixed
      ? glowFixed
      : (live || bodyFixed || '#424242');
    return { bodyColor, glowColor };
  }

  // Calls a light service on a specific set of ids (defaults to all card entities).
  _callLightService(service, data, ids) {
    if (!this._hass) return;
    const targets = ids || this._entityIds();
    if (!targets.length) return;
    this._hass.callService('light', service, { entity_id: targets, ...data }).catch(e => {
      console.warn('[ColorLightManagerCard] service call failed', e);
    });
  }

  // A button does ONE thing, decided by its Mode (single-purpose model):
  //   scene   → activate one HA scene (scene.turn_on on scene_ref)
  //   off     → turn its target lights off
  //   profile/color/temp → apply the resolved look to its target lights
  // To combine actions (dim + turn off others + close blinds), build a Scene and use Scene mode.
  // Legacy additive fields (scenes[]/turn_off_entities[]) are preserved in config but NOT fired.
  _applyPreset(rawPreset) {
    if (!rawPreset) return;

    // Scene selects: set each bound input_select to its option. Applies to EVERY button kind and
    // runs alongside the button's primary action below (a "Sports" button can set the helper in
    // several rooms; an Off button can reset several helpers). Fired first so the option is marked
    // even if a later action early-returns.
    this._applyPresetSelects(rawPreset);
    // Section default scene reset: a non-scene button diverges the room, so mark the group off-scene.
    this._applyDefaultSceneReset(rawPreset);

    // Scene mode: fire exactly the referenced scene, nothing else.
    if (buttonMode(rawPreset) === 'scene') {
      const scene = rawPreset.scene_ref;
      if (!scene) return;
      if (!this._hass || !this._hass.states[scene]) { console.warn(`[ColorLightManagerCard] scene ${scene} not found`); return; }
      this._hass.callService('scene', 'turn_on', { entity_id: scene })
        .catch(e => console.warn('[ColorLightManagerCard] scene.turn_on failed', e));
      return;
    }

    // Resolve the look from a referenced library profile / linked entity before applying.
    const preset = this._effectivePreset(rawPreset);

    // Optional profile-style extras applied alongside the color action:
    //   transition — fade duration (s); applies to both turn_on and turn_off.
    //   effect     — a firmware effect name; turn_on only.
    const transition = (preset.transition !== undefined && preset.transition !== null && preset.transition !== '')
      ? Number(preset.transition) : undefined;
    const hasTransition = Number.isFinite(transition) && transition >= 0;

    // 1. Color-control action on the color-control lights. Targeting stays on the raw preset.
    // Send methods (white-temp format + effect timing) are resolved PER TARGET ENTITY, since a
    // single button can drive fixtures with different controllers. We group the targets by their
    // resolved methods and emit one set of service calls per group.
    const colorIds = this._presetColorIds(rawPreset);
    if (colorIds.length) {
      if (preset.action === 'turn_off') {
        this._callLightService('turn_off', hasTransition ? { transition } : {}, colorIds);
      } else {
        this._groupIdsBySendMethod(colorIds).forEach(({ methods, ids }) => {
          const data = presetValueToSetColorData(preset, methods.temperature_output_format, this._kelvinRange());
          // A preset can carry ONLY an effect/transition (no color) — still send turn_on then.
          const payload = data || {};
          if (hasTransition) payload.transition = transition;
          // Effect handling. Some controllers re-trigger the effect from the color jump when
          // color + effect arrive together (an extra flash). When this group's effect timing is
          // "separate" AND the button has both a color and an effect, send the color first, then
          // the effect in its own turn_on so the controller applies them cleanly. Else bundle.
          const hasColorData = data && Object.keys(data).length > 0;
          if (preset.effect && methods.effect_separate_call && hasColorData) {
            if (Object.keys(payload).length) this._callLightService('turn_on', payload, ids);
            this._callLightService('turn_on', { effect: preset.effect }, ids);
          } else {
            if (preset.effect) payload.effect = preset.effect;
            if (Object.keys(payload).length) this._callLightService('turn_on', payload, ids);
          }
        });
      }
    }
  }

  // Fire the button's input_select "scene selects": one input_select.select_option per binding.
  // Skips bindings whose entity is missing or whose option isn't among the helper's current options
  // (avoids HA errors from a stale/renamed option). Safe no-op when the button has no selects.
  _applyPresetSelects(preset) {
    const binds = presetSelects(preset);
    if (!binds.length || !this._hass) return;
    binds.forEach(b => {
      const st = this._hass.states[b.entity];
      if (!st) { console.warn(`${LOG_PREFIX} scene select: ${b.entity} not found`); return; }
      const opts = (st.attributes && Array.isArray(st.attributes.options)) ? st.attributes.options : null;
      if (opts && !opts.includes(b.option)) { console.warn(`${LOG_PREFIX} scene select: "${b.option}" not an option of ${b.entity}`); return; }
      if (DEBUG) debugLog(`PRESS "${preset.name}": select_option ${b.entity} → "${b.option}"`);
      this._hass.callService('input_select', 'select_option', { entity_id: b.entity, option: b.option })
        .catch(e => console.warn(`${LOG_PREFIX} input_select.select_option failed`, e));
    });
  }

  // Section default scene reset (press-driven divergence). When a button's section defines
  // default_scene_group, pressing a button that diverges the room marks that group off-scene (its
  // default_scene_option, typically '-none-'), de-highlighting the active scene. Skipped when:
  //   • the button is a SCENE button (it's setting a scene, not diverging),
  //   • the button already binds this group in its own Scene Selects (its explicit intent wins),
  //   • the button opts out via no_scene_reset (Scene Selects panel).
  // Deterministic and press-driven — never compares live light state.
  _applyDefaultSceneReset(preset) {
    if (!preset || !this._hass) return;
    if (preset.no_scene_reset) { if (DEBUG) debugLog(`RESET "${preset.name}": skipped (no_scene_reset opt-out)`); return; }
    if (buttonMode(preset) === 'scene') { if (DEBUG) debugLog(`RESET "${preset.name}": skipped (scene-mode button)`); return; }
    const section = this._sectionForPreset(preset);
    const group = section && section.default_scene_group;
    if (!group) { if (DEBUG) debugLog(`RESET "${preset.name}": skipped (section has no default_scene_group)`); return; }
    // Explicit binding to this group wins — don't override the button's own intent.
    if (presetSelects(preset).some(b => b.entity === group)) { if (DEBUG) debugLog(`RESET "${preset.name}": skipped (button binds ${group} itself)`); return; }
    const st = this._hass.states[group];
    if (!st) { console.warn(`${LOG_PREFIX} default scene reset: ${group} not found`); return; }
    const option = section.default_scene_option || '-none-';
    const opts = (st.attributes && Array.isArray(st.attributes.options)) ? st.attributes.options : null;
    if (opts && !opts.includes(option)) { console.warn(`${LOG_PREFIX} default scene reset: "${option}" not an option of ${group}`); return; }
    if (DEBUG) debugLog(`RESET "${preset.name}": FIRING → set ${group} = "${option}" (was "${st.state}")`);
    this._hass.callService('input_select', 'select_option', { entity_id: group, option })
      .catch(e => console.warn(`${LOG_PREFIX} default scene reset failed`, e));
  }

  // The buttons section a preset belongs to (mirrors _presetsForSection's fallback: a missing/stale
  // section_id resolves to the FIRST buttons section; unassigned buttons have no section).
  _sectionForPreset(preset) {
    if (!preset || preset.section_id === '__none__') return null;
    const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
    if (!buttonsSections.length) return null;
    return buttonsSections.find(s => s.id === preset.section_id) || buttonsSections[0];
  }

  _setBrightness(pct, ids) {
    const value = Math.round(clamp(pct, 0, 100) * 2.55);
    this._callLightService('turn_on', { brightness: value }, ids);
  }
  _setColorTemp(kelvin, ids) {
    // Applies the white-temperature output format (kelvin/xy/hs/rgb/rgbw/rgbww), resolved PER
    // entity so mixed fixtures each get the format their controller expects.
    const targets = ids || this._entityIds();
    this._groupIdsBySendMethod(targets).forEach(({ methods, ids: gids }) => {
      this._callLightService('turn_on', kelvinToServiceData(kelvin, methods.temperature_output_format, this._kelvinRange()), gids);
    });
  }
  _setRgb(rgb, ids) {
    this._callLightService('turn_on', { rgb_color: rgb }, ids);
  }
  // The card's configured warm/cool Kelvin bounds, used for RGBWW cold/warm-white mixing.
  _kelvinRange() {
    return { warmK: Number(this._config.min_kelvin) || 2000, coolK: Number(this._config.max_kelvin) || 6500 };
  }

  // ---- Per-entity send-method resolution ----
  // Resolves the effective send methods for one light: its per-entity override (if any) merged
  // over the card defaults. Send methods compensate for a controller's firmware, so they're
  // resolved per PHYSICAL light — a single button can drive several different fixtures.
  _sendMethodsFor(entityId) {
    const ov = (this._config.entity_send_methods || {})[entityId] || {};
    return {
      temperature_output_format: ov.temperature_output_format || this._config.temperature_output_format || 'kelvin',
      effect_separate_call: ov.effect_separate_call !== undefined ? !!ov.effect_separate_call : !!this._config.effect_separate_call,
    };
  }
  // Groups target ids by their resolved send methods, so a single press can send the correct
  // format/timing to each fixture. Returns [{ methods, ids }, …]; one group when all match.
  _groupIdsBySendMethod(ids) {
    const groups = new Map();
    (ids || []).forEach(id => {
      const m = this._sendMethodsFor(id);
      const key = `${m.temperature_output_format}|${m.effect_separate_call}`;
      if (!groups.has(key)) groups.set(key, { methods: m, ids: [] });
      groups.get(key).ids.push(id);
    });
    return [...groups.values()];
  }

  _brightnessEndColor(currentRgb, sectionId) {
    const st = this._sliderStyle(sectionId);
    if (st.brightness_end_color_mode === 'current') return currentRgb;
    return ColorUtils.hexToRgb(st.brightness_end_color) || [255, 255, 255];
  }

  // Builds a 3-stop gradient (start -> midpoint -> end) so "strength" can shift how
  // much of the bar stays dark before lightening, without needing canvas rendering.
  // Direction follows the handle mapping: horizontal goes dark(left)->bright(right);
  // vertical goes dark(bottom)->bright(top), matching pct=0 at the bottom.
  _brightnessGradientCss(currentRgb, sectionId) {
    const st = this._sliderStyle(sectionId);
    const startRgb = ColorUtils.hexToRgb(st.brightness_start_color) || [0, 0, 0];
    const endRgb = this._brightnessEndColor(currentRgb, sectionId);
    const midRgb = ColorUtils.mixRgb(startRgb, endRgb, 0.5);
    const strength = clamp(Number(st.brightness_gradient_strength), 0, 100);
    const midPct = Number.isFinite(strength) ? strength : 50;
    const startHex = ColorUtils.rgbToHex(...startRgb);
    const midHex = ColorUtils.rgbToHex(...midRgb);
    const endHex = ColorUtils.rgbToHex(...endRgb);
    const direction = st.slider_orientation === 'vertical' ? 'to top' : 'to right';
    return `linear-gradient(${direction}, ${startHex} 0%, ${midHex} ${midPct}%, ${endHex} 100%)`;
  }

  // ---- Frame Style resolver (ported from EESC; self-contained) ------------
  // Resolves a frame reference ({ presets:[ids], disabled:[ids] }) into composed
  // CSS. Presets layer in order (last-writer-wins per group). This Color-card
  // build applies frames UNCONDITIONALLY — a preset's optional when/when_entity
  // condition is preserved in the shared library but not evaluated here (the
  // value-resolution engine that powers conditions is EESC-only for now).
  _frameIconColor(section) {
    return (section && section.icon_color) || (this._config && this._config.icon_color) || '#2196F3';
  }
  _framePresetsById() {
    const map = {};
    const lib = frameLibraryMap((this._config && this._config.frame_library_scope) || 'system');
    Object.keys(lib).forEach(slug => { map['lib:' + slug] = lib[slug]; });
    if (!map[BUILTIN_FRAME_ID]) map[BUILTIN_FRAME_ID] = builtinFramePreset();
    return map;
  }
  _usesLibraryRef() {
    const refUsesLib = fr => fr && Array.isArray(fr.presets) &&
      fr.presets.some(id => typeof id === 'string' && id.startsWith('lib:'));
    if (refUsesLib(this._config && this._config.card_frame)) return true;
    return ((this._config && this._config.sections) || []).some(s => refUsesLib(s.frame));
  }
  // Evaluate a frame preset's optional condition. Returns true when the preset
  // should apply (or has no condition). Two condition kinds:
  //   - entity: `when` (EESC condition: op + value) against `when_entity`'s
  //     state (or an attribute via when.ref). Self-contained op eval — no need
  //     for EESC's full value-resolution engine.
  //   - section membership (`when_kind` = section_has_entities|section_empty):
  //     EESC-specific (targets an EESC section id) → not evaluable here, so a
  //     Color-card frame with a section condition is treated as always-on.
  // `override` (optional) is the per-location override for THIS applied preset
  // (from the frame ref's `overrides` map): a full rule override —
  // { when_entity, when:{op,value} } — where each field, when present, replaces
  // the library preset's own condition HERE (blank fields inherit the preset).
  _framePresetActive(fx, override) {
    if (!fx) return false;
    if (fx.when_kind === 'section_has_entities' || fx.when_kind === 'section_empty') {
      return true;   // section-membership conditions are EESC-only; don't hide here
    }
    // Merge the per-location override onto the preset's own condition. A blank
    // override field inherits the preset's value; an override op/value replaces
    // it (so a location can flip "is on" → "is off", or compare a new value).
    const ov = override || {};
    const entId = ov.when_entity || fx.when_entity || '';
    const baseWhen = fx.when || null;
    const ovWhen = (ov.when && typeof ov.when === 'object') ? ov.when : null;
    let w = baseWhen;
    if (ovWhen && ovWhen.op) {
      w = { ...(baseWhen || {}), op: ovWhen.op };
      if (ovWhen.value !== undefined && ovWhen.value !== '') w.value = ovWhen.value;
      else if (baseWhen && baseWhen.value !== undefined) w.value = baseWhen.value;
      else delete w.value;
    }
    if (!w || !w.op) return true;   // no condition anywhere → always on
    const st = entId && this._hass ? this._hass.states[entId] : null;
    if (!st) return false;
    // Resolve the compared value: entity state by default, or an attribute if
    // the condition's ref names one.
    let raw = st.state;
    if (w.ref && w.ref.source === 'attribute' && w.ref.attribute) raw = (st.attributes || {})[w.ref.attribute];
    const op = w.op || 'eq';
    const norm = v => String(v == null ? '' : v).trim().toLowerCase();
    const num = Number(raw), tnum = Number(w.value);
    switch (op) {
      case 'is_on': return norm(raw) === 'on';
      case 'is_off': return norm(raw) === 'off';
      case 'unavailable': return norm(raw) === 'unavailable' || norm(raw) === 'unknown' || !st;
      case 'ne': return norm(raw) !== norm(w.value);
      case 'gt': return Number.isFinite(num) && Number.isFinite(tnum) && num > tnum;
      case 'lt': return Number.isFinite(num) && Number.isFinite(tnum) && num < tnum;
      case 'ge': return Number.isFinite(num) && Number.isFinite(tnum) && num >= tnum;
      case 'le': return Number.isFinite(num) && Number.isFinite(tnum) && num <= tnum;
      case 'eq':
      default: return norm(raw) === norm(w.value);
    }
  }

  _flattenFrameToBundle(frameRef) {
    frameRef = frameRef || {};
    const byId = this._framePresetsById();
    const disabled = new Set(frameRef.disabled || []);
    // Layers whose own condition is ignored HERE — they always apply on this
    // card/section regardless of their when/when_entity.
    const ignoreCond = new Set(frameRef.ignore_conditions || []);
    // Per-location condition overrides (keyed by preset id) — e.g. a rebound
    // when_entity / op / value so a shared conditional frame is driven
    // differently here than in the library.
    const overrides = (frameRef.overrides && typeof frameRef.overrides === 'object') ? frameRef.overrides : {};
    const layerIds = (frameRef.presets || []).filter(id => !disabled.has(id));
    if (!layerIds.length) return null;
    const acc = {}; let any = false;
    layerIds.forEach(id => {
      const fx = byId[id];
      if (!fx) return;
      // Skip conditional presets that aren't active — UNLESS this application
      // opted to ignore the condition (then the layer always applies). The
      // per-location override (if any) rebinds the condition here.
      if (!ignoreCond.has(id) && !this._framePresetActive(fx, overrides[id])) return;
      ['glow', 'shadow', 'border', 'background', 'edges'].forEach(g => {
        if (fx[g]) { acc[g] = JSON.parse(JSON.stringify(fx[g])); any = true; }
      });
    });
    return any ? acc : null;
  }
  _hexToRgba(hex, alpha) {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    const a = alpha == null ? 1 : alpha;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  _buildDropShadow(color, x, y, blur, spread, opacity) {
    return `${x}px ${y}px ${blur}px ${spread}px ${this._hexToRgba(color, opacity)}`;
  }
  _buildGlowShadow(color, sides, bordersOnly, intensity) {
    const blur = 12 * intensity, spread = -4 * intensity, offset = 4 * intensity;
    if (!bordersOnly) return `0 0 ${blur}px ${spread}px ${color}`;
    const parts = [];
    if (sides.top) parts.push(`0 -${offset}px ${blur}px ${spread}px ${color}`);
    if (sides.bottom) parts.push(`0 ${offset}px ${blur}px ${spread}px ${color}`);
    if (sides.left) parts.push(`-${offset}px 0 ${blur}px ${spread}px ${color}`);
    if (sides.right) parts.push(`${offset}px 0 ${blur}px ${spread}px ${color}`);
    return parts.length ? parts.join(', ') : 'none';
  }
  _resolveFrame(frameRef, section) {
    const acc = this._flattenFrameToBundle(frameRef || {});
    if (!acc) return null;
    const out = { boxShadow: 'none', borderVars: null, edge: null, background: null };
    const iconCol = this._frameIconColor(section);
    const parts = [];
    if (acc.glow) {
      const bsides = (acc.border && Array.isArray(acc.border.sides)) ? acc.border.sides : ['top', 'bottom', 'left', 'right'];
      const sides = acc.glow.borders_only
        ? { top: bsides.includes('top'), bottom: bsides.includes('bottom'), left: bsides.includes('left'), right: bsides.includes('right') }
        : { top: true, bottom: true, left: true, right: true };
      const gcolor = acc.glow.follow_icon ? iconCol : acc.glow.color;
      parts.push(this._buildGlowShadow(gcolor, sides, acc.glow.borders_only, acc.glow.intensity));
    }
    if (acc.shadow) {
      const scolor = acc.shadow.follow_icon ? iconCol : acc.shadow.color;
      parts.push(this._buildDropShadow(scolor, acc.shadow.x, acc.shadow.y, acc.shadow.blur, acc.shadow.spread, acc.shadow.opacity));
    }
    out.boxShadow = parts.filter(s => s && s !== 'none').join(', ') || 'none';
    if (acc.border) {
      const bc = acc.border.follow_icon ? iconCol : acc.border.color;
      const bw = acc.border.width, br = acc.border.radius;
      const on = side => acc.border.sides.includes(side);
      const cn = Array.isArray(acc.border.corners) && acc.border.corners.length === 4 ? acc.border.corners : [true, true, true, true];
      const rad = `${cn[0] ? br : 0}px ${cn[1] ? br : 0}px ${cn[2] ? br : 0}px ${cn[3] ? br : 0}px`;
      out.borderVars = {
        top: on('top') ? `${bw}px solid ${bc}` : 'none',
        bottom: on('bottom') ? `${bw}px solid ${bc}` : 'none',
        left: on('left') ? `${bw}px solid ${bc}` : 'none',
        right: on('right') ? `${bw}px solid ${bc}` : 'none',
        radius: rad
      };
    }
    if (acc.background) {
      const mode = acc.background.mode || 'custom';
      out.background = mode === 'theme' ? 'theme'
        : mode === 'transparent' ? 'transparent'
        : (acc.background.color || 'transparent');
    }
    const edgeMatch = (acc.border && !acc.border.follow_icon && acc.border.color) ? acc.border.color : iconCol;
    if (acc.edges) out.edge = buildEdgeBackground(acc.edges, edgeMatch);
    return out;
  }

  // Resolves the card background per the 3-way mode: theme default (transparent
  // to the dashboard's own card styling), forced transparent, or a custom color.
  // "Transparent" is distinct from "theme default" — it forces the background to
  // fully disappear rather than falling back to the theme's card color.
  _cardBackgroundCss() {
    const cfg = this._config;
    const mode = cfg.card_bg_mode || 'theme';
    if (mode === 'transparent') return 'transparent';
    if (mode === 'custom') return cfg.card_bg_color || '#1c1c1c';
    return 'var(--ha-card-background, var(--card-background-color, #1c1c1c))';
  }

  // Full `background` shorthand for .cpc-card: the gradient-border LAYERS (if any) painted over
  // the base color. Layers respect border-radius and don't disturb glow/shadow (those are
  // box-shadow) or the border (that's the border property). Falls back to just the base color.
  _cardBackgroundLayers() {
    const base = this._cardBackgroundCss();
    const g = gradientBorderBackground(this._config.card_border_gradient, this._config.card_border_color || '#2196F3');
    if (!g) return `background: ${base};`;
    // Gradient line layers first (painted on top), then the base color fills behind them.
    return `background-image: ${g.image}; background-size: ${g.size}; background-position: ${g.position}; background-repeat: ${g.repeat}; background-color: ${base === 'transparent' ? 'transparent' : base};`;
  }

  // Plain elevation drop-shadow, independent of the colored Glow effect.
  _cardDropShadowCss() {
    const cfg = this._config;
    if (!cfg.card_shadow_enabled) return null;
    const x = Number(cfg.card_shadow_x) || 0;
    const y = Number(cfg.card_shadow_y) || 0;
    const blur = Number(cfg.card_shadow_blur) || 0;
    const spread = Number(cfg.card_shadow_spread) || 0;
    const opacity = clamp(Number(cfg.card_shadow_opacity), 0, 1);
    return `${x}px ${y}px ${blur}px ${spread}px ${ColorUtils.hexToRgba(cfg.card_shadow_color || '#000000', Number.isFinite(opacity) ? opacity : 0.35)}`;
  }

  // Builds the card wrapper's border CSS (per-side, mirroring seed-card's pattern
  // of independently toggleable top/bottom/left/right borders).
  _cardBorderCss() {
    const cfg = this._config;
    if (!cfg.card_border_enabled) return 'border: none;';
    const w = Number(cfg.card_border_width) || 1;
    const color = cfg.card_border_color || '#2196F3';
    const side = (enabled) => (enabled !== false ? `${w}px solid ${color}` : 'none');
    return `
      border-top: ${side(cfg.card_border_top)};
      border-bottom: ${side(cfg.card_border_bottom)};
      border-left: ${side(cfg.card_border_left)};
      border-right: ${side(cfg.card_border_right)};
    `;
  }

  // Per-corner radius toggles (TL, TR, BR, BL), mirroring seed-card's corner-radius pattern.
  _cardRadiusCss() {
    const cfg = this._config;
    const radius = Number(cfg.card_border_radius) || 12;
    const corners = Array.isArray(cfg.card_border_corners) ? cfg.card_border_corners : [true, true, true, true];
    const [tl, tr, br, bl] = corners;
    return `border-radius: ${tl ? radius : 0}px ${tr ? radius : 0}px ${br ? radius : 0}px ${bl ? radius : 0}px;`;
  }

  // Whether the card glow should currently render, per card_glow_condition.
  // "always" glows unconditionally; "when_light_on" only glows while at least
  // one of the card's target light entities is on.
  _shouldCardGlow() {
    const cfg = this._config;
    if (!cfg.card_glow_enabled) return false;
    const condition = cfg.card_glow_condition || 'always';
    if (condition === 'always') return true;
    if (condition === 'when_light_on') {
      if (!this._hass) return false;
      return this._entityIds().some(id => {
        const st = this._hass.states[id];
        return st && st.state === 'on';
      });
    }
    return true;
  }

  // The RGB of the last-pressed preset's effective look — the color the card most recently
  // APPLIED (intent), used by the "active" glow/icon color mode. Null if nothing pressed yet
  // or the last preset carries no color (Off/None/scene-only).
  _activeColorRgb() {
    const id = this._lastPressedPresetId;
    if (!id) return null;
    const preset = (this._config.presets || []).find(p => p.id === id);
    if (!preset) return null;
    const look = this._effectivePreset(preset);
    if (look.action === 'turn_off' || look.look_none) return null;
    if (presetColorFormat(look)) return presetColorToRgb(look);
    if (look.color_kelvin != null) return ColorUtils.kelvinToRgb(look.color_kelvin);
    return null;
  }

  // Builds the card wrapper's glow box-shadow, matching seed-card's glow effect.
  // Glow enablement is independent of whether the border itself is drawn.
  // "Glow stronger on sides with borders" concentrates the glow onto just the
  // bordered sides (a tighter, more intense per-side glow) instead of a diffuse
  // ambient glow around the whole card; it only applies when the border is on.
  //   color mode 'light'  → the representative light's live color (passed in as currentRgb)
  //   color mode 'active' → the last-pressed button's color (card intent)
  //   else (fixed)        → the configured fixed color
  _cardGlowCss(currentRgb) {
    const cfg = this._config;
    if (!this._shouldCardGlow()) return 'none';
    const activeRgb = cfg.card_glow_color_mode === 'active' ? this._activeColorRgb() : null;
    const color = (cfg.card_glow_color_mode === 'light' && currentRgb)
      ? ColorUtils.rgbToHex(...currentRgb)
      : (activeRgb ? ColorUtils.rgbToHex(...activeRgb) : (cfg.card_glow_color || '#2196F3'));
    const intensity = Number(cfg.card_glow_intensity) || 1.0;
    const bordersOnly = cfg.card_glow_borders_only !== false && cfg.card_border_enabled;
    const blur = 12 * intensity;
    const spread = -4 * intensity;
    const offset = 4 * intensity;
    if (!bordersOnly) return `0 0 ${blur}px ${spread}px ${color}`;
    const sides = {
      top: cfg.card_border_top !== false,
      bottom: cfg.card_border_bottom !== false,
      left: cfg.card_border_left !== false,
      right: cfg.card_border_right !== false,
    };
    const parts = [];
    if (sides.top) parts.push(`0 -${offset}px ${blur}px ${spread}px ${color}`);
    if (sides.bottom) parts.push(`0 ${offset}px ${blur}px ${spread}px ${color}`);
    if (sides.left) parts.push(`-${offset}px 0 ${blur}px ${spread}px ${color}`);
    if (sides.right) parts.push(`${offset}px 0 ${blur}px ${spread}px ${color}`);
    return parts.length ? parts.join(', ') : 'none';
  }

  // Resolves the header icon color from the LIVE light state (passed in), so it can be
  // recomputed on every state change rather than baked once at render. Resolution:
  //   - coloring disabled → theme default
  //   - fixed mode        → the configured fixed color
  //   - light mode + on   → the light's current color (rgb, or derived from xy/kelvin)
  //   - light mode + off  → theme default, or the configured "off" color
  _headerIconColorCss(state) {
    const cfg = this._config;
    if (!cfg.icon_color_enabled) return 'var(--secondary-text-color)';
    // "active" mode: follow the last-pressed button's color (intent), independent of light state.
    if (cfg.icon_color_mode === 'active') {
      const rgb = this._activeColorRgb();
      return rgb ? ColorUtils.rgbToHex(...rgb) : (cfg.icon_color || 'var(--secondary-text-color)');
    }
    if (cfg.icon_color_mode !== 'light') return cfg.icon_color || 'var(--secondary-text-color)';
    // light mode
    const on = state && state.state === 'on';
    if (!on) return cfg.icon_off_color_mode === 'fixed' ? (cfg.icon_off_color || 'var(--secondary-text-color)') : 'var(--secondary-text-color)';
    const attrs = (state && state.attributes) || {};
    let rgb = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
      : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
    if (!rgb) { const k = attrsToKelvin(attrs); if (k !== undefined) rgb = ColorUtils.kelvinToRgb(k); }
    return rgb ? ColorUtils.rgbToHex(...rgb) : 'var(--secondary-text-color)';
  }

  // ---- Header Rules resolver + live-apply (shared engine; layers over the
  // card's own header logic above). All methods no-op unless a ref is present,
  // so a card with no applied Header Rule Set is untouched.

  // Overlay of applicable Header Rule Sets (Built-In + shared library).
  _headerSetsById() {
    const map = {};
    const lib = headerLibraryMap((this._config && this._config.header_library_scope) || 'system');
    Object.keys(lib).forEach(slug => { map['lib:' + slug] = lib[slug]; });
    if (!map[BUILTIN_HEADER_ID]) map[BUILTIN_HEADER_ID] = builtinHeaderRuleSet();
    return map;
  }
  // The entity a section's header rules evaluate against when a ref doesn't name
  // its own: the section's first resolved target light (its "primary").
  _sectionHeaderEntityId(section) {
    if (!section) return this._cardHeaderEntityId();
    // A synthetic card-title "section" carries no target spec → card entity.
    if (!section.id && !section.type) return this._cardHeaderEntityId();
    const ids = this._sectionTargetIds(section);
    return (Array.isArray(ids) && ids.length) ? ids[0] : this._cardHeaderEntityId();
  }
  // The card-title's fallback entity: the card's first configured entity.
  _cardHeaderEntityId() {
    const ids = this._entityIds();
    return (Array.isArray(ids) && ids.length) ? ids[0] : '';
  }
  // Resolve the CARD TITLE's Header Rule Sets (config.card_header_rules) into a
  // sparse style object, reusing the section resolver with a synthetic section.
  _resolveCardTitleStyle() {
    if (!this._config) return {};
    const refs = this._config.card_header_rules;
    if (!Array.isArray(refs) || !refs.length) return {};
    return this._resolveHeaderStyle({ header_rule_refs: refs });
  }
  // Resolve a section's applied Header Rule Sets into concrete style outputs.
  // Layered last-match-wins per field across all refs' rules; each set's
  // `default` seeds a field only if no rule set it. Returns a SPARSE object
  // (only fields the rules set) — the caller keeps its own value for anything
  // unset, which is how a rule layers over the card's own header logic.
  _resolveHeaderStyle(section) {
    if (!this._config) return {};
    const refs = (section && Array.isArray(section.header_rule_refs)) ? section.header_rule_refs : [];
    if (!refs.length) return {};
    const byId = this._headerSetsById();
    const out = {};
    const applyOutputs = (src, entId) => {
      HEADER_RULE_OUTPUT_KEYS.forEach(k => {
        if (src[k] === undefined) return;
        if (k === 'set_secondary') {
          const txt = this._resolveSecondaryText(entId, src[k]);
          if (txt !== '' && txt != null) out.secondaryText = txt;
        } else if (k === 'set_icon_color') { out.iconColor = src[k]; }
        else if (k === 'set_icon') { out.glyph = src[k]; }
        else if (k === 'set_text_color') { out.textColor = src[k]; }
        else if (k === 'set_icon_size') { out.iconSize = src[k]; }
        else if (k === 'set_text_size') { out.textSize = src[k]; }
      });
    };
    refs.forEach(ref => {
      const set = byId[ref.ref];
      if (!set) return;
      // Entity precedence (top wins): the card/section binding (ref.entity)
      // OVERRIDES the set's Library default_entity, which overrides the primary.
      const bound = ref.entity || set.default_entity || this._sectionHeaderEntityId(section);
      let matched = false;
      (set.rules || []).forEach(rule => {
        const entId = ref.entity || rule.when_entity || set.default_entity || this._sectionHeaderEntityId(section);
        const hasEnt = entId && this._hass && this._hass.states[entId];
        if (hasEnt && evalCondition(entId, rule.when, this._hass)) { applyOutputs(rule, entId); matched = true; }
      });
      if (!matched && set.default) applyOutputs(set.default, bound);
    });
    return out;
  }
  // Resolve a secondary-info value-ref to a display string (prefix + value+unit).
  _resolveSecondaryText(entId, si) {
    if (!si || !entId || !this._hass) return '';
    const res = resolveValueRef(entId, { source: si.source, attribute: si.attribute, transform: si.transform, unit: si.unit }, this._hass);
    if (!res || res.badState) return '';
    const val = res.display != null ? res.display : (res.raw != null ? String(res.raw) : '');
    if (val === '' || val === '—') return '';
    return (si.prefix || '') + val;
  }
  // Live re-apply the CARD TITLE's Header Rule style in place (no full render).
  // Sparse: a field the rules didn't set reverts to its base — for icon color
  // that means restoring the card's own _headerIconColorCss(), NOT clearing.
  _applyCardTitleStyleLive() {
    const header = this.querySelector('#cpc-header');
    if (!header) return;
    const cts = this._resolveCardTitleStyle();
    const iconEl = header.querySelector('#cpc-title-icon');
    if (iconEl) {
      iconEl.setAttribute('icon', normalizeIcon(cts.glyph || this._config.icon || 'mdi:palette'));
      // Rule wins when set; otherwise fall back to the card's own icon-color logic.
      iconEl.style.color = cts.iconColor ? String(cts.iconColor) : this._headerIconColorCss(this._primaryState());
      if (cts.iconSize) iconEl.style.setProperty('--mdc-icon-size', Number(cts.iconSize) + 'px');
      else iconEl.style.removeProperty && iconEl.style.removeProperty('--mdc-icon-size');
    }
    const textEl = header.querySelector('.cpc-title-text');
    if (textEl) {
      textEl.style.color = cts.textColor ? String(cts.textColor) : '';
      textEl.style.fontSize = cts.textSize ? (Number(cts.textSize) + 'px') : '';
    }
    let secEl = header.querySelector('.cpc-title-secondary');
    const secText = cts.secondaryText ? String(cts.secondaryText) : '';
    if (secText) {
      if (!secEl) { secEl = document.createElement('span'); secEl.className = 'cpc-title-secondary'; header.appendChild(secEl); }
      secEl.textContent = secText;
    } else if (secEl && secEl.remove) { secEl.remove(); }
  }
  // Live re-apply a section heading's Header Rule style in place. Mirrors the
  // render-time block in _sectionHeading. Sparse revert as above (an unset
  // field clears the inline style, falling back to the heading's own CSS).
  _applyHeaderStyleLive(sectionEl, section) {
    if (!sectionEl) return;
    const hrs = this._resolveHeaderStyle(section);
    const scale = Number(this._config.scale) || 1.0;
    const nameEl = sectionEl.querySelector('.cpc-section-name');
    if (nameEl) {
      const textEl = nameEl.querySelector('.cpc-section-head-text') || nameEl;
      textEl.style.color = hrs.textColor ? String(hrs.textColor) : '';
      textEl.style.fontSize = hrs.textSize ? `calc(${Number(hrs.textSize)}px * ${scale})` : '';
      let secEl = nameEl.querySelector('.cpc-section-secondary');
      const secText = hrs.secondaryText ? String(hrs.secondaryText) : '';
      if (secText) {
        if (!secEl) { secEl = document.createElement('div'); secEl.className = 'cpc-section-secondary'; nameEl.appendChild(secEl); }
        secEl.textContent = secText;
      } else if (secEl && secEl.remove) { secEl.remove(); }
    }
  }

  renderCard() {
    if (!this._config) return;
    const cfg = this._config;
    const state = this._primaryState();
    const attrs = (state && state.attributes) || {};
    const brightnessPct = attrs.brightness ? Math.round((attrs.brightness / 255) * 100) : 0;
    const currentKelvin = attrsToKelvin(attrs) || Math.round(((Number(cfg.min_kelvin)||2000) + (Number(cfg.max_kelvin)||6500)) / 2);
    const currentRgb = attrs.rgb_color || [255, 255, 255];
    const layoutClass = `layout-${cfg.layout || 'columns'}`;
    const gap = Number(cfg.gap) || 8;
    // NOTE: buttons are rendered per-section (see _renderSection → _renderPresetButton(p, bstyle)),
    // which applies each section's Button Style. There is no card-level preset list in the DOM, so
    // we do NOT pre-render one here — doing so ran a full (style-less) render pass over every button
    // on every renderCard() whose output was discarded, and logged phantom glowEnabled=false lines.

    const scale = Number(cfg.scale) || 1.0;
    const vertical = cfg.slider_orientation === 'vertical';
    const sliderWidth = Number(vertical ? cfg.slider_width_vertical : cfg.slider_width_horizontal) || 44;
    const sliderLength = Number(vertical ? cfg.slider_length_vertical : cfg.slider_length_horizontal) || (vertical ? 180 : 100);
    const sliderFontSize = Number(cfg.slider_font_size) || 13;
    const sliderTextColor = cfg.slider_text_color || ''; // '' = default (white on-bar / theme off-bar)
    const sliderBorderRadius = Number(cfg.slider_border_radius);
    const sliderRadiusPx = Number.isFinite(sliderBorderRadius) ? sliderBorderRadius : 10;
    const textPlacement = vertical ? (cfg.slider_text_placement_vertical || 'inside') : (cfg.slider_text_placement_horizontal || 'inside');
    const iconSize = Number(cfg.icon_size) || 22;
    const dividerColor = cfg.divider_color || 'var(--divider-color)';
    const dividerThickness = Number(cfg.divider_thickness) || 1;
    const dividerLength = clamp(Number(cfg.divider_length) || 100, 5, 100);
    const buttonFontSize = Number(cfg.button_font_size) || 14;
    const buttonHeight = Number(cfg.button_height) || 44;
    const buttonIconGap = Number.isFinite(Number(cfg.button_icon_gap)) ? Number(cfg.button_icon_gap) : 8;
    const buttonNameWeight = cfg.button_name_weight || '600';
    const buttonNameWrap = cfg.button_name_wrap === true;
    const buttonMaxWidth = Number(cfg.button_max_width) || 0; // 0 = no cap
    const titleFontSize = Number(cfg.title_font_size) || 18;
    const titleFontWeight = cfg.title_font_weight || '500';
    const titleColor = cfg.title_color || 'var(--primary-text-color)';
    const handleOpacity = clamp(Number(cfg.slider_handle_opacity), 0, 100) / 100;
    const handleColor = ColorUtils.hexToRgba(cfg.slider_handle_color || '#ffffff', Number.isFinite(handleOpacity) ? handleOpacity : 1);
    const handleShape = cfg.slider_handle_shape || 'round';
    // Only meaningful for vertical orientation, where sliders sit side-by-side
    // and can be pushed to one edge, centered, or spread evenly across the card.
    const verticalAlignmentCss = {
      left: 'justify-content:flex-start;',
      center: 'justify-content:center;',
      right: 'justify-content:flex-end;',
      even: 'justify-content:space-evenly;',
    }[cfg.vertical_slider_alignment] || 'justify-content:flex-start;';


    // Header composition. Title text and icon are independently show/hide-able.
    const showTitleText = cfg.show_title !== false && !!cfg.title;
    const showTitleIcon = cfg.show_title_icon !== false && !!cfg.icon;
    // Collapsible works even with no title/icon: the header becomes a minimal bar with just
    // a chevron so the card can still be expanded.
    const collapsible = cfg.card_collapsible === true;
    const showChevron = collapsible && cfg.card_show_chevron !== false;
    const expanded = collapsible && !this._cardCollapsed;
    const emptyHeader = !showTitleText && !showTitleIcon; // no title content
    const headerClasses = [
      'cpc-header',
      collapsible ? 'collapsible' : '',
      collapsible && this._cardCollapsed ? 'collapsed-state' : '',
      emptyHeader && collapsible ? 'cpc-header-minimal' : '',
    ].filter(Boolean).join(' ');
    // Render a header if there's title content, OR if collapsible needs a bar to click.
    const headerHtml = (showTitleText || showTitleIcon || collapsible)
      ? `<div class="${headerClasses}" id="cpc-header">${showTitleIcon ? `<ha-icon class="cpc-title-icon" id="cpc-title-icon" icon="${escapeHtml(normalizeIcon(cfg.icon))}"></ha-icon>` : ''}${showTitleText ? `<span class="cpc-title-text">${escapeHtml(cfg.title)}</span>` : (collapsible ? '<span class="cpc-title-text"></span>' : '')}${showChevron ? `<ha-icon class="cpc-chevron${expanded ? ' expanded' : ''}" icon="mdi:chevron-down"></ha-icon>` : ''}</div>`
      : '';

    this.innerHTML = `
      <style>
        .cpc-card {
          /* Base background only. Border / glow / drop-shadow / gradient border
             all come from the Card Frame (frame model), applied inline by
             _applyCardFrame() after render — the native card-styling settings
             were removed (clean break). */
          background: ${this._cardBackgroundCss()};
          border-radius: 12px;
          padding: calc(16px * ${scale});
          box-sizing: border-box;
        }
        .cpc-header { display:flex; align-items:center; gap:8px; margin-bottom:calc(14px * ${scale}); color:${titleColor}; font-size:calc(${titleFontSize}px * ${scale}); font-weight:${titleFontWeight}; }
        .cpc-header ha-icon { --mdc-icon-size:calc(${iconSize}px * ${scale}); }
        .cpc-header ha-icon.cpc-title-icon { color:${this._headerIconColorCss(state)}; }
        .cpc-header.collapsible { cursor:pointer; user-select:none; }
        /* Minimal bar when collapsible but no title/icon: reserve a small clickable height. */
        .cpc-header-minimal { min-height:calc(20px * ${scale}); margin-bottom:${collapsible && this._cardCollapsed ? '0' : `calc(14px * ${scale})`}; justify-content:flex-end; }
        .cpc-header .cpc-title-text { flex:1; }
        .cpc-section-name { margin-bottom:calc(6px * ${scale}); }
        /* Collapsible section title row: clickable, chevron rotates with state. */
        .cpc-section-head { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
        .cpc-section-head .cpc-section-head-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cpc-section-head ha-icon.cpc-section-chevron { color:var(--secondary-text-color); flex-shrink:0; transition:transform 0.25s ease; }
        .cpc-section-head ha-icon.cpc-section-chevron.expanded { transform:rotate(180deg); }
        .cpc-section-head.collapsed-state { margin-bottom:0; }
        .cpc-section-body.collapsed { display:none; }
        .cpc-header ha-icon.cpc-chevron { color:var(--secondary-text-color); flex-shrink:0; transition:transform 0.25s ease; }
        /* Chevron points down (default) when collapsed; rotates up-ish when expanded. */
        .cpc-header ha-icon.cpc-chevron.expanded { transform:rotate(180deg); }
        /* When collapsed, the header keeps no bottom margin so the card hugs the title. */
        .cpc-header.collapsed-state { margin-bottom:0; }
        .cpc-body.collapsed { display:none; }
        .cpc-presets { display:flex; gap:${gap}px; }
        .cpc-presets.layout-stack { flex-direction:column; }
        .cpc-presets.layout-columns { flex-direction:row; flex-wrap:${cfg.wrap ? 'wrap' : 'nowrap'}; justify-content:center; }
        .cpc-presets.layout-grid { display:grid; grid-template-columns:repeat(${Number(cfg.columns)||3},minmax(0,1fr)); gap:${gap}px; }
        /* Let grid items shrink to their track instead of overflowing at min-content width. */
        .cpc-presets.layout-grid .cpc-preset-btn { min-width:0; }
        .cpc-preset-btn {
          display:flex; align-items:center; justify-content:center; gap:calc(${buttonIconGap}px * ${scale});
          padding:calc(${buttonHeight}px * ${scale} / 3.15) calc(18px * ${scale}); border-radius:10px; border:none; cursor:pointer;
          font-size:calc(${buttonFontSize}px * ${scale}); font-weight:${buttonNameWeight};
          transition: transform 0.15s ease, box-shadow 0.15s ease;
          color:#000; background:#fff;
          /* Each button owns a stacking context so its glow (box-shadow) isn't painted over
             by the opaque background of the NEXT button in DOM order. */
          position:relative; z-index:0;
          ${buttonMaxWidth ? `max-width:calc(${buttonMaxWidth}px * ${scale});` : ''}
        }
        /* Word-wrap: allow the label to break to multiple lines; align all buttons to a
           common min-height so a wrapped 2-line button matches single-line ones (uniform). */
        .cpc-preset-btn .cpc-btn-label { font-weight:${buttonNameWeight}; ${buttonNameWrap
          ? 'white-space:normal; overflow-wrap:anywhere; text-align:center;'
          : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'} }
        ${buttonNameWrap ? `.cpc-preset-btn { min-height:calc(${buttonHeight}px * ${scale}); align-items:center; }` : ''}
        /* In columns layout with a max width, stretch buttons to equal width for uniformity. */
        ${(buttonMaxWidth && cfg.layout === 'columns') ? `.cpc-presets.layout-columns .cpc-preset-btn { flex:1 1 calc(${buttonMaxWidth}px * ${scale}); }` : ''}
        /* A glowing button floats above its neighbors so its halo shows on all sides. */
        .cpc-preset-btn.cpc-glowing { z-index:1; }
        .cpc-preset-btn:hover { transform:translateY(-1px); box-shadow:0 2px 8px rgba(0,0,0,0.25); }
        .cpc-preset-btn.off-style { background:transparent; border:2px solid var(--divider-color); color:var(--primary-text-color); }
        .cpc-preset-btn ha-icon { --mdc-icon-size:calc(18px * ${scale}); }
        /* Tile ("room card") style: tall tile, left-aligned colored icon + name, color-tinted bg. */
        .cpc-preset-btn.cpc-tile {
          flex-direction:row; justify-content:flex-start; align-items:center; gap:calc(${buttonIconGap}px * ${scale});
          min-height:calc(${buttonHeight}px * ${scale} * 1.6);
          padding:calc(14px * ${scale}) calc(16px * ${scale});
          border-radius:calc(18px * ${scale});
          color:var(--primary-text-color); text-align:left;
        }
        .cpc-preset-btn.cpc-tile ha-icon { --mdc-icon-size:calc(26px * ${scale}); color:var(--cpc-tile-icon-color, var(--primary-text-color)); flex-shrink:0; }
        .cpc-preset-btn.cpc-tile .cpc-tile-name { font-size:calc(${buttonFontSize}px * ${scale}); }
        .cpc-preset-btn.cpc-tile:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(0,0,0,0.35); }
        /* Scene Tracker styled tile: name + current-scene sub-line stacked. */
        .cpc-preset-btn .cpc-btn-labelwrap { display:flex; flex-direction:column; align-items:flex-start; min-width:0; }
        .cpc-preset-btn.cpc-tile .cpc-btn-labelwrap { align-items:center; }
        .cpc-preset-btn .cpc-btn-sublabel { font-size:calc(11px * ${scale}); color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
        .cpc-sliders { display:flex; width:100%; box-sizing:border-box; ${vertical ? `flex-direction:row; align-items:flex-start; gap:calc(16px * ${scale}); ${verticalAlignmentCss}` : `flex-direction:column; gap:calc(10px * ${scale});`} }
        .cpc-slider-row { display:flex; flex-direction:column; gap:4px; ${vertical ? `width:calc(${sliderWidth}px * ${scale});` : `width:${sliderLength}%;`} }
        .cpc-bar-slider {
          position:relative; border-radius:${sliderRadiusPx}px;
          cursor:pointer; user-select:none; overflow:visible;
          ${vertical
            ? `width:100%; height:calc(${sliderLength}px * ${scale});`
            : `height:calc(${sliderWidth}px * ${scale}); width:100%;`}
        }
        .cpc-bar-track {
          position:absolute; top:0; left:0; right:0; bottom:0; border-radius:${sliderRadiusPx}px; overflow:hidden;
        }
        .cpc-text-row {
          position:relative; height:calc((${sliderFontSize}px + 6px) * ${scale}); flex-shrink:0;
          font-size:calc(${sliderFontSize}px * ${scale});
        }
        .cpc-bar-label {
          position:absolute; display:flex; align-items:center;
          font-weight:600; pointer-events:none; z-index:1;
          font-size:calc(${sliderFontSize}px * ${scale}); padding:0 12px; box-sizing:border-box;
        }
        .cpc-bar-value {
          position:absolute; display:flex; align-items:center;
          font-weight:700; pointer-events:none; z-index:1;
          font-size:calc(${sliderFontSize}px * ${scale}); padding:0 12px; box-sizing:border-box;
        }
        .cpc-mired { font-size:calc(${sliderFontSize}px * ${scale} * 0.78); opacity:0.75; margin-left:4px; font-weight:600; }
        /* "inside" placement: label/value overlay the bar itself, full-bleed. Default is light
           text with a shadow for contrast; a user-selected color overrides it (shadow kept). */
        .cpc-bar-slider > .cpc-bar-label, .cpc-bar-slider > .cpc-bar-value {
          top:0; left:0; right:0; bottom:0; color:${sliderTextColor || '#fff'}; text-shadow:0 1px 2px rgba(0,0,0,0.5);
        }
        /* "above"/"below"/"outside" placement: label/value sit in their own row. Default theme
           text color; a user-selected color overrides it. */
        .cpc-text-row > .cpc-bar-label, .cpc-text-row > .cpc-bar-value {
          top:0; bottom:0; left:0; right:0; color:${sliderTextColor || 'var(--primary-text-color)'}; text-shadow:none;
        }
        .cpc-bar-handle {
          position:absolute; z-index:2; pointer-events:none; transition: box-shadow 0.1s ease;
          background:${handleColor}; border:2px solid rgba(0,0,0,0.3); box-shadow:0 1px 4px rgba(0,0,0,0.4);
          ${handleShape === 'square'
            ? `width:calc(18px * ${scale}); height:calc(18px * ${scale}); border-radius:3px;`
            : handleShape === 'diamond'
              ? `width:calc(14px * ${scale}); height:calc(14px * ${scale}); border-radius:2px;`
              : handleShape === 'line'
                ? (vertical ? `width:100%; height:calc(5px * ${scale}); border-radius:2px;` : `width:calc(5px * ${scale}); height:100%; border-radius:2px;`)
                : `width:calc(18px * ${scale}); height:calc(18px * ${scale}); border-radius:50%;`}
          ${vertical
            ? `left:50%; transform:translate(-50%,50%)${handleShape === 'diamond' ? ' rotate(45deg)' : ''};`
            : `top:50%; transform:translate(-50%,-50%)${handleShape === 'diamond' ? ' rotate(45deg)' : ''};`}
        }
        .cpc-temperature .cpc-bar-track { background:linear-gradient(${vertical ? 'to top' : 'to right'}, #ffb366, #fff2e6, #cce6ff); }
        .cpc-rgb .cpc-bar-track { background:linear-gradient(${vertical ? 'to top' : 'to right'}, red, yellow, lime, cyan, blue, magenta, red); }
        /* Each body section is wrapped in .cpc-section; consistent spacing lives here. */
        .cpc-section { margin-bottom:calc(14px * ${scale}); }
        .cpc-section:last-child { margin-bottom:0; }
        /* Scene Tracker: a responsive grid of read-only Area status tiles. */
        .cpc-scene-tracker { display:grid; grid-template-columns:repeat(auto-fill, minmax(calc(140px * ${scale}), 1fr)); gap:calc(8px * ${scale}); }
        .cpc-scene-tracker-empty { font-size:calc(12px * ${scale}); color:var(--secondary-text-color); padding:calc(8px * ${scale}) 0; }
        .cpc-area-tile { display:flex; align-items:center; gap:calc(8px * ${scale}); padding:calc(8px * ${scale}) calc(10px * ${scale}); border-radius:calc(10px * ${scale}); background:var(--secondary-background-color, rgba(255,255,255,0.04)); min-width:0; }
        .cpc-area-tile.cpc-area-unavailable { opacity:0.5; }
        .cpc-area-dot { flex:0 0 auto; width:calc(8px * ${scale}); height:calc(8px * ${scale}); border-radius:50%; }
        .cpc-area-icon { flex:0 0 auto; --mdc-icon-size:calc(20px * ${scale}); }
        .cpc-area-text { display:flex; flex-direction:column; min-width:0; }
        .cpc-area-name { font-size:calc(13px * ${scale}); color:var(--primary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .cpc-area-option { font-size:calc(11px * ${scale}); color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .cpc-current-values {
          display:grid; grid-template-columns:repeat(2, 1fr); gap:calc(6px * ${scale}) calc(14px * ${scale});
          font-size:calc(12px * ${scale}); color:var(--secondary-text-color);
        }
        /* Optional per-section dividers (opt-in via config). Implemented as centered
           pseudo-element lines so length (%), color, and thickness are all controllable. */
        .cpc-div-top, .cpc-div-bottom { position:relative; }
        .cpc-div-top { padding-top:calc(12px * ${scale}); margin-top:calc(12px * ${scale}); }
        .cpc-div-bottom { padding-bottom:calc(12px * ${scale}); margin-bottom:calc(12px * ${scale}); }
        .cpc-div-top::before, .cpc-div-bottom::after {
          content:''; position:absolute; left:50%; transform:translateX(-50%);
          width:${dividerLength}%; height:${dividerThickness}px; background:${dividerColor}; border-radius:${dividerThickness}px;
        }
        .cpc-div-top::before { top:0; }
        .cpc-div-bottom::after { bottom:0; }
        .cpc-cv-item { display:flex; align-items:center; gap:6px; min-width:0; }
        .cpc-cv-label { font-weight:600; color:var(--primary-text-color); flex-shrink:0; }
        .cpc-cv-value { font-family:var(--code-font-family, monospace); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cpc-cv-swatch { width:calc(12px * ${scale}); height:calc(12px * ${scale}); border-radius:3px; border:1px solid rgba(255,255,255,0.3); flex-shrink:0; }
        .cpc-favorites {
          display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; padding-top:12px;
          border-top:1px solid var(--divider-color);
        }
        .cpc-fav-chip {
          display:flex; align-items:center; gap:6px; padding:4px 10px 4px 4px;
          border-radius:999px; background:var(--secondary-background-color, #2a2a2a);
          border:1px solid var(--divider-color); cursor:pointer; font-size:12px; color:var(--primary-text-color);
        }
        .cpc-fav-swatch { width:20px; height:20px; border-radius:50%; border:1px solid rgba(255,255,255,0.3); }
        .cpc-fav-remove { margin-left:2px; color:var(--secondary-text-color); font-weight:bold; line-height:1; cursor:pointer; }
        .cpc-fav-remove:hover { color:var(--error-color, #f44336); }
        .cpc-fav-save-btn {
          display:flex; align-items:center; gap:4px; padding:4px 10px;
          border-radius:999px; border:1px dashed var(--divider-color);
          background:transparent; color:var(--secondary-text-color); cursor:pointer; font-size:12px;
        }
        .cpc-fav-save-btn ha-icon { --mdc-icon-size:14px; }
      </style>
      <div class="cpc-card">
        ${headerHtml}
        <div class="cpc-body${collapsible && this._cardCollapsed ? ' collapsed' : ''}" id="cpc-body">
        ${this._orderedSections().map(section => this._renderSection(section, { state })).join('')}
        ${cfg.show_favorites ? `<div class="cpc-favorites" id="cpc-favorites"></div>` : ''}
        </div>${/* /cpc-body */''}
      </div>
    `;
    this._wireEvents();
    if (cfg.show_favorites) this._renderFavoritesBar();
    this._applyCardFrame();
    this._applySectionFrames();
    this._applyHeaderRulesLive();
  }

  // Apply all Header Rule styling (card title + each section heading) in place.
  // No-op unless opted in; safe to call after render and from updateStates.
  _applyHeaderRulesLive() {
    if (!this._config) return;
    if (Array.isArray(this._config.card_header_rules) && this._config.card_header_rules.length) {
      this._applyCardTitleStyleLive();
    }
    this._orderedSectionsRaw().forEach(section => {
      if (!Array.isArray(section.header_rule_refs) || !section.header_rule_refs.length) return;
      const sectionEl = this.querySelector(`.cpc-section[data-section-id="${section.id}"]`);
      if (sectionEl) this._applyHeaderStyleLive(sectionEl, section);
    });
  }

  // Apply the resolved card-level Frame Style stack (card_frame) to .cpc-card
  // as inline overrides. Additive: when no frame resolves, the card's native
  // border/glow/shadow/background system is left untouched. When a frame does
  // resolve, its box-shadow / border / radius / background take precedence
  // (last-writer-wins, matching EESC's frame model).
  _applyCardFrame() {
    const el = this.querySelector('.cpc-card');
    if (!el) return;
    const fx = (this._config && this._config.card_frame)
      ? this._resolveFrame(this._config.card_frame, null) : null;
    if (!fx) return;   // no frame → leave the card's native styling as-is
    el.style.boxShadow = fx.boxShadow;
    const bv = fx.borderVars;
    if (bv) {
      el.style.borderTop = bv.top; el.style.borderBottom = bv.bottom;
      el.style.borderLeft = bv.left; el.style.borderRight = bv.right;
      el.style.borderRadius = bv.radius;
    }
    if (fx.background != null) {
      el.style.backgroundColor = fx.background === 'theme' ? '' : fx.background;
    }
    if (fx.edge) {
      el.style.backgroundImage = fx.edge.image;
      el.style.backgroundSize = fx.edge.size;
      el.style.backgroundPosition = fx.edge.position;
      el.style.backgroundRepeat = fx.edge.repeat;
    }
  }

  // Apply each section's resolved Frame Style stack (section.frame) to its
  // .cpc-section box as inline overrides. Mirrors _applyCardFrame + EESC's
  // updateGlow: a stack that resolves to nothing leaves the section unframed;
  // when it resolves it drives border / glow / shadow / background / edges and
  // adds padding so the border/glow doesn't hug the content. Conditional frames
  // re-evaluate here on state change (called after render and from updateStates).
  _applySectionFrames() {
    ((this._config && this._config.sections) || []).forEach(section => {
      if (!section || !section.id) return;
      const el = this.querySelector(`.cpc-section[data-section-id="${section.id}"]`);
      if (!el) return;
      const fx = section.frame ? this._resolveFrame(section.frame, section) : null;
      if (fx) {
        el.style.overflow = 'visible';
        el.style.boxSizing = 'border-box';
        el.style.padding = '10px 12px';
        el.style.boxShadow = fx.boxShadow;
        const bv = fx.borderVars;
        el.style.borderTop = bv ? bv.top : '';
        el.style.borderBottom = bv ? bv.bottom : '';
        el.style.borderLeft = bv ? bv.left : '';
        el.style.borderRight = bv ? bv.right : '';
        el.style.borderRadius = bv ? bv.radius : '';
        el.style.backgroundColor = fx.background === 'theme' ? '' : (fx.background != null ? fx.background : '');
        if (fx.edge) {
          el.style.backgroundImage = fx.edge.image;
          el.style.backgroundSize = fx.edge.size;
          el.style.backgroundPosition = fx.edge.position;
          el.style.backgroundRepeat = fx.edge.repeat;
        } else {
          el.style.backgroundImage = '';
        }
      } else {
        // No frame → clear any inline overrides a prior apply may have set.
        el.style.padding = '';
        el.style.boxShadow = '';
        el.style.borderTop = el.style.borderBottom = el.style.borderLeft = el.style.borderRight = '';
        el.style.borderRadius = '';
        el.style.backgroundColor = '';
        el.style.backgroundImage = '';
      }
    });
  }

  // The gradient runs warm-to-cool left-to-right, and low Kelvin = warm while high
  // Kelvin = cool, so pct=0 (left) maps directly to min_kelvin (warm) and pct=100
  // (right) to max_kelvin (cool) — a direct proportional mapping (unlike the old
  // mired scale, which was inverse).
  _kelvinToPct(kelvin, cfg) {
    const min = Number(cfg.min_kelvin) || 2000, max = Number(cfg.max_kelvin) || 6500;
    return clamp(((kelvin - min) / (max - min)) * 100, 0, 100);
  }
  _pctToKelvin(pct, cfg) {
    const min = Number(cfg.min_kelvin) || 2000, max = Number(cfg.max_kelvin) || 6500;
    return Math.round(min + (pct / 100) * (max - min));
  }
  _rgbToPct(rgb) { return (ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2])[0] / 360) * 100; }

  // Whether a preset's target matches the light's current live state, used to
  // decide "when_active" button glow. Off presets match when the light is off;
  // color/temp presets match when the corresponding attribute equals the preset's.
  // Thin wrappers over the shared module renderer (see renderPresetButtonHtml et al.), passing the
  // card's temperature_output_format. The editor preview calls the module functions directly.
  _isPresetActive(preset, state) { return isPresetActiveFor(preset, state, this._config && this._config.temperature_output_format, this._lastPressedPresetId, presetSelectsActive(preset, this._hass)); }

  _presetBorderAndGlowCss(preset, state, bstyle, btnColorOverride) {
    return presetBorderAndGlowCssFor(preset, state, bstyle || this._config, this._config && this._config.temperature_output_format, btnColorOverride, this._lastPressedPresetId, presetSelectsActive(preset, this._hass));
  }

  _renderPresetButton(preset, bstyle, stateOverride) {
    // `bstyle` is the section's effective button style (Card Default = this._config). The look
    // resolves through any referenced library profile; name/icon/id stay button-owned. `stateOverride`
    // (optional) lets the editor preview supply a fake light state so it renders through this exact
    // path. Delegates to the shared module renderer so card + preview never drift.
    const cfg = bstyle || this._config;
    const look = this._effectivePreset(preset);
    const state = stateOverride !== undefined ? stateOverride : this._presetPrimaryState(preset);
    // Scene buttons (and any button set to follow glow_entities) resolve an independent
    // { bodyColor, glowColor } pair: body follows the live color only when ACTIVE (else its fixed
    // Style Color / neutral); glow follows its own fixed Glow Color or the live color. Other button
    // kinds keep the look/style-color path (appearance undefined).
    const followsColor = buttonMode(preset) === 'scene' || (Array.isArray(preset.glow_entities) && preset.glow_entities.length > 0);
    const appearance = followsColor ? this._presetAppearance(preset, state) : undefined;
    return renderPresetButtonHtml(look, preset, cfg, state, this._config && this._config.temperature_output_format, this._lastPressedPresetId, presetSelectsActive(preset, this._hass), appearance);
  }

  // Maps a left/center/right position choice to a justify-content rule, for
  // either the label or value text within its slider (independent of the
  // slider's own horizontal/vertical orientation).
  _textPositionCss(position) {
    if (position === 'center') return 'justify-content:center;';
    if (position === 'right') return 'justify-content:flex-end;';
    return 'justify-content:flex-start;';
  }

  // Builds the slider bar itself (track, handle, and — for "inside" placement —
  // the label/value overlaid directly on the bar).
  _renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, includeText, sliderId, vertical) {
    const trackStyle = gradientCss ? ` style="background:${gradientCss};"` : '';
    // `vertical` is resolved per-section by the caller (_renderSlider).
    // Vertical sliders fill bottom-to-top, so 0% sits at the bottom edge.
    const handleStyle = vertical ? `bottom:${pct}%;` : `left:${pct}%;`;
    return `
      <div class="cpc-bar-slider cpc-${type}" id="${sliderId}" data-type="${type}" data-pct="${pct}">
        <div class="cpc-bar-track"${trackStyle}></div>
        ${includeText && showLabel ? `<div class="cpc-bar-label" style="${labelPos}">${label}</div>` : ''}
        ${includeText && showValue ? `<div class="cpc-bar-value" style="${valuePos}">${value}</div>` : ''}
        <div class="cpc-bar-handle" style="${handleStyle}"></div>
      </div>
    `;
  }

  // A standalone text row (used for above/below/outside placement, where the
  // label/value sit off the bar rather than overlaid on it).
  _renderTextRow(label, value, showLabel, showValue, labelPos, valuePos) {
    return `
      <div class="cpc-text-row">
        ${showLabel ? `<div class="cpc-bar-label" style="${labelPos}">${label}</div>` : ''}
        ${showValue ? `<div class="cpc-bar-value" style="${valuePos}">${value}</div>` : ''}
      </div>
    `;
  }

  // Temperature slider/readout text. Optionally appends the mired equivalent in smaller
  // text (e.g. "2000K / 500m") when temperature_show_mired is on — display only.
  _tempReadout(kelvin) {
    const k = Math.round(kelvin);
    if (this._config.temperature_show_mired) {
      return `${k}K <span class="cpc-mired">/ ${ColorUtils.kelvinToMired(k)}m</span>`;
    }
    return `${k}K`;
  }

  _renderSlider(type, pct, extra, gradientCss, sectionId) {
    const cfg = this._config;
    // Per-section unique DOM id so multiple slider sections don't collide.
    const sliderId = sectionId ? `cpc-slider-${sectionId}-${type}` : `cpc-slider-${type}`;
    let label, value;
    if (type === 'brightness') { label = 'Brightness'; value = `${Math.round(pct)}%`; }
    else if (type === 'temperature') { label = 'Temperature'; value = this._tempReadout(extra); }
    else { label = 'RGB'; value = `rgb(${extra[0]}, ${extra[1]}, ${extra[2]})`; }
    const showLabel = cfg[`${type}_show_label`] !== false;
    const showValue = cfg[`${type}_show_value`] !== false;
    const labelPos = this._textPositionCss(cfg[`${type}_label_position`] || 'left');
    const valuePos = this._textPositionCss(cfg[`${type}_value_position`] || 'right');
    const style = this._sliderStyle(sectionId);
    const vertical = style.slider_orientation === 'vertical';
    const placement = vertical ? (style.slider_text_placement_vertical || 'inside') : (style.slider_text_placement_horizontal || 'inside');

    if (vertical) {
      // "inside": label/value overlaid on the bar (top/bottom of the bar itself).
      // "outside": label sits in its own row above the bar, value in a row below.
      if (placement === 'outside') {
        return `
          <div class="cpc-slider-row">
            ${this._renderTextRow(label, '', showLabel, false, labelPos, valuePos)}
            ${this._renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, false, sliderId, vertical)}
            ${this._renderTextRow('', value, false, showValue, labelPos, valuePos)}
          </div>
        `;
      }
      return `<div class="cpc-slider-row">${this._renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, true, sliderId, vertical)}</div>`;
    }

    // Horizontal: "inside" overlays the bar; "above"/"below" render a single text
    // row (label + value together) on that side of the bar instead.
    const bar = this._renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, placement === 'inside', sliderId, vertical);
    const textRow = placement !== 'inside' ? this._renderTextRow(label, value, showLabel, showValue, labelPos, valuePos) : '';
    return `
      <div class="cpc-slider-row">
        ${placement === 'above' ? textRow : ''}
        ${bar}
        ${placement === 'below' ? textRow : ''}
      </div>
    `;
  }

  _renderFavoritesBar() {
    const el = this.querySelector('#cpc-favorites');
    if (!el) return;
    const chips = this._favorites.map(f => `
      <div class="cpc-fav-chip" data-fav-id="${escapeHtml(f.id)}" title="${escapeHtml(f.name)}">
        <span class="cpc-fav-swatch" style="background:${this._favoriteSwatch(f.value)};"></span>
        <span>${escapeHtml(f.name)}</span>
        <span class="cpc-fav-remove" data-fav-id="${escapeHtml(f.id)}">×</span>
      </div>
    `).join('');
    el.innerHTML = chips + `<button class="cpc-fav-save-btn" id="cpc-save-favorite"><ha-icon icon="mdi:star-plus-outline"></ha-icon><span>Save Current</span></button>`;
    el.querySelectorAll('.cpc-fav-chip').forEach(chip => {
      chip.onclick = (e) => { if (e.target.classList.contains('cpc-fav-remove')) return; const fav = this._favorites.find(f => f.id === chip.dataset.favId); if (fav) this._applyFavorite(fav); };
    });
    el.querySelectorAll('.cpc-fav-remove').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); if (window.confirm('Delete this favorite color?')) favoritesService.deleteFavorite(btn.dataset.favId); };
    });
    const saveBtn = el.querySelector('#cpc-save-favorite');
    if (saveBtn) saveBtn.onclick = () => this._promptSaveFavorite();
  }

  _favoriteSwatch(value) {
    if (!value) return '#888';
    if (value.rgb_color) return ColorUtils.rgbToHex(...value.rgb_color);
    if (value.color_kelvin) return ColorUtils.rgbToHex(...ColorUtils.kelvinToRgb(value.color_kelvin));
    return '#888';
  }
  _applyFavorite(fav) {
    const data = {};
    if (fav.value.rgb_color) data.rgb_color = fav.value.rgb_color;
    else if (fav.value.color_kelvin !== undefined) data.color_temp_kelvin = fav.value.color_kelvin;
    if (fav.value.brightness !== undefined) data.brightness = fav.value.brightness;
    this._callLightService('turn_on', data);
  }
  _promptSaveFavorite() {
    const state = this._primaryState();
    const attrs = (state && state.attributes) || {};
    const name = window.prompt('Name this favorite color:', '');
    if (!name || !name.trim()) return;
    const value = {};
    if (attrs.rgb_color) value.rgb_color = attrs.rgb_color;
    else { const kelvin = attrsToKelvin(attrs); if (kelvin !== undefined) value.color_kelvin = kelvin; }
    if (attrs.brightness !== undefined) value.brightness = attrs.brightness;
    favoritesService.addFavorite(name.trim(), value);
  }

  _wireEvents() {
    // Collapsible header: clicking the title bar toggles the card body.
    if (this._config.card_collapsible && this._config.title) {
      const header = this.querySelector('#cpc-header');
      const body = this.querySelector('#cpc-body');
      const chevron = this.querySelector('.cpc-chevron');
      if (header) {
        header.onclick = () => {
          this._cardCollapsed = !this._cardCollapsed;
          if (body) body.classList.toggle('collapsed', this._cardCollapsed);
          header.classList.toggle('collapsed-state', this._cardCollapsed);
          if (chevron) chevron.classList.toggle('expanded', !this._cardCollapsed);
        };
      }
    }

    // Per-section collapse: clicking a collapsible section's title row toggles
    // its body (tracked in this._collapsedSections so it persists across
    // re-renders without touching config).
    this.querySelectorAll('.cpc-section-head[data-section-head]').forEach(head => {
      head.onclick = () => {
        const sid = head.dataset.sectionHead;
        this._collapsedSections = this._collapsedSections || new Set();
        const nowCollapsed = !this._collapsedSections.has(sid);
        if (nowCollapsed) this._collapsedSections.add(sid); else this._collapsedSections.delete(sid);
        const body = this.querySelector(`.cpc-section-body[data-section-body="${sid}"]`);
        if (body) body.classList.toggle('collapsed', nowCollapsed);
        head.classList.toggle('collapsed-state', nowCollapsed);
        const chev = head.querySelector('.cpc-section-chevron');
        if (chev) chev.classList.toggle('expanded', !nowCollapsed);
      };
    });

    this.querySelectorAll('.cpc-preset-btn').forEach(btn => {
      btn.onclick = () => {
        const preset = (this._config.presets || []).find(p => p.id === btn.dataset.presetId);
        // Remember the last-pressed preset id so glow/header "active" color mode can follow the
        // color the card most recently applied (pure intent — independent of live light state).
        if (preset) this._lastPressedPresetId = preset.id;
        this._applyPreset(preset);
        // Refresh glow/header immediately so "active" reflects this press. Always call updateStates
        // so a scene (mode 'none') button — whose "active" is purely last-pressed — repaints its
        // glow right away (not just when card/icon 'active' color mode is on).
        this.updateStates();
      };
    });

    const debounceMs = clamp(Number(this._config.slider_debounce_ms) || 100, 0, 1000);

    // Wire every slider in every slider section, each acting on its OWN section target.
    this._orderedSections().filter(s => s.type === 'sliders').forEach(section => {
      const ids = () => this._sectionTargetIds(section);
      const sid = `#cpc-slider-${section.id}`;
      // Per-section orientation drives drag math + handle positioning.
      const vertical = this._sliderStyle(section.id).slider_orientation === 'vertical';

      // onCommit receives the raw pct (rAF-decoupled from onVisual); each converts pct→value.
      const commitBrightness = throttle((pct) => this._setBrightness(pct, ids()), debounceMs);
      this._wireSlider(`${sid}-brightness`, {
        onVisual: (pct) => this._updateSliderVisual(`${sid}-brightness`, pct, `${Math.round(pct)}%`, false, vertical),
        onCommit: commitBrightness,
        onFinal: (pct) => { commitBrightness.cancel(); this._setBrightness(pct, ids()); },
        vertical,
      });

      const commitTemp = throttle((pct) => this._setColorTemp(this._pctToKelvin(pct, this._config), ids()), debounceMs);
      this._wireSlider(`${sid}-temperature`, {
        onVisual: (pct) => {
          const kelvin = this._pctToKelvin(pct, this._config);
          this._updateSliderVisual(`${sid}-temperature`, pct, this._tempReadout(kelvin), true, vertical);
        },
        onCommit: commitTemp,
        onFinal: (pct) => { commitTemp.cancel(); this._setColorTemp(this._pctToKelvin(pct, this._config), ids()); },
        vertical,
      });

      const commitRgb = throttle((pct) => { const hue = Math.round((pct / 100) * 360); this._setRgb(ColorUtils.hsToRgb(hue, 100), ids()); }, debounceMs);
      this._wireSlider(`${sid}-rgb`, {
        onVisual: (pct) => {
          const hue = Math.round((pct / 100) * 360); const rgb = ColorUtils.hsToRgb(hue, 100);
          this._updateSliderVisual(`${sid}-rgb`, pct, `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, false, vertical);
        },
        onCommit: commitRgb,
        onFinal: (pct) => {
          commitRgb.cancel();
          const hue = Math.round((pct / 100) * 360);
          this._setRgb(ColorUtils.hsToRgb(hue, 100), ids());
        },
        vertical,
      });
    });
  }

  // Splits visual feedback (instant, every move) from the actual service call
  // (throttled during drag, plus one guaranteed final call on release) so dragging
  // feels smooth and doesn't flood Home Assistant with requests.
  _wireSlider(selector, { onVisual, onCommit, onFinal, vertical }) {
    const el = this.querySelector(selector);
    if (!el) return;
    let dragging = false;
    let lastPct = 0;
    // Orientation is resolved per-section by the caller; fall back to card global.
    if (vertical === undefined) vertical = this._config.slider_orientation === 'vertical';
    const compute = (clientX, clientY) => {
      const rect = el.getBoundingClientRect();
      if (vertical) {
        // Vertical sliders fill bottom-to-top, so pct grows as the pointer moves up.
        return clamp(((rect.bottom - clientY) / rect.height) * 100, 0, 100);
      }
      return clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
    };
    // Visual updates are coalesced to one per animation frame — mousemove can fire many
    // times per frame, and doing a DOM write on each caused the jumpy/laggy feel. We store
    // the latest pct and repaint once per rAF; the throttled service commit still runs on
    // every move (its own rate-limit handles HA traffic).
    let rafId = null;
    let pendingPct = null;
    const flush = () => {
      rafId = null;
      if (pendingPct === null) return;
      const p = pendingPct; pendingPct = null;
      onVisual(p);
    };
    const onMove = (e) => {
      if (!dragging) return;
      const point = e.touches ? e.touches[0] : e;
      const pct = compute(point.clientX, point.clientY);
      lastPct = pct;
      pendingPct = pct;
      if (rafId === null) rafId = requestAnimationFrame(flush);
      onCommit(pct);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      el._dragging = false;
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingPct = null;
      onVisual(lastPct); // ensure the final position is painted
      // After release, "settle" the slider on the value we just sent: updateStates ignores
      // incoming HA states that don't yet match this pct (stale/echo/in-transition values
      // that would otherwise bounce the handle back), until HA confirms or the window ends.
      el._settlePct = lastPct;
      el._settleUntil = Date.now() + 3000;
      onFinal(lastPct);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    el.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; el._dragging = true; onMove(e); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); });
    el.addEventListener('touchstart', (e) => { dragging = true; el._dragging = true; onMove(e); window.addEventListener('touchmove', onMove, {passive:true}); window.addEventListener('touchend', onUp); }, {passive:true});
  }

  // True when a slider is "settling" after release and the incoming HA pct doesn't yet match
  // the value we sent — so we skip repainting it (prevents the post-release bounce from stale
  // or in-transition state). Clears the guard once HA confirms (within tolerance) or the
  // window expires. `el` is the slider element; `incomingPct` is the value HA just reported.
  _sliderSettling(el, incomingPct) {
    if (!el || el._settleUntil === undefined) return false;
    if (Date.now() > el._settleUntil) { el._settleUntil = undefined; el._settlePct = undefined; return false; }
    if (Math.abs(incomingPct - (el._settlePct || 0)) <= 2) { el._settleUntil = undefined; el._settlePct = undefined; return false; }
    return true; // still waiting for HA to catch up — ignore this repaint
  }

  // isHtml: the temperature readout contains a <span> (mired), so it needs innerHTML; every
  // other readout is plain text and uses the far cheaper textContent (no HTML reparse).
  _updateSliderVisual(selector, pct, valueText, isHtml, vertical) {
    const el = this.querySelector(selector);
    if (!el) return;
    const handle = el.querySelector('.cpc-bar-handle');
    const val = el.querySelector('.cpc-bar-value');
    if (vertical === undefined) vertical = this._config.slider_orientation === 'vertical';
    if (handle) {
      if (vertical) { handle.style.bottom = `${pct}%`; handle.style.left = ''; }
      else { handle.style.left = `${pct}%`; handle.style.bottom = ''; }
    }
    if (val && valueText !== undefined) {
      if (isHtml) val.innerHTML = valueText; else val.textContent = valueText;
    }
  }

  // Read-only readout of the light's current color values (XY / HS / RGB / Kelvin), for
  // reading a color you've dialed in so you can save the numbers into a preset. Values are
  // taken from the live state where available and derived otherwise, so all four always show.
  _currentValuesHtml(state) {
    if (!state) {
      return `<div class="cpc-cv-item" style="grid-column:1/-1;">No light selected.</div>`;
    }
    const attrs = state.attributes || {};
    const on = state.state === 'on';
    let rgb = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
      : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
    const kelvin = attrsToKelvin(attrs);
    if (!rgb && kelvin !== undefined) rgb = ColorUtils.kelvinToRgb(kelvin);
    if (!rgb) rgb = [255, 255, 255];
    const xy = Array.isArray(attrs.xy_color) ? attrs.xy_color : ColorUtils.rgbToXy(rgb[0], rgb[1], rgb[2]);
    const hs = Array.isArray(attrs.hs_color) ? attrs.hs_color : ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]);
    const swatch = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
    const kText = kelvin !== undefined
      ? (this._config.temperature_show_mired ? `${kelvin}K / ${ColorUtils.kelvinToMired(kelvin)}m` : `${kelvin} K`)
      : '—';
    const item = (label, value) => `<div class="cpc-cv-item"><span class="cpc-cv-label">${label}</span><span class="cpc-cv-value">${value}</span></div>`;
    const items = [
      `<div class="cpc-cv-item"><span class="cpc-cv-swatch" style="background:${swatch};"></span><span class="cpc-cv-label">RGB</span><span class="cpc-cv-value">${rgb[0]}, ${rgb[1]}, ${rgb[2]}</span></div>`,
      item('Kelvin', kText),
      item('HS', `${hs[0]}°, ${hs[1]}%`),
      item('XY', `${xy[0]}, ${xy[1]}`),
    ];
    // Show the dedicated white channels when the light SUPPORTS them (not only when it's
    // currently reporting them — a light in another color mode won't report its white
    // channels). Use the live value if present, otherwise show 0 / "—".
    const modes = getSupportedColorModes(this._hass, this._entityIds()[0]);
    if (modes.includes('rgbw')) {
      const w = Array.isArray(attrs.rgbw_color) ? attrs.rgbw_color[3] : '—';
      items.push(item('W', `${w}`));
    }
    if (modes.includes('rgbww')) {
      const cw = Array.isArray(attrs.rgbww_color) ? attrs.rgbww_color[3] : '—';
      const ww = Array.isArray(attrs.rgbww_color) ? attrs.rgbww_color[4] : '—';
      items.push(item('CW', `${cw}`));
      items.push(item('WW', `${ww}`));
    }
    return `${items.join('')}${!on ? `<div class="cpc-cv-item" style="grid-column:1/-1;opacity:0.7;">(light is off — showing last/derived values)</div>` : ''}`;
  }

  // The ordered list of section objects to render. section_order holds section ids; any
  // section missing from the order is appended so nothing silently disappears.
  _orderedSections() {
    const sections = buildSections(this._config);
    const byId = new Map(sections.map(s => [s.id, s]));
    const order = Array.isArray(this._config.section_order) ? this._config.section_order : [];
    const ordered = order.map(id => byId.get(id)).filter(Boolean);
    sections.forEach(s => { if (!order.includes(s.id)) ordered.push(s); });
    return ordered.filter(s => !s.hidden);   // hidden sections don't render on the card
  }

  // Optional per-section name heading, with configurable size/weight/color.
  // When section.collapsible, the heading becomes a clickable title row with a
  // chevron that toggles this section's body (mirrors the card-level collapse).
  _sectionHeading(section) {
    if (!section.name_show || !section.name) return '';
    const size = Number(section.name_font_size) || 13;
    const weight = section.name_font_weight || '600';
    const color = section.name_color || 'var(--primary-text-color)';
    const scale = Number(this._config.scale) || 1.0;
    const style = `font-size:calc(${size}px * ${scale});font-weight:${weight};color:${color};`;
    if (section.collapsible) {
      const collapsed = this._isSectionCollapsed(section);
      return `<div class="cpc-section-name cpc-section-head${collapsed ? ' collapsed-state' : ''}" data-section-head="${section.id}" style="${style}">`
        + `<span class="cpc-section-head-text">${escapeHtml(section.name)}</span>`
        + `<ha-icon class="cpc-section-chevron${collapsed ? '' : ' expanded'}" icon="mdi:chevron-down"></ha-icon>`
        + `</div>`;
    }
    return `<div class="cpc-section-name" style="${style}">${escapeHtml(section.name)}</div>`;
  }

  // Per-section collapsed state. Defaults from section.collapsed_default the
  // first time; thereafter tracked live in this._collapsedSections (a Set of
  // section ids) so toggles persist across re-renders without touching config.
  _isSectionCollapsed(section) {
    if (!section.collapsible) return false;
    this._collapsedSections = this._collapsedSections || new Set();
    if (!this._collapsedSeeded) this._collapsedSeeded = new Set();
    if (!this._collapsedSeeded.has(section.id)) {
      this._collapsedSeeded.add(section.id);
      if (section.collapsed_default) this._collapsedSections.add(section.id);
    }
    return this._collapsedSections.has(section.id);
  }

  // The effective button-appearance settings for a buttons section. Resolution order:
  //   1. the section's referenced stack (style_preset: 'lib:<slug>' — a preset or built-in)
  //   2. else Basic Theme (the neutral built-in floor — never nothing)
  // The chosen stack's ACTIVE layers are flattened (last-writer-wins) over the card defaults, so
  // a sparse stack still fills in. Conditions are evaluated per the section's context.
  // The raw button-style STACK for a section: its explicit per-section preset (built-in or stored),
  // else Basic Theme. Every section names a concrete style now — there is no system-default pointer;
  // an unset/missing ref simply resolves to Basic Theme (the safe neutral built-in).
  _sectionButtonStack(section) {
    const slug = fixtureRefSlug(section && section.style_preset);   // 'lib:<slug>' → slug
    return (slug && buttonStyleStack(slug)) ? buttonStyleStack(slug) : builtinButtonStack(BTN_STYLE_BASIC_SLUG);
  }
  // Section-level effective style: layout/metrics + all SECTION-scoped conditional layers applied.
  // Per-button conditions (button_active) evaluate false here — they resolve per button in
  // _buttonStyleForPreset at render time. Used for the section's scoped CSS + layout class.
  _sectionButtonStyle(section) {
    const cfg = this._config;
    const stack = this._sectionButtonStack(section);
    if (!stack) return cfg;
    const isActive = (when) => this._buttonConditionActive(when, section);
    return { ...cfg, ...extractButtonAppearance(flattenButtonStack(stack, isActive)) };
  }
  // Per-BUTTON effective style: re-flattens the section's stack for one preset so a `button_active`
  // overlay applies only to the button whose scene is currently live on its target. Section-scoped
  // conditions (light_on/off, entity_state) delegate to _buttonConditionActive; button_active is
  // resolved via _isPresetActive against THIS preset's own target state.
  _buttonStyleForPreset(stack, section, preset) {
    if (!stack) return this._config;
    const isActive = (when) => {
      if (when && when.type === 'button_active') {
        // Selects-bound buttons use the deterministic all-match signal; others fall back to the
        // color/state/last-pressed logic inside _isPresetActive.
        const sa = presetSelectsActive(preset, this._hass);
        if (sa !== null) return sa;
        return this._isPresetActive(this._effectivePreset(preset), this._presetPrimaryState(preset));
      }
      // "Button Off": this specific button is a turn-off (Light Off) button — applies to it
      // regardless of light state, so its Off look can be styled independently per button.
      if (when && when.type === 'button_off') {
        return this._effectivePreset(preset).action === 'turn_off';
      }
      // Light-state conditions on a FOLLOW-COLOR button (scene, or one with glow_entities) follow
      // THIS button's own glow-source light — so a light_on-gated glow layer doesn't collapse when a
      // scene turns the SECTION's representative light off while the scene's own lights are on (the
      // Dinner-glow-dies bug). This is scoped to follow buttons ONLY; every other button kind (Off,
      // color, temp, profile) keeps the section-level evaluation unchanged — otherwise an Off button
      // whose target a scene turns off would wrongly light up (the "Off goes active" regression).
      const followsColor = buttonMode(preset) === 'scene' || (Array.isArray(preset.glow_entities) && preset.glow_entities.length > 0);
      if (followsColor && when && (when.type === 'light_on' || when.type === 'light_off' || when.type === 'light_unavailable')) {
        const st = this._presetPrimaryState(preset);
        if (st) {
          if (when.type === 'light_on') return st.state === 'on';
          if (when.type === 'light_off') return st.state === 'off';
          return st.state === 'unavailable' || st.state === 'unknown';
        }
        // No own light resolved → fall through to the section-level evaluation.
      }
      return this._buttonConditionActive(when, section);
    };
    return { ...this._config, ...extractButtonAppearance(flattenButtonStack(stack, isActive)) };
  }

  // Evaluate a layer condition for a buttons section. No condition (or unknown type) = always-on.
  // Types:
  //   light_on / light_off / light_unavailable — the section's representative light's state
  //   entity_state — a chosen entity's state equals `state` (or an attribute compared via op)
  //   section_has_entities / section_empty — frame-context (buttons treat as always-on)
  _buttonConditionActive(when, section) {
    if (!when || typeof when !== 'object' || !when.type) return true;
    const hass = this._hass;
    switch (when.type) {
      // Per-button conditions: never true at the SECTION level (a section has no single button).
      // Resolved per button in _buttonStyleForPreset; here they mean "base look only".
      case 'button_active': return false;
      case 'button_off': return false;
      case 'light_on': { const st = this._sectionPrimaryState(section); return !!st && st.state === 'on'; }
      case 'light_off': { const st = this._sectionPrimaryState(section); return !!st && st.state === 'off'; }
      case 'light_unavailable': { const st = this._sectionPrimaryState(section); return !st || st.state === 'unavailable' || st.state === 'unknown'; }
      case 'entity_state': {
        if (!when.entity) return true;
        const st = hass && hass.states[when.entity];
        if (!st) return false;
        if (when.attr) {
          const v = (st.attributes || {})[when.attr];
          const target = when.value;
          const op = when.op || '==';
          const nv = Number(v), nt = Number(target);
          if (op === '>') return Number.isFinite(nv) && Number.isFinite(nt) && nv > nt;
          if (op === '<') return Number.isFinite(nv) && Number.isFinite(nt) && nv < nt;
          if (op === '!=') return String(v) !== String(target);
          return String(v) === String(target);
        }
        return String(st.state) === String(when.state != null ? when.state : 'on');
      }
      // Frame-only conditions — meaningless for buttons; treat as always-on so a shared stack
      // authored for frames doesn't blank out button sections.
      case 'section_has_entities':
      case 'section_empty':
        return true;
      default: return true;
    }
  }

  // Per-section scoped CSS that overrides the global button metrics for a section using a
  // non-default Button Style preset. Returns '' when the section uses Card Default (the global
  // <style> already covers it). Mirrors the metric formulas in the global .cpc-preset-btn block,
  // scoped to `.cpc-section[data-section-id="<id>"]`.
  _sectionButtonStyleCss(section, bstyle) {
    // Card Default (no preset ref, or missing) → nothing to override.
    if (!fixtureRefSlug(section && section.style_preset) || bstyle === this._config) return '';
    const s = bstyle;
    const scale = Number(this._config.scale) || 1.0;
    const sel = `.cpc-section[data-section-id="${section.id}"]`;
    const bh = Number(s.button_height) || 44;
    const bfs = Number(s.button_font_size) || 14;
    const bnw = s.button_name_weight || '600';
    const bgap = Number(s.gap) || 8;
    const bIconGap = Number.isFinite(Number(s.button_icon_gap)) ? Number(s.button_icon_gap) : 8;
    const bMaxW = Number(s.button_max_width) || 0;
    const radius = Number(s.button_border_radius);
    const radiusCss = Number.isFinite(radius) ? `border-radius:${radius}px;` : '';
    const wrap = s.button_name_wrap;
    return `<style>
      ${sel} .cpc-presets { gap:${bgap}px; }
      ${sel} .cpc-presets.layout-columns { flex-wrap:${s.wrap ? 'wrap' : 'nowrap'}; }
      ${sel} .cpc-presets.layout-grid { grid-template-columns:repeat(${Number(s.columns)||3},minmax(0,1fr)); gap:${bgap}px; }
      ${sel} .cpc-preset-btn { padding:calc(${bh}px * ${scale} / 3.15) calc(18px * ${scale}); font-size:calc(${bfs}px * ${scale}); font-weight:${bnw}; gap:calc(${bIconGap}px * ${scale}); ${radiusCss}${bMaxW ? `max-width:calc(${bMaxW}px * ${scale});` : ''} }
      ${sel} .cpc-preset-btn .cpc-btn-label { font-weight:${bnw}; ${wrap ? 'white-space:normal; overflow-wrap:anywhere; text-align:center;' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'} }
      ${wrap ? `${sel} .cpc-preset-btn { min-height:calc(${bh}px * ${scale}); }` : ''}
      ${(bMaxW && s.layout === 'columns') ? `${sel} .cpc-presets.layout-columns .cpc-preset-btn { flex:1 1 calc(${bMaxW}px * ${scale}); }` : ''}
      ${sel} .cpc-preset-btn.cpc-tile { gap:calc(${bIconGap}px * ${scale}); min-height:calc(${bh}px * ${scale} * 1.6); }
      ${sel} .cpc-preset-btn.cpc-tile .cpc-tile-name { font-size:calc(${bfs}px * ${scale}); }
    </style>`;
  }



  // The visual line for a standalone divider section. Supports:
  //   style: solid | dashed | dotted   line_style: how the line is drawn
  //   justify: left | center | right    where the line sits when length < 100%
  //   gradient: when true, a left→right gradient from `color` to `color2` (full color pickers)
  //   color/thickness/length: fall back to the card defaults when unset
  _dividerLineHtml(section) { return dividerLineHtml(section, this._config); }

  // Wrap a section's inner body so a collapsible section can hide/show it. When
  // the section isn't collapsible this is a passthrough (no extra wrapper), so
  // non-collapsible sections render exactly as before.
  _wrapSectionBody(section, bodyHtml) {
    if (!section.collapsible) return bodyHtml;
    const collapsed = this._isSectionCollapsed(section);
    return `<div class="cpc-section-body${collapsed ? ' collapsed' : ''}" data-section-body="${section.id}">${bodyHtml}</div>`;
  }

  // Renders one section object. Slider/values sections read their OWN target's state.
  _renderSection(section, ctx) {
    const cfg = this._config;
    const heading = this._sectionHeading(section);
    if (section.type === 'divider') {
      return `<div class="cpc-section" data-section-id="${section.id}">${this._dividerLineHtml(section)}</div>`;
    }
    if (section.type === 'buttons') {
      // Resolve this section's effective button style (Card Default, or a system preset).
      const bstyle = this._sectionButtonStyle(section);
      const layoutClass = `layout-${bstyle.layout || 'columns'}`;
      const div = '';   // legacy auto-dividers removed — dividers are their own sections now
      // Per-section style overrides (scoped CSS) — empty when the section uses Card Default.
      const overrideCss = this._sectionButtonStyleCss(section, bstyle);
      // Each button re-flattens the stack for ITSELF so a `button_active` overlay applies only to
      // the button whose scene is live (section-scoped conditions still resolve the same for all).
      const stack = this._sectionButtonStack(section);
      const presetsHtml = this._presetsForSection(section.id).filter(p => !p.hidden)
        .map(p => this._renderPresetButton(p, this._buttonStyleForPreset(stack, section, p))).join('');
      const body = this._wrapSectionBody(section, `<div class="cpc-presets ${layoutClass}">${presetsHtml}</div>`);
      return `${overrideCss}<div class="cpc-section${div}" data-section-id="${section.id}">${heading}${body}</div>`;
    }
    if (section.type === 'sliders') {
      const div = '';   // legacy auto-dividers removed
      const sel = section.sliders || { brightness: true, temperature: true, rgb: true };
      // This section's own target state drives its slider positions.
      const st = this._sectionPrimaryState(section);
      const attrs = (st && st.attributes) || {};
      const briPct = attrs.brightness ? Math.round((attrs.brightness / 255) * 100) : 0;
      const kelvin = attrsToKelvin(attrs) || Math.round(((Number(cfg.min_kelvin)||2000) + (Number(cfg.max_kelvin)||6500)) / 2);
      const rgb = attrs.rgb_color || [255, 255, 255];
      // Slider STYLE is card-global now (set in the "Sliders" top-level panel) — like
      // Buttons, the section only controls WHICH sliders show + its target lights. No
      // per-section style override; the global renderCard style block drives shape/
      // orientation/handle for all slider sections.
      const body = this._wrapSectionBody(section, `<div class="cpc-sliders">
        ${sel.brightness ? this._renderSlider('brightness', briPct, null, this._brightnessGradientCss(rgb, section.id), section.id) : ''}
        ${sel.temperature ? this._renderSlider('temperature', this._kelvinToPct(kelvin, cfg), kelvin, null, section.id) : ''}
        ${sel.rgb ? this._renderSlider('rgb', this._rgbToPct(rgb), rgb, null, section.id) : ''}
      </div>`);
      return `<div class="cpc-section${div}" data-section-id="${section.id}">${heading}${body}</div>`;
    }
    if (section.type === 'values') {
      // A values section renders by virtue of existing (its presence is the enable). It reads
      // its own target's state and uses a per-section DOM id so multiple can coexist.
      const div = '';   // legacy auto-dividers removed
      const st = this._sectionPrimaryState(section);
      const body = this._wrapSectionBody(section, this._currentValuesBlock(st, section.id));
      return `<div class="cpc-section${div}" data-section-id="${section.id}">${heading}${body}</div>`;
    }
    if (section.type === 'scene_tracker') {
      const body = this._wrapSectionBody(section, this._renderSceneTracker(section));
      return `<div class="cpc-section" data-section-id="${section.id}">${heading}${body}</div>`;
    }
    return '';
  }

  // Scene Tracker: a read-only status board — one tile per Area. Each Area names an input_select
  // (its scene state) and optionally a representative light (for a live color/brightness readout).
  // Tiles reflect the current option + a status color; they never write state (v1 read-only).
  _renderSceneTracker(section) {
    const areas = Array.isArray(section.areas) ? section.areas : [];
    if (!areas.length) return `<div class="cpc-scene-tracker-empty">No areas configured. Add areas in the section settings.</div>`;
    // Optional Button Style binding: when the section names a style_preset, tiles render as styled
    // buttons (that style's border/glow/gradient/background), reusing the exact button renderer so
    // the tracker matches the buttons. Otherwise tiles use the default chip layout.
    const styleSlug = fixtureRefSlug(section.style_preset);
    const styled = styleSlug ? (buttonStyleStack(styleSlug) || null) : null;
    if (styled) {
      // Render EXACTLY like a buttons section: same `.cpc-presets` flex container + layout class +
      // scoped style CSS, and NO `.cpc-scene-tracker` grid (which would override the button layout).
      const bstyle = this._sectionButtonStyle(section);
      const overrideCss = this._sectionButtonStyleCss(section, bstyle);
      const layoutClass = `layout-${bstyle.layout || 'columns'}`;
      return `${overrideCss}<div class="cpc-presets ${layoutClass}">${areas.map(a => this._renderAreaTileStyled(a, section, styled)).join('')}</div>`;
    }
    return `<div class="cpc-scene-tracker">${areas.map(a => this._renderAreaTile(a)).join('')}</div>`;
  }
  // Find the Scene button whose Scene Select binding matches this (entity, option) — i.e. the button
  // that PUTS the group in this state. The Scene Tracker borrows that button's own color + icon so a
  // tile looks exactly like the button that produced its current scene. Returns the preset or null.
  _buttonForOption(entity, option) {
    if (!entity || !option) return null;
    return (this._config.presets || []).find(p => presetSelects(p).some(b => b.entity === entity && b.option === option)) || null;
  }
  // Shared: resolve an Area's live status into { option, unavailable, color, icon, sub, isOff, isActive }.
  // Color priority: MATCHING scene button's own color/icon (so the tile mirrors the button that set
  // this scene) → live light color → option→color map → neutral.
  _resolveAreaStatus(area) {
    const hass = this._hass;
    const selSt = (area && area.entity && hass && hass.states) ? hass.states[area.entity] : null;
    const option = selSt ? String(selSt.state) : '';
    const unavailable = !selSt || option === 'unavailable' || option === 'unknown';
    const lightSt = (area && area.light && hass && hass.states) ? hass.states[area.light] : null;
    // The Scene button that drives this area's current option (if any) — its color/icon lead.
    const srcBtn = this._buttonForOption(area && area.entity, option);
    let color = null;
    if (srcBtn) {
      if (srcBtn.button_style_color && /^#[0-9a-f]{6}$/i.test(srcBtn.button_style_color)) color = srcBtn.button_style_color;
      else { const rgb = presetColorToRgb(this._effectivePreset(srcBtn)); if (rgb && !(srcBtn.look_none || srcBtn.action === 'turn_off')) color = ColorUtils.rgbToHex(...rgb); }
    }
    const optColor = (area && area.option_colors && typeof area.option_colors === 'object') ? area.option_colors[option] : null;
    // Live light color only when the matching button didn't already provide one (button color leads,
    // per the explicit design: the tile mirrors the button that set this scene).
    if (!color && lightSt && lightSt.state === 'on') {
      const attrs = lightSt.attributes || {};
      let rgb = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
        : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
      if (!rgb) { const k = attrsToKelvin(attrs); if (k !== undefined) rgb = ColorUtils.kelvinToRgb(k); }
      if (rgb) color = ColorUtils.rgbToHex(...rgb);
    }
    if (!color && optColor) color = optColor;
    const isOff = !option || /^(-?off-?|none|off)$/i.test(option);
    // Icon: matching button's own icon → per-option map → area icon → generic.
    const btnIcon = srcBtn ? resolvePresetIcon(srcBtn, buttonMode(srcBtn)) : null;
    const iconMap = (area && area.icon_map && typeof area.icon_map === 'object') ? area.icon_map : null;
    const icon = normalizeIcon(btnIcon || (iconMap && iconMap[option]) || (area && area.icon) || 'mdi:palette-outline');
    let sub = '';
    if (lightSt) {
      if (lightSt.state === 'on') { const bri = lightSt.attributes && lightSt.attributes.brightness; sub = bri != null ? `${Math.round((bri / 255) * 100)}%` : 'On'; }
      else if (lightSt.state === 'off') sub = 'Off';
    }
    // "Active" for tracker glow = the area is on a real (non-off, available) scene.
    const isActive = !unavailable && !isOff;
    return { option, unavailable, color, icon, sub, isOff, isActive, lightSt };
  }
  // Default chip tile (no Button Style bound).
  _renderAreaTile(area) {
    const st = this._resolveAreaStatus(area);
    const color = st.color || (st.isOff ? 'var(--secondary-text-color)' : 'var(--primary-color)');
    const name = escapeHtml((area && area.name) || (area && area.entity) || 'Area');
    const optionLabel = st.unavailable ? '—' : escapeHtml(st.option || '—');
    return `<div class="cpc-area-tile${st.unavailable ? ' cpc-area-unavailable' : ''}">
      <span class="cpc-area-dot" style="background:${color};"></span>
      <ha-icon class="cpc-area-icon" icon="${st.icon}" style="color:${color};"></ha-icon>
      <span class="cpc-area-text"><span class="cpc-area-name">${name}</span><span class="cpc-area-option">${optionLabel}${st.sub ? ` · ${escapeHtml(st.sub)}` : ''}</span></span>
    </div>`;
  }
  // Styled tile: renders through the SAME button renderer as real buttons, using the bound Button
  // Style's flattened look. The area's status color becomes the tile's button color; the active-glow
  // (button_active layer / when_active glow) fires when the area is on a real scene (isActive).
  _renderAreaTileStyled(area, section, stack) {
    const st = this._resolveAreaStatus(area);
    // Flatten the style with button_active resolved to THIS tile's active state; other section-scoped
    // conditions evaluate against the section context.
    const isActive = (when) => {
      if (when && when.type === 'button_active') return st.isActive;
      if (when && when.type === 'button_off') return st.isOff;
      return this._buttonConditionActive(when, section);
    };
    const cfg = { ...this._config, ...extractButtonAppearance(flattenButtonStack(stack, isActive)) };
    // Render IDENTICALLY to a button using this style: name is just the Area name (the current scene
    // shows on the sub-line). The tile's color is the one resolved in _resolveAreaStatus — which now
    // LEADS with the matching Scene button's own color, so the tile mirrors that button's look
    // (match-mode glow/border/gradient resolve against the same color the button uses). No color
    // (no matching button, no light) → colorless, exactly as the equivalent button would render.
    const name = (area && area.name) || (area && area.entity) || 'Area';
    const subLabel = st.unavailable ? '—' : (st.option || '');   // current scene shown on a second line
    const colorHex = (st.color && /^#[0-9a-f]{6}$/i.test(st.color)) ? st.color : null;
    const preset = { id: `area-${escapeHtml((area && area.entity) || name)}`, name, _sublabel: subLabel, icon: st.icon, mode: st.isOff ? 'off' : 'scene', look_none: !st.isOff, ...(st.isOff ? { action: 'turn_off' } : {}), ...(colorHex ? { button_style_color: colorHex } : {}) };
    const look = st.isOff ? { action: 'turn_off' } : (colorHex ? { rgb_color: ColorUtils.hexToRgb(colorHex) } : { look_none: true });
    // Pass the Area's representative light state so 'match'-mode glow/border track the live light,
    // exactly as a real button pointed at that light would. selectsActive overrides active-detection
    // for the glow: true when the area is on a real scene.
    return renderPresetButtonHtml(look, preset, cfg, st.lightSt || null, this._config && this._config.temperature_output_format, null, st.isActive);
  }

  // Presets assigned to a section. A preset's section_id names its section; presets with no
  // section_id (or a stale one) fall back to the FIRST buttons section so none are orphaned.
  _presetsForSection(sectionId) {
    const presets = this._config.presets || [];
    const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
    const firstButtonsId = buttonsSections.length ? buttonsSections[0].id : null;
    const validIds = new Set(buttonsSections.map(s => s.id));
    return presets.filter(p => {
      if (p.section_id === '__none__') return false;   // unassigned: never rendered on the card
      const sid = validIds.has(p.section_id) ? p.section_id : firstButtonsId;
      return sid === sectionId;
    });
  }
  // Sections without the append-missing reordering (used internally to avoid recursion).
  _orderedSectionsRaw() { return buildSections(this._config); }

  // The color-value display block for one values section (per-section DOM id). Divider
  // classes live on the wrapping .cpc-section, so they're not repeated here.
  _currentValuesBlock(state, sectionId) {
    const cfg = this._config;
    const justify = { left: 'flex-start', center: 'center', right: 'flex-end' }[cfg.current_values_justify] || 'flex-start';
    const id = sectionId ? `cpc-current-values-${sectionId}` : 'cpc-current-values';
    return `<div class="cpc-current-values" id="${id}" style="justify-items:${justify};">${this._currentValuesHtml(state)}</div>`;
  }

  updateStates() {
    const cfg = this._config;
    // Update each slider section from its OWN target's state.
    this._orderedSections().filter(s => s.type === 'sliders').forEach(section => {
      const st = this._sectionPrimaryState(section);
      if (!st) return;
      const attrs = st.attributes || {};
      const sid = `#cpc-slider-${section.id}`;
      // Per-section style: orientation for handle positioning + end-color mode for the gradient.
      const sStyle = this._sliderStyle(section.id);
      const vertical = sStyle.slider_orientation === 'vertical';

      const brightnessEl = this.querySelector(`${sid}-brightness`);
      if (attrs.brightness !== undefined && brightnessEl && !brightnessEl._dragging) {
        const pct = Math.round((attrs.brightness / 255) * 100);
        if (!this._sliderSettling(brightnessEl, pct)) {
          this._updateSliderVisual(`${sid}-brightness`, pct, `${pct}%`, false, vertical);
          if (sStyle.brightness_end_color_mode === 'current' && attrs.rgb_color) {
            const track = brightnessEl.querySelector('.cpc-bar-track');
            if (track) track.style.background = this._brightnessGradientCss(attrs.rgb_color, section.id);
          }
        }
      }

      const tempEl = this.querySelector(`${sid}-temperature`);
      const kelvin = attrsToKelvin(attrs);
      if (kelvin !== undefined && tempEl && !tempEl._dragging) {
        const pct = this._kelvinToPct(kelvin, cfg);
        if (!this._sliderSettling(tempEl, pct)) this._updateSliderVisual(`${sid}-temperature`, pct, this._tempReadout(kelvin), true, vertical);
      }

      const rgbEl = this.querySelector(`${sid}-rgb`);
      if (attrs.rgb_color && rgbEl && !rgbEl._dragging) {
        const pct = this._rgbToPct(attrs.rgb_color);
        if (!this._sliderSettling(rgbEl, pct)) this._updateSliderVisual(`${sid}-rgb`, pct, `rgb(${attrs.rgb_color[0]}, ${attrs.rgb_color[1]}, ${attrs.rgb_color[2]})`, false, vertical);
      }
    });

    // Update each values section from its own target's state.
    this._orderedSections().filter(s => s.type === 'values').forEach(section => {
      const el = this.querySelector(`#cpc-current-values-${section.id}`);
      if (el) el.innerHTML = this._currentValuesHtml(this._sectionPrimaryState(section));
    });

    // Card-level state (header icon, glow) follows the card's primary entity.
    const state = this._primaryState();
    const attrs = (state && state.attributes) || {};

    // Keep the header title icon color in sync — with the live light state ('light' mode) or the
    // last-pressed color ('active' mode). Recomputed on every state change (and after a press).
    const titleIcon = this.querySelector('#cpc-title-icon');
    if (titleIcon) titleIcon.style.color = this._headerIconColorCss(state);

    // (Native card-glow live-refresh removed — card border/glow/shadow now come
    // solely from the Card Frame; frame conditions re-evaluate on state change.)

    // Refresh button glow live when any effective style could depend on state (when_active or
    // match). Each button resolves its OWN section's style (Card Default or a section preset),
    // so a section preset that enables glow works even if the card default doesn't.
    {
      const byId = new Map((cfg.presets || []).map(p => [p.id, p]));
      // Map each section id → its raw button-style STACK, so per-button re-flatten is cheap. We
      // resolve the PER-BUTTON style here (not the section style) so button_active / button_off
      // overlays are honored — otherwise this fast-path would strip them and revert the glow.
      const stackBySection = new Map();
      const sectionById = new Map();
      this._orderedSectionsRaw().filter(s => s.type === 'buttons').forEach(s => { stackBySection.set(s.id, this._sectionButtonStack(s)); sectionById.set(s.id, s); });
      const btns = this.querySelectorAll('.cpc-preset-btn');
      btns.forEach(btn => {
        const preset = byId.get(btn.dataset.presetId);
        if (!preset) return;
        const sectionEl = btn.closest('.cpc-section');
        const sid = sectionEl && sectionEl.dataset.sectionId;
        const stack = sid ? stackBySection.get(sid) : null;
        const section = sid ? sectionById.get(sid) : null;
        // Per-button effective style (base + button_active/button_off overlays for THIS button).
        const bstyle = stack ? this._buttonStyleForPreset(stack, section, preset) : cfg;
        try {
          const st = this._presetPrimaryState(preset);
          // A "follows color" button (scene, or any button with glow_entities) drives its WHOLE
          // appearance — fill, glow, gradient border, icon accents — from one resolved live color.
          // So a glow-only patch would leave the fill stale; re-render the whole button instead so
          // every effect tracks the new color together (exactly like a single-color button).
          const followsColor = buttonMode(preset) === 'scene' || (Array.isArray(preset.glow_entities) && preset.glow_entities.length > 0);
          if (followsColor) {
            // A follow button's whole appearance (fill + glow + accents) can change with the resolved
            // color. But updateStates() runs on EVERY hass tick, and a followed light re-reports
            // attributes constantly — so replace the node ONLY when its appearance actually changed.
            // We key on a compact signature (body/glow color + active + glowing) rather than full
            // HTML (attribute-order/whitespace differences would make HTML compare unreliable).
            // Rebuilding every tick would destroy the click handler mid-press — the "takes several
            // clicks to activate" bug.
            const app = this._presetAppearance(preset, st);
            const active = isPresetActiveFor(this._effectivePreset(preset), st, this._config && this._config.temperature_output_format, this._lastPressedPresetId, presetSelectsActive(preset, this._hass));
            const sig = `${app.bodyColor}|${app.glowColor}|${active ? 1 : 0}|${bstyle.button_glow_enabled ? 1 : 0}|${bstyle.button_glow_condition || ''}`;
            if (btn.dataset.followSig === sig) return;   // unchanged → leave the node (+ its handler) alone
            const tmp = document.createElement('template');
            tmp.innerHTML = this._renderPresetButton(preset, bstyle).trim();
            const fresh = tmp.content.firstElementChild;
            if (fresh) {
              fresh.dataset.followSig = sig;
              // Re-bind the press handler the freshly-rendered node lacks (listeners are attached
              // per-element in the initial render, not delegated).
              fresh.onclick = () => {
                const p = (this._config.presets || []).find(x => x.id === fresh.dataset.presetId);
                if (p) this._lastPressedPresetId = p.id;
                this._applyPreset(p);
                this.updateStates();
              };
              btn.replaceWith(fresh);
            }
            return;
          }
          if (!(bstyle.button_glow_enabled && (bstyle.button_glow_condition === 'when_active' || bstyle.button_glow_color_mode === 'match'))) return;
          const look = this._effectivePreset(preset);
          const { boxShadow } = this._presetBorderAndGlowCss(look, st, bstyle);
          btn.style.boxShadow = boxShadow;
          const glowing = !!boxShadow && boxShadow !== 'none';
          btn.classList.toggle('cpc-glowing', glowing);
        } catch (e) {
          console.warn(`${LOG_PREFIX} glow update failed for preset ${btn.dataset.presetId}:`, e);
        }
      });
    }

    // Re-apply card + section frames so any conditional Frame Style re-evaluates
    // against the new state without a full re-render.
    this._applyCardFrame();
    this._applySectionFrames();

    // Re-apply Header Rules so on/off (and any state) transitions restyle the
    // header live, without a page reload. Sparse-revert: an item a rule no
    // longer sets reverts to the card's own header logic. (This is exactly the
    // live-refresh path the sister card added in v186.)
    this._applyHeaderRulesLive();
  }
}

// ============ EDITOR ============
class ColorLightManagerCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._skipNextRender = false;
    this._openSection = null; // all sections start collapsed
    this._openPreset = null; // index of the expanded preset editor, or null (all collapsed)
    this._openSliderSection = null; // id of the expanded slider section, or null
    this._openSectionStyle = null; // id of the section whose name/style panel is open
    // Ids of linked presets with unsaved edits (edited since last read from the entity).
    // Used to enable "Save to Entity" and to revert on close if not saved.
    this._dirtyPresets = new Set();
    this._entitySearch = '';
    this._entityFilter = { type: 'none', value: '' }; // type: none|label|group|text
    this._sceneSearch = '';
    this._addedEntitiesCollapsed = true; // "Added Entities" list starts collapsed
    this._addedScenesCollapsed = true;   // "Added Scenes" list starts collapsed
    this._openProfile = null;            // slug of the library profile whose editor is open
    this._profileDraft = null;           // { slug, entry, dirty } — working copy while a profile editor is open; edits stay here until Save
    this._openColorEntity = null;        // entity_id whose inline edit panel is open (Color Entities)
    this._entityColorDraft = null;       // { id, patch, dirty } — buffered color/brightness edits; not written to the entity until Save
    this._openScene = null;              // scene.* entity_id whose edit panel is open
    this._sceneConfigCache = {};         // scene entity_id -> fetched {name, entities} config (+ _dirty edits)
    this._sceneCaptureSet = null;        // entity_ids to include in the next capture (null = seed from Default Entities)
    this._sceneListCollapsed = true;     // Scene Manager "Your Scenes" list starts collapsed
    this._sceneCreateCollapsed = true;   // Scene Manager "Create a Scene" sub-area starts collapsed
    // Collapse state for the Color Entities sub-areas (they can get long with many entities).
    this._ceCollapsed = { manage: false, create: true, orphans: true };
    // Open collapsible subpanels (Card/Button Appearance groups), keyed by a stable id. A key
    // present in the set = expanded. All start collapsed.
    this._openSubpanels = new Set();
    this._openButtonStack = null;   // slug of the button-style stack whose layer editor is open
    this._editingLayer = null;          // { slug, idx } — the layer currently open for editing (pencil toggle)
    this._openFrame = null;             // id (lib:<slug>) of the frame preset whose builder is open
    this._frameDraft = null;            // { id, fx, dirty } — working copy while the frame builder is open; edits stay here until Save
    this._openHeaderSet = null;         // slug of the Header Rule Set whose editor is open
    this._headerDraft = null;           // { slug, set, dirty } — working copy while a Header Rule Set editor is open; edits stay here until Save
    this._openHeaderRules = new Set();  // open per-rule rows inside a header set editor (keys `<slug>::<idx>`)
    this._unmatchedInputColors = [];
    // Full list of color entities, captured alongside _unmatchedInputColors in
    // _syncInputColorMatches() (which runs on every hass update). The Delete list renders
    // from this instead of reading hass.states live, so it refreshes on exactly the same
    // cadence as the Unmatched list — which does update correctly.
    this._allInputColorEntities = [];
    // Entities we've successfully deleted this session. The editor's hass.states snapshot
    // can keep reporting a just-deleted entity (it doesn't always refresh while the editor
    // is open), so we subtract these from every color-entity list unconditionally rather
    // than waiting for hass to drop them.
    this._deletedColorEntities = new Set();
  }

  // Editor-side resolver (shares the module helper with the renderer).
  _sliderStyle(sectionId) { return resolveSliderStyle(this._config, sectionId); }

  // Section objects (migrating legacy configs on the fly). The editor is a separate class
  // from the card, so it has its own copies of these helpers.
  _orderedSectionsRaw() { return buildSections(this._config); }

  // Editor copy of the divider line renderer (for the live preview in a divider's gear panel).
  _dividerLineHtml(section) { return dividerLineHtml(section, this._config); }
  // Editor copy of the card's look resolver: overlays a linked Color Entity's live value
  // (single source of truth for linked buttons), else a referenced library profile's look.
  _effectivePreset(preset) {
    if (!preset) return preset;
    if (preset.input_color_entity) {
      const st = this._hass && this._hass.states[preset.input_color_entity];
      const value = inputColorStateToPresetValue(st);
      if (value && Object.keys(value).length) {
        const p = { ...preset };
        ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]);
        delete p.color_kelvin; delete p.brightness; delete p.effect; delete p.transition;
        delete p.action; delete p.look_none;
        return { ...p, ...value };
      }
    }
    if (!fixtureRefSlug(preset.profile_ref)) return preset;
    return applyProfileLook(preset, resolvePresetLook(preset, this._config && this._config.fixture_library_scope));
  }
  // Ordered section objects for the ordering UI, self-healing for any missing from the order.
  _orderedSections() {
    const sections = this._orderedSectionsRaw();
    const byId = new Map(sections.map(s => [s.id, s]));
    const order = Array.isArray(this._config.section_order) ? this._config.section_order : [];
    const ordered = order.map(id => byId.get(id)).filter(Boolean);
    sections.forEach(s => { if (!order.includes(s.id)) ordered.push(s); });
    return ordered;
  }
  // The buttons section a preset belongs to (mirror of the card-class helper; used by
  // _renderPresetSelects to decide whether the default-scene opt-out applies).
  _sectionForPreset(preset) {
    if (!preset || preset.section_id === '__none__') return null;
    const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
    if (!buttonsSections.length) return null;
    return buttonsSections.find(s => s.id === preset.section_id) || buttonsSections[0];
  }

  // Persists an updated sections array (also normalizes section_order to match).
  _updateSections(sections) {
    const order = sections.map(s => s.id);
    this._updateConfig({ sections, section_order: order });
  }

  // The preset buttons that belong to a section id, applying the SAME fallback the card uses (a
  // missing/stale section_id resolves to the first buttons section). Returns [] for non-buttons.
  _presetsBelongingTo(sectionId) {
    const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
    const src = buttonsSections.find(s => s.id === sectionId);
    if (!src) return [];   // non-buttons section (or unknown) → no bundled buttons
    const firstButtonsId = buttonsSections.length ? buttonsSections[0].id : null;
    const validIds = new Set(buttonsSections.map(s => s.id));
    return (this._config.presets || []).filter(p => (validIds.has(p.section_id) ? p.section_id : firstButtonsId) === sectionId);
  }
  _nowIso() { try { return new Date().toISOString().slice(0, 10); } catch (e) { return ''; } }
  // Clipboard helpers with a legacy fallback. navigator.clipboard needs a secure context (HTTPS or
  // localhost); when it's absent, writing falls back to a hidden textarea + execCommand, and reading
  // rejects so callers can prompt for a paste instead.
  // Build + show a modal overlay containing `contentEl`. Returns { close } and closes on backdrop
  // click or Escape. Programmatic clipboard access is unreliable in HA's editor dialog (the async
  // API rejects with "Document is not focused"; execCommand's user-gesture expires in async
  // callbacks), so JSON transfer is done through a VISIBLE textarea the user can select/copy/paste
  // — the textarea itself is the focused element, sidestepping the whole focus problem.
  _showModal(contentEl) {
    // Use a native <dialog> + showModal(): it renders in the browser's TOP LAYER, which is above
    // HA's own <ha-dialog> (the config editor also lives in the top layer, so a plain z-index div
    // on document.body renders BEHIND it — the "modal hides behind the editor" bug). The top layer
    // has no z-index race: the most-recently-shown modal dialog is always on top.
    const dlg = document.createElement('dialog');
    dlg.style.cssText = 'padding:0;border:none;background:transparent;max-width:none;max-height:none;';
    // Backdrop styling via a scoped <style> (::backdrop can't be set inline).
    const st = document.createElement('style');
    st.textContent = 'dialog::backdrop{background:rgba(0,0,0,0.55);}';
    dlg.appendChild(st);
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--ha-card-background,var(--card-background-color,#1c1c1c));color:var(--primary-text-color,#e1e1e1);border:1px solid var(--divider-color,#444);border-radius:12px;max-width:640px;width:min(640px,92vw);max-height:85vh;overflow:auto;padding:16px;box-sizing:border-box;box-shadow:0 8px 40px rgba(0,0,0,0.5);';
    box.appendChild(contentEl);
    dlg.appendChild(box);
    const close = () => { try { dlg.close(); } catch (e) {} if (dlg.parentNode) dlg.parentNode.removeChild(dlg); };
    // Backdrop click (the dialog element itself, outside the inner box) closes.
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // Esc
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { /* showModal unsupported → dialog still shows via [open] */ dlg.setAttribute('open', ''); }
    return { close, box };
  }
  // Best-effort clipboard write for the modal's Copy button (the textarea is already focused +
  // selected, so execCommand runs inside the click gesture and reliably works here).
  _tryCopyTextarea(ta) {
    try { ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); return document.execCommand('copy'); }
    catch (e) { return false; }
  }
  // Unified JSON export: open a modal with the JSON in a selectable textarea + a Copy button. No
  // truncation (textarea, not prompt), and copying works because the textarea holds focus.
  _exportJson(text, note) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Export</div>
      <div style="font-size:12px;color:var(--secondary-text-color,#888);margin-bottom:10px;">${escapeHtml(note || 'Copy this JSON.')}</div>
      <textarea readonly style="width:100%;box-sizing:border-box;height:220px;font-family:var(--code-font-family,monospace);font-size:12px;padding:8px;border-radius:6px;border:1px solid var(--divider-color,#444);background:var(--secondary-background-color,#2a2a2a);color:var(--primary-text-color,#e1e1e1);resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
        <button class="cpce-modal-copy" style="padding:8px 14px;border:none;border-radius:6px;background:var(--primary-color,#2196F3);color:#fff;cursor:pointer;font-size:13px;">Copy to clipboard</button>
        <button class="cpce-modal-close" style="padding:8px 14px;border:1px solid var(--divider-color,#444);border-radius:6px;background:transparent;color:var(--primary-text-color,#e1e1e1);cursor:pointer;font-size:13px;">Close</button>
      </div>`;
    const ta = wrap.querySelector('textarea');
    ta.value = text;
    const modal = this._showModal(wrap);
    // Pre-select so a manual Ctrl/Cmd+C works immediately even without the button.
    setTimeout(() => { ta.focus(); ta.select(); }, 50);
    const copyBtn = wrap.querySelector('.cpce-modal-copy');
    copyBtn.onclick = () => {
      const ok = this._tryCopyTextarea(ta) || (navigator.clipboard && navigator.clipboard.writeText && (navigator.clipboard.writeText(ta.value), true));
      copyBtn.textContent = ok ? 'Copied ✓' : 'Press Ctrl/Cmd+C';
      setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 1500);
    };
    wrap.querySelector('.cpce-modal-close').onclick = () => modal.close();
  }
  // Unified JSON import: open a modal with an empty textarea to paste into + an Import button.
  // Calls onText(raw) with the pasted string; blank → no-op.
  _importJson(promptLabel, onText) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Import</div>
      <div style="font-size:12px;color:var(--secondary-text-color,#888);margin-bottom:10px;">${escapeHtml(promptLabel || 'Paste the exported JSON below.')}</div>
      <textarea placeholder="Paste JSON here…" style="width:100%;box-sizing:border-box;height:220px;font-family:var(--code-font-family,monospace);font-size:12px;padding:8px;border-radius:6px;border:1px solid var(--divider-color,#444);background:var(--secondary-background-color,#2a2a2a);color:var(--primary-text-color,#e1e1e1);resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
        <button class="cpce-modal-paste" style="padding:8px 14px;border:1px solid var(--divider-color,#444);border-radius:6px;background:transparent;color:var(--primary-text-color,#e1e1e1);cursor:pointer;font-size:13px;margin-right:auto;">Paste from clipboard</button>
        <button class="cpce-modal-import" style="padding:8px 14px;border:none;border-radius:6px;background:var(--primary-color,#2196F3);color:#fff;cursor:pointer;font-size:13px;">Import</button>
        <button class="cpce-modal-close" style="padding:8px 14px;border:1px solid var(--divider-color,#444);border-radius:6px;background:transparent;color:var(--primary-text-color,#e1e1e1);cursor:pointer;font-size:13px;">Cancel</button>
      </div>`;
    const ta = wrap.querySelector('textarea');
    const modal = this._showModal(wrap);
    setTimeout(() => ta.focus(), 50);
    // Paste button: pull from the clipboard when the browser allows it (secure context + permission);
    // otherwise nudge the user to paste manually. The textarea is always there as the reliable path.
    const pasteBtn = wrap.querySelector('.cpce-modal-paste');
    pasteBtn.onclick = () => {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText()
          .then(txt => { if (txt) { ta.value = txt; ta.focus(); } else { pasteBtn.textContent = 'Press Ctrl/Cmd+V'; setTimeout(() => { pasteBtn.textContent = 'Paste from clipboard'; }, 1500); } })
          .catch(() => { ta.focus(); pasteBtn.textContent = 'Press Ctrl/Cmd+V'; setTimeout(() => { pasteBtn.textContent = 'Paste from clipboard'; }, 1500); });
      } else { ta.focus(); pasteBtn.textContent = 'Press Ctrl/Cmd+V'; setTimeout(() => { pasteBtn.textContent = 'Paste from clipboard'; }, 1500); }
    };
    wrap.querySelector('.cpce-modal-import').onclick = () => {
      const txt = ta.value;
      modal.close();
      if (txt && txt.trim()) onText(txt);
    };
    wrap.querySelector('.cpce-modal-close').onclick = () => modal.close();
  }

  // Import a section (+ its bundled buttons) from a parsed envelope. Re-IDs the section and every
  // button (repointing section_id) so nothing collides, appends the section to the order, and adds
  // the buttons to cfg.presets. Buttons arrive fully configured and already assigned — no manual
  // re-assignment. Library refs (style_preset/profile_ref/frame/header) and entity ids ride along
  // as-is: they resolve on this instance and degrade gracefully if absent.
  _importSection(section, presets) {
    const ordered = this._orderedSections();
    const copy = JSON.parse(JSON.stringify(section));
    copy.id = newSectionId(copy.type || 'section');
    if (copy.type !== 'divider') copy.name = `${copy.name || copy.type} (imported)`;
    // Never inherit a stale hidden flag as a surprise; keep everything else the section carried.
    ordered.push(copy);
    let allPresets = this._config.presets || [];
    if (copy.type === 'buttons' && Array.isArray(presets) && presets.length) {
      const clones = presets.map(p => { const c = JSON.parse(JSON.stringify(p)); c.id = newPresetId(); c.section_id = copy.id; return c; });
      allPresets = [...allPresets, ...clones];
    }
    this._updateConfig({ sections: ordered, section_order: ordered.map(s => s.id), presets: dedupePresetIds(allPresets) });
    this._render();
    // Honest post-import note: flag referenced Button Styles / Fixture Profiles this instance lacks.
    const missing = this._missingRefsFor(copy, (copy.type === 'buttons' ? presets : []) || []);
    const n = (copy.type === 'buttons' && Array.isArray(presets)) ? presets.length : 0;
    let msg = `Imported “${copy.name || copy.type}”${copy.type === 'buttons' ? ` with ${n} button${n === 1 ? '' : 's'}` : ''}.`;
    if (missing.length) msg += `\n\nNot present on this system (they'll fall back until fixed):\n• ${missing.join('\n• ')}`;
    window.alert(msg);
  }

  // Collect library refs an imported section/buttons point at that DON'T exist on this instance —
  // for an honest "these will fall back" note. Only checks the genuinely-shared, possibly-missing
  // bits (Button Styles + Fixture Profiles); entity ids are left to HA to resolve.
  _missingRefsFor(section, presets) {
    const missing = [];
    const btnLib = buttonStyleLibraryMap();
    const styleSlug = fixtureRefSlug(section.style_preset);
    if (styleSlug && !isBuiltinButtonSlug(styleSlug) && !btnLib[styleSlug]) missing.push(`Button Style “${styleSlug}”`);
    const fixLib = (typeof fixtureLibraryMap === 'function') ? fixtureLibraryMap((this._config && this._config.fixture_library_scope) || 'system') : {};
    const seen = new Set();
    (presets || []).forEach(p => {
      const slug = fixtureRefSlug(p && p.profile_ref);
      if (slug && !seen.has(slug) && !(fixLib && fixLib[slug])) { seen.add(slug); missing.push(`Fixture Profile “${slug}”`); }
    });
    return missing;
  }

  // Duplicate a section by id: deep-copy with a fresh id + "(copy)" name, insert right after the
  // original. For buttons sections, also clone the preset buttons assigned to it (new ids, pointed
  // at the new section) so the copy is functional, not empty.
  _duplicateSection(id) {
    const ordered = this._orderedSections();
    const idx = ordered.findIndex(s => s.id === id);
    if (idx < 0) return;
    const src = ordered[idx];
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newSectionId(src.type || 'section');
    if (src.type === 'divider') { if (src.label) copy.label = `${src.label}`; }
    else copy.name = `${src.name || src.type} (copy)`;
    ordered.splice(idx + 1, 0, copy);
    // Clone this section's preset buttons (buttons sections only). Presets belong to a section via
    // section_id; those with a missing/stale id fall back to the FIRST buttons section (same rule
    // the card uses), so resolve that here to pick the right ones to clone.
    let presets = this._config.presets || [];
    if (src.type === 'buttons') {
      const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
      const firstButtonsId = buttonsSections.length ? buttonsSections[0].id : null;
      const validIds = new Set(buttonsSections.map(s => s.id));
      const mine = presets.filter(p => (validIds.has(p.section_id) ? p.section_id : firstButtonsId) === src.id);
      if (mine.length) {
        const clones = mine.map(p => { const c = JSON.parse(JSON.stringify(p)); c.id = newPresetId(); c.section_id = copy.id; return c; });
        presets = [...presets, ...clones];
      }
    }
    this._updateConfig({ sections: ordered, section_order: ordered.map(s => s.id), presets: dedupePresetIds(presets) });
    this._render();
  }

  setConfig(config) {
    this._config = { ...ColorLightManagerCard.getStubConfig(), ...config };
    this._config.presets = dedupePresetIds(this._config.presets);
    if (this._skipNextRender) { this._skipNextRender = false; return; }
    if (this._hass) this._syncInputColorMatches();
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    // The editor always loads the shared Fixture Profile Library so the manager + preset
    // profile picker reflect it live (re-render on updates), regardless of any ref existing.
    ensureFixtureLibrary(hass, (this._config && this._config.fixture_library_scope) || 'system', () => this._render());
    // Load + live-sync the shared Button Appearance preset library so the list reflects it.
    ensureButtonStyleLibrary(hass, () => { this._migrateSectionDefaults(); this._render(); });
    // Load + live-sync the shared Frame Style library so the Frame Styles panel
    // shows every System frame (incl. those authored in the Easy Entity Styler
    // card) — always, regardless of whether this card references one yet.
    ensureFrameLibrary(hass, (this._config && this._config.frame_library_scope) || 'system', () => this._render());
    // Load + live-sync the shared Header Rule library so the Header Rules panel
    // shows every System rule set (incl. those authored in the Easy Entity Styler
    // card — same `ltek_header_library` key) — always, like the Frame library.
    ensureHeaderLibrary(hass, (this._config && this._config.header_library_scope) || 'system', () => this._render());
    // Load the input_select storage-helper collection once (to know which helpers are editable in
    // the Scene Groups panel). Admin-gated at use; a non-admin/unsupported list just yields [].
    this._ensureSceneHelpers();
    // hass updates fire on nearly every state change anywhere in Home Assistant.
    // Only rebuild the checkbox list when the actual set of light entities changes
    // (e.g. a device added) — otherwise it wipes out checkboxes the user just ticked
    // before they get a chance to click "Add Selected".
    const key = getLightEntities(hass).join(',');
    const colorIds = getInputColorEntities(hass);
    const colorKey = colorIds.join(',');
    // A value signature over all color entities — detects an entity's color/brightness
    // changing (e.g. our own set_color, or an external edit) so the Color Entities manager
    // list + any open edit panel refresh to the entity's live value.
    const colorValKey = colorIds.map(id => { const s = hass.states[id]; return s ? `${id}:${s.state}:${s.last_updated}` : id; }).join('|');
    const entitiesChanged = key !== this._lastEntityKey;
    const colorEntitiesChanged = colorKey !== this._lastInputColorKey;
    const colorValuesChanged = colorValKey !== this._lastColorValKey;
    this._lastEntityKey = key;
    this._lastInputColorKey = colorKey;
    this._lastColorValKey = colorValKey;
    if (colorEntitiesChanged) {
      // Recompute matches whenever the set of input_color.* helpers changes (e.g. a new
      // one was created) — this also runs once on first hass assignment. Always
      // re-render here: even when no preset gets newly linked, the unmatched list
      // itself may have changed (e.g. a new unmatched entity appeared).
      this._syncInputColorMatches();
      this._render();
    } else if (colorValuesChanged && !this._ceWheelDragging) {
      // An entity's value changed but the set is the same. Re-render so swatches / linked-button
      // previews / an open entity edit panel reflect it — unless a wheel drag is in progress
      // (re-rendering would rebuild the canvas and drop the drag).
      this._render();
    }
    if (entitiesChanged && !colorEntitiesChanged) this._updateEntityList();
  }
  get hass() { return this._hass; }

  // Links any preset missing an input_color_entity to a matching input_color.* entity
  // (by slugified name), and recomputes the unmatched-entities list.
  _syncInputColorMatches() {
    if (!this._hass) return;
    const presets = this._config.presets || [];
    // Exclude session-deleted entities so the matcher can't re-link a preset to one we
    // just removed, and so neither list shows it (the editor's hass snapshot may still
    // report it until the dashboard is reloaded).
    const { presets: updated, unmatched, all } = matchPresetsToInputColorEntities(presets, this._hass, this._deletedColorEntities);
    this._unmatchedInputColors = unmatched;
    this._allInputColorEntities = all;
    const changed = updated.some((p, i) => p.input_color_entity !== presets[i].input_color_entity);
    if (changed) this._updateConfig({ presets: updated });
  }

  // Creates a brand-new Color helper entity by driving its config-entry flow — the same
  // REST endpoint (`config/config_entries/flow`) the "Add Integration" / Helpers UI uses.
  // The Color helper (HA core PR #177605, domain `color`) is a config-flow integration,
  // NOT a storage helper, so it registers no `<domain>/create` WebSocket command (that's
  // why those attempts returned `unknown_command`). Config flows are driven over REST via
  // hass.callApi, exactly as HA's own frontend does it — callWS is not used for flow steps.
  //
  // Flow (per the PR's config_flow.py):
  //   step "user"      → { name, icon?, initial_mode: "chromatic"|"white" }
  //   step "chromatic" → { initial_color: [r,g,b], initial_brightness? }   (pure black rejected)
  //   step "white"     → { initial_kelvin, initial_brightness? }
  //
  // The created entity's domain depends on the installed integration (core `color`, or a
  // custom `input_color`), so rather than assume it, we snapshot state before the flow and
  // return whichever new entity actually appears. Resolves with the new entity_id, or null
  // on failure (having surfaced the reason to console + an alert). `handler` lets callers
  // override which integration's flow to start; it defaults to trying `color` then `input_color`.
  _createInputColorEntity(name, initialValue, handlers) {
    const hass = this._hass;
    if (!hass) {
      console.warn(`${LOG_PREFIX} Cannot create Color Entity — hass is not available yet.`);
      return Promise.resolve(null);
    }
    if (typeof hass.callApi !== 'function') {
      const msg = 'hass.callApi is unavailable, cannot drive the config flow.';
      console.error(`${LOG_PREFIX} ${msg}`);
      window.alert(`Could not create the Color Entity "${name}".\n\nReason: ${msg}`);
      return Promise.resolve(null);
    }

    const flowHandlers = handlers && handlers.length ? handlers : ['color', 'input_color'];

    // Build the chromatic-step color input: prefer the preset's own RGB, avoid pure black
    // (the flow rejects [0,0,0]), and default to red otherwise.
    let rgb = (initialValue && Array.isArray(initialValue.rgb_color)) ? initialValue.rgb_color.slice(0, 3) : null;
    if (!rgb || (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0)) rgb = [255, 0, 0];
    const brightness = (initialValue && initialValue.brightness != null) ? initialValue.brightness : undefined;

    const before = new Set(Object.keys(hass.states));

    // Runs the two/three-step flow for one handler. Resolves { flowResult } on create_entry,
    // or throws with a descriptive reason (form validation error, abort, or transport error).
    // Aborts a still-open flow so a partially-completed attempt can't leave a dangling
    // config entry / orphaned entity behind.
    const cancelFlow = (flowId) => {
      if (!flowId) return;
      hass.callApi('DELETE', `config/config_entries/flow/${flowId}`)
        .then(() => console.log(`${LOG_PREFIX} Cancelled incomplete flow ${flowId}.`))
        .catch(() => {});
    };

    const runFlow = async (handler) => {
      const start = await hass.callApi('POST', 'config/config_entries/flow', { handler, show_advanced_options: false });
      if (!start || !start.flow_id) throw new Error(`flow did not start for handler "${handler}"`);
      console.log(`${LOG_PREFIX} Flow "${handler}" started: type=${start.type} step_id=${start.step_id} flow_id=${start.flow_id}`);

      // Some flows complete immediately at the first prompt; handle create_entry/abort at
      // every step and NEVER post a further step once the flow has finished. Posting to a
      // completed flow is what was creating a second config entry (and thus an orphan).
      const checkStep = (resp, label) => {
        console.log(`${LOG_PREFIX} Flow "${handler}" ${label}: type=${resp && resp.type} step_id=${resp && resp.step_id}`, resp || '');
        if (resp && resp.type === 'form' && resp.errors && Object.keys(resp.errors).length) {
          throw new Error(`step "${resp.step_id}" rejected input: ${JSON.stringify(resp.errors)}`);
        }
        if (resp && resp.type === 'abort') throw new Error(`flow aborted: ${resp.reason}`);
        return resp && resp.type === 'create_entry';
      };

      // Step "user": name + mode. (Icon is optional; we omit it.)
      const afterUser = await hass.callApi('POST', `config/config_entries/flow/${start.flow_id}`, {
        name,
        initial_mode: 'chromatic',
      });
      // If the flow finished here, we're done — do NOT send the chromatic step.
      if (checkStep(afterUser, 'after user step')) return afterUser;

      // Only advance to the "chromatic" step if the flow is actually still asking for a form
      // (a multi-step flow like the core `color` PR). Otherwise something unexpected happened.
      if (!afterUser || afterUser.type !== 'form') {
        cancelFlow(start.flow_id);
        throw new Error(`unexpected flow state after user step (type: ${afterUser && afterUser.type})`);
      }

      // Step "chromatic": initial color (+ optional brightness).
      const chromaticInput = { initial_color: rgb };
      if (brightness !== undefined) chromaticInput.initial_brightness = brightness;
      const afterChromatic = await hass.callApi('POST', `config/config_entries/flow/${start.flow_id}`, chromaticInput);
      if (checkStep(afterChromatic, 'after chromatic step')) return afterChromatic;

      cancelFlow(start.flow_id);
      throw new Error(`flow did not complete (last step type: ${afterChromatic && afterChromatic.type})`);
    };

    console.log(`${LOG_PREFIX} Creating Color helper named "${name}" via config flow (handlers tried: ${flowHandlers.join(', ')})…`);

    // Try each handler in turn; keep the first that starts a real flow. A 404/unknown
    // handler means that integration isn't installed — move on to the next.
    const tryHandlers = async () => {
      let lastErr = null;
      for (const handler of flowHandlers) {
        try {
          const result = await runFlow(handler);
          console.log(`${LOG_PREFIX} Config flow completed for handler "${handler}".`, result);
          return result;
        } catch (e) {
          lastErr = e;
          console.warn(`${LOG_PREFIX} Handler "${handler}" flow failed: ${formatWsError(e)}`);
        }
      }
      throw lastErr || new Error('no config-flow handler succeeded');
    };

    return tryHandlers()
      .then(() => this._findNewEntities(before))
      .then(async (newIds) => {
        if (!newIds.length) {
          throw new Error('config entry was created but no new entity appeared in state');
        }
        if (newIds.length === 1) {
          console.log(`${LOG_PREFIX} Successfully created Color Entity "${newIds[0]}".`);
          return newIds[0];
        }
        // The integration's config flow can spawn duplicates (a known bug: its RGB selector
        // default is malformed — "#NaNNaNNaN" — which triggers an error/resubmit that
        // creates a second, orphaned config entry). Keep the properly-backed entity and
        // clean up any orphaned duplicates so our create never leaves junk behind.
        console.warn(`${LOG_PREFIX} Config flow produced ${newIds.length} entities (${newIds.join(', ')}); resolving duplicates…`);
        const kept = await this._dedupeCreatedEntities(newIds);
        console.log(`${LOG_PREFIX} Kept "${kept}" and cleaned up duplicates.`);
        return kept;
      })
      .catch(e => {
        const reason = formatWsError(e);
        console.error(`${LOG_PREFIX} Failed to create Color Entity "${name}". Reason: ${reason}`, e);
        window.alert(
          `Could not create the Color Entity "${name}".\n\nReason: ${reason}\n\n` +
          `This card creates the helper via the "Color" integration's config flow (the ${COLOR_DOMAIN} domain; a legacy "input_color" integration also works). ` +
          `If neither is installed, create the entity from Settings → Devices & Services → Helpers instead.`
        );
        return null;
      });
  }

  // Waits for new color/input_color state keys (not in `beforeKeys`) to appear after a
  // create, and returns ALL of them — the config flow can create more than one (a known
  // integration bug), and we need to see every duplicate to clean them up. Waits until at
  // least one appears, then a short settle window to catch a duplicate landing just after.
  _findNewEntities(beforeKeys, timeoutMs = 5000, settleMs = 800) {
    const collect = () => {
      if (!this._hass) return [];
      return Object.keys(this._hass.states)
        .filter(id => !beforeKeys.has(id))
        .filter(id => COLOR_HELPER_DOMAINS.some(d => id.startsWith(d + '.')));
    };
    return new Promise(resolve => {
      const start = Date.now();
      let firstSeenAt = 0;
      const tick = () => {
        const found = collect();
        if (found.length && !firstSeenAt) firstSeenAt = Date.now();
        // Resolve once we've seen something AND the settle window has elapsed since first
        // sighting (so a straggler duplicate is included), or on overall timeout.
        if (firstSeenAt && Date.now() - firstSeenAt >= settleMs) { resolve(found); return; }
        if (Date.now() - start >= timeoutMs) { resolve(found); return; }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
  }

  // Given several entities created by one config-flow run (the integration can spawn an
  // orphaned duplicate), keep the one backed by a live config entry and remove the rest.
  // Returns the entity_id we kept. If we can't tell which is "real", keep the first and
  // remove the others (they're duplicates of the same helper regardless).
  async _dedupeCreatedEntities(ids) {
    const hass = this._hass;
    // Pull the registry once to see which of the new entities has a real config_entry_id.
    let list = [];
    try {
      const resp = await hass.callWS({ type: 'config/entity_registry/list' });
      list = Array.isArray(resp) ? resp : (resp && resp.entities) || [];
    } catch (e) {
      console.warn(`${LOG_PREFIX} dedupe: entity_registry/list failed: ${formatWsError(e)}`);
    }
    const backed = ids.filter(id => {
      const e = list.find(r => r.entity_id === id);
      return e && e.config_entry_id;
    });
    const keep = backed[0] || ids[0];
    const remove = ids.filter(id => id !== keep);
    for (const id of remove) {
      console.warn(`${LOG_PREFIX} Removing duplicate entity "${id}" left by the config flow…`);
      await this._deleteColorEntity(id, { silent: true }).catch(err => console.warn(`${LOG_PREFIX} cleanup of "${id}" failed:`, formatWsError(err)));
    }
    return keep;
  }

  // Interrogates the live Home Assistant to report exactly how THIS install's
  // input_color integration is set up: which services it registers, whether it's a
  // config-flow (UI/"Add Integration") integration or a YAML/storage helper, and its
  // existing entities. This is diagnostic-only — it never creates anything — and exists
  // because "input_color" is a custom integration whose creation mechanism varies by
  // author, so we base any create path on facts from the running system, not guesses.
  async _diagnoseInputColor() {
    const hass = this._hass;
    if (!hass) { console.warn(`${LOG_PREFIX} diagnose: hass unavailable`); return null; }
    const report = { domain: INPUT_COLOR_DOMAIN };

    // Is the integration even loaded?
    report.componentLoaded = Array.isArray(hass.config?.components)
      ? hass.config.components.includes(INPUT_COLOR_DOMAIN)
      : 'unknown';

    // Which services does it register? (e.g. set_color, set_brightness, apply_to…)
    report.services = hass.services && hass.services[INPUT_COLOR_DOMAIN]
      ? Object.keys(hass.services[INPUT_COLOR_DOMAIN]) : [];

    // Existing entities in this domain.
    report.entities = getInputColorEntities(hass);

    // Does it use a config-flow (created via Settings → Devices & Services), or is it a
    // storage/YAML helper? The manifest tells us.
    try {
      const manifest = await hass.callWS({ type: 'manifest/get', integration: INPUT_COLOR_DOMAIN });
      report.configFlow = !!(manifest && manifest.config_flow);
      report.integrationType = manifest && manifest.integration_type;
      report.manifest = manifest || null;
    } catch (e) {
      report.manifestError = formatWsError(e);
    }

    // Any existing config entries for it? (present for config-flow integrations)
    try {
      const entries = await hass.callWS({ type: 'config_entries/get' });
      report.configEntries = (entries || []).filter(en => en.domain === INPUT_COLOR_DOMAIN)
        .map(en => ({ entry_id: en.entry_id, title: en.title }));
    } catch (e) {
      report.configEntriesError = formatWsError(e);
    }

    console.log(`${LOG_PREFIX} input_color diagnostics:`, report);
    return report;
  }

  // Deletes a Color helper entity. input_color helpers are config-entry-backed (custom
  // integration), so deletion is `config_entries/remove` over WebSocket — NOT
  // input_color/delete (no such command) and NOT registry-remove alone (which doesn't
  // clear the config entry). We resolve the entity's config_entry_id from the registry,
  // remove that entry, AND remove the registry entry (config-entry removal isn't enough on
  // its own — it can leave an orphan). Orphaned entities (registered, no live config entry)
  // are removed straight from the registry. Falls back to storage-helper commands only if
  // there's no registry/config entry at all. Resolves true on success, false on failure.
  async _deleteColorEntity(entityId, options) {
    const silent = !!(options && options.silent); // suppress the user-facing alert (internal cleanup)
    const hass = this._hass;
    if (!hass) { console.warn(`${LOG_PREFIX} Cannot delete "${entityId}" — hass unavailable.`); return false; }
    console.log(`${LOG_PREFIX} Deleting Color Entity "${entityId}"…`);
    try {
      // Read the entity's registry entry over WS (the authoritative source). Note we do NOT
      // trust hass.entities here — that frontend map omits ORPHANED entities (ones "no
      // longer provided by the integration"), which are exactly the ones we need to delete.
      // The registry entry tells us whether a config entry backs it (delete that) or it's
      // orphaned/registry-only (remove it straight from the registry, as HA's UI does).
      let regEntry = null;
      try {
        const resp = await hass.callWS({ type: 'config/entity_registry/list' });
        const list = Array.isArray(resp) ? resp : (resp && resp.entities) || [];
        regEntry = list.find(e => e.entity_id === entityId) || null;
        console.log(`${LOG_PREFIX} registry entry for "${entityId}":`, regEntry || '(not in registry)');
      } catch (e) {
        console.warn(`${LOG_PREFIX} config/entity_registry/list failed: ${formatWsError(e)}`);
      }

      let configEntryId = regEntry && regEntry.config_entry_id;

      // If the entity has a registry entry, its own config_entry_id is authoritative:
      //   - present  → remove that config entry (a real integration instance backs it).
      //   - null     → orphaned; skip straight to removing the registry entry below.
      // We only fall through to the config_entries title-match if there's NO registry entry.

      // Orphaned entity: it's in the registry but no config entry backs it ("no longer
      // provided by the integration"). Remove it directly from the registry — do NOT try
      // to match some other config entry by title, which risks deleting the wrong thing.
      if (regEntry && !configEntryId) {
        console.log(`${LOG_PREFIX} "${entityId}" is orphaned (registered, config_entry_id: null); removing from the entity registry…`);
        const removed = await this._removeEntityRegistryEntry(entityId);
        if (removed) {
          console.log(`${LOG_PREFIX} Successfully removed "${entityId}" from the entity registry.`);
          return true;
        }
        throw new Error('entity registry removal failed');
      }

      // No registry entry at all → fall back to matching a config entry by domain + title.
      if (!configEntryId) {
        try {
          const entries = await hass.callWS({ type: 'config_entries/get' });
          const domain = entityId.split('.')[0];
          const wanted = friendlyName(hass, entityId);
          const candidates = (entries || []).filter(en => en.domain === domain || COLOR_HELPER_DOMAINS.includes(en.domain));
          console.log(`${LOG_PREFIX} config_entries/get candidates for "${entityId}":`, candidates.map(en => ({ entry_id: en.entry_id, domain: en.domain, title: en.title })));
          const match = candidates.find(en => en.title === wanted) || (candidates.length === 1 ? candidates[0] : null);
          if (match) { configEntryId = match.entry_id; console.log(`${LOG_PREFIX} Matched config entry ${configEntryId} ("${match.title}") for "${entityId}".`); }
        } catch (e) {
          console.warn(`${LOG_PREFIX} config_entries/get failed: ${formatWsError(e)}`);
        }
      }

      if (configEntryId) {
        console.log(`${LOG_PREFIX} Removing config entry ${configEntryId} for "${entityId}"…`);
        // input_color helpers are config-entry-backed, so removal is `config_entries/remove`
        // over WebSocket (WS-first, REST DELETE as fallback — see _removeConfigEntry).
        const entryRemoved = await this._removeConfigEntry(configEntryId);
        // Removing the config entry does NOT reliably purge the entity-registry entry, so
        // ALWAYS follow up by removing the orphaned registry entry too (the note: config
        // entry removal "is not enough on its own"). This is what leaves orphans otherwise.
        const regRemoved = await this._removeEntityRegistryEntry(entityId);
        if (entryRemoved || regRemoved) {
          console.log(`${LOG_PREFIX} Deleted "${entityId}" (config entry removed: ${entryRemoved}, registry entry removed: ${regRemoved}).`);
          return true;
        }
        throw new Error('config entry removal and registry removal both failed');
      }

      // No config entry backs this entity → it's an orphaned/registry-only entity (the
      // earlier logs showed config_entry_id: null). These are removed straight from the
      // entity registry, exactly as HA's UI does for an entity with no integration.
      console.log(`${LOG_PREFIX} "${entityId}" has no config entry; removing it from the entity registry…`);
      const removed = await this._removeEntityRegistryEntry(entityId);
      if (removed) {
        console.log(`${LOG_PREFIX} Successfully removed "${entityId}" from the entity registry.`);
        return true;
      }

      // Last resort — treat as a legacy storage helper (input_boolean-style). Try the
      // domain the entity actually uses (from its own id), then the config/-prefixed form.
      console.warn(`${LOG_PREFIX} Registry removal didn't apply to "${entityId}"; falling back to storage-helper delete.`);
      const domain = entityId.split('.')[0];
      const helperId = entityId.slice((domain + '.').length);
      try {
        await hass.callWS({ type: `${domain}/delete`, [`${domain}_id`]: helperId });
      } catch (primaryErr) {
        console.warn(`${LOG_PREFIX} "${domain}/delete" failed (${formatWsError(primaryErr)}); trying legacy "config/${domain}/delete"…`);
        await hass.callWS({ type: `config/${domain}/delete`, [`${domain}_id`]: helperId });
      }
      console.log(`${LOG_PREFIX} Successfully deleted storage helper "${entityId}".`);
      return true;
    } catch (e) {
      const reason = formatWsError(e);
      console.error(`${LOG_PREFIX} Failed to delete Color Entity "${entityId}". Reason: ${reason}`, e);
      if (!silent) window.alert(`Could not delete the entity "${entityId}".\n\nReason: ${reason}\n\nIt may need to be removed from Settings → Devices & Services → Helpers instead.`);
      return false;
    }
  }

  // Removes a config entry. input_color helpers are config-entry-backed (custom
  // integration), so the correct removal is `config_entries/remove` over WebSocket. We try
  // that first, then fall back to the REST DELETE form some cores/UI use. Returns true on
  // success. NOTE: removing the config entry does NOT always purge the entity registry
  // entry, so callers should also remove the registry entry afterward.
  async _removeConfigEntry(entryId) {
    const hass = this._hass;
    if (!hass || !entryId) return false;
    try {
      await hass.callWS({ type: 'config_entries/remove', entry_id: entryId });
      console.log(`${LOG_PREFIX} Removed config entry ${entryId} (config_entries/remove WS).`);
      return true;
    } catch (wsErr) {
      console.warn(`${LOG_PREFIX} config_entries/remove WS failed (${formatWsError(wsErr)}); trying REST DELETE…`);
    }
    if (typeof hass.callApi === 'function') {
      try {
        await hass.callApi('DELETE', `config/config_entries/entry/${entryId}`);
        console.log(`${LOG_PREFIX} Removed config entry ${entryId} (REST DELETE).`);
        return true;
      } catch (restErr) {
        console.warn(`${LOG_PREFIX} REST DELETE of config entry ${entryId} failed: ${formatWsError(restErr)}`);
      }
    }
    return false;
  }

  // Removes an entity from the entity registry (purging an orphaned/registry-only entity
  // and its state), the same operation HA's UI uses to delete an entity that has no
  // integration behind it. Returns true if the remove command succeeded, false otherwise.
  async _removeEntityRegistryEntry(entityId) {
    const hass = this._hass;
    if (!hass) return false;
    try {
      await hass.callWS({ type: 'config/entity_registry/remove', entity_id: entityId });
      return true;
    } catch (e) {
      console.warn(`${LOG_PREFIX} config/entity_registry/remove failed for "${entityId}": ${formatWsError(e)}`);
      return false;
    }
  }

  // Finds orphaned color entities: registry entries in the color/input_color domains whose
  // backing config entry is gone (config_entry_id is null, or points at an entry that no
  // longer exists). The input_color integration's buggy config flow leaves these behind,
  // and HA's own UI often won't offer a delete for them — so we detect them here to sweep.
  // Resolves with an array of orphaned entity_ids.
  async _findOrphanedColorEntities() {
    const hass = this._hass;
    if (!hass) return [];
    let list = [];
    try {
      const resp = await hass.callWS({ type: 'config/entity_registry/list' });
      list = Array.isArray(resp) ? resp : (resp && resp.entities) || [];
    } catch (e) {
      console.warn(`${LOG_PREFIX} orphan scan: entity_registry/list failed: ${formatWsError(e)}`);
      return [];
    }
    let validEntryIds = null;
    try {
      const entries = await hass.callWS({ type: 'config_entries/get' });
      validEntryIds = new Set((entries || []).map(en => en.entry_id));
    } catch (e) {
      console.warn(`${LOG_PREFIX} orphan scan: config_entries/get failed: ${formatWsError(e)}`);
    }
    // Return {entity_id, config_entry_id} so the sweep can remove BOTH the (possibly dead)
    // config entry and the registry entry — registry-remove alone isn't always enough.
    const orphans = list
      .filter(e => e.entity_id && COLOR_HELPER_DOMAINS.some(d => e.entity_id.startsWith(d + '.')))
      .filter(e => {
        if (!e.config_entry_id) return true;                       // no backing entry at all
        if (validEntryIds && !validEntryIds.has(e.config_entry_id)) return true; // points at a dead entry
        return false;
      })
      .map(e => ({ entity_id: e.entity_id, config_entry_id: e.config_entry_id || null }));
    console.log(`${LOG_PREFIX} orphan scan found ${orphans.length}:`, orphans.map(o => o.entity_id));
    return orphans;
  }

  // Sweeps orphaned color entities: removes any (dead) config entry they reference AND the
  // registry entry, matching the delete path. Resolves with the count removed.
  async _cleanupOrphanedColorEntities() {
    const orphans = await this._findOrphanedColorEntities();
    let removed = 0;
    for (const o of orphans) {
      if (o.config_entry_id) await this._removeConfigEntry(o.config_entry_id).catch(() => {});
      const ok = await this._removeEntityRegistryEntry(o.entity_id);
      if (ok) { removed++; console.log(`${LOG_PREFIX} Removed orphan "${o.entity_id}".`); }
    }
    return removed;
  }

  _fire(config) {
    this._config = { ...config };
    this._skipNextRender = true;
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
  }
  _updateConfig(patch) { const next = { ...this._config, ...patch }; this._config = next; this._fire(next); }
  // Nudge HA's own editor PREVIEW pane to re-render after a shared button-style save. Button styles
  // live in the shared WS store (not in the card's config), so the save doesn't change config. The
  // preview card DOES subscribe to the store and re-renders on update — but to guarantee an immediate
  // repaint we also broadcast a DOM event the live card listens for (belt-and-suspenders), bypassing
  // setConfig's byte-identical guard (which would swallow a re-fired unchanged config).
  _nudgeHaPreview() {
    try {
      window.dispatchEvent(new CustomEvent('clm-button-styles-saved', { detail: { ts: 0 } }));
    } catch (e) { /* no-op */ }
  }

  _section(icon, title, id, bodyHtml, desc) {
    const collapsed = this._openSection === id ? '' : ' collapsed';
    // Optional description renders as the first body child (a .cpce-hint), so it
    // shows only when the panel is EXPANDED — the body is hidden when collapsed.
    // Mirrors every other panel (intro hint at the top of the open panel).
    const descHtml = desc ? `<div class="cpce-hint">${desc}</div>` : '';
    return `<div class="cpce-sec${collapsed}" data-sec-id="${id}"><div class="cpce-sec-header" data-target="${id}"><ha-icon icon="${icon}"></ha-icon><span>${title}</span><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></div><div class="cpce-sec-body">${descHtml}${bodyHtml}</div></div>`;
  }

  // A collapsible sub-section inside a settings panel (used to tame the long Card/Button
  // Appearance panels). `key` is a stable id tracked in _openSubpanels; header uses the accent
  // color via .cpce-collapse-head. Body renders only when expanded.
  _subpanel(key, title, bodyHtml) {
    const open = this._openSubpanels.has(key);
    return `<div class="cpce-collapse-head cpce-subpanel-head${open ? '' : ' collapsed'}" data-subpanel="${escapeHtml(key)}"><span class="cpce-subpanel-name">${escapeHtml(title)}</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>${open ? `<div class="cpce-subpanel-body">${bodyHtml}</div>` : ''}`;
  }
  // A Style-Builder subpanel bound to a button-style GROUP. On an overlay layer it carries an
  // include checkbox: unchecked = this layer doesn't define the group (inherits from below);
  // checked = this layer owns the whole group (controls shown). On the base layer (Layer 1) the
  // group is always owned, so no checkbox — just the normal subpanel. `subKey` is the collapse id.
  _btnGroupSubpanel(subKey, group, title, bodyHtml) {
    const editingBase = this._editingLayer && this._editingLayer.idx === 0;
    const owned = !this._layerOwned || this._layerOwned.has(group);
    if (editingBase) return this._subpanel(subKey, title, bodyHtml);   // base: always full, no toggle
    const open = this._openSubpanels.has(subKey) && owned;
    // The include checkbox sits at the FAR LEFT (before the title). When unchecked (disabled) the
    // group is inherited from the base — no controls to expand, so the chevron is hidden and the
    // header isn't clickable-to-open.
    const check = `<label class="cpce-group-include" title="${owned ? 'This layer defines ' + escapeHtml(title) + ' — uncheck to inherit from the base' : 'Enable ' + escapeHtml(title) + ' on this layer'}" onclick="event.stopPropagation();"><input type="checkbox" class="cpce-btn-group-toggle" data-group="${escapeHtml(group)}" ${owned ? 'checked' : ''}></label>`;
    return `<div class="cpce-collapse-head cpce-subpanel-head${open ? '' : ' collapsed'}${owned ? '' : ' cpce-subpanel-inherited cpce-subpanel-nochevron'}" data-subpanel="${escapeHtml(subKey)}">${check}<span class="cpce-subpanel-name">${escapeHtml(title)}</span>${owned ? '<ha-icon icon="mdi:chevron-down"></ha-icon>' : ''}</div>${open ? `<div class="cpce-subpanel-body">${bodyHtml}</div>` : ''}`;
  }

  // ----- entity picker -----
  _getFilteredEntities() {
    if (!this._hass) return [];
    let entities = getLightEntities(this._hass);
    const filter = this._entityFilter;
    if (filter.type === 'label' && filter.value) {
      entities = entities.filter(id => getEntityLabels(this._hass, id).includes(filter.value));
    } else if (filter.type === 'group' && filter.value) {
      entities = entities.filter(id => getEntityAreaId(this._hass, id) === filter.value);
    } else if (filter.type === 'text' && filter.value) {
      const term = filter.value.toLowerCase();
      entities = entities.filter(id => id.toLowerCase().includes(term) || friendlyName(this._hass, id).toLowerCase().includes(term));
    }
    if (this._entitySearch) {
      const s = this._entitySearch.toLowerCase();
      entities = entities.filter(id => id.toLowerCase().includes(s) || friendlyName(this._hass, id).toLowerCase().includes(s));
    }
    return entities;
  }

  // Small chips listing a light's supported color modes (color_temp, xy, rgb, …).
  _colorModesHtml(id) {
    const modes = getSupportedColorModes(this._hass, id);
    if (!modes.length) return '';
    return `<span class="cpce-cm-chips">${modes.map(m => `<span class="cpce-cm-chip">${escapeHtml(m)}</span>`).join('')}</span>`;
  }

  _renderSelectedList() {
    const selected = this._config.entities || [];
    if (!selected.length) return `<div class="cpce-hint" style="margin-top:8px;">No entities added yet.</div>`;
    return `<div class="cpce-selected-list">${selected.map(id => `
      <div class="cpce-selected-item">
        <span class="cpce-sel-name">${escapeHtml(friendlyName(this._hass, id))}</span>
        <span class="cpce-entity-id">${escapeHtml(id)}</span>
        ${this._colorModesHtml(id)}
        <button class="cpce-sel-remove" data-entity="${escapeHtml(id)}" title="Remove">×</button>
      </div>`).join('')}</div>`;
  }

  // Per-light send-method overrides (in Advanced Send Methods). Each card light gets a row with
  // a White-Temp format select and an Effect-timing select; both default to "Card default" and
  // only write into entity_send_methods when set to a real value. Absent = inherit.
  _renderEntitySendMethods() {
    // Every light this card can control: the Default Entities pool ∪ any light targeted by a
    // button's custom list. So a light used by only one button still gets a send-method row.
    const set = new Set(this._config.entities || []);
    (this._config.presets || []).forEach(p => {
      const spec = presetTargetSpec(p);
      if (spec.useCustom) spec.custom.forEach(id => { if (id) set.add(id); });
    });
    const ids = [...set];
    if (!ids.length) return `<div class="cpce-hint">Add lights to Default Entities (or to a button) first — each will appear here so you can override its send methods.</div>`;
    const map = this._config.entity_send_methods || {};
    const cardFmt = this._config.temperature_output_format || 'kelvin';
    const cardSep = !!this._config.effect_separate_call;
    const fmtOpts = [['kelvin','Kelvin'],['xy','XY'],['hs','HS'],['rgb','RGB'],['rgbw','RGBW'],['rgbww','RGBWW']];
    return `
      <div class="cpce-hint">Leave a light on “Card default” unless its controller misbehaves. Overrides apply wherever that light receives a white temperature or an effect.</div>
      <div class="cpce-manage-list">
        ${ids.map(id => {
          const ov = map[id] || {};
          const fmtVal = ov.temperature_output_format || '';
          const sepVal = ov.effect_separate_call === undefined ? '' : (ov.effect_separate_call ? 'separate' : 'merged');
          return `<div class="cpce-esm-item" data-entity="${escapeHtml(id)}">
            <div class="cpce-esm-name">${escapeHtml(friendlyName(this._hass, id))}<span class="cpce-entity-id">${escapeHtml(id)}</span></div>
            <div class="cpce-esm-controls">
              <label class="cpce-esm-field"><span>White Temp</span>
                <select class="cpce-esm-temp" data-entity="${escapeHtml(id)}">
                  <option value="" ${!fmtVal?'selected':''}>Card default (${cardFmt.toUpperCase()})</option>
                  ${fmtOpts.map(([v,l]) => `<option value="${v}" ${fmtVal===v?'selected':''}>${l}</option>`).join('')}
                </select>
              </label>
              <label class="cpce-esm-field"><span>Effect</span>
                <select class="cpce-esm-effect" data-entity="${escapeHtml(id)}">
                  <option value="" ${!sepVal?'selected':''}>Card default (${cardSep?'Separate':'Merged'})</option>
                  <option value="merged" ${sepVal==='merged'?'selected':''}>Merged (one command)</option>
                  <option value="separate" ${sepVal==='separate'?'selected':''}>Separate (two commands)</option>
                </select>
              </label>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  _renderEntityListInner() {
    if (!this._hass) return `<div class="cpce-hint">Loading…</div>`;
    const entities = this._getFilteredEntities();
    const selected = this._config.entities || [];
    if (!entities.length) return `<div class="cpce-hint">No entities match filters.</div>`;
    // Per-row + button adds immediately. Already-added rows show a check instead.
    return entities.map(id => {
      const isAdded = selected.includes(id);
      return `<div class="cpce-entity-row">
        <span class="cpce-sel-name">${escapeHtml(friendlyName(this._hass, id))}</span>
        <span class="cpce-entity-id">${escapeHtml(id)}</span>
        ${this._colorModesHtml(id)}
        ${isAdded
          ? `<ha-icon class="cpce-entity-added" icon="mdi:check-circle" title="Added"></ha-icon>`
          : `<button class="cpce-entity-add" data-entity="${escapeHtml(id)}" title="Add">＋</button>`}
      </div>`;
    }).join('');
  }

  _updateEntityList() {
    const el = this.querySelector('#cpce-entity-list');
    if (!el) return;
    el.innerHTML = this._renderEntityListInner();
    this._attachEntityAddListeners();
    const selEl = this.querySelector('#cpce-selected-list');
    if (selEl) selEl.innerHTML = this._renderSelectedList();
    this._attachSelectedRemoveListeners();
  }

  // Per-row "+" adds that entity immediately, then refreshes both lists.
  _attachEntityAddListeners() {
    this.querySelectorAll('.cpce-entity-add').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.entity;
        const merged = [...new Set([...(this._config.entities || []), id])];
        this._updateConfig({ entities: merged, entity: merged[0] || '' });
        this._updateEntityList();
      };
    });
  }
  _attachSelectedRemoveListeners() {
    this.querySelectorAll('.cpce-sel-remove').forEach(btn => {
      btn.onclick = () => {
        if (!this._confirmDelete(`Remove “${friendlyName(this._hass, btn.dataset.entity)}” from this card?`)) return;
        const entities = (this._config.entities || []).filter(id => id !== btn.dataset.entity);
        this._updateConfig({ entities, entity: entities[0] || '' });
        const selEl = this.querySelector('#cpce-selected-list');
        if (selEl) { selEl.innerHTML = this._renderSelectedList(); this._attachSelectedRemoveListeners(); }
        this._updateEntityList();
      };
    });
  }

  // ----- Scene Manager -----
  _getFilteredScenes() {
    let scenes = getSceneEntities(this._hass);
    const s = (this._sceneSearch || '').toLowerCase();
    if (s) scenes = scenes.filter(id => id.toLowerCase().includes(s) || friendlyName(this._hass, id).toLowerCase().includes(s));
    return scenes;
  }
  _renderSceneListInner() {
    if (!this._hass) return `<div class="cpce-hint">Loading…</div>`;
    const scenes = this._getFilteredScenes();
    const selected = this._config.scenes || [];
    if (!scenes.length) return `<div class="cpce-hint">No scenes match.</div>`;
    return scenes.map(id => {
      const isAdded = selected.includes(id);
      return `<div class="cpce-entity-row">
        <span class="cpce-sel-name">${escapeHtml(friendlyName(this._hass, id))}</span>
        <span class="cpce-entity-id">${escapeHtml(id)}</span>
        ${isAdded
          ? `<ha-icon class="cpce-entity-added" icon="mdi:check-circle" title="Added"></ha-icon>`
          : `<button class="cpce-scene-add" data-scene="${escapeHtml(id)}" title="Add">＋</button>`}
      </div>`;
    }).join('');
  }
  _renderSelectedScenes() {
    const selected = this._config.scenes || [];
    if (!selected.length) return `<div class="cpce-hint" style="margin-top:8px;">No scenes added yet.</div>`;
    return `<div class="cpce-selected-list">${selected.map(id => `
      <div class="cpce-selected-item">
        <span class="cpce-sel-name">${escapeHtml(friendlyName(this._hass, id))}</span>
        <span class="cpce-entity-id">${escapeHtml(id)}</span>
        <button class="cpce-scene-remove cpce-icon-btn" data-scene="${escapeHtml(id)}" title="Remove"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>`).join('')}</div>`;
  }
  _updateSceneList() {
    const el = this.querySelector('#cpce-scene-list');
    if (el) el.innerHTML = this._renderSceneListInner();
    this._attachSceneListeners();
    const selEl = this.querySelector('#cpce-selected-scene-list');
    if (selEl) selEl.innerHTML = this._renderSelectedScenes();
    this._attachSceneListeners();
  }
  _attachSceneListeners() {
    this.querySelectorAll('.cpce-scene-add').forEach(btn => {
      btn.onclick = () => {
        const merged = [...new Set([...(this._config.scenes || []), btn.dataset.scene])];
        this._updateConfig({ scenes: merged });
        this._updateSceneList();
      };
    });
    this.querySelectorAll('.cpce-scene-remove').forEach(btn => {
      btn.onclick = () => {
        if (!this._confirmDelete(`Remove scene “${friendlyName(this._hass, btn.dataset.scene)}” from this card?`)) return;
        const scenes = (this._config.scenes || []).filter(id => id !== btn.dataset.scene);
        this._updateConfig({ scenes });
        this._updateSceneList();
      };
    });
  }

  // ----- color wheel + native-format fields for presets -----
  // The preset stores its color in ONE native format (rgb/xy/hs/rgbw/rgbww) and sends it
  // verbatim. The editor shows a format selector (defaulted from the target lights'
  // supported_color_modes), the wheel for visual picking, and the native fields for the
  // chosen format — typed values are stored as-is, so nothing drifts through a conversion.
  _renderColorWheelEditor(look, index) {
    const fmt = presetColorFormat(look) || 'rgb';
    const rgb = presetColorToRgb(look);                // for wheel + hex preview
    const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
    const v = presetColorValue(look) || [];
    // Supported-mode awareness (union across all targeted entities).
    const supported = getUnionColorModes(this._hass, this._entityIds ? this._entityIds() : (this._config.entities || []));
    const formatOptions = [
      ['rgb', 'RGB', 'rgb'], ['xy', 'XY', 'xy'], ['hs', 'HS', 'hs'],
      ['rgbw', 'RGBW', 'rgbw'], ['rgbww', 'RGBWW', 'rgbww'],
    ];
    // A format is "native" when at least one target light advertises that color mode — it's
    // passed straight through. Non-native formats still work; Home Assistant converts them.
    // We only tag the native ones (an absent tag is not a warning).
    const isNative = (f) => supported.length > 0 && supported.includes(FORMAT_TO_COLOR_MODE[f]);
    const warn = (supported.length && !isNative(fmt))
      ? `<div class="cpce-hint">The selected light(s) don't use <code>${FORMAT_TO_COLOR_MODE[fmt]}</code> natively — Home Assistant will convert it (usually fine; whites may vary on some controllers).</div>` : '';

    // Native fields per format.
    const num = (cls, label, val, min, max, step) =>
      `<div class="cpce-field-col"><label>${label}</label><input type="number" class="${cls}" min="${min}" max="${max}"${step?` step="${step}"`:''} value="${val}"></div>`;
    let fields = '';
    if (fmt === 'rgb') {
      fields = `<div class="cpce-rgb-fields">${num('cpce-c-0','Red',v[0]??rgb[0],0,255)}${num('cpce-c-1','Green',v[1]??rgb[1],0,255)}${num('cpce-c-2','Blue',v[2]??rgb[2],0,255)}</div>`;
    } else if (fmt === 'xy') {
      const xy = v.length===2 ? v : ColorUtils.rgbToXy(rgb[0],rgb[1],rgb[2]);
      fields = `<div class="cpce-xy-fields">${num('cpce-c-0','X',xy[0],0,1,'0.0001')}${num('cpce-c-1','Y',xy[1],0,1,'0.0001')}</div>`;
    } else if (fmt === 'hs') {
      const hs = v.length===2 ? v : ColorUtils.rgbToHs(rgb[0],rgb[1],rgb[2]);
      fields = `<div class="cpce-hs-fields">${num('cpce-c-0','H (Hue)',hs[0],0,360)}${num('cpce-c-1','S (Sat)',hs[1],0,100)}</div>`;
    } else if (fmt === 'rgbw') {
      fields = `<div class="cpce-rgb-fields">${num('cpce-c-0','Red',v[0]??rgb[0],0,255)}${num('cpce-c-1','Green',v[1]??rgb[1],0,255)}${num('cpce-c-2','Blue',v[2]??rgb[2],0,255)}${num('cpce-c-3','White',v[3]??0,0,255)}</div>`;
    } else if (fmt === 'rgbww') {
      fields = `<div class="cpce-rgb-fields">${num('cpce-c-0','Red',v[0]??rgb[0],0,255)}${num('cpce-c-1','Green',v[1]??rgb[1],0,255)}${num('cpce-c-2','Blue',v[2]??rgb[2],0,255)}</div>
                <div class="cpce-rgb-fields" style="margin-top:6px;">${num('cpce-c-3','Cold White',v[3]??0,0,255)}${num('cpce-c-4','Warm White',v[4]??0,0,255)}</div>`;
    }

    return `
      <div class="cpce-color-editor">
        <div class="cpce-row"><label class="lbl">Color Format</label>
          <select class="cpce-color-format" data-index="${index}">
            ${formatOptions.map(([val,label]) => `<option value="${val}" ${fmt===val?'selected':''}>${label}${isNative(val)?' (native)':''}</option>`).join('')}
          </select>
        </div>
        ${warn}
        <div class="cpce-wheel-row">
          <canvas class="cpce-color-wheel" width="150" height="150"></canvas>
          <div class="cpce-color-fields">
            <div class="cpce-hex-row">
              <div class="cpce-hex-preview" style="background:${hex};"></div>
              <input type="text" class="cpce-hex-input" value="${hex}">
            </div>
            <div class="cpce-field-title">${fmt.toUpperCase()} Values</div>
            ${fields}
            <div class="cpce-hint">Stored &amp; sent as <code>${PRESET_COLOR_KEYS[fmt]}</code>. Type exact values here — they're saved as-is.</div>
          </div>
        </div>
      </div>
    `;
  }

  _drawColorWheel(canvas, selectedHue, selectedSat) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2, radius = Math.min(cx, cy) - 4;
    ctx.clearRect(0, 0, w, h);
    for (let angle = 0; angle < 360; angle += 1) {
      const startAngle = (angle - 1) * Math.PI / 180;
      const endAngle = (angle + 1) * Math.PI / 180;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      const [r1, g1, b1] = ColorUtils.hsToRgb(angle, 0);
      const [r2, g2, b2] = ColorUtils.hsToRgb(angle, 100);
      gradient.addColorStop(0, `rgb(${r1},${g1},${b1})`);
      gradient.addColorStop(1, `rgb(${r2},${g2},${b2})`);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    // Draw selection indicator. The wheel is painted with hue = canvas angle measured
    // clockwise from east (3 o'clock) with no offset, so the indicator for a given hue
    // must use that same convention — cos/sin of the hue directly (canvas y is down, so
    // this naturally goes clockwise). Any offset here would desync the handle from the
    // painted color under it (and from the click handler below, which is also offset-free).
    const selAngle = selectedHue * Math.PI / 180;
    const selDist = (selectedSat / 100) * radius;
    const sx = cx + Math.cos(selAngle) * selDist;
    const sy = cy + Math.sin(selAngle) * selDist;
    ctx.beginPath();
    ctx.arc(sx, sy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, 5.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _wireColorWheel(container, presetIndex) {
    // Color format selector — changes which native fields are shown; needs a re-render.
    const fmtSel = container.querySelector('.cpce-color-format');
    if (fmtSel) fmtSel.addEventListener('change', () => this._setPresetColorFormat(presetIndex, fmtSel.value));

    const canvas = container.querySelector('.cpce-color-wheel');
    if (canvas) {
      const preset = (this._config.presets || [])[presetIndex];
      const rgb = presetColorToRgb(preset);
      const hs0 = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]);
      this._drawColorWheel(canvas, hs0[0], hs0[1]);
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const radius = Math.min(cx, cy) - 4;
      const updateFromWheel = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        const px = (clientX - rect.left) * (canvas.width / rect.width) - cx;
        const py = (clientY - rect.top) * (canvas.height / rect.height) - cy;
        const dist = Math.min(Math.sqrt(px * px + py * py), radius);
        let angle = Math.atan2(py, px) * 180 / Math.PI;
        if (angle < 0) angle += 360;
        const hue = Math.round(angle) % 360;
        const sat = Math.round((dist / radius) * 100);
        // The wheel picks a hue/sat → convert to whatever the preset's current format needs.
        this._setPresetColorFromRgb(presetIndex, ColorUtils.hsToRgb(hue, sat));
      };
      let dragging = false;
      canvas.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; updateFromWheel(e.clientX, e.clientY); });
      window.addEventListener('mousemove', (e) => { if (dragging) updateFromWheel(e.clientX, e.clientY); });
      window.addEventListener('mouseup', () => { dragging = false; });
      canvas.addEventListener('touchstart', (e) => { dragging = true; updateFromWheel(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
      window.addEventListener('touchmove', (e) => { if (dragging) updateFromWheel(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
      window.addEventListener('touchend', () => { dragging = false; });
    }

    // Hex box → sets color from an RGB hex (respects the current format's storage).
    const hexEl = container.querySelector('.cpce-hex-input');
    if (hexEl) hexEl.addEventListener('change', () => {
      const rgb = ColorUtils.hexToRgb(hexEl.value);
      if (rgb) this._setPresetColorFromRgb(presetIndex, rgb);
    });

    // Native numeric fields (cpce-c-0..4) → store the typed values VERBATIM under the
    // current format's key. This is the fix for the XY-drift bug: no lossy round-trip.
    const fieldEls = [...container.querySelectorAll('[class*="cpce-c-"]')];
    fieldEls.forEach(el => el.addEventListener('change', () => this._commitPresetNativeFields(presetIndex, container)));
  }

  // Reads the native fields for the preset's current format and stores them verbatim.
  _commitPresetNativeFields(index, container) {
    const preset = (this._config.presets || [])[index];
    const fmt = presetColorFormat(preset) || 'rgb';
    const read = (i, isFloat) => {
      const el = container.querySelector(`.cpce-c-${i}`);
      if (!el) return 0;
      return isFloat ? (parseFloat(el.value) || 0) : (parseInt(el.value, 10) || 0);
    };
    let value;
    if (fmt === 'xy') value = [clamp(read(0, true), 0, 1), clamp(read(1, true), 0, 1)];
    else if (fmt === 'hs') value = [clamp(read(0), 0, 360), clamp(read(1), 0, 100)];
    else if (fmt === 'rgb') value = [0,1,2].map(i => clamp(read(i), 0, 255));
    else if (fmt === 'rgbw') value = [0,1,2,3].map(i => clamp(read(i), 0, 255));
    else if (fmt === 'rgbww') value = [0,1,2,3,4].map(i => clamp(read(i), 0, 255));
    this._storePresetColor(index, fmt, value);
    this._refreshPresetColorPreview(index);
  }

  // Wheel/hex give us an RGB triple; convert to the preset's current format and store.
  _setPresetColorFromRgb(index, rgb) {
    const preset = (this._config.presets || [])[index];
    const fmt = presetColorFormat(preset) || 'rgb';
    let value;
    switch (fmt) {
      case 'xy': value = ColorUtils.rgbToXy(rgb[0], rgb[1], rgb[2]); break;
      case 'hs': value = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]); break;
      case 'rgbw': value = [rgb[0], rgb[1], rgb[2], (preset[PRESET_COLOR_KEYS.rgbw] || [])[3] || 0]; break;
      case 'rgbww': { const cur = preset[PRESET_COLOR_KEYS.rgbww] || []; value = [rgb[0], rgb[1], rgb[2], cur[3] || 0, cur[4] || 0]; break; }
      default: value = rgb.slice(0, 3);
    }
    this._storePresetColor(index, fmt, value);
    this._refreshPresetColorPreview(index);
  }

  // Writes the color value under the format's native key, clearing other color keys and any
  // leftover temperature (a color preset is color-only). Marks the preset dirty for save.
  _storePresetColor(index, fmt, value) {
    const presets = [...(this._config.presets || [])];
    const p = { ...presets[index] };
    ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]);
    p[PRESET_COLOR_KEYS[fmt]] = value;
    delete p.color_kelvin;
    delete p.action;
    presets[index] = p;
    this._updateConfig({ presets });
    this._markPresetDirty(index);
    // Editing a linked preset does NOT auto-write to its Color Entity — the entity stays the
    // source of truth. Edits are "dirty" until the user clicks Save to Entity; otherwise they
    // revert when the preset editor is closed.
  }

  // Legacy no-op: linked buttons no longer store their own color (the entity is the single
  // source of truth and is edited in the Color Entities panel), so there are no "unsaved edits"
  // to track. Kept because inline color-edit handlers still call it for unlinked buttons, where
  // it early-returns (no input_color_entity).
  _markPresetDirty(index) {
    const preset = (this._config.presets || [])[index];
    if (!preset || !preset.input_color_entity) return;   // unlinked → nothing to track
    // A linked button has no inline editors, so this path shouldn't be reached; guard anyway.
  }

  // Legacy no-op (see _markPresetDirty): nothing to revert now that linked buttons hold no
  // color. Retained so the preset-close call site stays valid.
  _revertUnsavedLinkedPreset(index) { /* linked buttons store no color; nothing to revert */ }

  // Live-update the swatch/wheel/hex preview after a color change (no full re-render, so
  // the field the user is typing in keeps focus). Native field values are authoritative.
  _refreshPresetColorPreview(index) {
    const container = this.querySelector(`.cpce-preset-editor[data-index="${index}"]`);
    if (!container) return;
    const preset = (this._config.presets || [])[index];
    const rgb = presetColorToRgb(preset);
    const hs = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]);
    const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
    const hexEl = container.querySelector('.cpce-hex-input');
    if (hexEl && document.activeElement !== hexEl) hexEl.value = hex;
    const preview = container.querySelector('.cpce-hex-preview');
    if (preview) preview.style.background = hex;
    this._drawColorWheel(container.querySelector('.cpce-color-wheel'), hs[0], hs[1]);
    const swatch = container.querySelector('.cpce-preset-swatch');
    if (swatch) swatch.style.background = this._presetSwatch(preset);
  }

  // Switches a preset's color format, converting the current color into the new format so
  // the visible color is preserved. Full re-render to swap the native fields shown.
  _setPresetColorFormat(index, fmt) {
    const presets = [...(this._config.presets || [])];
    const preset = presets[index];
    const rgb = presetColorToRgb(preset);
    let value;
    switch (fmt) {
      case 'xy': value = ColorUtils.rgbToXy(rgb[0], rgb[1], rgb[2]); break;
      case 'hs': value = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]); break;
      case 'rgbw': value = [rgb[0], rgb[1], rgb[2], 0]; break;
      case 'rgbww': value = [rgb[0], rgb[1], rgb[2], 0, 0]; break;
      default: value = rgb.slice(0, 3);
    }
    this._storePresetColor(index, fmt, value);
    this._render();
  }

  // ----- preset editor rows -----
  // Editor-local copies of the renderer's glow-source resolution (the editor class doesn't share the
  // card's methods). Kept intentionally minimal — only what the swatch + follow-lights preview need:
  // explicit glow_entities → HA-native scene members → []. No section-target fallback (matches the
  // card's no-fallback rule for scene buttons).
  _glowSourceIds(preset) {
    const follow = Array.isArray(preset && preset.glow_entities) ? preset.glow_entities.filter(Boolean) : [];
    if (follow.length) return follow;
    if (buttonMode(preset) === 'scene') return this._sceneMemberLightIds(preset);
    return [];
  }
  _sceneMemberLightIds(preset) {
    const ref = preset && preset.scene_ref;
    const st = ref && this._hass && this._hass.states[ref];
    const members = (st && st.attributes && Array.isArray(st.attributes.entity_id)) ? st.attributes.entity_id : [];
    return members.filter(id => typeof id === 'string' && id.startsWith('light.'));
  }
  _presetPrimaryState(preset) {
    const use = this._glowSourceIds(preset);
    if (!use.length || !this._hass) return null;
    let firstOn = null;
    for (const id of use) { const st = this._hass.states[id]; if (st && st.state === 'on') { firstOn = st; break; } }
    return firstOn || this._hass.states[use[0]] || null;
  }
  _presetLiveColor(state) {
    if (state && state.state === 'on') {
      const a = state.attributes || {};
      let rgb = Array.isArray(a.rgb_color) ? a.rgb_color
        : (Array.isArray(a.xy_color) ? ColorUtils.xyToRgb(a.xy_color[0], a.xy_color[1]) : null);
      if (!rgb) { const k = attrsToKelvin(a); if (k !== undefined) rgb = ColorUtils.kelvinToRgb(k); }
      if (rgb) return ColorUtils.rgbToHex(...rgb);
    }
    return null;
  }
  // Editor mirror of the card's body-color resolution: fixed Style Color → (live only when active)
  // → grey. Used for the summary swatch so it matches what renders on the card.
  _presetBodyColor(preset, state) {
    const bodyFixed = preset.button_style_color || null;
    if (bodyFixed) return bodyFixed;
    const live = this._presetLiveColor(state);
    // The editor has no last-pressed signal; scene "active" is deterministic via selectsActive (all
    // bound helpers match), which needs only hass — so a null activeId is fine here.
    const active = isPresetActiveFor(this._effectivePreset(preset), state, this._config && this._config.temperature_output_format, null, presetSelectsActive(preset, this._hass));
    return (active && live) ? live : '#424242';
  }
  _presetSwatch(preset) {
    // Scene / follow-color buttons: the swatch mirrors the card body color (fixed Style Color →
    // live-when-active → grey), so the editor summary matches what shows.
    if (buttonMode(preset) === 'scene' || (Array.isArray(preset.glow_entities) && preset.glow_entities.length > 0)) {
      return this._presetBodyColor(preset, this._presetPrimaryState(preset));
    }
    // Explicit button style color wins (used for scene-only / None buttons).
    if (preset.button_style_color) { const rgb = ColorUtils.hexToRgb(preset.button_style_color); if (rgb) return ColorUtils.rgbToHex(...rgb); }
    const look = this._effectivePreset(preset);
    if (look.action === 'turn_off') return 'transparent';
    if (presetColorFormat(look)) return ColorUtils.rgbToHex(...presetColorToRgb(look));
    if (look.color_kelvin) return ColorUtils.rgbToHex(...ColorUtils.kelvinToRgb(look.color_kelvin));
    return '#888';
  }

  // Linkage badges shown in the preset title row — one per association a button has, each
  // with its own icon. NEVER shows a "not-linked" badge. A button can carry several at once
  // (e.g. a Color Entity link AND scenes), so all applicable badges render together:
  //   Color Entity link → mdi:link-variant (broken → mdi:link-variant-off, error color)
  //   Fixture Profile   → mdi:palette-swatch (missing profile → warning color)
  //   Scene(s)          → mdi:palette
  _presetLinkIcon(preset) {
    const badges = [];
    // Section chip (no icon): which buttons section this button lives in — or "Unassigned" for a
    // tile-only button. Purely informational; always shown first.
    const unassigned = preset.section_id === '__none__';
    if (unassigned) {
      badges.push(`<span class="cpce-summary-chip" title="Not shown on the card — tile look only">Unassigned</span>`);
    } else {
      const sec = this._sectionForPreset(preset);
      const secName = (sec && sec.name) || 'Buttons';
      badges.push(`<span class="cpce-summary-chip" title="In button section “${escapeHtml(secName)}”">${escapeHtml(secName)}</span>`);
    }
    // Color Entity link → a chip showing the bound entity's NAME, prefixed with a link icon.
    const linked = preset.input_color_entity;
    if (linked) {
      const exists = this._allInputColorEntities.includes(linked);
      const nm = exists ? friendlyName(this._hass, linked) : linked;
      badges.push(`<span class="cpce-summary-chip${exists ? '' : ' cpce-chip-broken'}" title="${exists ? 'Bound to Color Entity ' + escapeHtml(linked) : 'Broken link — ' + escapeHtml(linked) + ' no longer exists'}"><ha-icon icon="${exists ? 'mdi:link-variant' : 'mdi:link-variant-off'}"></ha-icon>${escapeHtml(nm)}</span>`);
    }
    // Fixture Profile reference → a chip with the profile name, prefixed with a link icon.
    const slug = fixtureRefSlug(preset.profile_ref);
    if (slug) {
      const entry = fixtureLibraryMap(this._config && this._config.fixture_library_scope)[slug];
      badges.push(`<span class="cpce-summary-chip${entry ? '' : ' cpce-chip-broken'}" title="${entry ? 'Uses Fixture Profile ' + escapeHtml(entry.name || slug) : 'Missing Fixture Profile ' + escapeHtml(slug)}"><ha-icon icon="${entry ? 'mdi:link-variant' : 'mdi:link-variant-off'}"></ha-icon>${escapeHtml(entry ? (entry.name || slug) : slug)}</span>`);
    }
    // Scene Selects → a chip "N scene(s)" (count of input_select bindings). Replaces the palette icon.
    const nSel = presetSelects(preset).length;
    if (nSel) {
      badges.push(`<span class="cpce-summary-chip" title="Bound to ${nSel} scene helper${nSel === 1 ? '' : 's'} (Scene Selects)"><ha-icon icon="mdi:link-variant"></ha-icon>${nSel} scene${nSel === 1 ? '' : 's'}</span>`);
    }
    return badges.join('');
  }

  // Standard confirmation gate for every destructive (delete/remove) action in the editor, so
  // a stray click can't silently destroy config. Returns true only if the user confirms.
  // Keep the message specific ("Delete the button 'Warm'?") so it's clear what's being removed.
  _confirmDelete(message) {
    return window.confirm(message || 'Delete this item? This cannot be undone.');
  }

  // Reusable target-entities picker: "All card entities" or "Specific", and when specific,
  // a checkbox per card entity. `dataAttr` (e.g. data-preset-target="2") identifies the
  // owner so the change handler can route the update. Reused by presets and slider sections.
  // Reusable text-styling controls (size / weight / color). `idBase` prefixes the field ids
  // (e.g. "cpce-title" → cpce-title-size / -weight / -color). Values are the current ones.
  _textStyleControls(idBase, { size, weight, color }, sizeDefault) {
    const sz = Number(size) || sizeDefault;
    const wt = weight || '500';
    const weights = ['300', '400', '500', '600', '700'];
    return `
      <div class="cpce-row"><label class="lbl">Text Size</label><input type="range" id="${idBase}-size" min="8" max="40" value="${sz}"><span class="cpce-strength-val" id="${idBase}-size-val">${sz}px</span></div>
      <div class="cpce-row"><label class="lbl">Text Weight</label>
        <select id="${idBase}-weight">${weights.map(w => `<option value="${w}" ${wt===w?'selected':''}>${w}</option>`).join('')}</select>
      </div>
      <div class="cpce-row"><label class="lbl">Text Color</label>
        <select id="${idBase}-color-mode">
          <option value="theme" ${!color?'selected':''}>Theme default</option>
          <option value="fixed" ${color?'selected':''}>Custom color</option>
        </select>
      </div>
      ${color ? `<div class="cpce-row"><label class="lbl">Custom Color</label><input type="color" id="${idBase}-color" value="${color}"></div>` : ''}
    `;
  }

  // Wires the reusable text-style controls. onChange(patch) receives {size,weight,color}
  // deltas; color '' means theme. Color-mode change re-renders to toggle the picker.
  _wireTextStyleControls(root, idBase, onChange, defColor) {
    const q = (s) => root.querySelector(s);
    const sizeEl = q(`#${idBase}-size`);
    if (sizeEl) { sizeEl.addEventListener('input', () => { const v = q(`#${idBase}-size-val`); if (v) v.textContent = `${sizeEl.value}px`; }); sizeEl.addEventListener('change', () => onChange({ size: parseInt(sizeEl.value, 10) })); }
    const weightEl = q(`#${idBase}-weight`);
    if (weightEl) weightEl.addEventListener('change', () => onChange({ weight: weightEl.value }));
    const modeEl = q(`#${idBase}-color-mode`);
    if (modeEl) modeEl.addEventListener('change', () => { onChange({ color: modeEl.value === 'fixed' ? (defColor || '#ffffff') : '' }); this._render(); });
    const colorEl = q(`#${idBase}-color`);
    if (colorEl) colorEl.addEventListener('input', () => onChange({ color: colorEl.value }));
  }

  // A row of removable chips for a set of selected ids. `kind` = on|off|scene (chip color).
  // `removeCls` names the ✕ button class the wiring listens on.
  _renderChips(ids, kind, removeCls) {
    if (!ids || !ids.length) return '';
    return `<div class="cpce-chips">${ids.map(id => `
      <span class="cpce-chip ${kind}">${escapeHtml(friendlyName(this._hass, id))}<span class="cpce-chip-x ${removeCls}" data-id="${escapeHtml(id)}">✕</span></span>
    `).join('')}</div>`;
  }
  // Read-only chips (no ✕) for a fixed set — used to show the live Default Entities pool.
  _renderStaticChips(ids, kind) {
    if (!ids || !ids.length) return '';
    return `<div class="cpce-chips">${ids.map(id => `
      <span class="cpce-chip ${kind}">${escapeHtml(friendlyName(this._hass, id))}</span>
    `).join('')}</div>`;
  }

  // Button Appearance Presets: save the current button-appearance settings as a named, shared
  // preset (system store, reusable across cards), apply/rename/delete, and export/import as JSON
  // (the cross-card bridge until a shared kit exists). Captures BUTTON_APPEARANCE_KEYS only.
  // A small live preview of the current Card Default button look — two sample buttons (a colored
  // one + an Off one) built from the same cfg the live card reads, so the Builder isn't styled
  // blind. Reflects style (solid/tinted), border, gradient border, glow, radius, and sizing.
  // Scoped copy of the card's .cpc-preset-btn CSS so the editor preview (a SEPARATE element that
  // lacks the card's <style>) renders buttons identically. Scoped under .cpce-btn-preview so it
  // never leaks. Mirrors the metric rules in the card's global block (bg/border/glow/name are
  // emitted inline by _renderPresetButton, so only layout/padding/font/tile rules live here).
  _buttonPreviewScopedCss(cfg) {
    const scale = Number(cfg.scale) || 1.0;
    const fs = Number(cfg.button_font_size) || 14;
    const fw = cfg.button_name_weight || '600';
    const h = Number(cfg.button_height) || 44;
    const iconGap = Number.isFinite(Number(cfg.button_icon_gap)) ? Number(cfg.button_icon_gap) : 8;
    const wrap = cfg.button_name_wrap === true;
    return `<style>
      .cpce-btn-preview .cpc-presets { display:flex; gap:${Number(cfg.gap)||8}px; flex-wrap:wrap; }
      .cpce-btn-preview .cpc-preset-btn { display:flex; align-items:center; justify-content:center; gap:calc(${iconGap}px * ${scale}); padding:calc(${h}px * ${scale} / 3.15) calc(18px * ${scale}); border-radius:10px; border:none; font-size:calc(${fs}px * ${scale}); font-weight:${fw}; color:#000; background:#fff; position:relative; z-index:0; min-width:90px; }
      .cpce-btn-preview .cpc-preset-btn .cpc-btn-label { font-weight:${fw}; ${wrap ? 'white-space:normal; overflow-wrap:anywhere; text-align:center;' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'} }
      .cpce-btn-preview .cpc-preset-btn.cpc-glowing { z-index:1; }
      .cpce-btn-preview .cpc-preset-btn.off-style { background:transparent; border:2px solid var(--divider-color); color:var(--primary-text-color); }
      .cpce-btn-preview .cpc-preset-btn ha-icon { --mdc-icon-size:calc(18px * ${scale}); }
      .cpce-btn-preview .cpc-preset-btn.cpc-tile { flex-direction:row; justify-content:flex-start; align-items:center; gap:calc(${iconGap}px * ${scale}); min-height:calc(${h}px * ${scale} * 1.6); padding:calc(14px * ${scale}) calc(16px * ${scale}); border-radius:calc(18px * ${scale}); color:var(--primary-text-color); text-align:left; }
      .cpce-btn-preview .cpc-preset-btn.cpc-tile ha-icon { --mdc-icon-size:calc(26px * ${scale}); color:var(--cpc-tile-icon-color, var(--primary-text-color)); flex-shrink:0; }
      .cpce-btn-preview .cpc-preset-btn.cpc-tile .cpc-tile-name { font-size:calc(${fs}px * ${scale}); }
    </style>`;
  }
  // Renders two sample buttons by driving the REAL renderer with fake presets + fake states — so the
  // preview is byte-for-byte the same as the live card (no drift). Sample = an active colored button;
  // Off = an inactive turn-off button. `stack` is the layer stack; each sample flattens it through
  // its OWN condition evaluation (Sample → button_active true; Off → button_off true), so per-button
  // overlays isolate to the right sample — exactly like the live card. Falls back to the Built-In
  // look only when a sample's flatten is fully empty. Shared by all three preview callers.
  _renderButtonSampleRow(stack, baseCfg) {
    const samplePreset = { id: '__preview_sample__', name: 'Sample', icon: 'mdi:palette', mode: 'color', rgb_color: [33, 150, 243] };
    const sampleState = { state: 'on', attributes: { rgb_color: [33, 150, 243] } };
    const offPreset = { id: '__preview_off__', name: 'Off', icon: 'mdi:palette', mode: 'off', action: 'turn_off' };
    const offState = { state: 'on', attributes: {} };
    // Per-sample condition evaluator: mirrors _buttonStyleForPreset. button_active is true only for
    // the colored Sample; button_off is true only for the Off sample; section-scoped conditions
    // (light_on/off, entity_state) are treated as active so authored looks are visible in preview.
    const cfgFor = (preset, activeType) => {
      const isActive = (when) => {
        if (!when || !when.type) return true;
        if (when.type === 'button_active') return activeType === 'active';
        if (when.type === 'button_off') return activeType === 'off';
        return true;   // section-scoped conditions: show in preview
      };
      return { ...baseCfg, ...extractButtonAppearance(flattenButtonStack(stack, isActive)) };
    };
    const sampleCfg = cfgFor(samplePreset, 'active');
    const offCfg = cfgFor(offPreset, 'off');
    // Scoped CSS uses layout/metric keys, which are the same across samples → use the Sample's cfg.
    return `${this._buttonPreviewScopedCss(sampleCfg)}<div class="cpce-btn-preview" style="padding:10px;border:1px dashed var(--divider-color,#333);border-radius:6px;margin-bottom:8px;background:var(--ha-card-background,#1a1a1a);">
      <div class="cpc-presets">
        ${renderPresetButtonHtml(samplePreset, samplePreset, sampleCfg, sampleState, sampleCfg.temperature_output_format)}
        ${renderPresetButtonHtml(offPreset, offPreset, offCfg, offState, offCfg.temperature_output_format)}
      </div>
    </div>`;
  }

  // Preview B — under the Style Builder. Shows the preset WITH your current unsaved Builder edits:
  // the draft's layers flattened, but the layer currently loaded into the Builder is overridden
  // live by the Builder's settings (so typing in the Builder updates this in real time). With no
  // preset editor open, it's just this card's Card Default (the raw Builder settings).
  _renderButtonStylePreview() {
    const draft = this._stackDraft;
    let stack, labelHtml = '';
    if (draft && draft.slug) {
      // The edited layer isn't hidden even if its hide toggle is on, so you can see what you're editing.
      const libEntry = buttonStyleLibraryMap()[draft.slug];
      const editing = (this._editingLayer && this._editingLayer.slug === draft.slug) ? this._editingLayer.idx : null;
      const layers = draft.layers.map((l, i) => (i === editing) ? { ...l, hidden: false } : l);
      stack = { ...(libEntry || {}), layers };
      const nm = (libEntry && libEntry.name) || draft.slug;
      const layerSuffix = (editing != null) ? ` Layer ${editing + 1}` : '';
      labelHtml = `<span class="cpce-preview-title">UNSAVED STYLE CHANGES (${escapeHtml(nm)}${layerSuffix})</span>`;
    } else {
      stack = builtinButtonStack(BTN_STYLE_BASIC_SLUG);
      labelHtml = `<span class="cpce-preview-title">PREVIEW (${escapeHtml(stack.name)})</span>`;
    }
    return `<div class="cpce-hint">${labelHtml}</div>${this._renderButtonSampleRow(stack, this._config)}`;
  }

  // Preview A — under a preset's layers. Shows the preset exactly as SAVED in the library (all
  // layers flattened, conditions treated as met, hidden layers skipped): the current saved look.
  _renderSavedPresetPreview(slug) {
    const e = buttonStyleLibraryMap()[slug]; if (!e) return '';
    // CURRENT STYLE = the SAVED library look (the "before"). Renders the saved stack straight from
    // the library (not the draft), so it stays fixed while you edit. Per-sample conditions are
    // evaluated inside _renderButtonSampleRow.
    return `<div class="cpce-hint" style="margin-top:6px;"><span class="cpce-preview-title"><ha-icon icon="mdi:content-save-check-outline" style="--mdc-icon-size:14px;"></ha-icon> CURRENT STYLE</span></div>${this._renderButtonSampleRow(e, this._config)}`;
  }

  // Frame Styles library panel (Color-card authoring surface). Lists the
  // read-only Built-In plus the shared System frames (ltek_frame_library), with
  // per-row duplicate / export / delete, an Add + Import row, and a Card Frame
  // picker (which presets layer onto this card). Full per-group visual editing
  // (glow/shadow/border sliders) also lives in the Easy Entity Styler card; this
  // panel focuses on library management + applying frames to the Color card.
  _renderFramePresets() {
    const lib = frameLibraryMap((this._config && this._config.frame_library_scope) || 'system');
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    const cardRef = (this._config && this._config.card_frame) || { presets: [] };
    const applied = Array.isArray(cardRef.presets) ? cardRef.presets : [];
    const rows = [{ id: BUILTIN_FRAME_ID, e: builtinFramePreset(), builtin: true }]
      .concat(slugs.map(s => ({ id: 'lib:' + s, e: lib[s], builtin: false })));
    const groupsOf = e => ['glow', 'shadow', 'border', 'background', 'edges'].filter(g => e[g]).join(' + ') || '(empty)';
    // Human summary of a preset's condition (if any) — surfaced so a conditional
    // frame reads clearly here even though the full condition builder is in EESC.
    const condOf = e => {
      if (e.when_kind === 'section_has_entities') return ' · when a section has entities (EESC only)';
      if (e.when_kind === 'section_empty') return ' · when a section is empty (EESC only)';
      if (e.when && e.when_entity) {
        const op = e.when.op || 'eq';
        const opTxt = { eq: '=', ne: '≠', gt: '>', lt: '<', ge: '≥', le: '≤', is_on: 'is on', is_off: 'is off', unavailable: 'unavailable' }[op] || op;
        const val = ['is_on', 'is_off', 'unavailable'].includes(op) ? '' : ` ${e.when.value ?? ''}`;
        return ` · when ${e.when_entity} ${opTxt}${val}`;
      }
      return '';
    };
    return `
      <div class="cpce-hint">Build, edit and store styles. To apply a Frame, use Card Appearance → Card Frame or per section in the section under Section Order.<br><br>Library items are shared system-wide. Built-In is read-only; duplicate to customize.</div>
      <div class="cpce-row" style="gap:8px; margin-bottom:6px;">
        <button class="cpce-create-preset-btn" id="cpce-frame-add"><ha-icon icon="mdi:plus"></ha-icon> New Frame</button>
        <button class="cpce-mini-btn" id="cpce-frame-import"><ha-icon icon="mdi:import"></ha-icon> Import JSON…</button>
      </div>
      <div class="cpce-manage-list">${rows.map(({ id, e, builtin }) => {
        const used = applied.includes(id);
        const open = this._openFrame === id;
        // While open, the builder edits a DRAFT (this._frameDraft) — nothing is
        // written to the shared library until Save. Show the draft's live look.
        const draft = (open && this._frameDraft && this._frameDraft.id === id) ? this._frameDraft : null;
        const dirty = !!(draft && draft.dirty);
        const view = draft ? draft.fx : e;
        return `<div class="cpce-manage-item${dirty ? ' cpce-item-unsaved' : ''}" data-frame-id="${escapeHtml(id)}">
          <ha-icon icon="${builtin ? 'mdi:lock' : 'mdi:auto-fix'}" style="color:var(--primary-color);flex-shrink:0;"></ha-icon>
          <span class="cpce-ce-name">${escapeHtml(view.name || id)}${dirty ? ' <span class="cpce-unsaved-dot" title="Unsaved changes">●</span>' : ''}<span class="cpce-entity-id">${builtin ? 'built-in (read-only) · ' : ''}${escapeHtml(groupsOf(view))}${escapeHtml(condOf(view))}${view.note ? ' · 📝 ' + escapeHtml(view.note) : ''}</span></span>
          ${used ? '<span class="cpce-order-type">on card</span>' : ''}
          ${builtin ? '' : `<button class="cpce-icon-btn cpce-frame-edit${open ? ' active' : ''}" data-frame-id="${escapeHtml(id)}" title="Edit this frame's visuals"><ha-icon icon="mdi:pencil"></ha-icon></button>`}
          <button class="cpce-icon-btn cpce-frame-duplicate" data-frame-id="${escapeHtml(id)}" title="Duplicate into an editable System frame"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
          <button class="cpce-icon-btn cpce-frame-export" data-frame-id="${escapeHtml(id)}" title="Export JSON"><ha-icon icon="mdi:download"></ha-icon></button>
          ${builtin ? '' : `<button class="cpce-delete-entity-btn cpce-frame-delete" data-frame-id="${escapeHtml(id)}" title="Delete from the shared library"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>`}
        </div>${open && !builtin ? `<div class="cpce-frame-builder-panel${dirty ? ' cpce-panel-unsaved' : ''}" data-frame-id="${escapeHtml(id)}">${this._renderFrameBuilder(id, view)}${this._renderFrameSaveRow(id, dirty)}</div>` : ''}`;
      }).join('')}</div>
    `;
  }

  // Per-section Frame Style applicator (in a section's gear panel). Single-select:
  // None / Built-In / a system frame → stores section.frame = { presets:[id] }.
  // Building/editing frames stays in the Frame Styles library; this only applies.
  // Compact human summary of a frame's condition (if any), so a conditional
  // layer reads clearly in an applied stack. Empty string when unconditional.
  _frameCondText(e) {
    if (!e) return '';
    if (e.when_kind === 'section_has_entities') return 'when a section has entities (EESC only)';
    if (e.when_kind === 'section_empty') return 'when a section is empty (EESC only)';
    if (e.when && e.when_entity) {
      const op = e.when.op || 'eq';
      const opTxt = { eq: '=', ne: '≠', gt: '>', lt: '<', ge: '≥', le: '≤', is_on: 'is on', is_off: 'is off', unavailable: 'unavailable' }[op] || op;
      const val = ['is_on', 'is_off', 'unavailable'].includes(op) ? '' : ` ${e.when.value ?? ''}`;
      return `when ${e.when_entity} ${opTxt}${val}`;
    }
    return '';
  }

  // A per-location condition-override row for one applied frame preset. Shown for
  // an entity-conditional preset that isn't force-applied (ignore cond.). Lets a
  // card/section rebind the entity + operator + value the preset's condition tests
  // HERE — the shared library preset is unchanged. Blank fields inherit the preset.
  // `scopeAttrs` places the scope keys (data-cf-* for the card, data-sf-* +
  // data-sid for a section) so the wiring can target the right frame ref.
  _frameOverrideRow(id, preset, ov, scopeAttrs) {
    const p = preset || {};
    const o = ov || {};
    const ovWhen = (o.when && typeof o.when === 'object') ? o.when : {};
    const pWhen = p.when || {};
    const effOp = ovWhen.op || pWhen.op || 'is_on';
    const has = !!(o.when_entity || (o.when && o.when.op));
    const opts = this._HDR_OPS.map(([v, l]) => `<option value="${v}" ${effOp === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
    return `<div class="cpce-fr-override" ${scopeAttrs}>
      <div class="cpce-hint" title="Override this preset's condition here only — the shared library preset is unchanged. Blank fields inherit the preset's own condition.">Condition override (here only)${has ? '' : ' — <em>inheriting preset</em>'}</div>
      <div class="cpce-row" style="gap:6px;">
        <input type="text" class="cpce-fr-ov-entity" ${scopeAttrs} value="${escapeHtml(o.when_entity || '')}" placeholder="${escapeHtml(p.when_entity || 'entity id')}" style="flex:1;min-width:0;" title="Entity the condition tests (blank = preset's own)">
        <select class="cpce-fr-ov-op" ${scopeAttrs} title="Operator">${opts}</select>
        <input type="text" class="cpce-fr-ov-value" ${scopeAttrs} value="${escapeHtml(ovWhen.value ?? '')}" placeholder="${escapeHtml(pWhen.value ?? 'value')}" style="width:80px;" title="Compare value (blank = preset's own)">
        ${has ? `<button class="cpce-icon-btn cpce-fr-ov-clear" ${scopeAttrs} title="Clear override — inherit the library preset's condition"><ha-icon icon="mdi:backup-restore"></ha-icon></button>` : ''}
      </div>
    </div>`;
  }

  // Per-section Frame Style applicator (in a section's gear panel). A LAYERED
  // STACK — same model as the Card Frame — so a base style can be combined with
  // one or more conditional overlays (each layer's optional `when` decides if it
  // applies; last active layer wins per property). Building/editing frames stays
  // in the Frame Styles library; this only applies them.
  // Scene Tracker section config: a repeatable Areas list. Each Area = a name + an input_select
  // (the scene state) + an optional representative light (for a live color/brightness readout).
  _renderSceneTrackerConfig(s) {
    const areas = Array.isArray(s.areas) ? s.areas : [];
    const selects = this._allInputSelectEntities();
    const lights = (this._hass && this._hass.states) ? Object.keys(this._hass.states).filter(id => id.startsWith('light.')).sort() : [];
    const row = (a, i) => `<div class="cpce-row cpce-area-row" data-section-id="${s.id}" data-area="${i}" style="gap:6px;flex-wrap:wrap;">
      <input type="text" class="cpce-area-name" data-section-id="${s.id}" data-area="${i}" placeholder="Area name" value="${escapeHtml((a && a.name) || '')}" style="flex:1;min-width:110px;">
      <select class="cpce-area-entity" data-section-id="${s.id}" data-area="${i}" style="flex:1.5;min-width:150px;">
        <option value="">input_select…</option>
        ${selects.map(x => `<option value="${escapeHtml(x.entity)}" ${a && a.entity === x.entity ? 'selected' : ''}>${escapeHtml(friendlyName(this._hass, x.entity))}</option>`).join('')}
        ${(a && a.entity && !selects.some(x => x.entity === a.entity)) ? `<option value="${escapeHtml(a.entity)}" selected>${escapeHtml(a.entity)} (missing)</option>` : ''}
      </select>
      <select class="cpce-area-light" data-section-id="${s.id}" data-area="${i}" style="flex:1.5;min-width:150px;">
        <option value="">(optional light)</option>
        ${lights.map(id => `<option value="${escapeHtml(id)}" ${a && a.light === id ? 'selected' : ''}>${escapeHtml(friendlyName(this._hass, id))}</option>`).join('')}
        ${(a && a.light && !lights.includes(a.light)) ? `<option value="${escapeHtml(a.light)}" selected>${escapeHtml(a.light)} (missing)</option>` : ''}
      </select>
      <button class="cpce-delete-entity-btn cpce-area-remove" data-section-id="${s.id}" data-area="${i}" title="Remove area"><ha-icon icon="mdi:close"></ha-icon></button>
    </div>`;
    // Optional Button Style binding: render the tiles as styled buttons (that style's border/glow/
    // gradient/background). "Default tiles" = the simple chip layout.
    const lib = buttonStyleLibraryMap();
    const curStyle = fixtureRefSlug(s.style_preset) || '';
    const styleEntries = [...Object.keys(BUILTIN_BUTTON_STYLES).map(bs => ({ slug: bs, name: BUILTIN_BUTTON_STYLES[bs].name })),
      ...Object.keys(lib).map(sl => ({ slug: sl, name: lib[sl].name || sl }))].sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="cpce-sub-title">Tile Style</div>
      <div class="cpce-row"><label class="lbl">Button Style</label>
        <select class="cpce-tracker-style" data-id="${s.id}">
          <option value="" ${!curStyle ? 'selected' : ''}>Default tiles (status chips)</option>
          ${styleEntries.map(e => `<option value="lib:${escapeHtml(e.slug)}" ${curStyle === e.slug ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
          ${(curStyle && !isBuiltinButtonSlug(curStyle) && !lib[curStyle]) ? `<option value="lib:${escapeHtml(curStyle)}" selected>${escapeHtml(curStyle)} (missing)</option>` : ''}
        </select>
      </div>
      <div class="cpce-hint">Bind a <strong>Button Style</strong> to render the Area tiles like buttons (border, glow, gradient). The active-scene glow fires when an Area is on a real (non-off) scene. Leave as “Default tiles” for the simple chip look.</div>
      <div class="cpce-sub-title">Areas</div>
      <div class="cpce-hint">Each Area shows the current option of its <code>input_select</code>. Add an optional light to show its live color/brightness. Read-only status board.</div>
      ${areas.map((a, i) => row(a, i)).join('')}
      <button class="cpce-mini-btn cpce-area-add" data-section-id="${s.id}"><ha-icon icon="mdi:plus"></ha-icon> Add area</button>
      ${selects.length ? '' : '<div class="cpce-hint">No <code>input_select</code> helpers found — create one in Home Assistant first.</div>'}`;
  }

  // Section default scene reset: when set, any NON-scene button in this section (color / profile /
  // temp / Off) that doesn't already bind this group will, on press, set the group to the chosen
  // option (default '-none-'). This de-highlights the active scene when the room diverges — press-
  // driven, not light-state detection. A scene-mode button, or a button that binds this group itself,
  // is unaffected; a per-button "Leave scene group alone" opt-out (Scene Selects panel) also skips it.
  _renderSectionDefaultScene(s) {
    const groups = this._allInputSelectEntities();   // respects the Scene Group filter
    const cur = s.default_scene_group || '';
    const curGroup = groups.find(g => g.entity === cur);
    const opts = curGroup ? curGroup.options : [];
    const curOpt = s.default_scene_option || '';
    const optionList = (curOpt && !opts.includes(curOpt)) ? [curOpt, ...opts] : opts;
    return `<div class="cpce-sub-title">Default scene reset</div>
      <div class="cpce-hint">When a color/profile/Off button here is <strong>pressed</strong>, set this Scene Group to the option below — so the active scene de-highlights once the room diverges. Scene buttons (and any button that sets this group itself) are unaffected. Leave as “(none)” to disable.</div>
      <div class="cpce-row"><label class="lbl">Scene Group</label>
        <select class="cpce-sn-default-group" data-id="${escapeHtml(s.id)}">
          <option value="">(none — no reset)</option>
          ${groups.map(g => `<option value="${escapeHtml(g.entity)}" ${g.entity === cur ? 'selected' : ''}>${escapeHtml(friendlyName(this._hass, g.entity))}</option>`).join('')}
          ${(cur && !groups.some(g => g.entity === cur)) ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)} (filtered/missing)</option>` : ''}
        </select>
      </div>
      ${cur ? `<div class="cpce-row"><label class="lbl">Reset to</label>
        <select class="cpce-sn-default-option" data-id="${escapeHtml(s.id)}">
          ${optionList.map(o => `<option value="${escapeHtml(o)}" ${o === curOpt ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
          ${optionList.length ? '' : '<option value="">(group has no options)</option>'}
        </select>
      </div>
      <div class="cpce-hint">Tip: use your Scene Group's <code>-none-</code> option so nothing highlights when the room is off-scene.</div>` : ''}`;
  }

  _renderSectionFramePicker(s) {
    const lib = frameLibraryMap((this._config && this._config.frame_library_scope) || 'system');
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    const applied = (s.frame && Array.isArray(s.frame.presets)) ? s.frame.presets : [];
    const ignore = new Set((s.frame && Array.isArray(s.frame.ignore_conditions)) ? s.frame.ignore_conditions : []);
    const disabled = new Set((s.frame && Array.isArray(s.frame.disabled)) ? s.frame.disabled : []);
    const overrides = (s.frame && s.frame.overrides && typeof s.frame.overrides === 'object') ? s.frame.overrides : {};
    const rows = [{ id: BUILTIN_FRAME_ID, e: builtinFramePreset() }]
      .concat(slugs.map(sl => ({ id: 'lib:' + sl, e: lib[sl] })));
    const optionEls = rows.map(({ id, e }) => `<option value="${escapeHtml(id)}">${escapeHtml(e.name || id)}</option>`).join('');
    // An entity-conditional preset (not a section-membership kind) can be rebound here.
    const hasEntCond = e => !!(e && e.when && !e.when_kind);
    return `<div class="cpce-sub-title">Section Frame</div>
      <div class="cpce-hint">Apply reusable <strong>Frame Styles</strong> to just this section. Layered in order — last active wins per property. Add a base style plus <strong>conditional</strong> overlays to change the look when their condition matches. Build or edit styles in the <strong>Frame Styles</strong> library (under Libraries).</div>
      <div class="cpce-manage-list">${applied.map((id, i) => {
        const e = id === BUILTIN_FRAME_ID ? builtinFramePreset() : (lib[id.slice(4)] || null);
        const nm = e ? (e.name || id) : `${id} (missing)`;
        const cond = this._frameCondText(e);
        const off = disabled.has(id);
        const scope = `data-sid="${escapeHtml(s.id)}" data-fid="${escapeHtml(id)}"`;
        const ovRow = (hasEntCond(e) && !ignore.has(id)) ? this._frameOverrideRow(id, e, overrides[id], scope) : '';
        return `<div class="cpce-manage-item${off ? ' cpce-frame-off' : ''}" data-sf-sid="${escapeHtml(s.id)}" data-sf-idx="${i}">
          <ha-icon icon="${cond ? 'mdi:auto-fix-outline' : 'mdi:auto-fix'}" style="color:var(--primary-color);flex-shrink:0;" title="${cond ? 'conditional layer' : 'always applies'}"></ha-icon>
          <span class="cpce-ce-name">${escapeHtml(nm)}${off ? ' <span class="cpce-hint">(hidden)</span>' : ''}${cond ? `<span class="cpce-entity-id">${escapeHtml(cond)}</span>` : ''}</span>
          ${cond ? `<label class="cpce-check-inline" title="Apply this layer even when its condition is false"><input type="checkbox" class="cpce-sf-ignore" data-sid="${escapeHtml(s.id)}" data-fid="${escapeHtml(id)}" ${ignore.has(id) ? 'checked' : ''}> ignore cond.</label>` : ''}
          <button class="cpce-icon-btn cpce-sf-hide" data-sid="${escapeHtml(s.id)}" data-fid="${escapeHtml(id)}" title="${off ? 'Hidden — click to apply' : 'Applied — click to hide (keeps it in the list)'}"><ha-icon icon="${off ? 'mdi:eye-off' : 'mdi:eye'}"></ha-icon></button>
          <button class="cpce-icon-btn cpce-sf-up" data-sid="${escapeHtml(s.id)}" data-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-up-bold"></ha-icon></button>
          <button class="cpce-icon-btn cpce-sf-down" data-sid="${escapeHtml(s.id)}" data-idx="${i}" title="Move down" ${i === applied.length - 1 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-down-bold"></ha-icon></button>
          <button class="cpce-delete-entity-btn cpce-sf-remove" data-sid="${escapeHtml(s.id)}" data-idx="${i}" title="Remove from section"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>${ovRow}`;
      }).join('') || '<div class="cpce-hint">No frame applied. Choose a style below and apply it.</div>'}</div>
      <div class="cpce-row" style="gap:8px;">
        <select class="cpce-sf-add-pick" data-sid="${escapeHtml(s.id)}">${optionEls}</select>
        <button class="cpce-mini-btn cpce-sf-add" data-sid="${escapeHtml(s.id)}"><ha-icon icon="mdi:plus"></ha-icon> Apply to section</button>
      </div>`;
  }

  // The Card Frame APPLICATOR — lives in Card Appearance, not the library.
  // Picks which stored Frame Styles layer onto the whole card (last wins per
  // property), with reorder + remove. Building/editing styles stays in the
  // Frame Styles library panel; this only applies them.
  _renderCardFrameApply() {
    const lib = frameLibraryMap((this._config && this._config.frame_library_scope) || 'system');
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    const cardRef = (this._config && this._config.card_frame) || { presets: [] };
    const applied = Array.isArray(cardRef.presets) ? cardRef.presets : [];
    const ignore = new Set(Array.isArray(cardRef.ignore_conditions) ? cardRef.ignore_conditions : []);
    const disabled = new Set(Array.isArray(cardRef.disabled) ? cardRef.disabled : []);
    const overrides = (cardRef.overrides && typeof cardRef.overrides === 'object') ? cardRef.overrides : {};
    const rows = [{ id: BUILTIN_FRAME_ID, e: builtinFramePreset() }]
      .concat(slugs.map(s => ({ id: 'lib:' + s, e: lib[s] })));
    const optionEls = rows.map(({ id, e }) => `<option value="${escapeHtml(id)}">${escapeHtml(e.name || id)}</option>`).join('');
    const hasEntCond = e => !!(e && e.when && !e.when_kind);
    return `
      <div class="cpce-hint">Apply reusable <strong>Frame Styles</strong> to the whole card (border / glow / shadow / background / gradient border). Layered in order — last wins per property. Build or edit styles in the <strong>Frame Styles</strong> library (under Libraries).</div>
      <div class="cpce-manage-list">${applied.map((id, i) => {
        const e = id === BUILTIN_FRAME_ID ? builtinFramePreset() : (lib[id.slice(4)] || null);
        const nm = e ? (e.name || id) : `${id} (missing)`;
        const cond = this._frameCondText(e);
        const off = disabled.has(id);
        const scope = `data-fid="${escapeHtml(id)}"`;
        const ovRow = (hasEntCond(e) && !ignore.has(id)) ? this._frameOverrideRow(id, e, overrides[id], scope) : '';
        return `<div class="cpce-manage-item${off ? ' cpce-frame-off' : ''}" data-cf-idx="${i}">
          <ha-icon icon="${cond ? 'mdi:auto-fix-outline' : 'mdi:auto-fix'}" style="color:var(--primary-color);flex-shrink:0;" title="${cond ? 'conditional layer' : 'always applies'}"></ha-icon>
          <span class="cpce-ce-name">${escapeHtml(nm)}${off ? ' <span class="cpce-hint">(hidden)</span>' : ''}${cond ? `<span class="cpce-entity-id">${escapeHtml(cond)}</span>` : ''}</span>
          ${cond ? `<label class="cpce-check-inline" title="Apply this layer even when its condition is false"><input type="checkbox" class="cpce-cf-ignore" data-fid="${escapeHtml(id)}" ${ignore.has(id) ? 'checked' : ''}> ignore cond.</label>` : ''}
          <button class="cpce-icon-btn cpce-cf-hide" data-fid="${escapeHtml(id)}" title="${off ? 'Hidden — click to apply' : 'Applied — click to hide (keeps it in the list)'}"><ha-icon icon="${off ? 'mdi:eye-off' : 'mdi:eye'}"></ha-icon></button>
          <button class="cpce-icon-btn cpce-cf-up" data-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-up-bold"></ha-icon></button>
          <button class="cpce-icon-btn cpce-cf-down" data-idx="${i}" title="Move down" ${i === applied.length - 1 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-down-bold"></ha-icon></button>
          <button class="cpce-delete-entity-btn cpce-cf-remove" data-idx="${i}" title="Remove from card"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>${ovRow}`;
      }).join('') || '<div class="cpce-hint">No frame applied yet. Choose a style below and apply it.</div>'}</div>
      <div class="cpce-row" style="gap:8px;">
        <select id="cpce-cf-add-pick">${optionEls}</select>
        <button class="cpce-mini-btn" id="cpce-cf-add"><ha-icon icon="mdi:plus"></ha-icon> Apply to card</button>
      </div>
    `;
  }

  // A labeled slider for the frame builder. `path` is a dotted path into the
  // preset (e.g. 'shadow.blur'); the fb-input handler writes it + saves.
  _fbSlider(id, path, label, cur, min, max, step) {
    const v = Number.isFinite(Number(cur)) ? Number(cur) : min;
    return `<div class="cpce-row"><label class="lbl">${label}</label>
      <input type="range" class="fb-input fb-range" data-fb-id="${escapeHtml(id)}" data-fb-path="${path}" min="${min}" max="${max}" step="${step}" value="${v}">
      <span class="fb-val" data-fb-id="${escapeHtml(id)}" data-fb-path="${path}">${v}</span></div>`;
  }

  // The frame visual builder — mirrors the Easy Entity Styler card's builder
  // (Glow / Shadow / Border / Edges / Condition), editing the shared library
  // preset directly. Kept structurally identical so both cards' builders match.
  _renderFrameBuilder(id, fx) {
    const g = fx.glow, sh = fx.shadow, bd = fx.border, bg = fx.background;
    const hasEdges = fx.edges && ['top', 'bottom', 'left', 'right'].some(s => fx.edges[s] && fx.edges[s].enabled);
    const chk = (on) => on ? 'checked' : '';
    const bgMode = bg ? (bg.mode || 'custom') : 'custom';
    const cn = (bd && Array.isArray(bd.corners)) ? bd.corners : [true, true, true, true];
    const isSectionCond = fx.when_kind === 'section_has_entities' || fx.when_kind === 'section_empty';
    const condOn = !!fx.when || isSectionCond;
    return `
      <div class="cpce-fb">
        <div class="cpce-hint">Live preview:</div>
        <div class="cpce-frame-preview" data-frame-preview="${escapeHtml(id)}"><span>Preview</span></div>
        <div class="cpce-row" style="gap:8px;">
          <label class="lbl">Name</label>
          <input type="text" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="name" value="${escapeHtml(fx.name || '')}" placeholder="Frame name">
        </div>
        <div class="cpce-row" style="gap:8px;">
          <label class="lbl">Note</label>
          <input type="text" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="note" value="${escapeHtml(fx.note || '')}" placeholder="optional note">
        </div>

        <div class="cpce-sub-title">Glow</div>
        <div class="cpce-check"><input type="checkbox" class="fb-toggle" data-fb-id="${escapeHtml(id)}" data-fb-key="glow" ${chk(!!g)}><label>Enable glow</label></div>
        ${g ? `<div class="cpce-row"><label class="lbl">Color</label>
            <input type="color" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="glow.color" value="${/^#/.test(g.color||'')?g.color:'#2196F3'}" ${g.follow_icon?'disabled':''}>
            <label class="cpce-check-inline"><input type="checkbox" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="glow.follow_icon" ${chk(g.follow_icon)}> Follow icon color</label></div>
          <div class="cpce-check"><input type="checkbox" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="glow.borders_only" ${chk(g.borders_only)}><label>Borders only</label></div>
          ${this._fbSlider(id, 'glow.intensity', 'Intensity', g.intensity ?? 1.0, 0.25, 3, 0.05)}` : ''}

        <div class="cpce-sub-title">Drop Shadow</div>
        <div class="cpce-check"><input type="checkbox" class="fb-toggle" data-fb-id="${escapeHtml(id)}" data-fb-key="shadow" ${chk(!!sh)}><label>Enable drop-shadow</label></div>
        ${sh ? `<div class="cpce-row"><label class="lbl">Color</label>
            <input type="color" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="shadow.color" value="${/^#/.test(sh.color||'')?sh.color:'#000000'}" ${sh.follow_icon?'disabled':''}>
            <label class="cpce-check-inline"><input type="checkbox" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="shadow.follow_icon" ${chk(sh.follow_icon)}> Follow icon color</label></div>
          ${this._fbSlider(id, 'shadow.x', 'X offset (px)', sh.x ?? 0, -40, 40, 1)}
          ${this._fbSlider(id, 'shadow.y', 'Y offset (px)', sh.y ?? 4, -40, 40, 1)}
          ${this._fbSlider(id, 'shadow.blur', 'Blur (px)', sh.blur ?? 12, 0, 60, 1)}
          ${this._fbSlider(id, 'shadow.spread', 'Spread (px)', sh.spread ?? 0, -20, 40, 1)}
          ${this._fbSlider(id, 'shadow.opacity', 'Opacity', sh.opacity ?? 0.35, 0, 1, 0.05)}` : ''}

        <div class="cpce-sub-title">Border</div>
        <div class="cpce-check"><input type="checkbox" class="fb-toggle" data-fb-id="${escapeHtml(id)}" data-fb-key="border" ${chk(!!bd)}><label>Enable border</label></div>
        ${bd ? `<div class="cpce-row"><label class="lbl">Color</label>
            <input type="color" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="border.color" value="${/^#/.test(bd.color||'')?bd.color:'#2196F3'}" ${bd.follow_icon?'disabled':''}>
            <label class="cpce-check-inline"><input type="checkbox" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="border.follow_icon" ${chk(bd.follow_icon)}> Follow icon color</label></div>
          ${this._fbSlider(id, 'border.width', 'Width (px)', bd.width ?? 1, 1, 8, 1)}
          ${this._fbSlider(id, 'border.radius', 'Radius (px)', bd.radius ?? 12, 0, 24, 1)}
          <div class="cpce-row"><label class="lbl">Sides</label><span class="cpce-side-toggles">
            ${[['top','Top'],['bottom','Bottom'],['left','Left'],['right','Right']].map(([s,l])=>`<label><input type="checkbox" class="fb-side" data-fb-id="${escapeHtml(id)}" data-fb-side="${s}" ${chk((bd.sides||['top','bottom','left','right']).includes(s))}> ${l}</label>`).join('')}
          </span></div>
          <div class="cpce-row"><label class="lbl">Corners</label><span class="cpce-side-toggles">
            ${[['0','TL'],['1','TR'],['2','BR'],['3','BL']].map(([i,l])=>`<label><input type="checkbox" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="border.corners.${i}" ${chk(cn[Number(i)]!==false)}> ${l}</label>`).join('')}
          </span></div>` : ''}

        <div class="cpce-sub-title">Background</div>
        <div class="cpce-check"><input type="checkbox" class="fb-toggle" data-fb-id="${escapeHtml(id)}" data-fb-key="background" ${chk(!!bg)}><label>Set background</label></div>
        ${bg ? `<div class="cpce-row"><label class="lbl">Mode</label>
            <select class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="background.mode">
              <option value="custom" ${bgMode==='custom'?'selected':''}>Custom color</option>
              <option value="transparent" ${bgMode==='transparent'?'selected':''}>Transparent</option>
              <option value="theme" ${bgMode==='theme'?'selected':''}>Theme (inherit)</option>
            </select>
            ${bgMode==='custom'?`<input type="color" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="background.color" value="${/^#/.test((bg&&bg.color)||'')?bg.color:'#1c1c1c'}">`:''}</div>` : ''}

        <div class="cpce-sub-title">Edges (Border / Gradient)</div>
        <div class="cpce-hint">Each edge is a <b>Solid line</b> or a <b>Gradient</b> (multi-stop; a stop color of <code>match</code> follows the border/icon color). Set thickness, pick a pattern, or edit stops by hand.</div>
        ${['top','bottom','left','right'].map(side => {
          const e = (fx.edges && fx.edges[side]) || { enabled:false, thickness:1, gradient:true, color:'match', stops:[] };
          const eon = e.enabled===true, grad = e.gradient!==false;
          const stops = Array.isArray(e.stops) ? e.stops : [];
          return `<div class="cpce-fb-edge">
            <div class="cpce-check"><input type="checkbox" class="fb-edge-enable" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" ${chk(eon)}><label>${side[0].toUpperCase()+side.slice(1)} edge</label></div>
            ${eon?`<div class="cpce-row"><label class="lbl">Type</label>
              <select class="fb-edge-mode" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}"><option value="solid" ${!grad?'selected':''}>Solid</option><option value="gradient" ${grad?'selected':''}>Gradient</option></select>
            </div>
            <div class="cpce-row"><label class="lbl">Thickness</label>
              <input type="range" class="fb-edge-thickness" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" min="1" max="12" step="1" value="${e.thickness||1}">
              <span class="fb-edge-thickness-val" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}">${e.thickness||1}px</span></div>
            ${!grad
              ? (() => { const col = e.color || 'match'; const cmode = col==='match'?'match':(col==='theme'?'theme':'fixed'); return `<div class="cpce-row"><label class="lbl">Color</label>
                  <select class="fb-edge-solid-mode" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}">
                    <option value="match" ${cmode==='match'?'selected':''}>Match (border/icon)</option>
                    <option value="theme" ${cmode==='theme'?'selected':''}>Theme</option>
                    <option value="fixed" ${cmode==='fixed'?'selected':''}>Custom</option>
                  </select>
                  ${cmode==='fixed'?`<input type="color" class="fb-edge-color" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" value="${/^#[0-9a-f]{6}$/i.test(col)?col:'#2196F3'}" style="margin-left:6px;">`:''}
                </div>`; })()
              : `<div class="cpce-row"><label class="lbl">Pattern</label>
                  <select class="fb-edge-pattern" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}">
                    ${EDGE_GRADIENT_PATTERN_LIST.map(([v,l]) => `<option value="${v}" ${(e.pattern||'')===v?'selected':''}>${escapeHtml(l)}</option>`).join('')}
                  </select></div>
                <div class="cpce-fb-stops">
                  ${stops.map((s,i)=>{
                    const isMatch = s.color==='match', isT = s.color==='transparent';
                    const posV = clamp(Number(s.pos)||0,0,100);
                    return `<div class="cpce-row cpce-fb-stop">
                    <input type="range" class="fb-edge-stop-pos" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" data-fb-idx="${i}" min="0" max="100" step="1" value="${posV}" style="flex:1;"><span class="cpce-strength-val fb-edge-stop-pos-val" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" data-fb-idx="${i}">${posV}%</span>
                    <input type="color" class="fb-edge-stop-color" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" data-fb-idx="${i}" value="${/^#[0-9a-f]{6}$/i.test(s.color||'')?s.color:'#2196F3'}" style="width:44px;${(isMatch||isT)?'display:none;':''}">
                    <select class="fb-edge-stop-mode" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" data-fb-idx="${i}" title="Stop color source">
                      <option value="color" ${(!isMatch&&!isT)?'selected':''}>Color</option>
                      <option value="match" ${isMatch?'selected':''}>Match</option>
                      <option value="transparent" ${isT?'selected':''}>Transp.</option>
                    </select>
                    <button class="cpce-icon-btn fb-edge-stop-del" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}" data-fb-idx="${i}" title="Remove stop"><ha-icon icon="mdi:close"></ha-icon></button>
                  </div>`; }).join('') || '<div class="cpce-hint">No stops. Pick a pattern or add stops (use <code>match</code> to follow the border/icon color).</div>'}
                  <button class="cpce-mini-btn fb-edge-stop-add" data-fb-id="${escapeHtml(id)}" data-fb-side="${side}"><ha-icon icon="mdi:plus"></ha-icon> Add stop</button>
                </div>`}
            `:''}
          </div>`;
        }).join('')}

        <div class="cpce-sub-title">Condition (optional)</div>
        <div class="cpce-check"><input type="checkbox" class="fb-cond-toggle" data-fb-id="${escapeHtml(id)}" ${chk(condOn)}><label>Only apply when an entity is in a state</label></div>
        ${condOn && !isSectionCond ? `<div class="cpce-row">
            <input type="text" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="when_entity" value="${escapeHtml(fx.when_entity||'')}" placeholder="entity id" style="flex:1;">
            <select class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="when.op">
              ${[['eq','='],['ne','≠'],['gt','>'],['lt','<'],['ge','≥'],['le','≤'],['is_on','is on'],['is_off','is off'],['unavailable','unavailable']].map(([v,l])=>`<option value="${v}" ${((fx.when&&fx.when.op)||'eq')===v?'selected':''}>${l}</option>`).join('')}
            </select>
            <input type="text" class="fb-input" data-fb-id="${escapeHtml(id)}" data-fb-path="when.value" value="${escapeHtml((fx.when&&fx.when.value)??'')}" placeholder="value" style="width:90px;">
          </div>` : (isSectionCond ? '<div class="cpce-hint">This frame uses a section-membership condition (Easy Entity Styler only).</div>' : '')}
      </div>`;
  }

  // Save/Discard row for the frame builder. Edits live in this._frameDraft until
  // Save commits them to the shared library. Save is disabled until dirty.
  _renderFrameSaveRow(id, dirty) {
    return `<div class="cpce-layer-save-row">
      ${dirty ? `<div class="cpce-unsaved-banner"><ha-icon icon="mdi:content-save-alert"></ha-icon>Unsaved changes — this is a shared Frame Style; Save applies it to every card that uses it.</div>` : ''}
      <div class="cpce-row" style="gap:8px;">
        <button class="cpce-mini-btn cpce-frame-save${dirty ? ' cpce-btn-enabled' : ''}" data-frame-id="${escapeHtml(id)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:content-save"></ha-icon> Save</button>
        <button class="cpce-mini-btn cpce-frame-discard" data-frame-id="${escapeHtml(id)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:undo"></ha-icon> Discard</button>
      </div>
    </div>`;
  }

  // ===== Header Rules — authoring UI (Color-card native idiom) =====
  // Ops the header `when` condition offers. STATE_OPS need no value input.
  _HDR_OPS = [['is_on', 'is on'], ['is_off', 'is off'], ['truthy', 'truthy'], ['unavailable', 'unavailable'], ['eq', '='], ['ne', '≠'], ['gt', '>'], ['lt', '<'], ['ge', '≥'], ['le', '≤']];
  _hdrOpNeedsValue(op) { return !['is_on', 'is_off', 'truthy', 'unavailable'].includes(op || 'eq'); }
  _hdrScope() { return (this._config && this._config.header_library_scope) || 'system'; }
  // The set to display for a slug: the live DRAFT if this set is open+editing, else the stored one.
  _hdrDisplaySet(slug, stored) {
    return (this._headerDraft && this._headerDraft.slug === slug) ? this._headerDraft.set : stored;
  }

  // Top-level "Header Rules" library panel — mirrors _renderFramePresets. Lists
  // the read-only Built-In plus the shared System sets (ltek_header_library),
  // each with duplicate / export / delete + an inline visual editor (pencil), an
  // Add + Import row. Sets are applied to the Card Header (Card Appearance) or a
  // section header (Section Layout). Shared system-wide with the Easy Entity
  // Styler card via the same library key.
  _renderHeaderRuleSets() {
    const lib = headerLibraryMap(this._hdrScope());
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    const rows = [{ id: BUILTIN_HEADER_ID, e: builtinHeaderRuleSet(), builtin: true }]
      .concat(slugs.map(s => ({ id: 'lib:' + s, e: lib[s], builtin: false })));
    // Which sets this card references (card title OR any section) — a usage badge.
    const usedIds = new Set();
    ((this._config && this._config.card_header_rules) || []).forEach(r => r && r.ref && usedIds.add(r.ref));
    this._orderedSectionsRaw().forEach(s => (s.header_rule_refs || []).forEach(r => r && r.ref && usedIds.add(r.ref)));
    return `
      <div class="cpce-hint">State-driven header styling. Each rule sets any/all of: icon color, MDI icon, text color, icon/text size, and a secondary line — anything left <strong>Not set</strong> defers to the card's own header logic. Build sets here, then <strong>apply</strong> one to the <strong>Card Header</strong> (Card Appearance → Header) or a <strong>Section</strong> (Section Layout) — applying a set is what turns it on; nothing happens until you do. Shared system-wide (and with the Easy Entity Styler card); Built-In is read-only — duplicate to customize.</div>
      <div class="cpce-row" style="gap:8px; margin:6px 0;">
        <button class="cpce-create-preset-btn" id="cpce-hdr-add"><ha-icon icon="mdi:plus"></ha-icon> New Rule Set</button>
        <button class="cpce-mini-btn" id="cpce-hdr-import"><ha-icon icon="mdi:import"></ha-icon> Import JSON…</button>
      </div>
      <div class="cpce-manage-list">${rows.map(({ id, e, builtin }) => {
        const slug = builtin ? BUILTIN_HEADER_SLUG : id.slice(4);
        const open = !builtin && this._openHeaderSet === slug;
        const view = open ? this._hdrDisplaySet(slug, e) : e;
        const dirty = open && !!(this._headerDraft && this._headerDraft.slug === slug && this._headerDraft.dirty);
        const nRules = Array.isArray(view.rules) ? view.rules.length : 0;
        const meta = [builtin ? 'built-in (read-only)' : '', `${nRules} rule${nRules === 1 ? '' : 's'}`, view.default_entity ? '🔗 ' + view.default_entity : ''].filter(Boolean).join(' · ');
        return `<div class="cpce-manage-item${dirty ? ' cpce-item-unsaved' : ''}" data-hdr-id="${escapeHtml(id)}">
          <ha-icon icon="${builtin ? 'mdi:lock' : 'mdi:format-list-checks'}" style="color:var(--primary-color);flex-shrink:0;"></ha-icon>
          <span class="cpce-ce-name">${escapeHtml(view.name || id)}${dirty ? ' <span class="cpce-unsaved-dot" title="Unsaved changes">●</span>' : ''}<span class="cpce-entity-id">${escapeHtml(meta)}</span></span>
          ${usedIds.has(id) ? '<span class="cpce-order-type">in use</span>' : ''}
          ${builtin ? '' : `<button class="cpce-icon-btn cpce-hdr-edit${open ? ' active' : ''}" data-hdr-slug="${escapeHtml(slug)}" title="Edit this rule set"><ha-icon icon="mdi:pencil"></ha-icon></button>`}
          <button class="cpce-icon-btn cpce-hdr-duplicate" data-hdr-id="${escapeHtml(id)}" title="Duplicate into an editable System set"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
          <button class="cpce-icon-btn cpce-hdr-export" data-hdr-id="${escapeHtml(id)}" title="Export JSON"><ha-icon icon="mdi:download"></ha-icon></button>
          ${builtin ? '' : `<button class="cpce-delete-entity-btn cpce-hdr-delete" data-hdr-id="${escapeHtml(id)}" title="Delete from the shared library"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>`}
        </div>${open ? `<div class="cpce-hdr-builder-panel${dirty ? ' cpce-panel-unsaved' : ''}" data-hdr-slug="${escapeHtml(slug)}">${this._renderHeaderSetBuilder(slug, view)}${this._renderHeaderSaveRow(slug, dirty)}</div>` : ''}`;
      }).join('')}</div>
    `;
  }

  // Inline visual editor for ONE System Header Rule Set (edits a draft).
  _renderHeaderSetBuilder(slug, set) {
    const rules = Array.isArray(set.rules) ? set.rules : [];
    return `
      <div class="cpce-row"><label class="lbl">Name</label><input type="text" class="hdr-name" data-hdr-slug="${escapeHtml(slug)}" value="${escapeHtml(set.name || '')}" placeholder="Rule set name"></div>
      <div class="cpce-row"><label class="lbl">Default Entity</label><input type="text" class="hdr-default-entity" data-hdr-slug="${escapeHtml(slug)}" value="${escapeHtml(set.default_entity || '')}" placeholder="light.kitchen (optional)"></div>
      <div class="cpce-hint">Optional. The entity every rule's condition tests, unless the card/section that applies this set binds its own (which overrides). Blank = the card/section's own primary entity.</div>
      ${rules.map((r, i) => this._renderHeaderRuleRow(slug, r, i)).join('') || '<div class="cpce-hint">No rules yet — add one below.</div>'}
      <button class="cpce-mini-btn cpce-hr-add" data-hdr-slug="${escapeHtml(slug)}" style="margin-top:6px;"><ha-icon icon="mdi:plus"></ha-icon> Add rule</button>
    `;
  }

  // A compact chip summary of a rule's outputs, so a collapsed row stays legible.
  _headerRuleChips(rule) {
    const chips = [];
    if (rule.set_icon_color) chips.push(`<span class="cpce-hr-chip"><span class="cpce-hr-swatch" style="background:${escapeHtml(rule.set_icon_color)};"></span>icon</span>`);
    if (rule.set_icon) chips.push(`<span class="cpce-hr-chip"><ha-icon icon="${escapeHtml(normalizeIcon(rule.set_icon))}"></ha-icon></span>`);
    if (rule.set_text_color) chips.push(`<span class="cpce-hr-chip"><span class="cpce-hr-swatch" style="background:${escapeHtml(rule.set_text_color)};"></span>text</span>`);
    if (Number(rule.set_icon_size) > 0) chips.push(`<span class="cpce-hr-chip">${Number(rule.set_icon_size)}px icon</span>`);
    if (Number(rule.set_text_size) > 0) chips.push(`<span class="cpce-hr-chip">${Number(rule.set_text_size)}px text</span>`);
    if (rule.set_secondary && rule.set_secondary.enabled) chips.push(`<span class="cpce-hr-chip"><ha-icon icon="mdi:subtitles-outline"></ha-icon>2nd</span>`);
    return chips.length ? `<span class="cpce-hr-chips">${chips.join('')}</span>` : '<span class="cpce-hint" style="opacity:0.6;">no outputs set</span>';
  }

  // One rule row: a when-editor + the six sparse outputs. Collapsible; the summary
  // shows a condition label + output chips. Each output has a "Not set" default.
  _renderHeaderRuleRow(slug, rule, idx) {
    rule = rule || {};
    const key = slug + '::' + idx;
    const open = this._openHeaderRules.has(key);
    const when = rule.when || {};
    const op = when.op || 'eq';
    const needsVal = this._hdrOpNeedsValue(op);
    const sec = rule.set_secondary || {};
    const secSrc = sec.source || 'attribute';
    const ds = `data-hdr-slug="${escapeHtml(slug)}" data-hr-idx="${idx}"`;
    const condLabel = (this._HDR_OPS.find(o => o[0] === op) || [op, op])[1] + (needsVal ? ' ' + (when.value ?? '') : '');
    return `
      <div class="cpce-hr-row${open ? ' cpce-hr-open' : ''}" data-hdr-slug="${escapeHtml(slug)}" data-hr-idx="${idx}">
        <div class="cpce-hr-summary cpce-hr-toggle" ${ds}>
          <span class="cpce-hr-num">Rule ${idx + 1}</span>
          <span class="cpce-entity-id">when ${escapeHtml(condLabel)}</span>
          ${this._headerRuleChips(rule)}
          <span style="flex:1;"></span>
          <button class="cpce-delete-entity-btn cpce-hr-del" ${ds} title="Remove rule"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
          <ha-icon class="cpce-hr-chev" icon="mdi:chevron-${open ? 'up' : 'down'}"></ha-icon>
        </div>
        ${open ? `<div class="cpce-hr-body">
          <div class="cpce-hr-preview" ${ds}>${this._headerRulePreviewHtml(rule)}</div>
          <div class="cpce-sub-title">Condition</div>
          <div class="cpce-row" style="gap:8px;">
            <select class="hr-op" ${ds}>${this._HDR_OPS.map(([v, l]) => `<option value="${v}" ${op === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
            ${needsVal ? `<input type="text" class="hr-input" ${ds} data-hr-path="when.value" value="${escapeHtml(when.value ?? '')}" placeholder="value" style="width:120px;">` : ''}
          </div>
          <div class="cpce-hint">Tests the bound entity's state. <strong>is on / is off</strong> need no value.</div>
          <div class="cpce-sub-title">Outputs — leave any control off for “Not set” (defers to the card)</div>
          ${this._hdrColorField(slug, idx, 'set_icon_color', 'Set icon color', rule.set_icon_color)}
          <div class="cpce-row"><label class="lbl">Icon (mdi)</label><input type="text" class="hr-input" ${ds} data-hr-path="set_icon" value="${escapeHtml(rule.set_icon || '')}" placeholder="mdi:… (blank = Not set)"></div>
          ${this._hdrColorField(slug, idx, 'set_text_color', 'Set text color', rule.set_text_color)}
          ${this._hdrSizeSlider(slug, idx, 'set_icon_size', 'Icon size', rule.set_icon_size)}
          ${this._hdrSizeSlider(slug, idx, 'set_text_size', 'Text size', rule.set_text_size)}
          <div class="cpce-check"><input type="checkbox" class="hr-sec-enable" ${ds} ${sec.enabled ? 'checked' : ''}><label>Show a secondary info line</label></div>
          ${sec.enabled ? `
            <div class="cpce-row" style="gap:8px;">
              <label class="lbl">Source</label>
              <select class="hr-sec-source" ${ds}>${[['state', 'State'], ['attribute', 'Attribute'], ['last_changed_ago', 'Time since change']].map(([v, l]) => `<option value="${v}" ${secSrc === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            </div>
            ${secSrc === 'attribute' ? `<div class="cpce-row"><label class="lbl">Attribute</label><input type="text" class="hr-input" ${ds} data-hr-path="set_secondary.attribute" value="${escapeHtml(sec.attribute || '')}" placeholder="brightness"></div>` : ''}
            <div class="cpce-row"><label class="lbl">Prefix</label><input type="text" class="hr-input" ${ds} data-hr-path="set_secondary.prefix" value="${escapeHtml(sec.prefix || '')}" placeholder="e.g. 'Bri: '"></div>
          ` : ''}
        </div>` : ''}
      </div>`;
  }

  // Enable-checkbox + color picker for a "Not set"-capable color output. Unchecked
  // = the key is omitted (Not set). data-hr-path names the output key.
  _hdrColorField(slug, idx, pathKey, label, val) {
    const ds = `data-hdr-slug="${escapeHtml(slug)}" data-hr-idx="${idx}" data-hr-path="${pathKey}"`;
    const on = !!(val && String(val).length);
    return `<div class="cpce-row" style="gap:8px;">
      <label class="cpce-inline-check"><input type="checkbox" class="hr-color-enable" ${ds} ${on ? 'checked' : ''}> ${label}</label>
      ${on ? `<input type="color" class="hr-color" ${ds} value="${/^#[0-9a-f]{6}$/i.test(val || '') ? val : '#2196F3'}">` : '<span class="cpce-hint">Not set</span>'}
    </div>`;
  }

  // A 0–48px slider where 0 = "Not set" (the size output is omitted at 0).
  _hdrSizeSlider(slug, idx, pathKey, label, val) {
    const v = Number(val) > 0 ? Number(val) : 0;
    const ds = `data-hdr-slug="${escapeHtml(slug)}" data-hr-idx="${idx}" data-hr-path="${pathKey}"`;
    return `<div class="cpce-row"><label class="lbl">${label}</label>
      <input type="range" class="hr-slider" ${ds} min="0" max="48" step="1" value="${v}">
      <span class="cpce-strength-val hr-slider-val" ${ds}>${v > 0 ? v + 'px' : 'Not set'}</span></div>`;
  }

  // A static preview of one rule's outputs (condition ignored) — icon + title +
  // optional secondary — so the styled header reads without hunting a live state.
  _headerRulePreviewHtml(rule) {
    rule = rule || {};
    const iconColor = rule.set_icon_color || 'var(--secondary-text-color)';
    const textColor = rule.set_text_color || 'var(--primary-text-color)';
    const iconSize = Number(rule.set_icon_size) > 0 ? Number(rule.set_icon_size) : 22;
    const textSize = Number(rule.set_text_size) > 0 ? Number(rule.set_text_size) : 15;
    const icon = rule.set_icon ? normalizeIcon(rule.set_icon) : 'mdi:tune-variant';
    const sec = rule.set_secondary || {};
    const secLine = sec.enabled
      ? `<div class="cpce-hr-prev-sec">${escapeHtml(sec.prefix || '')}${sec.source === 'attribute' ? escapeHtml(sec.attribute || 'attribute') : (sec.source === 'last_changed_ago' ? '2m ago' : 'sample value')}</div>`
      : '';
    return `<div class="cpce-hr-prev">
      <ha-icon icon="${icon}" style="--mdc-icon-size:${iconSize}px; color:${iconColor};"></ha-icon>
      <div><div style="font-size:${textSize}px; color:${textColor}; font-weight:600;">Header Title</div>${secLine}</div>
    </div>`;
  }

  // Save/Discard row for a Header Rule Set draft. Mirrors _renderFrameSaveRow.
  _renderHeaderSaveRow(slug, dirty) {
    return `<div class="cpce-layer-save-row">
      ${dirty ? `<div class="cpce-unsaved-banner"><ha-icon icon="mdi:content-save-alert"></ha-icon>Unsaved changes — this is a shared Header Rule Set; Save applies it to every card that uses it.</div>` : ''}
      <div class="cpce-row" style="gap:8px;">
        <button class="cpce-mini-btn cpce-hdr-save${dirty ? ' cpce-btn-enabled' : ''}" data-hdr-slug="${escapeHtml(slug)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:content-save"></ha-icon> Save</button>
        <button class="cpce-mini-btn cpce-hdr-discard" data-hdr-slug="${escapeHtml(slug)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:undo"></ha-icon> Discard</button>
      </div>
    </div>`;
  }

  // The applied-refs editor shared by the Card Header (Card Appearance) and each
  // Section (Section Layout). `refs` is the current list; `scopeAttr` marks which
  // surface (data-hdr-target="card" or data-hdr-target-sid="<id>") so wiring routes
  // add/remove/reorder/bind to the right config location.
  _renderHeaderRefEditor(refs, scopeAttr) {
    const lib = headerLibraryMap(this._hdrScope());
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    const applied = Array.isArray(refs) ? refs : [];
    const nameOf = id => {
      if (id === BUILTIN_HEADER_ID) return 'Built-In';
      if (typeof id === 'string' && id.startsWith('lib:')) { const s = lib[id.slice(4)]; return (s ? (s.name || id.slice(4)) : id.slice(4)); }
      return id;
    };
    const libDefaultOf = id => {
      if (typeof id !== 'string' || !id.startsWith('lib:')) return '';
      const s = lib[id.slice(4)];
      return (s && s.default_entity) ? String(s.default_entity) : '';
    };
    const optionEls = `<option value="${BUILTIN_HEADER_ID}">Built-In</option>`
      + slugs.map(s => `<option value="lib:${escapeHtml(s)}">${escapeHtml(lib[s].name || s)}</option>`).join('');
    return `
      <div class="cpce-hint">Apply one or more <strong>Header Rule Sets</strong> (built under Libraries → Header Rules). Layered top→bottom, last match wins. An entity chosen here <strong>overrides</strong> the set's default entity; blank = the set default, else the ${scopeAttr.card ? "card's" : "section's"} own primary entity.</div>
      <div class="cpce-manage-list">${applied.map((r, i) => {
        const libDef = libDefaultOf(r.ref);
        const boundHere = !!r.entity;
        const bound = boundHere || !!libDef;
        return `<div class="cpce-manage-item" ${scopeAttr.attr} data-hr-ref-idx="${i}">
          <ha-icon icon="${bound ? 'mdi:link-variant' : 'mdi:link-variant-off'}" style="color:${bound ? 'var(--primary-color)' : 'var(--warning-color,#ff9800)'};flex-shrink:0;" title="${bound ? 'Entity bound' : 'No entity bound'}"></ha-icon>
          <span class="cpce-ce-name">${escapeHtml(nameOf(r.ref))}<span class="cpce-entity-id">${boundHere ? escapeHtml(r.entity) : (libDef ? 'default: ' + escapeHtml(libDef) : 'uses primary entity')}</span></span>
          <input type="text" class="cpce-hr-ref-entity" ${scopeAttr.attr} data-hr-ref-idx="${i}" value="${escapeHtml(r.entity || '')}" placeholder="entity (optional)" style="width:150px;">
          <button class="cpce-icon-btn cpce-hr-ref-up" ${scopeAttr.attr} data-hr-ref-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-up-bold"></ha-icon></button>
          <button class="cpce-icon-btn cpce-hr-ref-down" ${scopeAttr.attr} data-hr-ref-idx="${i}" title="Move down" ${i === applied.length - 1 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-down-bold"></ha-icon></button>
          <button class="cpce-delete-entity-btn cpce-hr-ref-remove" ${scopeAttr.attr} data-hr-ref-idx="${i}" title="Remove"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>`;
      }).join('') || '<div class="cpce-hint">No rule sets applied.</div>'}</div>
      <div class="cpce-row" style="gap:8px;">
        <select class="cpce-hr-ref-add-pick" ${scopeAttr.attr}>${optionEls}</select>
        <button class="cpce-mini-btn cpce-hr-ref-add" ${scopeAttr.attr}><ha-icon icon="mdi:plus"></ha-icon> Apply</button>
      </div>`;
  }

  // Card-level applied Header Rule Sets (config.card_header_rules) — a subpanel in Card Appearance.
  _renderCardHeaderApply() {
    return this._renderHeaderRefEditor((this._config && this._config.card_header_rules) || [], { card: true, attr: 'data-hdr-target="card"' });
  }
  // Section-level applied Header Rule Sets (section.header_rule_refs) — in the section config panel.
  _renderSectionHeaderApply(s) {
    return `<div class="cpce-sub-title">Header Rules</div>${this._renderHeaderRefEditor(s.header_rule_refs || [], { card: false, attr: `data-hdr-target-sid="${escapeHtml(s.id)}"` })}`;
  }

  _renderButtonStylePresets() {
    const lib = buttonStyleLibraryMap();
    // Built-ins first, then stored presets alphabetical; the open one is floated to the BOTTOM so it
    // sits directly above the Style Builder — a clearer "you're editing this one" connection.
    const openSlug = this._openButtonStack;
    const storedSlugs = Object.keys(lib)
      .sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b))
      .sort((a, b) => (a === openSlug ? 1 : 0) - (b === openSlug ? 1 : 0));   // open one → last
    const rowsData = [...Object.keys(BUILTIN_BUTTON_STYLES).map(bs => ({ slug: bs, entry: builtinButtonStack(bs), builtin: true })),
      ...storedSlugs.map(s => ({ slug: s, entry: lib[s], builtin: false }))];
    // Which stacks are referenced by this card's sections (usage badge). A section with no explicit
    // style_preset resolves to Basic Theme, so that counts as "in use" too.
    const usedSlugs = new Set();
    this._orderedSectionsRaw().forEach(s => {
      if (!s || s.type !== 'buttons') return;
      usedSlugs.add(fixtureRefSlug(s.style_preset) || BTN_STYLE_BASIC_SLUG);
    });
    return `
      <div class="cpce-hint">Styles are shared across every section (and every Color Light &amp; Scene Manager card) that uses them — edit a style here and all its sections update. <strong>Basic Theme</strong> and <strong>Neon Lux</strong> are fixed built-in looks you can’t edit (duplicate one, or use it as a <em>starter</em> for a new style). Each section picks its own style in Section settings.</div>
      <div class="cpce-row" style="gap:8px; margin-bottom:6px;">
        <button class="cpce-create-preset-btn" id="cpce-btnstyle-new" title="Create a new style from a chosen starter"><ha-icon icon="mdi:plus"></ha-icon> New style</button>
        <button class="cpce-mini-btn" id="cpce-btnstyle-import"><ha-icon icon="mdi:import"></ha-icon> Import as new preset…</button>
      </div>
      <div class="cpce-manage-list">${rowsData.map(({ slug: s, entry: e, builtin }) => {
            const nLayers = Array.isArray(e.layers) ? e.layers.length : 0;
            const open = this._openButtonStack === s;
            const rowDirty = open && !!(this._stackDraft && this._stackDraft.slug === s && this._stackDraft.dirty);
            const starterFrom = (!builtin && e.starter_name) ? `from ${e.starter_name}` : '';
            const meta = [builtin ? 'built-in (read-only)' : '', `${nLayers} layer${nLayers===1?'':'s'}`, starterFrom, e.note ? '📝 ' + e.note : ''].filter(Boolean).join(' · ');
            return `<div class="cpce-manage-item${rowDirty ? ' cpce-item-unsaved' : ''}" data-slug="${escapeHtml(s)}">
              <ha-icon icon="${builtin ? 'mdi:lock' : 'mdi:palette-swatch'}" style="color:var(--primary-color);flex-shrink:0;"></ha-icon>
              <span class="cpce-ce-name">${escapeHtml(e.name || s)}${rowDirty ? ' <span class="cpce-unsaved-dot" title="Unsaved changes">●</span>' : ''}<span class="cpce-entity-id">${escapeHtml(meta)}</span></span>
              ${usedSlugs.has(s) ? '<span class="cpce-order-type">in use</span>' : ''}
              ${builtin ? '' : `<button class="cpce-icon-btn cpce-btnstyle-layers${open?' active':''}" data-slug="${escapeHtml(s)}" title="Edit layers &amp; conditions"><ha-icon icon="mdi:pencil"></ha-icon></button>`}
              <button class="cpce-icon-btn cpce-btnstyle-duplicate" data-slug="${escapeHtml(s)}" title="Duplicate this preset"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
              <button class="cpce-icon-btn cpce-btnstyle-export" data-slug="${escapeHtml(s)}" title="Export JSON"><ha-icon icon="mdi:download"></ha-icon></button>
              ${builtin ? '' : `<button class="cpce-delete-entity-btn cpce-btnstyle-delete" data-slug="${escapeHtml(s)}" title="Delete preset"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>`}
            </div>${open && !builtin ? `<div class="cpce-btnstyle-layers-panel${rowDirty ? ' cpce-panel-unsaved' : ''}" data-slug="${escapeHtml(s)}">${this._renderButtonStackLayers(s, e)}</div>` : ''}`;
          }).join('')}</div>
    `;
  }

  // Layer editor for one button-style stack. Renders from a live DRAFT (this._stackDraft) so edits
  // accumulate without touching the shared library until the user hits "Save layers (system-wide)".
  // Each layer = a condition + a self-contained appearance snapshot (groups). Layers stack
  // last-writer-wins; a base (Always) layer should be first. Frame-only conditions are hidden for
  // button-kind stacks and vice-versa.
  _renderButtonStackLayers(slug, entry) {
    const draft = (this._stackDraft && this._stackDraft.slug === slug) ? this._stackDraft : null;
    const layers = draft ? draft.layers : (Array.isArray(entry.layers) ? entry.layers : []);
    const kind = (entry.kind === 'frame') ? 'frame' : 'button';
    const dirty = !!(draft && draft.dirty);
    const opts = BTN_STYLE_CONDITIONS.filter(c => c.kinds.includes(kind));
    const editingIdx = (this._editingLayer && this._editingLayer.slug === slug) ? this._editingLayer.idx : null;
    const groupTitles = { layout: 'Layout', background: 'Background', border: 'Line Border', gradient: 'Gradient', glow: 'Glow', shadow: 'Shadow', text: 'Text', icon: 'Icon', sizing: 'Button Shape' };
    const rows = layers.map((l, i) => {
      const when = l.when || null;
      const isBase = i === 0;
      // Whole-group model: show which GROUPS this layer defines, not a raw key count. Base = "All Settings".
      const owned = [...layerOwnedGroups(l.groups)].map(g => groupTitles[g] || g);
      const countLabel = isBase ? 'All Settings' : (owned.length ? owned.join(', ') : 'inherits all');
      const selType = when ? when.type : '';
      const isEnt = selType === 'entity_state';
      const hidden = !!l.hidden;
      const isEditing = i === editingIdx;
      // A single pencil per layer is the edit toggle: it opens this layer for editing (loads its look
      // into the Style Builder + reveals its condition/label controls). Click again to close.
      // Header row = Layer #, label pill, condition PILL (read-only summary), then the icon controls.
      // The editable condition <select> moves into the expanded (edit-mode) area, like the Label.
      return `<div class="cpce-stack-layer${hidden ? ' cpce-layer-off' : ''}${isEditing ? ' cpce-layer-editing' : ''}" data-slug="${escapeHtml(slug)}" data-idx="${i}">
        <div class="cpce-stack-layer-hd">
          <span class="cpce-stack-layer-num">Layer ${i + 1}${l.label ? `<span class="cpce-stack-layer-label" title="Layer label">${escapeHtml(l.label)}</span>` : ''}</span>
          <span class="cpce-stack-cond-pill" title="Condition: ${escapeHtml(btnStyleConditionLabel(when))}">${escapeHtml(btnStyleConditionLabel(when))}</span>
          <span class="cpce-stack-layer-spacer"></span>
          <button class="cpce-icon-btn cpce-layer-edit" data-idx="${i}" title="${isEditing ? 'Editing — click to close the editor' : 'Edit this layer (load its look into the Style Builder)'}" style="color:${isEditing ? 'var(--cpce-editing,#ffb300)' : 'var(--secondary-text-color)'};"><ha-icon icon="${isEditing ? 'mdi:pencil' : 'mdi:pencil-outline'}"></ha-icon></button>
          <button class="cpce-icon-btn cpce-layer-duplicate" data-idx="${i}" title="Duplicate this layer"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
          <button class="cpce-icon-btn cpce-layer-hide" data-idx="${i}" title="${hidden ? 'Layer hidden — click to show' : 'Hide this layer (preview without it)'}"><ha-icon icon="${hidden ? 'mdi:eye-off' : 'mdi:eye'}"></ha-icon></button>
          <button class="cpce-icon-btn cpce-layer-up" data-idx="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-up-bold"></ha-icon></button>
          <button class="cpce-icon-btn cpce-layer-down" data-idx="${i}" title="Move down" ${i === layers.length - 1 ? 'disabled' : ''}><ha-icon icon="mdi:arrow-down-bold"></ha-icon></button>
          <button class="cpce-delete-entity-btn cpce-layer-remove" data-idx="${i}" title="Remove layer" ${layers.length <= 1 ? 'disabled' : ''}><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
        </div>
        <div class="cpce-stack-layer-groups">${countLabel}</div>
        ${isEditing ? `<div class="cpce-row" style="gap:6px;"><label class="lbl" style="flex:0 0 auto;">Condition</label><select class="cpce-layer-cond" data-idx="${i}" style="flex:1;min-width:150px;">
            ${opts.map(c => `<option value="${c.type}" ${c.type === selType ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
          </select></div>` : ''}
        ${isEnt && isEditing ? `<div class="cpce-row cpce-layer-entrow" style="gap:6px;flex-wrap:wrap;">
          <input type="text" class="cpce-layer-ent" data-idx="${i}" placeholder="entity_id (e.g. light.desk)" value="${escapeHtml(when.entity || '')}" style="flex:2;min-width:150px;">
          <input type="text" class="cpce-layer-attr" data-idx="${i}" placeholder="attribute (optional)" value="${escapeHtml(when.attr || '')}" style="flex:1;min-width:110px;">
          <select class="cpce-layer-op" data-idx="${i}" ${when.attr ? '' : 'disabled'}>
            ${['==', '!=', '>', '<'].map(o => `<option value="${o}" ${o === (when.op || '==') ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
          <input type="text" class="cpce-layer-val" data-idx="${i}" placeholder="${when.attr ? 'value' : 'state (default: on)'}" value="${escapeHtml(when.attr ? (when.value != null ? when.value : '') : (when.state != null ? when.state : ''))}" style="flex:1;min-width:90px;">
        </div>` : ''}
        ${isEditing ? `<div class="cpce-row" style="gap:6px;"><label class="lbl" style="flex:0 0 auto;">Label</label><input type="text" class="cpce-layer-label" data-idx="${i}" placeholder="optional layer name (e.g. Active glow)" value="${escapeHtml(l.label || '')}" style="flex:1;min-width:150px;"></div>` : ''}
      </div>`;
    }).join('');
    const usedByCount = this._orderedSectionsRaw().filter(s => s && s.type === 'buttons' && (fixtureRefSlug(s.style_preset) || BTN_STYLE_BASIC_SLUG) === slug).length;
    return `
      ${usedByCount ? `<div class="cpce-hint">Editing this style updates the <strong>${usedByCount} section${usedByCount === 1 ? '' : 's'}</strong> using it (and any other card that uses it).</div>` : ''}
      <div class="cpce-row"><label class="lbl">Preset Name</label><input type="text" class="cpce-btnstyle-rename" data-slug="${escapeHtml(slug)}" value="${escapeHtml(entry.name || slug)}" placeholder="Style name"></div>
      <div class="cpce-row"><label class="lbl">Note</label><input type="text" class="cpce-btnstyle-note" data-slug="${escapeHtml(slug)}" value="${escapeHtml(entry.note || '')}" placeholder="optional note"></div>
      <div class="cpce-hint">Layers stack bottom-to-top — a later layer overrides earlier ones where they set the same thing. <strong>Layer 1</strong> always sets <strong>All Settings</strong> (the full look); layers on top enable only the settings groups you check and apply when their condition is met. Click a layer's ✏️ to edit it (loads its look into the Style Builder below). The 👁 button hides a layer so you can preview without it.</div>
      ${dirty ? `<div class="cpce-unsaved-banner">
        <div class="cpce-unsaved-banner-msg"><ha-icon icon="mdi:alert-circle"></ha-icon> Unsaved changes</div>
        <div class="cpce-row" style="gap:8px;margin-top:8px;">
          <button class="cpce-create-preset-btn cpce-layer-save cpce-unsaved" data-slug="${escapeHtml(slug)}" style="flex:1;justify-content:center;" title="Save these layers to the shared library (applies system-wide to every card that uses this preset)"><ha-icon icon="mdi:content-save"></ha-icon> Save Changes</button>
          <button class="cpce-mini-btn cpce-layer-discard" data-slug="${escapeHtml(slug)}" title="Undo unsaved layer edits — reloads the layers as currently saved"><ha-icon icon="mdi:undo"></ha-icon> Discard changes</button>
        </div>
      </div>` : ''}
      <div class="cpce-row" style="gap:8px;margin-top:6px;">
        <button class="cpce-mini-btn cpce-layer-add" data-slug="${escapeHtml(slug)}"><ha-icon icon="mdi:plus"></ha-icon> Add layer</button>
        <button class="cpce-mini-btn cpce-layer-import" data-slug="${escapeHtml(slug)}" title="Paste Button Appearance JSON and append it as new layer(s) to this preset"><ha-icon icon="mdi:import"></ha-icon> Import a Layer</button>
      </div>
      ${this._renderSavedPresetPreview(slug)}
      ${dirty ? this._renderDraftPreview(slug) : ''}
      ${rows}`;
  }
  // The "after" preview: the DRAFT flattened (all conditions active, hidden layers skipped), so
  // layer hide/show, reorder, add and unsaved edits are all reflected. Shown next to CURRENT STYLE
  // while there are unsaved changes, so previewing-without-a-layer (the 👁 button) always has effect.
  _renderDraftPreview(slug) {
    const d = this._stackDraftFor(slug); if (!d) return '';
    const libEntry = buttonStyleLibraryMap()[slug];
    const stack = { ...(libEntry || {}), layers: d.layers };
    return `<div class="cpce-hint" style="margin-top:6px;"><span class="cpce-preview-title"><ha-icon icon="mdi:eye-outline" style="--mdc-icon-size:14px;"></ha-icon> UNSAVED STYLE CHANGES</span></div>${this._renderButtonSampleRow(stack, this._config)}`;
  }

  // Reusable gradient-border editor. `g` is the spec object; `ns` a namespace used in element
  // classes (e.g. 'cardgb' / 'btngb') so wiring can scope to this instance. Offers: enable, per-
  // side toggles, width, a preset Pattern dropdown, and stop rows (position + color + transparent
  // + remove) — the SAME stop model as dividers. Wiring is done by _wireGradientBorderEditor.
  _renderGradientBorderEditor(g, ns, matchColor) {
    g = g || {};
    const on = g.enabled === true;
    const sides = g.sides || {};
    const width = Number(g.width) || 2;
    const stops = Array.isArray(g.stops) ? g.stops : [];
    const mc = matchColor || '#2196F3';
    return `
      <div class="cpce-check"><input type="checkbox" class="${ns}-enable"${on?' checked':''}><label>Gradient border</label></div>
      ${on ? `
        <div class="cpce-div-preview ${ns}-preview" style="border:1px dashed var(--divider-color,#333); border-radius:6px; height:34px; margin:6px 0; ${(() => { const bg = gradientBorderBackground(g, mc); return bg ? `background-image:${bg.image};background-size:${bg.size};background-position:${bg.position};background-repeat:${bg.repeat};` : ''; })()}"></div>
        <div class="cpce-row"><label class="lbl">Sides</label>
          <label class="cpce-inline-check"><input type="checkbox" class="${ns}-side" data-side="top" ${sides.top?'checked':''}> Top</label>
          <label class="cpce-inline-check"><input type="checkbox" class="${ns}-side" data-side="bottom" ${sides.bottom?'checked':''}> Bottom</label>
          <label class="cpce-inline-check"><input type="checkbox" class="${ns}-side" data-side="left" ${sides.left?'checked':''}> Left</label>
          <label class="cpce-inline-check"><input type="checkbox" class="${ns}-side" data-side="right" ${sides.right?'checked':''}> Right</label>
        </div>
        <div class="cpce-row"><label class="lbl">Thickness</label><input type="range" class="${ns}-width" min="1" max="20" value="${width}"><span class="cpce-strength-val">${width}px</span></div>
        <div class="cpce-row"><label class="lbl">Pattern</label>
          <select class="${ns}-pattern">
            <option value="" ${g.pattern==null?'selected':''}>Custom…</option>
            ${DIVIDER_GRADIENT_PATTERNS.map((p, pi) => `<option value="${pi}" ${String(g.pattern)===String(pi)?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="cpce-hint">Color stops — position + <strong>Match</strong> (uses the border color), a custom color, or <strong>Transparent</strong> for a fade.</div>
        <div class="${ns}-stops">${stops.map((st, i) => {
          const isT = (st.color === 'transparent');
          const isMatch = (st.color === 'match');
          return `<div class="cpce-row ${ns}-stop-row">
            <input type="range" class="${ns}-stop-pos" data-idx="${i}" min="0" max="100" value="${clamp(Number(st.pos)||0,0,100)}"><span class="cpce-strength-val ${ns}-stop-pos-val">${clamp(Number(st.pos)||0,0,100)}%</span>
            <select class="${ns}-stop-kind" data-idx="${i}">
              <option value="match" ${isMatch?'selected':''}>Match</option>
              <option value="custom" ${(!isMatch&&!isT)?'selected':''}>Custom</option>
              <option value="transparent" ${isT?'selected':''}>Transparent</option>
            </select>
            <input type="color" class="${ns}-stop-color" data-idx="${i}" value="${/^#[0-9a-f]{6}$/i.test(st.color||'')?st.color:mc}"${(isT||isMatch)?' style="display:none;"':''}>
            <button class="cpce-delete-entity-btn ${ns}-stop-remove" data-idx="${i}" title="Remove stop"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>`;
        }).join('')}</div>
        <button class="cpce-mini-btn ${ns}-stop-add"><ha-icon icon="mdi:plus"></ha-icon> Add color stop</button>
        <div class="cpce-hint">Painted as gradient lines on the chosen sides — works alongside a solid border and the glow.</div>
      ` : `<div class="cpce-hint">A multi-stop gradient border line on any side (top/bottom/left/right), independent of the solid border and glow.</div>`}
    `;
  }

  // Wires a gradient-border editor. `getG()` returns the current spec; `setG(patch)` merges and
  // persists (via the caller's updater). Live edits (pos/color) repaint the preview in place
  // (no full re-render → picker stays open); structural changes (enable/side/add/remove/pattern/
  // transparent) re-render.
  _wireGradientBorderEditor(root, ns, getG, setG, getMatchColor) {
    const matchColor = () => (typeof getMatchColor === 'function' ? getMatchColor() : null) || '#2196F3';
    const stopsOf = () => { const g = getG() || {}; return Array.isArray(g.stops) ? g.stops.map(s => ({ ...s })) : []; };
    // New stops default to 'match' (usually what you want — tracks the border color).
    const seedStops = () => [{ pos: 0, color: 'transparent' }, { pos: 50, color: 'match' }, { pos: 100, color: 'transparent' }];
    const en = root.querySelector(`.${ns}-enable`);
    if (en) en.addEventListener('change', () => {
      const g = getG() || {};
      if (en.checked) setG({ enabled: true, width: g.width || 2, sides: g.sides || { bottom: true }, stops: (Array.isArray(g.stops) && g.stops.length >= 2) ? g.stops : seedStops() });
      else setG({ enabled: false });
      this._render();
    });
    root.querySelectorAll(`.${ns}-side`).forEach(cb => cb.addEventListener('change', () => {
      const g = getG() || {}; const sides = { ...(g.sides || {}) }; sides[cb.dataset.side] = cb.checked; setG({ sides }); this._render();
    }));
    const width = root.querySelector(`.${ns}-width`);
    if (width) { width.addEventListener('input', () => { const v = width.nextElementSibling; if (v) v.textContent = `${width.value}px`; }); width.addEventListener('change', () => { setG({ width: clamp(parseInt(width.value,10)||1,1,20) }); this._render(); }); }
    const refreshPreview = () => {
      const g = getG(); const prev = root.querySelector(`.${ns}-preview`); if (!g || !prev) return;
      const bg = gradientBorderBackground(g, matchColor());
      prev.style.backgroundImage = bg ? bg.image : ''; prev.style.backgroundSize = bg ? bg.size : '';
      prev.style.backgroundPosition = bg ? bg.position : ''; prev.style.backgroundRepeat = bg ? bg.repeat : '';
    };
    root.querySelectorAll(`.${ns}-stop-pos`).forEach(sl => {
      const readout = sl.parentElement && sl.parentElement.querySelector(`.${ns}-stop-pos-val`);
      const commit = () => { const stops = stopsOf(); const i = Number(sl.dataset.idx); if (stops[i]) { stops[i].pos = clamp(parseInt(sl.value,10)||0,0,100); setG({ stops, pattern: undefined }); refreshPreview(); } };
      sl.addEventListener('input', () => { if (readout) readout.textContent = `${sl.value}%`; commit(); });
      sl.addEventListener('change', commit);
    });
    root.querySelectorAll(`.${ns}-stop-color`).forEach(col => col.addEventListener('input', () => {
      const stops = stopsOf(); const i = Number(col.dataset.idx); if (stops[i]) { stops[i].color = col.value; setG({ stops, pattern: undefined }); refreshPreview(); }
    }));
    // Stop kind: Match (track border color) / Custom (own color) / Transparent. Match & Transparent
    // hide the color picker (no color to pick); switching to Custom seeds it from the match color.
    // Re-render to reflect the picker's visibility.
    root.querySelectorAll(`.${ns}-stop-kind`).forEach(sel => sel.addEventListener('change', () => {
      const stops = stopsOf(); const i = Number(sel.dataset.idx); if (!stops[i]) return;
      if (sel.value === 'match') stops[i].color = 'match';
      else if (sel.value === 'transparent') stops[i].color = 'transparent';
      else stops[i].color = matchColor();   // custom, seeded from the border color
      setG({ stops, pattern: undefined }); this._render();
    }));
    root.querySelectorAll(`.${ns}-stop-remove`).forEach(btn => btn.onclick = () => {
      const stops = stopsOf(); stops.splice(Number(btn.dataset.idx), 1); setG({ stops, pattern: undefined }); this._render();
    });
    const add = root.querySelector(`.${ns}-stop-add`);
    if (add) add.onclick = () => { const stops = stopsOf(); stops.push({ pos: 100, color: 'match' }); setG({ stops, pattern: undefined }); this._render(); };
    const pat = root.querySelector(`.${ns}-pattern`);
    if (pat) pat.addEventListener('change', () => {
      if (pat.value === '') { setG({ pattern: undefined }); return; }
      const p = DIVIDER_GRADIENT_PATTERNS[Number(pat.value)]; if (!p) return;
      // A pattern's null (accent) placeholder becomes 'match' here, so the pattern tracks the
      // border color rather than baking in a fixed blue.
      const stops = p.stops.map(st => ({ pos: st.pos, color: st.color === null ? 'match' : st.color }));
      setG({ enabled: true, stops, pattern: Number(pat.value) }); this._render();
    });
  }
  // A "+ add" dropdown of candidate ids not already chosen. `addCls` names the ＋ button, and
  // `kind` colors it. Options come from `candidates`, excluding `chosen`.
  _renderAddPicker(candidates, chosen, kind, addCls, selCls, placeholder) {
    const remaining = (candidates || []).filter(id => !(chosen || []).includes(id));
    return `<div class="cpce-addrow">
      <select class="${selCls}">
        <option value="">${placeholder}</option>
        ${remaining.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(friendlyName(this._hass, id))}</option>`).join('')}
      </select>
      <button class="cpce-add-plus ${kind} ${addCls}" type="button" title="Add">＋</button>
    </div>`;
  }

  // Search-as-you-type picker for a large entity list, backed by a native <datalist>. The user
  // types (matching name OR id) and picks; `inputCls` is the text input's class and `listId`
  // the datalist id (must be unique per instance). Wiring reads the input's value → id.
  // A search-as-you-type picker that works on ALL platforms (no <datalist> — it silently fails
  // on mobile Safari/Chrome). Renders a filter input plus a scrollable list of clickable rows;
  // typing filters the rows live in JS (matching name OR id). Clicking a row calls the wired
  // add handler. `pickerCls` marks the wrapper so wiring can scope to it.
  _renderEntitySearchPicker(candidates, chosen, pickerCls, placeholder) {
    const remaining = (candidates || []).filter(id => !(chosen || []).includes(id));
    // The list starts collapsed (hidden) and opens on focus/typing — see _wireEntitySearchPicker.
    // Keeps long entity lists from dominating the panel until you actually want to pick something.
    return `<div class="cpce-search-picker ${pickerCls}">
      <input type="text" class="cpce-sp-input" placeholder="${placeholder}" autocomplete="off">
      <div class="cpce-sp-list collapsed">
        ${remaining.map(id => `<div class="cpce-sp-item" data-id="${escapeHtml(id)}" data-search="${escapeHtml((friendlyName(this._hass, id) + ' ' + id).toLowerCase())}"><span class="cpce-sp-name">${escapeHtml(friendlyName(this._hass, id))}</span><span class="cpce-entity-id">${escapeHtml(id)}</span></div>`).join('')}
        ${remaining.length ? '' : '<div class="cpce-hint" style="padding:8px;">Nothing left to add.</div>'}
      </div>
    </div>`;
  }
  // Wires a search picker: live filtering of its rows + onPick(id) when a row is clicked.
  _wireEntitySearchPicker(root, pickerCls, onPick) {
    const picker = root.querySelector(`.${pickerCls}`);
    if (!picker) return;
    const input = picker.querySelector('.cpce-sp-input');
    const list = picker.querySelector('.cpce-sp-list');
    const items = [...picker.querySelectorAll('.cpce-sp-item')];
    const openList = () => { if (list) list.classList.remove('collapsed'); };
    const closeList = () => { if (list) list.classList.add('collapsed'); };
    if (input) {
      input.addEventListener('focus', openList);
      input.addEventListener('input', () => {
        openList();
        const q = input.value.trim().toLowerCase();
        items.forEach(it => { it.style.display = (!q || it.dataset.search.includes(q)) ? '' : 'none'; });
      });
      // Close when focus leaves the picker (delay so an item click lands before we hide the list).
      input.addEventListener('blur', () => setTimeout(() => { if (!picker.contains(document.activeElement)) closeList(); }, 150));
    }
    items.forEach(it => it.addEventListener('click', () => { onPick(it.dataset.id); if (input) input.value = ''; closeList(); }));
  }

  // Per-divider appearance config (in a Section Order divider's gear panel). Layout: a live
  // preview + three Show toggles (Line / Text / Icon) at the top, then three COLLAPSIBLE
  // subpanels — Line, Text, Icon — each holding just that group's settings. Subpanel open-state
  // is tracked per-divider in this._openSubpanels (keys div-line/text/icon-<id>).
  _renderDividerConfig(s) {
    const cfg = this._config;
    const hasColor = !!s.color;
    const thickness = Number(s.thickness) || Number(cfg.divider_thickness) || 1;
    const length = Number(s.length) || Number(cfg.divider_length) || 100;
    const style = s.line_style || 'solid';
    const justify = s.justify || 'center';
    const isGradient = !!s.gradient;
    const did = escapeHtml(s.id);
    const showLine = !s.hide_line;
    const showText = !s.hide_text;
    const showIcon = !s.hide_icon;

    // ----- LINE group -----
    const lineBody = `
      <div class="cpce-divcfg-row">
        <label>Line Style<select class="cpce-div-style" data-id="${did}"${isGradient?' disabled':''}>
          <option value="solid" ${style==='solid'?'selected':''}>Solid</option>
          <option value="dashed" ${style==='dashed'?'selected':''}>Dashed</option>
          <option value="dotted" ${style==='dotted'?'selected':''}>Dotted</option>
        </select></label>
        <label>Line Position<select class="cpce-div-justify" data-id="${did}">
          <option value="left" ${justify==='left'?'selected':''}>Left</option>
          <option value="center" ${justify==='center'?'selected':''}>Center</option>
          <option value="right" ${justify==='right'?'selected':''}>Right</option>
        </select></label>
      </div>
      <div class="cpce-divcfg-checks"><label class="cpce-inline-check"><input type="checkbox" class="cpce-div-gradient" data-id="${did}" ${isGradient?'checked':''}> Gradient (multi-stop fade)</label></div>
      ${isGradient
        ? `<div class="cpce-divcfg-row"><label>Pattern<select class="cpce-div-pattern" data-id="${did}">
               <option value="" ${s.gradient_pattern==null?'selected':''}>Custom…</option>
               ${DIVIDER_GRADIENT_PATTERNS.map((p, pi) => `<option value="${pi}" ${String(s.gradient_pattern)===String(pi)?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}
             </select></label>
           </div>
           <div class="cpce-hint">Color stops left → right — position (0–100%) + color, or mark a stop <strong>Transparent</strong> for a fade in/out.</div>
           <div class="cpce-div-stops">${(Array.isArray(s.stops)?s.stops:[]).map((st, i) => {
             const isT = (st.color === 'transparent');
             const isTheme = (st.color === 'theme');
             return `<div class="cpce-row cpce-div-stop-row">
               <input type="range" class="cpce-div-stop-pos" data-id="${did}" data-idx="${i}" min="0" max="100" value="${clamp(Number(st.pos)||0,0,100)}"><span class="cpce-strength-val cpce-div-stop-pos-val">${clamp(Number(st.pos)||0,0,100)}%</span>
               <input type="color" class="cpce-div-stop-color" data-id="${did}" data-idx="${i}" value="${/^#[0-9a-f]{6}$/i.test(st.color||'')?st.color:'#2196F3'}"${(isT||isTheme)?' style="display:none;"':''}>
               <select class="cpce-div-stop-mode" data-id="${did}" data-idx="${i}" title="Stop color source">
                 <option value="color" ${(!isT&&!isTheme)?'selected':''}>Color</option>
                 <option value="theme" ${isTheme?'selected':''}>Theme</option>
                 <option value="transparent" ${isT?'selected':''}>Transp.</option>
               </select>
               <button class="cpce-delete-entity-btn cpce-div-stop-remove" data-id="${did}" data-idx="${i}" title="Remove stop"><ha-icon icon="mdi:close"></ha-icon></button>
             </div>`;
           }).join('')}</div>
           <button class="cpce-mini-btn cpce-div-stop-add" data-id="${did}"><ha-icon icon="mdi:plus"></ha-icon> Add color stop</button>
           <div class="cpce-hint">Color stops accept a hex color, <strong>Transparent</strong>, or <strong>Theme</strong> (theme divider color). Gradient uses a solid line (dashed/dotted disabled). Needs at least 2 stops.</div>
           ${((s.content_justify||s.justify||'center')==='center' && (s.text_position||'on')==='on' && showLine && (s.label || s.icon)) ? `<div class="cpce-divcfg-checks"><label class="cpce-inline-check"><input type="checkbox" class="cpce-div-mirror-center" data-id="${did}" ${s.mirror_center?'checked':''}> Mirror gradient around center (both sides symmetric)</label></div>` : ''}`
        : `<div class="cpce-divcfg-row"><label>Line Color<select class="cpce-div-color-mode" data-id="${did}">
              <option value="theme" ${!hasColor?'selected':''}>Theme default</option>
              <option value="fixed" ${hasColor?'selected':''}>Custom color</option>
            </select>${hasColor ? `<input type="color" class="cpce-div-color" data-id="${did}" value="${s.color}">` : ''}</label>
          </div>`}
      <div class="cpce-divcfg-slider"><label><span>Thickness (px):</span></label><input type="range" class="cpce-div-thickness" data-id="${did}" min="1" max="20" value="${thickness}"><span class="cpce-strength-val">${thickness}px</span></div>
      <div class="cpce-divcfg-slider"><label><span>Length (%):</span></label><input type="range" class="cpce-div-length" data-id="${did}" min="5" max="100" value="${length}"><span class="cpce-strength-val">${length}%</span></div>`;

    // ----- TEXT group (also holds content-layout: position vs line, justify, indent, mirror) -----
    // Layout matches the Easy Entity Styler card: compact 12px/400 labels, paired
    // dropdowns two-up per row, and full-width sliders (see .cpce-divcfg-* CSS).
    const tm = s.text_color_mode || (s.text_color ? 'fixed' : 'line');
    const textBody = `
      <div class="cpce-divcfg-slider"><label><span>Label:</span></label><input type="text" class="cpce-div-label" data-id="${did}" value="${escapeHtml(s.label || '')}" placeholder="(none)" style="flex:1;"></div>
      <div class="cpce-divcfg-row">
        ${showLine ? `<label>Text position<select class="cpce-div-text-position" data-id="${did}">
          <option value="above" ${s.text_position==='above'?'selected':''}>Above line</option>
          <option value="on" ${(s.text_position||'on')==='on'?'selected':''}>On line</option>
          <option value="below" ${s.text_position==='below'?'selected':''}>Below line</option>
        </select></label>` : ''}
        <label>Content align<select class="cpce-div-content-justify" data-id="${did}">
          <option value="left" ${(s.content_justify||s.justify||'center')==='left'?'selected':''}>Left</option>
          <option value="center" ${(s.content_justify||s.justify||'center')==='center'?'selected':''}>Center</option>
          <option value="right" ${(s.content_justify||s.justify||'center')==='right'?'selected':''}>Right</option>
        </select></label>
      </div>
      <div class="cpce-divcfg-slider"><label><span>Indent (px):</span></label><input type="range" class="cpce-div-indent" data-id="${did}" min="0" max="200" value="${Number(s.indent)||0}"><span class="cpce-strength-val">${Number(s.indent)||0}px</span></div>
      <div class="cpce-divcfg-slider"><label><span>Text size (px):</span></label><input type="range" class="cpce-div-text-size" data-id="${did}" min="8" max="32" value="${Number(s.text_size)||13}"><span class="cpce-strength-val">${Number(s.text_size)||13}px</span></div>
      <div class="cpce-divcfg-row">
        <label>Text weight<select class="cpce-div-text-weight" data-id="${did}">
          ${['300','400','500','600','700'].map(w => `<option value="${w}" ${String(s.text_weight||'600')===w?'selected':''}>${w}</option>`).join('')}
        </select></label>
        <label>Text color<select class="cpce-div-text-color-mode" data-id="${did}">
          <option value="line" ${tm==='line'?'selected':''}>Line color</option>
          <option value="theme" ${tm==='theme'?'selected':''}>Theme</option>
          <option value="fixed" ${tm==='fixed'?'selected':''}>Custom color</option>
        </select>${tm==='fixed' ? `<input type="color" class="cpce-div-text-color" data-id="${did}" value="${/^#[0-9a-f]{6}$/i.test(s.text_color||'')?s.text_color:'#ffffff'}">` : ''}</label>
      </div>
      ${tm==='line' && s.gradient ? `<div class="cpce-hint">A gradient line has no single color — "Line color" uses the first solid gradient stop. For an exact color, choose <strong>Custom color</strong>.</div>` : ''}`;

    // ----- ICON group -----
    const im = s.icon_color_mode || (s.icon_color ? 'fixed' : 'text');
    const iconBody = `
      <div class="cpce-divcfg-slider"><label><span>Icon:</span></label><input type="text" class="cpce-div-icon" data-id="${did}" value="${escapeHtml(s.icon || '')}" placeholder="mdi:star (none)" style="flex:1;">${s.icon ? `<ha-icon icon="${escapeHtml(normalizeIcon(s.icon))}" style="margin-left:6px;"></ha-icon>` : ''}</div>
      <div class="cpce-divcfg-slider"><label><span>Icon size (px):</span></label><input type="range" class="cpce-div-icon-size" data-id="${did}" min="10" max="48" value="${Number(s.icon_size)||(Number(s.text_size)||13)+4}"><span class="cpce-strength-val">${Number(s.icon_size)||(Number(s.text_size)||13)+4}px</span></div>
      <div class="cpce-divcfg-row">
        <label>Icon color<select class="cpce-div-icon-color-mode" data-id="${did}">
          <option value="text" ${im==='text'?'selected':''}>Match text color</option>
          <option value="theme" ${im==='theme'?'selected':''}>Theme</option>
          <option value="fixed" ${im==='fixed'?'selected':''}>Custom color</option>
        </select>${im==='fixed' ? `<input type="color" class="cpce-div-icon-color" data-id="${did}" value="${/^#[0-9a-f]{6}$/i.test(s.icon_color||'')?s.icon_color:'#ffffff'}">` : ''}</label>
      </div>`;

    return `
      <div class="cpce-hint">Live preview:</div>
      <div class="cpce-div-preview" data-id="${did}" style="border:1px dashed var(--divider-color,#333); border-radius:4px; margin-bottom:8px;">${this._dividerLineHtml(s)}</div>

      <div class="cpce-divcfg-checks">
        <label class="cpce-inline-check"><input type="checkbox" class="cpce-div-show-line" data-id="${did}" ${showLine?'checked':''}> Show Line</label>
        <label class="cpce-inline-check"><input type="checkbox" class="cpce-div-show-text" data-id="${did}" ${showText?'checked':''}> Show Text</label>
        <label class="cpce-inline-check"><input type="checkbox" class="cpce-div-show-icon" data-id="${did}" ${showIcon?'checked':''}> Show Icon</label>
      </div>

      ${this._subpanel(`div-line-${s.id}`, 'Line', lineBody)}
      ${this._subpanel(`div-text-${s.id}`, 'Text', textBody)}
      ${this._subpanel(`div-icon-${s.id}`, 'Icon', iconBody)}
    `;
  }

  // Target-lights picker for a slider/values section — SAME model as buttons: two checkboxes
  // (Default Entities pool ∪ this section's own any-light list). `section` is the section
  // object; `dataAttr` carries data-ss-target / data-vs-target so wiring can route the update.
  _renderTargetPicker(section, dataAttr) {
    const cardEntities = this._config.entities || [];
    const spec = presetTargetSpec(section);
    const allLights = getLightEntities(this._hass);
    return `
      <div class="cpce-target-picker" ${dataAttr}>
        <div class="cpce-check"><input type="checkbox" class="cpce-tp-use-default" ${spec.useDefault?'checked':''}><label>Use Default Entities${cardEntities.length ? '' : ' — none set'}</label></div>
        ${spec.useDefault && cardEntities.length ? `<div style="margin-left:22px;">${this._renderStaticChips(cardEntities, 'default')}</div>` : ''}
        <div class="cpce-check"><input type="checkbox" class="cpce-tp-use-custom" ${spec.useCustom?'checked':''}><label>Include other Entities</label></div>
        ${spec.useCustom ? (allLights.length
          ? `${this._renderAddPicker(allLights, spec.custom, 'on', 'cpce-tp-add', 'cpce-tp-sel', 'Add any light…')}${this._renderChips(spec.custom, 'on', 'cpce-tp-chip-x')}`
          : `<div class="cpce-hint">No <code>light.*</code> entities found.</div>`) : ''}
        ${!spec.useDefault && !spec.useCustom ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">No lights selected for this section.</div>` : ''}
      </div>
    `;
  }

  _renderInputColorLink(preset, index) {
    const linked = preset.input_color_entity;
    const allEntities = this._allInputColorEntities;
    // An entity may be linked to more than one preset (presets READ from the entity, so
    // sharing is fine). We still surface which entities are already used by another preset
    // via a 🔗+ marker so the user knows it's shared — but don't restrict the choice.
    const claimedByOthers = new Set(
      (this._config.presets || [])
        .filter((p, i) => i !== index && p.input_color_entity)
        .map(p => p.input_color_entity)
    );
    const optionIds = [...allEntities].sort();
    const linkedExists = linked && allEntities.includes(linked);
    const previewHex = linkedExists ? inputColorEntitySwatch(this._hass, linked) : null;
    return `
      <div class="cpce-input-color-link">
        <div class="cpce-row">
          <label class="lbl">Color Entity Link</label>
          <select class="cpce-preset-input-color" data-index="${index}">
            <option value="">Not linked (use the color above)</option>
            ${optionIds.map(id => `<option value="${escapeHtml(id)}" ${id === linked ? 'selected' : ''}>${escapeHtml(friendlyName(this._hass, id))} (${escapeHtml(id)})${claimedByOthers.has(id) ? ' — in another button' : ''}</option>`).join('')}
          </select>
          ${claimedByOthers.has(linked) ? `<ha-icon class="cpce-shared-link" icon="mdi:link-variant-plus" title="This Color Entity is also linked to another button"></ha-icon>` : ''}
        </div>
        ${linkedExists
          ? `<div class="cpce-row"><label class="lbl">Live Value</label><span class="cpce-preset-swatch" style="background:${previewHex}; width:26px; height:26px;"></span><span class="cpce-entity-id">follows the entity</span></div>
             <div class="cpce-hint">This button has <strong>no color of its own</strong> — it always applies <code>${escapeHtml(linked)}</code>'s current value, in real time. To change the color or brightness, edit the entity in <strong>Color Entities</strong> (Entities, Scenes &amp; Profiles). Every button linked to it updates together.</div>`
          : (linked
            ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">Linked entity "${escapeHtml(linked)}" isn't available. This button applies no color until it's restored (or unlink to set an inline color).</div>`
            : `<div class="cpce-hint">${allEntities.length ? 'Link to a Color Entity to make this button follow that entity live (its color/brightness are then edited in Color Entities, not here).' : 'No color.* (Color helper) entities found.'}</div>`)}
      </div>
    `;
  }

  // The merged "Manage Entities" list (Color Entities panel): every color.* / input_color.*
  // entity as a row with swatch · name · id · status icon · edit (per-entity color editor) ·
  // create-preset (only when unmatched to any button) · delete. Replaces the old separate
  // "Unmatched Entities" and "Delete Color Entities" lists.
  _renderColorEntitiesManageList() {
    const ids = this._allInputColorEntities;
    if (!ids.length) return `<div class="cpce-hint">No <code>color.*</code> (Color helper) entities found on this system.</div>`;
    // Which entities are linked to at least one button (status icon + create-preset gating).
    const linkedCounts = {};
    (this._config.presets || []).forEach(p => { const e = p && p.input_color_entity; if (e) linkedCounts[e] = (linkedCounts[e] || 0) + 1; });
    return `
      <div class="cpce-hint">Edit an entity's color/brightness with the pencil — buttons linked to it update live. The trash deletes the entity itself (never a button). Unlinked entities offer “+ Preset” to create a button that follows it.</div>
      <div class="cpce-manage-list">
        ${ids.map(id => {
          const count = linkedCounts[id] || 0;
          const open = this._openColorEntity === id;
          const statusIcon = count
            ? `<ha-icon class="cpce-link-indicator" icon="mdi:link-variant" title="Linked to ${count} button${count===1?'':'s'}"></ha-icon>`
            : `<ha-icon class="cpce-link-indicator cpce-link-unused" icon="mdi:link-variant-off" title="Not linked to any button"></ha-icon>`;
          return `<div class="cpce-manage-item" data-entity="${escapeHtml(id)}">
              <span class="cpce-fav-swatch" style="background:${inputColorEntitySwatch(this._hass, id)};"></span>
              <span class="cpce-ce-name">${escapeHtml(friendlyName(this._hass, id))}<span class="cpce-entity-id">${escapeHtml(id)}</span></span>
              ${statusIcon}
              <button class="cpce-icon-btn cpce-ce-edit${open?' active':''}" data-entity="${escapeHtml(id)}" title="Edit color / brightness"><ha-icon icon="mdi:pencil"></ha-icon></button>
              ${count ? '' : `<button class="cpce-create-preset-btn cpce-ce-create-preset" data-entity="${escapeHtml(id)}" title="Create a button linked to this entity"><ha-icon icon="mdi:plus"></ha-icon> Preset</button>`}
              <button class="cpce-delete-entity-btn cpce-ce-delete" data-entity="${escapeHtml(id)}" title="Delete entity"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
            </div>${open ? `<div class="cpce-ce-edit-panel" data-entity="${escapeHtml(id)}">${this._renderEntityEditPanel(id)}</div>` : ''}`;
        }).join('')}
      </div>
    `;
  }

  // Inline per-entity editor (color wheel + brightness) that writes to the entity via
  // set_color. Reads the entity's live value; every button linked to it follows instantly.
  _renderEntityEditPanel(id) {
    // Read the effective value = live entity value + any buffered draft edits.
    const value = this._entityEffectiveValue(id);
    const isWhite = value.color_kelvin != null;
    // value may now carry a native color key (rgb/xy/hs/…) from color_params — derive an rgb
    // preview via presetColorToRgb rather than assuming rgb_color.
    const rgb = isWhite ? ColorUtils.kelvinToRgb(value.color_kelvin) : presetColorToRgb(value);
    const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
    const min = Number(this._config.min_kelvin) || 2000;
    const max = Number(this._config.max_kelvin) || 6500;
    const kelvin = clamp(value.color_kelvin || Math.round((min + max) / 2), min, max);
    const hasBri = value.brightness !== undefined && value.brightness !== null;
    const briPct = hasBri ? Math.round((value.brightness / 255) * 100) : 100;
    return `
      <div class="cpce-row"><label class="lbl">Mode</label>
        <select class="cpce-ce-mode" data-entity="${escapeHtml(id)}">
          <option value="color" ${!isWhite?'selected':''}>Color</option>
          <option value="temp" ${isWhite?'selected':''}>White Temperature</option>
        </select>
      </div>
      ${!isWhite ? `<div class="cpce-wheel-row">
        <canvas class="cpce-color-wheel cpce-ce-wheel" width="150" height="150"></canvas>
        <div class="cpce-color-fields">
          <div class="cpce-hex-row"><div class="cpce-hex-preview" style="background:${hex};"></div><input type="text" class="cpce-hex-input cpce-ce-hex" data-entity="${escapeHtml(id)}" value="${hex}"></div>
        </div>
      </div>` : `<div class="cpce-temp-editor"><input type="range" class="cpce-ce-temp" data-entity="${escapeHtml(id)}" min="${min}" max="${max}" step="50" value="${kelvin}"><span class="cpce-temp-val">${kelvin}K</span></div>`}
      <div class="cpce-field-title">Brightness</div>
      <div class="cpce-check"><input type="checkbox" class="cpce-ce-bri-enable" data-entity="${escapeHtml(id)}" ${hasBri?'checked':''}><label>Store a brightness on this entity</label></div>
      ${hasBri ? `<div class="cpce-temp-editor"><input type="range" class="cpce-ce-bri" data-entity="${escapeHtml(id)}" min="1" max="100" value="${briPct}"><span class="cpce-bri-val">${briPct}%</span></div>` : ''}
      ${(() => { const d = this._entityDraftFor(id); const dirty = !!(d && d.dirty); return `<div class="cpce-layer-save-row">
        ${dirty ? `<div class="cpce-unsaved-banner"><ha-icon icon="mdi:content-save-alert"></ha-icon>Unsaved — writes to <code>${escapeHtml(id)}</code> on Save; linked buttons then apply it live.</div>` : `<div class="cpce-hint">Edit the color/brightness, then Save to write it to <code>${escapeHtml(id)}</code>.</div>`}
        <div class="cpce-row" style="gap:8px;">
          <button class="cpce-mini-btn cpce-ce-save${dirty ? ' cpce-btn-enabled' : ''}" data-entity="${escapeHtml(id)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:content-save"></ha-icon> Save</button>
          <button class="cpce-mini-btn cpce-ce-discard" data-entity="${escapeHtml(id)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:undo"></ha-icon> Discard</button>
        </div>
      </div>`; })()}
    `;
  }

  // Writes a color/brightness change to a Color Entity via <domain>.set_color. The service
  // needs a color component AND allows an independent brightness; to change just one we merge
  // the patch over the entity's CURRENT value so the other is preserved. `patch` may carry
  // rgb_color / color_temp_kelvin / brightness (brightness:null clears it). `silent` skips the
  // catch alert (used during wheel drag to avoid alert spam).
  _writeEntityColorData(id, patch, silent) {
    if (!this._hass || !id) return Promise.resolve(false);
    const cur = inputColorStateToPresetValue(this._hass.states[id]) || {};
    // Resolve the color component: patch wins; else keep the entity's current color/temp in its
    // OWN native format (rgb/xy/hs/…) so a brightness-only edit doesn't flatten an xy entity.
    const data = {};
    if (patch.rgb_color) data.rgb_color = patch.rgb_color;
    else if (patch.color_temp_kelvin != null) data.color_temp_kelvin = patch.color_temp_kelvin;
    else if (cur.color_kelvin != null) data.color_temp_kelvin = cur.color_kelvin;
    else {
      const fmt = presetColorFormat(cur);   // xy/hs/rgb/… preserved from color_params
      if (fmt) data[PRESET_COLOR_KEYS[fmt]] = cur[PRESET_COLOR_KEYS[fmt]];
      else data.rgb_color = [255, 255, 255];
    }
    // Brightness: patch overrides (null = clear); else preserve the entity's current brightness.
    const bri = ('brightness' in patch) ? patch.brightness : cur.brightness;
    if (bri != null) data.brightness = bri;
    const domain = colorEntityDomain(id);
    return this._hass.callService(domain, 'set_color', { entity_id: id, ...data })
      .then(() => true)
      .catch(e => { console.warn(`${LOG_PREFIX} ${domain}.set_color failed`, e); if (!silent) window.alert(`Could not update ${id}: ${formatWsError(e)}`); return false; });
  }

  // ---- Color Entity edit DRAFT (buffer edits; write on Save) ----
  _entityDraftFor(id) { return (this._entityColorDraft && this._entityColorDraft.id === id) ? this._entityColorDraft : null; }
  // The value the edit panel shows: the entity's live value with any buffered
  // draft patch merged on top (so unsaved edits are reflected without writing).
  _entityEffectiveValue(id) {
    const live = (this._hass && inputColorStateToPresetValue(this._hass.states[id])) || {};
    const d = this._entityDraftFor(id);
    if (!d || !d.patch) return live;
    const v = { ...live };
    const p = d.patch;
    if (p.rgb_color) { ALL_PRESET_COLOR_KEYS.forEach(k => delete v[k]); delete v.color_kelvin; v.rgb_color = p.rgb_color; }
    else if (p.color_temp_kelvin != null) { ALL_PRESET_COLOR_KEYS.forEach(k => delete v[k]); v.color_kelvin = p.color_temp_kelvin; }
    if ('brightness' in p) { if (p.brightness == null) delete v.brightness; else v.brightness = p.brightness; }
    return v;
  }
  // Merge a patch into the open entity's draft (seeding it if needed), mark dirty.
  _mutateEntityDraft(id, patch) {
    let d = this._entityDraftFor(id);
    if (!d) d = this._entityColorDraft = { id, patch: {}, dirty: false };
    // A color choice replaces any prior color key in the buffered patch.
    if (patch.rgb_color) delete d.patch.color_temp_kelvin;
    if (patch.color_temp_kelvin != null) delete d.patch.rgb_color;
    Object.assign(d.patch, patch);
    d.dirty = true;
  }
  // Save the buffered patch to the live entity via set_color.
  _saveEntityDraft(id) {
    const d = this._entityDraftFor(id); if (!d || !d.dirty) return;
    this._writeEntityColorData(id, d.patch, false).then(ok => {
      if (ok !== false) { this._entityColorDraft = null; this._render(); }
    });
  }
  _discardEntityDraft(id) { this._entityColorDraft = null; this._render(); }
  _syncEntityDirtyButtons(id) {
    const d = this._entityDraftFor(id); const dirty = !!(d && d.dirty);
    this.querySelectorAll(`.cpce-ce-save[data-entity="${id}"], .cpce-ce-discard[data-entity="${id}"]`).forEach(b => { b.disabled = !dirty; b.classList.toggle('cpce-btn-enabled', dirty); });
  }

  _renderPresetEditor(preset, index) {
    // The Button Mode drives which settings are relevant; everything else is hidden.
    //   off/scene → Button Styling (appearance only, since the button sends no color of its own)
    //   profile   → the Fixture Profile selector (the library owns the look)
    //   temp/color → the inline look editors + Save-to-Library + Color Entity Link
    const mode = buttonMode(preset);
    const isProfile = mode === 'profile';
    const isColor = mode === 'color';
    const isTemp = mode === 'temp';
    const isOff = mode === 'off';
    const isScene = mode === 'scene';
    // A Color-Entity-linked button holds NO color of its own — the entity is the source of
    // truth. So when linked we HIDE the inline look editors entirely and edit the value in the
    // Color Entities panel instead. Only Custom Color/Temp buttons can link.
    const isLinked = (isColor || isTemp) && !!preset.input_color_entity &&
      this._allInputColorEntities.includes(preset.input_color_entity);
    const showLook = (isColor || isTemp) && !isLinked;   // inline look editors live here
    const showButtonStyle = isScene || isOff;            // custom appearance for color-less buttons
    const min = Number(this._config.min_kelvin) || 2000;
    const max = Number(this._config.max_kelvin) || 6500;
    const kelvin = clamp(preset.color_kelvin || Math.round((min + max) / 2), min, max);
    // Brightness is optional (undefined = "don't set brightness"); when present it's 1-100%.
    const hasBrightness = preset.brightness !== undefined && preset.brightness !== null;
    const brightnessPct = hasBrightness ? Math.round((preset.brightness / 255) * 100) : 100;
    const collapsed = this._openPreset === index ? '' : ' collapsed';
    return `
      <div class="cpce-preset-editor${collapsed}${preset.hidden ? ' cpce-preset-hidden' : ''}" data-index="${index}">
        <div class="cpce-preset-summary" data-preset-toggle="${index}">
          <span class="cpce-preset-swatch" style="background:${this._presetSwatch(preset)};"></span>
          <ha-icon icon="${escapeHtml(resolvePresetIcon(preset, mode))}"></ha-icon>
          <span class="cpce-preset-summary-name">${escapeHtml(preset.name || 'Preset')}</span>
          ${this._presetLinkIcon(preset)}
          <button class="cpce-icon-btn cpce-preset-hide" title="${preset.hidden?'Show on card':'Hide from card'}"><ha-icon icon="${preset.hidden?'mdi:eye-off':'mdi:eye'}"></ha-icon></button>
          <button class="cpce-icon-btn cpce-preset-duplicate" title="Duplicate this button"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
          <button class="cpce-delete-entity-btn cpce-preset-remove" title="Delete this button"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
          <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
        </div>
        <div class="cpce-preset-body">
          <div class="cpce-subgroup"><ha-icon icon="mdi:link-variant"></ha-icon>Button</div>
          <div class="cpce-preset-header">
            <input type="text" class="cpce-preset-name" value="${escapeHtml(preset.name)}" placeholder="Name">
            <input type="text" class="cpce-preset-icon" value="${escapeHtml(preset.icon && !GENERIC_DEFAULT_ICONS.has(preset.icon) ? preset.icon : '')}" placeholder="${escapeHtml(modeDefaultIcon(mode))}">
          </div>
          ${(() => {
            const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
            // A button may be UNASSIGNED (section_id === '__none__'): it's not shown on the card, but
            // still defines a Scene-tile look (color/icon) the Scene Tracker borrows via Scene Selects.
            // A missing/blank section_id defaults to the first buttons section (legacy behavior).
            const unassigned = preset.section_id === '__none__';
            const current = unassigned ? '__none__' : (buttonsSections.some(s => s.id === preset.section_id) ? preset.section_id : (buttonsSections[0] && buttonsSections[0].id) || '');
            return `<div class="cpce-row"><label class="lbl">In Button Section</label>
              <select class="cpce-preset-section" data-index="${index}">
                ${buttonsSections.map(s => `<option value="${s.id}" ${s.id===current?'selected':''}>${escapeHtml(s.name || 'Buttons')}</option>`).join('')}
                <option value="__none__" ${unassigned?'selected':''}>None — not shown on card (tile look only)</option>
              </select>
            </div>
            ${unassigned ? '<div class="cpce-hint">This button is <strong>hidden from the card</strong>. It still defines a look the Scene Tracker can borrow (via its Scene Selects binding) — use it to style a scene tile without exposing a button.</div>' : ''}`;
          })()}
          <div class="cpce-row"><label class="lbl">Mode</label>
            <select class="cpce-preset-mode">
              <option value="off" ${isOff ? 'selected' : ''}>Light Off</option>
              <option value="profile" ${isProfile ? 'selected' : ''}>Fixture Profile</option>
              <option value="scene" ${isScene ? 'selected' : ''}>Scene</option>
              <option value="temp" ${isTemp ? 'selected' : ''}>Custom Temperature</option>
              <option value="color" ${isColor ? 'selected' : ''}>Custom Color</option>
            </select>
          </div>
          ${isScene ? `<div class="cpce-subgroup"><ha-icon icon="mdi:palette"></ha-icon>Scene</div>${this._renderPresetScenePicker(preset, index)}` : ''}
          ${isScene ? `<div class="cpce-subgroup"><ha-icon icon="mdi:lightbulb-on-outline"></ha-icon>Follow Lights for Color</div>${this._renderPresetGlowFollow(preset, index)}` : ''}
          ${showButtonStyle ? this._renderButtonStyling(preset, index) : ''}

          ${isProfile ? `<div class="cpce-subgroup"><ha-icon icon="mdi:link-variant"></ha-icon>Fixture Profile</div>
          ${this._renderPresetProfileLink(preset, index)}` : ''}

          ${(isColor || isTemp) ? `<div class="cpce-subgroup"><ha-icon icon="mdi:link-variant"></ha-icon>Custom ${isTemp ? 'Temperature' : 'Color'} (the look)</div>` : ''}
          ${showLook ? `
          ${isColor ? this._renderColorWheelEditor(preset, index) : ''}
          ${isTemp ? `<div class="cpce-field-title">Color Temperature</div><div class="cpce-temp-editor"><input type="range" class="cpce-preset-temp" min="${min}" max="${max}" step="50" value="${kelvin}"><span class="cpce-temp-val">${kelvin}K</span></div>` : ''}
          <div class="cpce-field-title">Brightness</div>
          <div class="cpce-check"><input type="checkbox" class="cpce-preset-bri-enable" ${hasBrightness ? 'checked' : ''}><label>Set brightness with this button</label></div>
          ${hasBrightness ? `<div class="cpce-temp-editor"><input type="range" class="cpce-preset-bri" min="1" max="100" value="${brightnessPct}"><span class="cpce-bri-val">${brightnessPct}%</span></div>` : `<div class="cpce-hint">When off, this button leaves the light's current brightness unchanged.</div>`}
          ${this._renderPresetExtras(preset, index, false)}
          <div class="cpce-row" style="margin-top:8px;">
            <button class="cpce-mini-btn cpce-preset-save-profile" data-index="${index}" title="Save this button's look as a reusable Fixture Profile in the shared library, then point this button at it"><ha-icon icon="mdi:content-save-move-outline"></ha-icon> Save as Fixture Profile</button>
          </div>
          <div class="cpce-hint">Promotes this local look to the shared <strong>Fixture Profiles</strong> library so other buttons/cards can reuse it. This button then follows the profile — edit it once, all update.</div>
          ` : ''}
          ${(isColor || isTemp) ? this._renderInputColorLink(preset, index) : ''}

          ${!isScene ? `<div class="cpce-subgroup"><ha-icon icon="mdi:lightbulb-group-outline"></ha-icon>Target Lights</div>
          ${this._renderPresetActions(preset, index, mode)}` : ''}

          <div class="cpce-subgroup"><ha-icon icon="mdi:format-list-bulleted"></ha-icon>Scene Selects</div>
          ${this._renderPresetSelects(preset, index)}
        </div>
      </div>
    `;
  }

  // Repeatable input_select bindings for a button. On press the card sets each; the button lights up
  // (active) only when ALL bindings currently match. Works for any button kind — group scenes across
  // rooms (one "Sports" button → several helpers), or an Off button that resets multiple helpers.
  _renderPresetSelects(preset, index) {
    // Render from the RAW array (not sanitized) so an in-progress row — entity chosen but option not
    // yet — still shows while editing. presetSelects() is the sanitized view used for card behavior.
    const binds = Array.isArray(preset.selects) ? preset.selects.map(b => ({ entity: (b && b.entity) || '', option: (b && b.option) || '' })) : [];
    const selects = this._allInputSelectEntities();   // [{entity, options[]}]
    const rowHtml = (b, i) => {
      const opts = (selects.find(s => s.entity === b.entity) || {}).options || [];
      // If the bound option isn't in the (known) list, still show it so it isn't silently dropped.
      const optionList = (b.option && !opts.includes(b.option)) ? [b.option, ...opts] : opts;
      return `<div class="cpce-row cpce-select-row" data-index="${index}" data-bind="${i}" style="gap:6px;">
        <select class="cpce-select-entity" data-index="${index}" data-bind="${i}" style="flex:2;min-width:150px;">
          <option value="">Choose input_select…</option>
          ${selects.map(s => `<option value="${escapeHtml(s.entity)}" ${s.entity === b.entity ? 'selected' : ''}>${escapeHtml(friendlyName(this._hass, s.entity))}</option>`).join('')}
          ${(b.entity && !selects.some(s => s.entity === b.entity)) ? `<option value="${escapeHtml(b.entity)}" selected>${escapeHtml(b.entity)} (missing)</option>` : ''}
        </select>
        <select class="cpce-select-option" data-index="${index}" data-bind="${i}" style="flex:1;min-width:110px;" ${b.entity ? '' : 'disabled'}>
          <option value="">Option…</option>
          ${optionList.map(o => `<option value="${escapeHtml(o)}" ${o === b.option ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
        </select>
        <button class="cpce-delete-entity-btn cpce-select-remove" data-index="${index}" data-bind="${i}" title="Remove binding"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
    };
    // Opt-out is only meaningful when this button's section defines a default scene reset AND this
    // is a non-scene button that doesn't already bind that group (otherwise the reset never fires).
    const section = this._sectionForPreset(preset);
    const defGroup = section && section.default_scene_group;
    const resetApplies = defGroup && buttonMode(preset) !== 'scene' && !binds.some(b => b.entity === defGroup);
    return `
      <div class="cpce-hint">When pressed, this button sets each chosen <code>input_select</code> to its option — and lights up (active) only when all of them currently match. Use for grouping scenes across rooms, or an Off button that resets several helpers.</div>
      ${binds.map((b, i) => rowHtml(b, i)).join('')}
      <button class="cpce-mini-btn cpce-select-add" data-index="${index}"><ha-icon icon="mdi:plus"></ha-icon> Add binding</button>
      ${selects.length ? '' : '<div class="cpce-hint">No <code>input_select</code> helpers found. Create one in Home Assistant (Settings → Devices &amp; Services → Helpers) first.</div>'}
      ${resetApplies ? `<div class="cpce-check" style="margin-top:8px;"><input type="checkbox" class="cpce-preset-no-reset" data-index="${index}" ${preset.no_scene_reset ? 'checked' : ''}><label>Do Not Set “${escapeHtml(friendlyName(this._hass, defGroup))}” to “${escapeHtml(section.default_scene_option || '-none-')}” on button press</label></div>` : ''}
    `;
  }
  // All input_select entities in HA (as Scene Groups), with their options — for every Scene Selects
  // picker + tracker Area picker. Filtered by the card-level Scene Group filter (Scene Groups panel):
  //   • string — the entity_id must contain this substring (default 'scene'); empty = no string filter.
  //   • label  — the entity must carry this HA label; empty = no label filter.
  // When BOTH are set a group must match BOTH (AND). One place to set it, every picker respects it.
  _allInputSelectEntities(ignoreFilter) {
    if (!this._hass || !this._hass.states) return [];
    const cfg = this._config || {};
    const str = ignoreFilter ? '' : (cfg.scene_group_filter_str !== undefined ? String(cfg.scene_group_filter_str) : 'scene').trim().toLowerCase();
    const label = ignoreFilter ? '' : (cfg.scene_group_filter_label || '');
    return Object.keys(this._hass.states)
      .filter(id => id.startsWith('input_select.'))
      .filter(id => !str || id.toLowerCase().includes(str))
      .filter(id => !label || getEntityLabels(this._hass, id).includes(label))
      .sort()
      .map(id => ({ entity: id, options: (this._hass.states[id].attributes && Array.isArray(this._hass.states[id].attributes.options)) ? this._hass.states[id].attributes.options : [] }));
  }

  // Custom button styling — TWO independent fixed colors, each enabled separately:
  //   • Button color (button_style_color): when on, the button BODY is always this color, no matter
  //     what the glow does.
  //   • Glow color (button_glow_style_color): when on, the GLOW is always this color, no matter what
  //     the body does.
  // Either off = that aspect follows the live/look color instead (body follows only when active;
  // glow follows the live color). Presence of the key = enabled (no separate boolean).
  _renderButtonStyling(preset, index) {
    const bodyOn = !!preset.button_style_color;
    const glowOn = !!preset.button_glow_style_color;
    return `
      <div class="cpce-check"><input type="checkbox" class="cpce-btnstyle-enable" data-index="${index}" ${bodyOn?'checked':''}><label>Fixed button color</label></div>
      ${bodyOn ? `
        <div class="cpce-row"><label class="lbl">Button Color</label><input type="color" class="cpce-btnstyle-color" data-index="${index}" value="${preset.button_style_color}"></div>
        <div class="cpce-hint">The button body stays this exact color — independent of the glow.</div>
      ` : ''}
      <div class="cpce-check"><input type="checkbox" class="cpce-btnglow-enable" data-index="${index}" ${glowOn?'checked':''}><label>Fixed glow color</label></div>
      ${glowOn ? `
        <div class="cpce-row"><label class="lbl">Glow Color</label><input type="color" class="cpce-btnglow-color" data-index="${index}" value="${preset.button_glow_style_color}"></div>
        <div class="cpce-hint">The glow stays this exact color — independent of the button body.</div>
      ` : ''}
      ${!bodyOn && !glowOn ? `<div class="cpce-hint">Off: the button body follows the live color when active; the glow follows the live color.</div>` : ''}
    `;
  }

  // "Follow Lights for Color" (scene buttons): pick lights whose LIVE color this scene button
  // borrows for its whole appearance (fill, glow, accents) — used when the card can't read a
  // scene's member lights automatically (a Zigbee2MQTT scene.* is a proxy that lists none) or to
  // override. When empty, an HA-native scene auto-resolves its own member lights; if nothing
  // resolves, the button falls back to its Custom Style Color, then grey.
  _renderPresetGlowFollow(preset, index) {
    const follow = Array.isArray(preset.glow_entities) ? preset.glow_entities.filter(Boolean) : [];
    const allLights = getLightEntities(this._hass);
    const autoMembers = this._sceneMemberLightIds(preset);
    const autoNote = follow.length
      ? ''
      : (autoMembers.length
        ? `<div class="cpce-hint">Auto-following this scene's ${autoMembers.length} member light${autoMembers.length === 1 ? '' : 's'} (read from the scene). Add lights below to override.</div>`
        : `<div class="cpce-hint">This scene exposes no member lights (e.g. a Zigbee2MQTT scene). Add the lights it turns on so the button's color follows them live; otherwise it uses the Custom Style Color below, then grey.</div>`);
    return `
      <div class="cpce-glowfollow" data-index="${index}">
        ${autoNote}
        ${allLights.length
          ? `${this._renderEntitySearchPicker(allLights, follow, 'cpce-gf-picker', 'Search lights to follow…')}${this._renderChips(follow, 'on', 'cpce-gf-chip-x')}`
          : `<div class="cpce-hint">No <code>light.*</code> entities found.</div>`}
      </div>
    `;
  }

  // The Fixture Profile selector (shown only in Mode = Fixture Profile). Picks a shared
  // library profile whose look this button applies. The look itself is edited in the Fixture
  // Profile Library — a change there updates every button referencing it.
  _renderPresetProfileLink(preset, index) {
    const scope = this._config && this._config.fixture_library_scope;
    const lib = fixtureLibraryMap(scope);
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    const curSlug = fixtureRefSlug(preset.profile_ref);
    const linked = curSlug && lib[curSlug];
    return `
      <div class="cpce-profile-link">
        <div class="cpce-row"><label class="lbl">Profile</label>
          <select class="cpce-preset-profile" data-index="${index}">
            <option value="" ${!curSlug?'selected':''}>Choose a profile…</option>
            ${slugs.map(s => `<option value="lib:${escapeHtml(s)}" ${curSlug===s?'selected':''}>${escapeHtml(lib[s].name || s)}</option>`).join('')}
            ${curSlug && !linked ? `<option value="lib:${escapeHtml(curSlug)}" selected>${escapeHtml(curSlug)} (missing)</option>` : ''}
          </select>
        </div>
        ${linked
          ? `<div class="cpce-hint">This button uses the shared profile <strong>${escapeHtml(lib[curSlug].name || curSlug)}</strong>. Edit it in the Fixture Profile Library; changes apply to every button using it.</div>`
          : (curSlug
            ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">Referenced profile "${escapeHtml(curSlug)}" isn't in the Library.</div>`
            : `<div class="cpce-hint">${slugs.length ? 'Pick a saved profile above.' : 'No profiles yet — create one in the Fixture Profile Library (Entities, Scenes &amp; Profiles), then select it here.'}</div>`)}
      </div>
    `;
  }

  // The Scene selector (shown only in Mode = Scene). A Scene button activates exactly ONE HA
  // scene (scene.turn_on). Build/edit scenes in the Scene Builder; combine multiple actions
  // (dim + turn off + close blinds…) inside the scene, not by stacking actions on the button.
  _renderPresetScenePicker(preset, index) {
    const scenes = getSceneEntities(this._hass);
    const cur = preset.scene_ref || '';
    const curExists = cur && scenes.includes(cur);
    return `
      <div class="cpce-row"><label class="lbl">Scene</label>
        <select class="cpce-preset-scene" data-index="${index}">
          <option value="" ${!cur?'selected':''}>Choose a scene…</option>
          ${scenes.map(s => `<option value="${escapeHtml(s)}" ${cur===s?'selected':''}>${escapeHtml(friendlyName(this._hass, s))}</option>`).join('')}
          ${cur && !curExists ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)} (missing)</option>` : ''}
        </select>
      </div>
      ${cur && !curExists ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">Scene "${escapeHtml(cur)}" isn't available.</div>`
        : `<div class="cpce-hint">${scenes.length ? 'This button activates the chosen scene. Build scenes in Scene Manager (Entities, Scenes &amp; Profiles).' : 'No scenes yet — create one in Scene Manager, then select it here.'}</div>`}
    `;
  }

  // ---- Scene Builder ----
  // Authors REAL Home Assistant scenes (scene.* entities) so they're usable by native cards,
  // select/input_select helpers, automations, and voice — not a card-private store. Scenes are
  // written via HA's scene config REST API (POST config/scene/config/<id>), the same endpoint
  // HA's own scene editor uses; they then appear as scene.* and can be triggered by any button's
  // "Trigger Scenes". Build #1: capture current light states into a new scene; list + delete.
  //
  // A scene is a frozen snapshot of per-entity state — unlike a Fixture Profile (a live look),
  // editing a light later does not change a saved scene. That's standard HA scene behavior.
  // The entity set the next capture will snapshot: an explicit user-chosen set, or (until they
  // touch it) the Default Entities pool as a sensible seed. Only capturable domains are kept.
  _sceneCaptureIds() {
    const base = this._sceneCaptureSet != null ? this._sceneCaptureSet : (this._config.entities || []);
    return base.filter(id => sceneDomainSupported(id));
  }

  // ---- Scene Groups: create & manage input_select helpers (the scene-state helpers buttons bind
  // to and the Scene Tracker displays). Admin-only (HA restriction). YAML-defined helpers are shown
  // read-only. Uses this._sceneHelpers (loaded via input_select/list) reconciled with hass.states.
  _renderSceneGroupsSection() {
    const isAdmin = !!(this._hass && this._hass.user && this._hass.user.is_admin);
    // All input_select entities from state (covers YAML + storage helpers).
    const all = this._allInputSelectEntities();   // [{entity, options[]}]
    // Storage helpers (editable) come from the collection list; map id→entity best-effort.
    const storage = Array.isArray(this._sceneHelpers) ? this._sceneHelpers : null;   // null = not loaded yet
    const storageEntities = new Set();
    (storage || []).forEach(h => { const eid = this._helperEntityId(h); if (eid) storageEntities.add(eid); });
    // Reference counts: how many buttons/areas point at each entity (for delete warnings).
    const refCount = (entity) => {
      let n = 0;
      (this._config.presets || []).forEach(p => { if (presetSelects(p).some(b => b.entity === entity)) n++; });
      ((this._config.sections) || []).forEach(s => { if (s && s.type === 'scene_tracker' && Array.isArray(s.areas)) s.areas.forEach(a => { if (a && a.entity === entity) n++; }); });
      return n;
    };
    const draft = this._sceneHelperDraft || null;   // { name, options:'multiline', initial, icon }
    const createOpen = !!this._sceneHelperCreateOpen;
    // Scene Group filter (card-level; every scene picker respects it). String defaults to 'scene'.
    const cfg = this._config || {};
    const filterStr = cfg.scene_group_filter_str !== undefined ? String(cfg.scene_group_filter_str) : 'scene';
    const filterLabel = cfg.scene_group_filter_label || '';
    const totalCount = this._allInputSelectEntities(true).length;   // unfiltered, for "N of M"
    const labelIds = getAllLabels(this._hass);
    const labelName = (id) => (this._hass && this._hass.labels && this._hass.labels[id] && this._hass.labels[id].name) || id;
    const filterUi = `
      <div class="cpce-sub-title">Scene Group filter</div>
      <div class="cpce-hint">Which <code>input_select</code> helpers count as Scene Groups everywhere in this card (button Scene Selects, tracker areas, this list). Both filters apply together.</div>
      <div class="cpce-row"><label class="lbl">Name contains</label><input type="text" id="cpce-sg-filter-str" placeholder="scene" value="${escapeHtml(filterStr)}"></div>
      <div class="cpce-row"><label class="lbl">Has label</label>
        <select id="cpce-sg-filter-label">
          <option value="" ${!filterLabel ? 'selected' : ''}>(any label)</option>
          ${labelIds.map(id => `<option value="${escapeHtml(id)}" ${filterLabel === id ? 'selected' : ''}>${escapeHtml(labelName(id))}</option>`).join('')}
          ${(filterLabel && !labelIds.includes(filterLabel)) ? `<option value="${escapeHtml(filterLabel)}" selected>${escapeHtml(filterLabel)} (missing)</option>` : ''}
        </select>
      </div>
      <div class="cpce-hint">Showing <strong>${all.length}</strong> of ${totalCount} <code>input_select</code> helper${totalCount === 1 ? '' : 's'}.</div>`;
    const listRows = all.map(({ entity, options }) => {
      const editable = isAdmin && storageEntities.has(entity);
      const editing = this._sceneHelperEditing === entity;
      const refs = refCount(entity);
      const optsPreview = options.length ? options.join(', ') : '(no options)';
      const meta = [editable ? '' : 'YAML / read-only', `${options.length} option${options.length===1?'':'s'}`, refs ? `${refs} ref${refs===1?'':'s'}` : ''].filter(Boolean).join(' · ');
      return `<div class="cpce-manage-item" data-entity="${escapeHtml(entity)}">
          <ha-icon icon="${editable ? 'mdi:form-select' : 'mdi:lock'}" style="color:var(--primary-color);flex-shrink:0;"></ha-icon>
          <span class="cpce-ce-name">${escapeHtml(friendlyName(this._hass, entity))}<span class="cpce-entity-id">${escapeHtml(entity)} · ${escapeHtml(meta)}</span></span>
          ${editable ? `<button class="cpce-icon-btn cpce-sh-edit${editing?' active':''}" data-entity="${escapeHtml(entity)}" title="Edit options"><ha-icon icon="mdi:pencil"></ha-icon></button>
          <button class="cpce-icon-btn cpce-sh-rename" data-entity="${escapeHtml(entity)}" title="Rename helper"><ha-icon icon="mdi:rename-box"></ha-icon></button>
          <button class="cpce-delete-entity-btn cpce-sh-delete" data-entity="${escapeHtml(entity)}" title="Delete helper"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>` : ''}
        </div>
        ${editing && editable ? `<div class="cpce-order-style-panel">
          <div class="cpce-sub-title">Options (one per line)</div>
          <textarea class="cpce-sh-options" data-entity="${escapeHtml(entity)}" rows="${Math.max(3, options.length + 1)}" style="width:100%;box-sizing:border-box;">${escapeHtml(options.join('\n'))}</textarea>
          <div class="cpce-hint">Changing or removing an option can orphan buttons/tracker areas that reference the old value (${refs} reference${refs===1?'':'s'}). They’ll simply stop matching until repointed.</div>
          <div class="cpce-row" style="gap:8px;margin-top:6px;"><button class="cpce-create-preset-btn cpce-sh-options-save" data-entity="${escapeHtml(entity)}"><ha-icon icon="mdi:content-save"></ha-icon> Save options</button><button class="cpce-mini-btn cpce-sh-edit" data-entity="${escapeHtml(entity)}">Cancel</button></div>
        </div>` : ''}`;
    }).join('');
    return `
      <div class="cpce-hint">Manage the <code>input_select</code> helpers that hold each area's current scene. Buttons set them (Scene Selects) and the Scene Tracker displays them. These are standard Home Assistant helpers — usable anywhere.</div>
      ${filterUi}
      ${isAdmin ? `
      <div class="cpce-collapse-head${createOpen ? '' : ' collapsed'}" id="cpce-sh-create-toggle"><span class="cpce-subpanel-name">Create a Scene Group</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
      ${createOpen ? `
        <div class="cpce-row"><label class="lbl">Name</label><input type="text" id="cpce-sh-name" placeholder="e.g. Family Room Scenes" value="${escapeHtml((draft && draft.name) || '')}"></div>
        <div class="cpce-sub-title">Options (one per line)</div>
        <textarea id="cpce-sh-new-options" rows="5" style="width:100%;box-sizing:border-box;" placeholder="Sports&#10;Dinner&#10;Bright&#10;Comfort&#10;-none-">${escapeHtml((draft && draft.options) || '')}</textarea>
        <div class="cpce-row"><label class="lbl">Initial option</label><input type="text" id="cpce-sh-initial" placeholder="(optional — defaults to first)" value="${escapeHtml((draft && draft.initial) || '')}"></div>
        <div class="cpce-row"><label class="lbl">Icon</label><input type="text" id="cpce-sh-icon" placeholder="mdi:lightbulb-group (optional)" value="${escapeHtml((draft && draft.icon) || '')}"></div>
        <div class="cpce-row" style="margin-top:6px;"><button class="cpce-create-preset-btn" id="cpce-sh-create"><ha-icon icon="mdi:plus"></ha-icon> Create helper</button></div>
      ` : ''}` : '<div class="cpce-hint">⚠️ Creating and editing helpers requires an <strong>admin</strong> Home Assistant user. You can still bind buttons to existing helpers.</div>'}
      <div class="cpce-collapse-head" id="cpce-sh-list-header" style="pointer-events:none;"><span class="cpce-subpanel-name">Scene Groups (${all.length})</span></div>
      ${all.length ? `<div class="cpce-manage-list">${listRows}</div>` : '<div class="cpce-hint">No input_select helpers yet.</div>'}
    `;
  }
  // Best-effort collection-id → entity_id resolution for a helper from input_select/list. The
  // storage helper's entity_id is input_select.<id> in the common case; verify against hass.states.
  _helperEntityId(h) {
    if (!h || !h.id) return null;
    const guess = `input_select.${h.id}`;
    if (this._hass && this._hass.states && this._hass.states[guess]) return guess;
    // Fallback: match by name against friendly_name.
    if (this._hass && this._hass.states) {
      const byName = Object.keys(this._hass.states).find(id => id.startsWith('input_select.') && (this._hass.states[id].attributes || {}).friendly_name === h.name);
      if (byName) return byName;
    }
    return guess;   // last resort
  }
  // Reverse of _helperEntityId: entity_id → the collection id needed by update/delete. Matches the
  // loaded storage-helper list; returns null when the entity isn't an editable storage helper.
  _helperCollectionId(entity) {
    const list = Array.isArray(this._sceneHelpers) ? this._sceneHelpers : [];
    const hit = list.find(h => this._helperEntityId(h) === entity);
    return hit ? hit.id : null;
  }
  // Count references to an input_select entity across button selects + tracker areas.
  _sceneHelperReferences(entity) {
    let buttons = 0, areas = 0;
    (this._config.presets || []).forEach(p => { if (presetSelects(p).some(b => b.entity === entity)) buttons++; });
    ((this._config.sections) || []).forEach(s => { if (s && s.type === 'scene_tracker' && Array.isArray(s.areas)) s.areas.forEach(a => { if (a && a.entity === entity) areas++; }); });
    return { buttons, areas, total: buttons + areas };
  }
  // Remove every reference to a (deleted) input_select entity: strip matching button selects and
  // tracker areas so no binding dangles. Writes config once.
  _cleanupHelperReferences(entity) {
    const presets = (this._config.presets || []).map(p => {
      if (!Array.isArray(p.selects)) return p;
      const kept = p.selects.filter(b => !(b && b.entity === entity));
      if (kept.length === p.selects.length) return p;
      const np = { ...p }; if (kept.length) np.selects = kept; else delete np.selects; return np;
    });
    const sections = (this._config.sections || []).map(s => {
      if (!s || s.type !== 'scene_tracker' || !Array.isArray(s.areas)) return s;
      const areas = s.areas.filter(a => !(a && a.entity === entity));
      if (areas.length === s.areas.length) return s;
      return { ...s, areas };
    });
    this._updateConfig({ presets, sections });
  }
  // Load the storage-helper collection once hass is available (admin only; non-admins can't list-edit
  // but the list command still returns for read — we only USE it to know which are editable).
  _ensureSceneHelpers() {
    if (this._sceneHelpersLoading || this._sceneHelpers) return;
    if (!this._hass || !this._hass.connection) return;
    this._sceneHelpersLoading = true;
    wsInputSelectList(this._hass)
      .then(list => { this._sceneHelpers = Array.isArray(list) ? list : []; this._sceneHelpersLoading = false; this._render(); })
      .catch(() => { this._sceneHelpers = []; this._sceneHelpersLoading = false; });   // non-admin/unsupported → empty (all treated read-only)
  }

  _renderSceneBuilderSection() {
    const scenes = getSceneEntities(this._hass);
    const captureIds = this._sceneCaptureIds();
    const candidates = getSceneCapturableEntities(this._hass);
    return `
      <div class="cpce-hint">Manage real Home Assistant <code>scene.*</code> entities — snapshots of the entities you choose (lights <em>and</em> switches, fans, covers, climate, media players…). They work anywhere in HA (native cards, <code>select</code> helpers, automations, voice) and can be triggered by a Scene-mode button.</div>

      <div class="cpce-collapse-head${this._sceneCreateCollapsed ? ' collapsed' : ''}" id="cpce-scene-create-toggle"><span class="cpce-subpanel-name">Create a Scene</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
      ${this._sceneCreateCollapsed ? '' : `
      <div class="cpce-hint">Set everything how you want it, choose which entities to include, then Capture. Seeded from your Default Entities; add or remove any supported entity. (A scene is a frozen snapshot — re-capture to update it.)</div>
      ${this._renderAddPicker(candidates, captureIds, 'on', 'cpce-scene-cap-add', 'cpce-scene-cap-sel', 'Add an entity to capture…')}
      ${captureIds.length
        ? this._renderChips(captureIds, 'on', 'cpce-scene-cap-x')
        : `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">No entities selected — add at least one to capture.</div>`}
      <div class="cpce-row"><label class="lbl">Transition</label>
        <input type="range" id="cpce-scene-new-transition" min="0" max="30" step="0.5" value="0"><span class="cpce-strength-val" id="cpce-scene-new-transition-val">0 sec</span>
      </div>
      <div class="cpce-row"><label class="lbl">Name</label><input type="text" id="cpce-scene-new-name" placeholder="e.g. Movie Night"></div>
      <div class="cpce-row"><label class="lbl">Icon</label><input type="text" id="cpce-scene-new-icon" placeholder="mdi:ticket"></div>
      <div class="cpce-row" style="margin-top:6px;">
        <button class="cpce-create-preset-btn" id="cpce-scene-capture"${captureIds.length?'':' disabled'}><ha-icon icon="mdi:camera-plus-outline"></ha-icon> Capture</button>
      </div>`}

      <div class="cpce-collapse-head${this._sceneListCollapsed ? ' collapsed' : ''}" id="cpce-scene-list-toggle"><span class="cpce-subpanel-name">Your Scenes (${scenes.length})</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
      ${this._sceneListCollapsed ? '' : (scenes.length
        ? `<div class="cpce-manage-list">${scenes.map(id => {
            const st = this._hass && this._hass.states[id];
            const members = (st && st.attributes && Array.isArray(st.attributes.entity_id)) ? st.attributes.entity_id.length : null;
            const open = this._openScene === id;
            return `<div class="cpce-manage-item" data-scene="${escapeHtml(id)}">
              <ha-icon icon="mdi:ticket" style="color:var(--info-color,#2196F3);"></ha-icon>
              <span class="cpce-ce-name">${escapeHtml(friendlyName(this._hass, id))}<span class="cpce-entity-id">${escapeHtml(id)}${members != null ? ` · ${members} ${members===1?'entity':'entities'}` : ''}</span></span>
              <button class="cpce-icon-btn cpce-scene-activate" data-scene="${escapeHtml(id)}" title="Activate this scene now"><ha-icon icon="mdi:play"></ha-icon></button>
              <button class="cpce-icon-btn cpce-scene-edit${open?' active':''}" data-scene="${escapeHtml(id)}" title="View / edit scene values"><ha-icon icon="mdi:pencil"></ha-icon></button>
              <button class="cpce-icon-btn cpce-scene-duplicate" data-scene="${escapeHtml(id)}" title="Duplicate this scene"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
            </div>${open ? `<div class="cpce-scene-edit-panel" data-scene="${escapeHtml(id)}">${this._renderSceneEditPanel(id)}</div>` : ''}`;
          }).join('')}</div>
          <div class="cpce-hint">Edit/re-capture/delete work for scenes stored in <code>scenes.yaml</code> (the editable store). Scenes defined in packages or read-only YAML can't be changed here — HA will report an error.</div>`
        : `<div class="cpce-hint">No scenes yet. Capture one above.</div>`)}
    `;
  }

  // The expanded edit panel for a scene: shows each captured light's exact stored values and
  // lets you edit them, then Save (a separate button writes back via the scene config API).
  // The scene's saved config isn't in the entity state, so we fetch it via GET config/scene/
  // config/<id> on expand and cache it (with any pending edits) in _sceneConfigCache.
  _renderSceneEditPanel(sceneEntity) {
    const cached = this._sceneConfigCache[sceneEntity];
    if (!cached) return `<div class="cpce-hint">Loading scene data…</div>`;
    if (cached._error) return `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">${escapeHtml(cached._error)}</div>`;
    const ents = cached.entities || {};
    const ids = Object.keys(ents);
    if (!ids.length) return `<div class="cpce-hint">This scene has no light entries.</div>`;
    const rows = ids.map(id => {
      const e = ents[id] || {};
      const domain = sceneDomainOf(id);
      // Swatch: light color if a light, else a neutral domain dot.
      let sw = 'var(--secondary-text-color)';
      if (domain === 'light') {
        if (e.state === 'off') sw = 'transparent';
        else if (e.color_temp_kelvin != null) sw = ColorUtils.rgbToHex(...ColorUtils.kelvinToRgb(e.color_temp_kelvin));
        else if (presetColorFormat(e)) sw = ColorUtils.rgbToHex(...presetColorToRgb(e));
        else sw = '#ffd27f';
      }
      return `<div class="cpce-manage-item" data-scene-row="${escapeHtml(id)}">
        <span class="cpce-fav-swatch" style="background:${sw};"></span>
        <span class="cpce-ce-name">${escapeHtml(friendlyName(this._hass, id))}<span class="cpce-entity-id">${escapeHtml(id)}</span></span>
        <button class="cpce-delete-entity-btn cpce-scene-row-remove" data-scene="${escapeHtml(sceneEntity)}" data-id="${escapeHtml(id)}" title="Remove this entity from the scene"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>
      <div class="cpce-scene-row-detail" style="margin:0 0 10px 26px;">${this._renderSceneRowDetail(sceneEntity, id, e)}</div>`;
    }).join('');
    // Add-entity picker (searchable): any capturable entity not already in the scene.
    const addCandidates = getSceneCapturableEntities(this._hass).filter(cid => !ids.includes(cid));
    const iconVal = cached.icon || '';
    return `
      <div class="cpce-hint">Exact values stored in this scene, grouped by entity. Edit, then Save.</div>
      <div class="cpce-row"><label class="lbl">Name</label><input type="text" class="cpce-scene-name" data-scene="${escapeHtml(sceneEntity)}" value="${escapeHtml(cached.name || '')}" placeholder="Scene name"></div>
      <div class="cpce-row"><label class="lbl">Icon</label><input type="text" class="cpce-scene-icon" data-scene="${escapeHtml(sceneEntity)}" value="${escapeHtml(iconVal)}" placeholder="mdi:ticket"><ha-icon icon="${escapeHtml(normalizeIcon(iconVal) || 'mdi:ticket')}"></ha-icon></div>
      ${rows}
      <div class="cpce-sub-title">Add an Entity</div>
      <div class="cpce-hint">Type to filter, then tap an entity to add it. Set its values here (no need to change the physical device first).</div>
      ${this._renderEntitySearchPicker(addCandidates, [], 'cpce-scene-add-picker', 'Search entities…')}
      <div class="cpce-row" style="margin-top:10px;">
        <button class="cpce-scene-save${cached._dirty?' dirty':''}" data-scene="${escapeHtml(sceneEntity)}">
          <ha-icon icon="${cached._dirty?'mdi:content-save-alert':'mdi:check'}"></ha-icon>
          ${cached._dirty ? 'Unsaved Changes — Click to Save' : 'Settings Saved'}
        </button>
      </div>
      <div class="cpce-sub-title">Scene Actions</div>
      <div class="cpce-row" style="gap:8px;">
        <button class="cpce-mini-btn cpce-accent-btn cpce-scene-recapture" data-scene="${escapeHtml(sceneEntity)}" title="Overwrite this scene with the current live state of its members"><ha-icon icon="mdi:camera-retake-outline"></ha-icon> Re-capture from current state</button>
        <button class="cpce-mini-btn cpce-scene-delete" data-scene="${escapeHtml(sceneEntity)}" style="color:var(--error-color,#f44336); border-color:var(--error-color,#f44336);"><ha-icon icon="mdi:trash-can-outline"></ha-icon> Delete scene</button>
      </div>
    `;
  }

  // A sensible default scene entry for a freshly-added entity (so it appears with editable
  // values). Lights default to on/white; toggles to on; others to their live state.
  _defaultSceneEntry(id) {
    const domain = sceneDomainOf(id);
    const st = this._hass && this._hass.states[id];
    if (domain === 'light') return { state: 'on', rgb_color: [255, 255, 255], brightness: 255 };
    if (domain === 'switch' || domain === 'input_boolean') return { state: 'on' };
    if (domain === 'lock') return { state: 'locked' };
    // Capture the live state as a starting point for richer domains.
    const cap = this._captureSceneEntities([id]);
    return cap[id] || { state: (st && st.state) || 'on' };
  }

  // Renders the editable detail for one scene entry, branched by domain. Choice-type attributes
  // (fan preset, media source, climate modes) draw their options from the LIVE entity's option
  // lists (e.g. preset_modes / source_list / hvac_modes) so we only offer valid values.
  _renderSceneRowDetail(sceneEntity, id, e) {
    const domain = sceneDomainOf(id);
    const st = this._hass && this._hass.states[id];
    const la = (st && st.attributes) || {};   // live attributes (for option lists)
    const d = (attr) => `data-scene="${escapeHtml(sceneEntity)}" data-id="${escapeHtml(id)}" data-attr="${attr}"`;
    // A generic on/off state selector shared by toggle-like domains.
    const stateSelect = (onVal, offVal) => `<div class="cpce-row"><label class="lbl">State</label>
      <select class="cpce-scene-attr" ${d('state')}>
        <option value="${onVal}" ${e.state!==offVal?'selected':''}>On</option>
        <option value="${offVal}" ${e.state===offVal?'selected':''}>Off</option>
      </select></div>`;
    // A number control. When min AND max are finite it's a same-row SLIDER with a live value
    // readout; otherwise a number input (open-ended values like a target temperature). The
    // slider uses class cpce-scene-slider (wired for live readout + commit-on-release).
    const numRow = (label, attr, val, min, max, step, suffix) => {
      const hasRange = Number.isFinite(min) && Number.isFinite(max);
      const cur = (val ?? '');
      if (hasRange) {
        const shown = (val != null && val !== '') ? val : min;
        return `<div class="cpce-row"><label class="lbl">${label}</label>
          <input type="range" class="cpce-scene-slider" ${d(attr)} min="${min}" max="${max}" ${step!=null?`step="${step}"`:''} value="${shown}">
          <span class="cpce-strength-val cpce-scene-slider-val">${shown}${suffix?` ${suffix}`:''}</span></div>`;
      }
      return `<div class="cpce-row"><label class="lbl">${label}</label>
        <input type="number" class="cpce-scene-attr" ${d(attr)} value="${cur}" ${min!=null?`min="${min}"`:''} ${max!=null?`max="${max}"`:''} ${step!=null?`step="${step}"`:''}>${suffix?`<span class="cpce-entity-id">${suffix}</span>`:''}</div>`;
    };
    const selRow = (label, attr, cur, options) => `<div class="cpce-row"><label class="lbl">${label}</label>
      <select class="cpce-scene-attr" ${d(attr)}>
        <option value="" ${cur==null?'selected':''}>(unset)</option>
        ${(options||[]).map(o => `<option value="${escapeHtml(String(o))}" ${String(cur)===String(o)?'selected':''}>${escapeHtml(String(o))}</option>`).join('')}
      </select></div>`;
    const checkRow = (label, attr, checked) => `<div class="cpce-check"><input type="checkbox" class="cpce-scene-attr-bool" ${d(attr)} ${checked?'checked':''}><label>${label}</label></div>`;

    if (domain === 'light') {
      const on = e.state !== 'off';
      let rgb = [255,210,127], fmtLabel = '';
      if (e.color_temp_kelvin != null) { rgb = ColorUtils.kelvinToRgb(e.color_temp_kelvin); fmtLabel = `${e.color_temp_kelvin}K`; }
      else if (presetColorFormat(e)) { rgb = presetColorToRgb(e); fmtLabel = presetColorFormat(e).toUpperCase(); }
      const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
      const briPct = e.brightness != null ? Math.round((e.brightness / 255) * 100) : null;
      const effects = Array.isArray(la.effect_list) ? la.effect_list : [];
      return `
        <div class="cpce-row"><label class="lbl">State</label>
          <select class="cpce-scene-light-state" data-scene="${escapeHtml(sceneEntity)}" data-id="${escapeHtml(id)}">
            <option value="on" ${on?'selected':''}>On</option>
            <option value="off" ${!on?'selected':''}>Off</option>
          </select></div>
        ${on ? `
          <div class="cpce-row"><label class="lbl">Color</label>
            <input type="color" class="cpce-scene-row-color" data-scene="${escapeHtml(sceneEntity)}" data-id="${escapeHtml(id)}" value="${hex}">
            <span class="cpce-entity-id">${fmtLabel ? `stored as ${escapeHtml(fmtLabel)}` : 'no color'}</span>
          </div>
          <div class="cpce-check"><input type="checkbox" class="cpce-scene-row-bri-en" data-scene="${escapeHtml(sceneEntity)}" data-id="${escapeHtml(id)}" ${briPct!=null?'checked':''}><label>Set brightness</label></div>
          ${briPct != null ? `<div class="cpce-row"><label class="lbl">Brightness</label><input type="range" class="cpce-scene-row-bri" data-scene="${escapeHtml(sceneEntity)}" data-id="${escapeHtml(id)}" min="1" max="100" value="${briPct}"><span class="cpce-strength-val cpce-bri-val">${briPct}%</span></div>` : ''}
          ${effects.length ? selRow('Effect', 'effect', e.effect ?? null, effects) : (e.effect ? `<div class="cpce-hint">Effect: <code>${escapeHtml(e.effect)}</code> (target reports no effect_list)</div>` : '')}
          ${numRow('Transition', 'transition', e.transition, 0, 300, 0.5, 'sec')}
        ` : ''}`;
    }
    if (domain === 'switch' || domain === 'input_boolean' || domain === 'lock') {
      return stateSelect(domain === 'lock' ? 'locked' : 'on', domain === 'lock' ? 'unlocked' : 'off');
    }
    if (domain === 'fan') {
      return `${stateSelect('on','off')}
        ${e.state!=='off' ? `${numRow('Speed %','percentage', e.percentage, 0, 100, 1, '%')}
        ${selRow('Preset', 'preset_mode', e.preset_mode ?? null, la.preset_modes)}
        ${checkRow('Oscillating', 'oscillating', !!e.oscillating)}` : ''}`;
    }
    if (domain === 'cover') {
      return `${numRow('Position','current_position', e.current_position, 0, 100, 1, '% open')}
        ${la.current_tilt_position != null || e.current_tilt_position != null ? numRow('Tilt','current_tilt_position', e.current_tilt_position, 0, 100, 1, '%') : ''}`;
    }
    if (domain === 'climate') {
      return `${selRow('Mode','hvac_mode', e.hvac_mode ?? null, la.hvac_modes)}
        ${numRow('Target °','temperature', e.temperature, null, null, 0.5)}
        ${selRow('Fan','fan_mode', e.fan_mode ?? null, la.fan_modes)}
        ${selRow('Preset','preset_mode', e.preset_mode ?? null, la.preset_modes)}`;
    }
    if (domain === 'media_player') {
      const volPct = e.volume_level != null ? Math.round(e.volume_level * 100) : 50;
      return `${stateSelect('on','off')}
        <div class="cpce-row"><label class="lbl">Volume</label><input type="range" class="cpce-scene-attr-vol" ${d('volume_level')} min="0" max="100" value="${volPct}"><span class="cpce-strength-val cpce-bri-val">${volPct}%</span></div>
        ${selRow('Source','source', e.source ?? null, la.source_list)}
        ${selRow('Sound Mode','sound_mode', e.sound_mode ?? null, la.sound_mode_list)}`;
    }
    if (domain === 'humidifier') {
      return `${stateSelect('on','off')}
        ${numRow('Humidity %','humidity', e.humidity, 0, 100, 1, '%')}
        ${selRow('Mode','mode', e.mode ?? null, la.available_modes)}`;
    }
    if (domain === 'input_number') return numRow('Value','state', e.state, null, null, 'any');
    if (domain === 'select' || domain === 'input_select') return selRow('Option','state', e.state, la.options);
    // Fallback: show the raw state read-only.
    return `<div class="cpce-hint">State: <code>${escapeHtml(String(e.state))}</code></div>`;
  }

  // Fetch a scene's saved config (name + per-entity states) via the scene config REST API and
  // cache it, then re-render the panel with real data.
  _loadSceneConfig(sceneEntity) {
    const cfgId = this._sceneConfigId(sceneEntity);
    if (!cfgId) { this._sceneConfigCache[sceneEntity] = { _error: 'This scene has no editable config id (likely YAML/packages) — can’t view its values here.' }; this._render(); return; }
    if (typeof this._hass.callApi !== 'function') { this._sceneConfigCache[sceneEntity] = { _error: 'hass.callApi unavailable.' }; this._render(); return; }
    this._hass.callApi('GET', `config/scene/config/${cfgId}`)
      .then(cfg => { this._sceneConfigCache[sceneEntity] = { name: cfg.name, icon: cfg.icon || '', entities: cfg.entities || {}, _cfgId: cfgId, _dirty: false }; this._render(); })
      .catch(e => { this._sceneConfigCache[sceneEntity] = { _error: `Could not load scene config: ${formatWsError(e)}` }; this._render(); });
  }

  // Mutate a cached scene entry and mark dirty (does not persist until Save Scene).
  _patchSceneRow(sceneEntity, entityId, patch) {
    const c = this._sceneConfigCache[sceneEntity]; if (!c || !c.entities) return;
    const e = { ...(c.entities[entityId] || {}) };
    Object.keys(patch).forEach(k => { if (patch[k] === undefined) delete e[k]; else e[k] = patch[k]; });
    c.entities[entityId] = e; c._dirty = true;
  }

  // Builds a scene `entities` map by snapshotting each entity's current state. Multi-domain:
  // lights get on/off + native color/brightness + effect; other domains get their state plus
  // the settable attributes from SCENE_CAPTURE_DOMAINS. Unknown domains are skipped.
  // `transition` (seconds), when > 0, is written onto each ON light entry (per-entity fade-in).
  _captureSceneEntities(ids, transition) {
    const tr = Number(transition);
    const hasTr = Number.isFinite(tr) && tr > 0;
    const out = {};
    (ids || []).forEach(id => {
      const st = this._hass && this._hass.states[id];
      if (!st) return;
      const domain = sceneDomainOf(id);
      if (!sceneDomainSupported(id)) return;
      const a = st.attributes || {};
      if (domain === 'light') {
        if (st.state !== 'on') { out[id] = { state: 'off' }; return; }
        const e = { state: 'on' };
        if (a.brightness != null) e.brightness = a.brightness;
        if (a.color_mode === 'color_temp' && a.color_temp_kelvin != null) e.color_temp_kelvin = a.color_temp_kelvin;
        else if (Array.isArray(a.rgbww_color)) e.rgbww_color = a.rgbww_color;
        else if (Array.isArray(a.rgbw_color)) e.rgbw_color = a.rgbw_color;
        else if (Array.isArray(a.xy_color)) e.xy_color = a.xy_color;
        else if (Array.isArray(a.hs_color)) e.hs_color = a.hs_color;
        else if (Array.isArray(a.rgb_color)) e.rgb_color = a.rgb_color;
        else if (a.color_temp_kelvin != null) e.color_temp_kelvin = a.color_temp_kelvin;
        // Effect: only meaningful values (skip "None"/empty, which isn't a real effect).
        if (a.effect && a.effect !== 'None' && a.effect !== 'none') e.effect = a.effect;
        if (hasTr) e.transition = tr;
        out[id] = e;
        return;
      }
      // Other domains: always capture the state, plus each whitelisted attribute that's present.
      const e = { state: st.state };
      (SCENE_CAPTURE_DOMAINS[domain] || []).forEach(key => { if (a[key] !== undefined && a[key] !== null) e[key] = a[key]; });
      out[id] = e;
    });
    return out;
  }

  // Writes a scene via HA's scene config REST API (persistent; lands in scenes.yaml), then
  // reloads scenes so the scene.* entity appears/refreshes. `sceneId` is the numeric-ish unique
  // id; for a new scene we mint one from a timestamp+counter. Returns a Promise<bool>.
  _saveSceneConfig(sceneId, name, entities, icon) {
    const hass = this._hass;
    if (!hass || typeof hass.callApi !== 'function') return Promise.reject(new Error('hass.callApi unavailable'));
    if (!Object.keys(entities).length) return Promise.reject(new Error('No entity states captured'));
    const body = { name, entities };
    const ic = normalizeIcon(icon);
    if (ic) body.icon = ic;
    return hass.callApi('POST', `config/scene/config/${sceneId}`, body)
      .then(() => hass.callService('scene', 'reload').catch(() => {}))
      .then(() => true);
  }

  _deleteSceneConfig(sceneId) {
    const hass = this._hass;
    if (!hass || typeof hass.callApi !== 'function') return Promise.reject(new Error('hass.callApi unavailable'));
    return hass.callApi('DELETE', `config/scene/config/${sceneId}`)
      .then(() => hass.callService('scene', 'reload').catch(() => {}))
      .then(() => true);
  }

  // The scene config API keys scenes by a unique id (the entity is scene.<slug of name> but the
  // config id is a separate opaque id). For a scene.* entity we read its `id` attribute when
  // present; else fall back to null (can't edit externally-defined scenes without an id).
  _sceneConfigId(sceneEntityId) {
    const st = this._hass && this._hass.states[sceneEntityId];
    return (st && st.attributes && st.attributes.id) || null;
  }

  // The Fixture Profile Library manager: lists saved profiles with rename/delete, a scope
  // toggle, and a swatch. Profiles are shared across all Color Light & Scene Manager cards.
  _renderProfileLibrarySection() {
    const lib = fixtureLibraryMap('system');
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    // Which library slugs are referenced by this card's presets (usage badge).
    const usedSlugs = new Set((this._config.presets || []).map(p => fixtureRefSlug(p && p.profile_ref)).filter(Boolean));
    return `
      <div class="cpce-hint">Reusable fixture profiles (color/brightness/transition/effect) shared across all Color Light & Scene Manager cards via Home Assistant's built-in store. Create and edit profiles here; a button uses one by setting Mode = Fixture Profile — one edit updates every button referencing it.</div>
      ${slugs.length
        ? `<div class="cpce-manage-list">${slugs.map(s => {
            const open = this._openProfile === s;
            // While open, show the DRAFT (unsaved edits) in the row + panel.
            const draft = (open && this._profileDraftFor(s)) || null;
            const dirty = !!(draft && draft.dirty);
            const e = draft ? draft.entry : lib[s];
            const rgb = presetColorToRgb(e.look || {});
            const sw = (e.look && e.look.action === 'turn_off') ? 'transparent' : ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
            return `<div class="cpce-manage-item${dirty ? ' cpce-item-unsaved' : ''}" data-slug="${escapeHtml(s)}">
              <span class="cpce-fav-swatch" style="background:${sw};"></span>
              <span class="cpce-ce-name">${escapeHtml(e.name || s)}${dirty ? ' <span class="cpce-unsaved-dot" title="Unsaved changes">●</span>' : ''}</span>
              ${usedSlugs.has(s) ? '<span class="cpce-order-type">in use</span>' : ''}
              <button class="cpce-icon-btn cpce-profile-edit${open?' active':''}" data-slug="${escapeHtml(s)}" title="Edit profile"><ha-icon icon="mdi:pencil"></ha-icon></button>
              <button class="cpce-delete-entity-btn cpce-profile-lib-delete" data-slug="${escapeHtml(s)}" title="Delete profile from library"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
            </div>${open ? `<div class="cpce-profile-edit-panel${dirty ? ' cpce-panel-unsaved' : ''}" data-slug="${escapeHtml(s)}">${this._renderProfileEditPanel(s, e)}${this._renderProfileSaveRow(s, dirty)}</div>` : ''}`;
          }).join('')}</div>`
        : `<div class="cpce-hint">No profiles yet. Click “Add Profile” to create one.</div>`}
      <button class="cpce-add-btn" id="cpce-add-profile"><ha-icon icon="mdi:plus"></ha-icon> Add Profile</button>
    `;
  }

  // Inline editor for a library profile's LOOK — the SAME UI as a Custom Color/Temperature
  // button (real color wheel, brightness, transition & effect). Edits write straight to the
  // library, so every button referencing this profile updates live. A profile is always a
  // color OR a temperature — never Off/None (those are button behaviors, not looks).
  _renderProfileEditPanel(slug, entry) {
    const look = (entry && entry.look) || {};
    const mode = presetMode(look) === 'temp' ? 'temp' : 'color';   // profiles are color|temp only
    const min = Number(this._config.min_kelvin) || 2000;
    const max = Number(this._config.max_kelvin) || 6500;
    const kelvin = clamp(look.color_kelvin || Math.round((min + max) / 2), min, max);
    const hasBri = look.brightness !== undefined && look.brightness !== null;
    const briPct = hasBri ? Math.round((look.brightness / 255) * 100) : 100;
    const hasTrans = look.transition !== undefined && look.transition !== null && look.transition !== '';
    const tVal = hasTrans ? Number(look.transition) : 0;
    const effects = getUnionEffectList(this._hass, this._config.entities || []);
    const curEffect = look.effect || '';
    return `
      <div class="cpce-row"><label class="lbl">Name</label>
        <input type="text" class="cpce-profile-rename" data-slug="${escapeHtml(slug)}" value="${escapeHtml((entry && entry.name) || slug)}" placeholder="Profile name">
      </div>
      <div class="cpce-row"><label class="lbl">Note</label>
        <input type="text" class="cpce-profile-note" data-slug="${escapeHtml(slug)}" value="${escapeHtml((entry && entry.note) || '')}" placeholder="optional note">
      </div>
      <div class="cpce-row"><label class="lbl">Mode</label>
        <select class="cpce-pe-mode" data-slug="${escapeHtml(slug)}">
          <option value="color" ${mode==='color'?'selected':''}>Custom Color</option>
          <option value="temp" ${mode==='temp'?'selected':''}>Custom Temperature</option>
        </select>
      </div>
      ${mode === 'color' ? this._renderColorWheelEditor(look, -1) : ''}
      ${mode === 'temp' ? `<div class="cpce-field-title">Color Temperature</div><div class="cpce-temp-editor"><input type="range" class="cpce-pe-temp" data-slug="${escapeHtml(slug)}" min="${min}" max="${max}" step="50" value="${kelvin}"><span class="cpce-temp-val">${kelvin}K</span></div>` : ''}
      <div class="cpce-field-title">Brightness</div>
      <div class="cpce-check"><input type="checkbox" class="cpce-pe-bri-enable" data-slug="${escapeHtml(slug)}" ${hasBri?'checked':''}><label>Set brightness with this profile</label></div>
      ${hasBri ? `<div class="cpce-temp-editor"><input type="range" class="cpce-pe-bri" data-slug="${escapeHtml(slug)}" min="1" max="100" value="${briPct}"><span class="cpce-bri-val">${briPct}%</span></div>` : `<div class="cpce-hint">When off, the profile leaves the light's current brightness unchanged.</div>`}
      <div class="cpce-field-title">Transition &amp; Effect</div>
      <div class="cpce-check"><input type="checkbox" class="cpce-pe-trans-enable" data-slug="${escapeHtml(slug)}" ${hasTrans?'checked':''}><label>Fade with a transition</label></div>
      ${hasTrans ? `<div class="cpce-temp-editor"><input type="range" class="cpce-pe-trans" data-slug="${escapeHtml(slug)}" min="0" max="10" step="0.1" value="${tVal}"><span class="cpce-transition-val">${tVal}s</span></div>` : `<div class="cpce-hint">When off, the light changes instantly.</div>`}
      ${effects.length
        ? `<div class="cpce-row"><label class="lbl">Effect</label>
            <select class="cpce-pe-effect" data-slug="${escapeHtml(slug)}">
              <option value="" ${!curEffect?'selected':''}>None</option>
              ${effects.map(e => `<option value="${escapeHtml(e)}" ${curEffect===e?'selected':''}>${escapeHtml(e)}</option>`).join('')}
            </select>
          </div>${curEffect && !effects.includes(curEffect) ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">Saved effect "${escapeHtml(curEffect)}" isn't offered by the card's light(s).</div>` : ''}${curEffect ? `<div class="cpce-hint">Effects run on the bulb's firmware; their speed isn't adjustable and most override the color. If it flashes with a color, try “Send effect in a separate command” under Advanced Send Methods.</div>` : ''}`
        : `<div class="cpce-hint">The card's light(s) report no effects (<code>effect_list</code>), so none can be chosen.</div>`}
      <div class="cpce-hint">Editing here updates every button that references this profile — after you Save.</div>
    `;
  }

  // Save/Discard row for a fixture-profile editor. Edits live in this._profileDraft
  // until Save commits them to the shared library. Disabled until dirty.
  _renderProfileSaveRow(slug, dirty) {
    return `<div class="cpce-layer-save-row">
      ${dirty ? `<div class="cpce-unsaved-banner"><ha-icon icon="mdi:content-save-alert"></ha-icon>Unsaved changes — this is a shared Fixture Profile; Save applies it to every card/button that uses it.</div>` : ''}
      <div class="cpce-row" style="gap:8px;">
        <button class="cpce-mini-btn cpce-profile-save${dirty ? ' cpce-btn-enabled' : ''}" data-slug="${escapeHtml(slug)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:content-save"></ha-icon> Save</button>
        <button class="cpce-mini-btn cpce-profile-discard" data-slug="${escapeHtml(slug)}" ${dirty ? '' : 'disabled'}><ha-icon icon="mdi:undo"></ha-icon> Discard</button>
      </div>
    </div>`;
  }

  // ---- Fixture Profile DRAFT (edits stay local until Save) ----
  // The open profile's working copy. Look reads route through here so the editor
  // + preview reflect unsaved edits; readers fall back to the stored entry.
  _profileDraftFor(slug) { return (this._profileDraft && this._profileDraft.slug === slug) ? this._profileDraft : null; }
  _profileEntry(slug) {
    const d = this._profileDraftFor(slug);
    return d ? d.entry : (fixtureLibraryMap('system')[slug] || null);
  }
  _profileLook(slug) { const e = this._profileEntry(slug); return (e && e.look) || {}; }
  // Mutate the draft entry via fn(entry), mark dirty. Seeds the draft from the
  // stored entry if not already open for this slug.
  _mutateProfileDraft(slug, fn) {
    let d = this._profileDraftFor(slug);
    if (!d) {
      const cur = fixtureLibraryMap('system')[slug]; if (!cur) return;
      d = this._profileDraft = { slug, entry: JSON.parse(JSON.stringify(cur)), dirty: false };
    }
    fn(d.entry); d.dirty = true;
  }
  // Persist the open profile draft → shared library (system-wide confirm).
  _saveProfileDraft(slug) {
    const d = this._profileDraftFor(slug); if (!d || !d.dirty) return;
    const nm = d.entry.name || slug;
    if (!window.confirm(`Save "${nm}"?\n\nThis is a shared Fixture Profile — the change applies to EVERY card and button using it across your Home Assistant, not just this one.`)) return;
    const map = { ...fixtureLibraryMap('system') };
    map[slug] = JSON.parse(JSON.stringify(d.entry));
    // Reflect immediately in the module cache so the UI shows the saved state
    // without waiting for the subscription echo.
    FIXTURE_LIBRARY.system.map = map;
    saveFixtureLibrary(this._hass, 'system', map)
      .then(() => { d.dirty = false; this._render(); })
      .catch(err => { console.error(`${LOG_PREFIX} save profile failed`, err); window.alert(`Could not save: ${formatWsError(err)}`); });
  }
  _discardProfileDraft(slug) {
    const cur = fixtureLibraryMap('system')[slug];
    this._profileDraft = cur ? { slug, entry: JSON.parse(JSON.stringify(cur)), dirty: false } : null;
    this._render();
  }

  // Merge a partial look change into the profile DRAFT (not the store).
  _patchProfileLook(slug, patch) {
    this._mutateProfileDraft(slug, e => {
      const look = { ...(e.look || {}), ...patch };
      // Drop empty keys so a cleared effect/transition doesn't linger.
      Object.keys(look).forEach(k => { if (look[k] === null || look[k] === undefined || look[k] === '') delete look[k]; });
      e.look = look;
    });
    this._syncProfileDirtyButtons(slug);
  }

  // Stores a profile color (native format+value) into the DRAFT, clearing other
  // color keys and kelvin/action. Returns a resolved promise for callers that chain.
  _storeProfileColor(slug, fmt, value) {
    this._mutateProfileDraft(slug, e => {
      const look = { ...(e.look || {}) };
      ALL_PRESET_COLOR_KEYS.forEach(k => delete look[k]);
      look[PRESET_COLOR_KEYS[fmt]] = value;
      delete look.color_kelvin; delete look.action; delete look.look_none;
      e.look = look;
    });
    return Promise.resolve();
  }

  // Wheel/hex give an RGB triple; convert to the profile's current format and store.
  _setProfileColorFromRgb(slug, rgb) {
    const look = this._profileLook(slug);
    const fmt = presetColorFormat(look) || 'rgb';
    let value;
    switch (fmt) {
      case 'xy': value = ColorUtils.rgbToXy(rgb[0], rgb[1], rgb[2]); break;
      case 'hs': value = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]); break;
      case 'rgbw': value = [rgb[0], rgb[1], rgb[2], (look[PRESET_COLOR_KEYS.rgbw] || [])[3] || 0]; break;
      case 'rgbww': { const cur = look[PRESET_COLOR_KEYS.rgbww] || []; value = [rgb[0], rgb[1], rgb[2], cur[3] || 0, cur[4] || 0]; break; }
      default: value = rgb.slice(0, 3);
    }
    this._storeProfileColor(slug, fmt, value);
    this._refreshProfileColorPreview(slug);
  }

  // Switches a profile's color format, converting the current color so it's preserved. Full
  // re-render to swap the visible native fields.
  _setProfileColorFormat(slug, fmt) {
    const look = this._profileLook(slug);
    const rgb = presetColorToRgb(look);
    let value;
    switch (fmt) {
      case 'xy': value = ColorUtils.rgbToXy(rgb[0], rgb[1], rgb[2]); break;
      case 'hs': value = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]); break;
      case 'rgbw': value = [rgb[0], rgb[1], rgb[2], 0]; break;
      case 'rgbww': value = [rgb[0], rgb[1], rgb[2], 0, 0]; break;
      default: value = rgb.slice(0, 3);
    }
    const p = this._storeProfileColor(slug, fmt, value);
    (p && p.then ? p : Promise.resolve()).then(() => this._render());
  }

  // Reads the native fields (cpce-c-0..4) in a profile panel and stores them verbatim.
  _commitProfileNativeFields(slug, panel) {
    const look = this._profileLook(slug);
    const fmt = presetColorFormat(look) || 'rgb';
    const read = (i, isFloat) => { const el = panel.querySelector(`.cpce-c-${i}`); if (!el) return 0; return isFloat ? (parseFloat(el.value) || 0) : (parseInt(el.value, 10) || 0); };
    let value;
    if (fmt === 'xy') value = [clamp(read(0, true), 0, 1), clamp(read(1, true), 0, 1)];
    else if (fmt === 'hs') value = [clamp(read(0), 0, 360), clamp(read(1), 0, 100)];
    else if (fmt === 'rgb') value = [0,1,2].map(i => clamp(read(i), 0, 255));
    else if (fmt === 'rgbw') value = [0,1,2,3].map(i => clamp(read(i), 0, 255));
    else if (fmt === 'rgbww') value = [0,1,2,3,4].map(i => clamp(read(i), 0, 255));
    this._storeProfileColor(slug, fmt, value);
    this._refreshProfileColorPreview(slug);
  }

  // Live-refresh the wheel/hex/swatch in a profile panel (no full re-render, so a focused
  // native field keeps its caret). Mirrors _refreshPresetColorPreview.
  _refreshProfileColorPreview(slug) {
    const panel = this.querySelector(`.cpce-profile-edit-panel[data-slug="${slug}"]`);
    if (!panel) return;
    const look = this._profileLook(slug);
    const rgb = presetColorToRgb(look);
    const hs = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]);
    const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
    const hexEl = panel.querySelector('.cpce-hex-input');
    if (hexEl && document.activeElement !== hexEl) hexEl.value = hex;
    const preview = panel.querySelector('.cpce-hex-preview');
    if (preview) preview.style.background = hex;
    this._drawColorWheel(panel.querySelector('.cpce-color-wheel'), hs[0], hs[1]);
    const item = this.querySelector(`.cpce-manage-item[data-slug="${slug}"] .cpce-fav-swatch`);
    if (item) item.style.background = hex;
    // A wheel/hex edit marks the draft dirty without a full re-render — reflect
    // that on the Save/Discard buttons so they enable immediately.
    this._syncProfileDirtyButtons(slug);
  }

  // Enable/disable the profile Save/Discard buttons to match draft dirtiness,
  // without rebuilding the DOM (used after live color edits).
  _syncProfileDirtyButtons(slug) {
    const d = this._profileDraftFor(slug); const dirty = !!(d && d.dirty);
    this.querySelectorAll(`.cpce-profile-save[data-slug="${slug}"], .cpce-profile-discard[data-slug="${slug}"]`).forEach(b => {
      b.disabled = !dirty; b.classList.toggle('cpce-btn-enabled', dirty);
    });
  }

  // Wires the real color wheel + hex + native fields inside a library profile's edit panel.
  _wireProfileColorWheel(panel, slug) {
    const fmtSel = panel.querySelector('.cpce-color-format');
    if (fmtSel) fmtSel.addEventListener('change', () => this._setProfileColorFormat(slug, fmtSel.value));
    const canvas = panel.querySelector('.cpce-color-wheel');
    if (canvas) {
      const look = this._profileLook(slug);
      const rgb = presetColorToRgb(look);
      const hs0 = ColorUtils.rgbToHs(rgb[0], rgb[1], rgb[2]);
      this._drawColorWheel(canvas, hs0[0], hs0[1]);
      const cx = canvas.width / 2, cy = canvas.height / 2;
      const radius = Math.min(cx, cy) - 4;
      const updateFromWheel = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        const px = (clientX - rect.left) * (canvas.width / rect.width) - cx;
        const py = (clientY - rect.top) * (canvas.height / rect.height) - cy;
        const dist = Math.min(Math.sqrt(px * px + py * py), radius);
        let angle = Math.atan2(py, px) * 180 / Math.PI; if (angle < 0) angle += 360;
        this._setProfileColorFromRgb(slug, ColorUtils.hsToRgb(Math.round(angle) % 360, Math.round((dist / radius) * 100)));
      };
      let dragging = false;
      canvas.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; updateFromWheel(e.clientX, e.clientY); });
      window.addEventListener('mousemove', (e) => { if (dragging) updateFromWheel(e.clientX, e.clientY); });
      window.addEventListener('mouseup', () => { dragging = false; });
      canvas.addEventListener('touchstart', (e) => { dragging = true; updateFromWheel(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
      window.addEventListener('touchmove', (e) => { if (dragging) updateFromWheel(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
      window.addEventListener('touchend', () => { dragging = false; });
    }
    const hexEl = panel.querySelector('.cpce-hex-input');
    if (hexEl) hexEl.addEventListener('change', () => { const rgb = ColorUtils.hexToRgb(hexEl.value); if (rgb) this._setProfileColorFromRgb(slug, rgb); });
    [...panel.querySelectorAll('[class*="cpce-c-"]')].forEach(el => el.addEventListener('change', () => this._commitProfileNativeFields(slug, panel)));
  }

  _renderPresetExtras(preset, index, isOff) {
    // Effects come from the union of the button's effective targets (defaults ∪ custom), falling
    // back to the Default Entities pool so the picker still populates for a not-yet-targeted button.
    const spec = presetTargetSpec(preset);
    let targetIds = [];
    if (spec.useDefault) targetIds.push(...(this._config.entities || []));
    if (spec.useCustom) targetIds.push(...spec.custom);
    if (!targetIds.length) targetIds = this._config.entities || [];
    const effects = getUnionEffectList(this._hass, [...new Set(targetIds)]);
    const curEffect = preset.effect || '';
    const hasTransition = preset.transition !== undefined && preset.transition !== null && preset.transition !== '';
    const tVal = hasTransition ? Number(preset.transition) : 0;
    return `
      <div class="cpce-field-title">Transition &amp; Effect</div>
      <div class="cpce-check"><input type="checkbox" class="cpce-preset-transition-enable" ${hasTransition ? 'checked' : ''}><label>Fade with a transition</label></div>
      ${hasTransition ? `<div class="cpce-temp-editor"><input type="range" class="cpce-preset-transition" min="0" max="10" step="0.1" value="${tVal}"><span class="cpce-transition-val">${tVal}s</span></div>` : `<div class="cpce-hint">When off, the light changes instantly.</div>`}
      ${!isOff ? (effects.length
        ? `<div class="cpce-row"><label class="lbl">Effect</label>
            <select class="cpce-preset-effect">
              <option value="" ${!curEffect?'selected':''}>None</option>
              ${effects.map(e => `<option value="${escapeHtml(e)}" ${curEffect===e?'selected':''}>${escapeHtml(e)}</option>`).join('')}
            </select>
          </div>${curEffect && !effects.includes(curEffect) ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">Saved effect "${escapeHtml(curEffect)}" isn't offered by the target light(s).</div>` : ''}${curEffect ? `<div class="cpce-hint">Effects run on the bulb's firmware; their speed isn't adjustable and most override this button's color. If it flashes when combined with a color, try “Send effect in a separate command” under Advanced Send Methods.</div>` : ''}`
        : `<div class="cpce-hint">The target light(s) report no effects (<code>effect_list</code>), so none can be chosen.</div>`) : ''}
    `;
  }

  // Target Lights for a preset: which lights get its color/temp/profile look, or its off command.
  // Single-purpose model — a button does ONE thing (its Mode); to combine actions (dim + turn
  // off others + close blinds), build a Scene and use a Scene-mode button. So there is no longer
  // an additive "Trigger Scenes" / "Turn Off These" here. Scene/None buttons show nothing.
  _renderPresetActions(preset, index, mode) {
    if (mode === 'scene') return '';   // Scene buttons target nothing here — they fire a scene.
    const cardEntities = this._config.entities || [];
    const isOff = mode === 'off';
    const spec = presetTargetSpec(preset);
    const customSel = spec.custom;
    const allLights = getLightEntities(this._hass);
    return `
      <div class="cpce-preset-actions" data-index="${index}">
        <div class="cpce-action-block">
          <div class="cpce-hint">Which lights get this button's ${isOff ? 'off command' : mode === 'profile' ? "profile's look" : 'color/temperature'}. Combine the shared Default Entities pool with this button's own lights.</div>
          <div class="cpce-check"><input type="checkbox" class="cpce-cc-use-default" ${spec.useDefault?'checked':''}><label>Use Default Entities${cardEntities.length ? '' : ' — none set'}</label></div>
          ${spec.useDefault && cardEntities.length ? `<div style="margin-left:22px;">${this._renderStaticChips(cardEntities, 'default')}</div>` : ''}
          <div class="cpce-check"><input type="checkbox" class="cpce-cc-use-custom" ${spec.useCustom?'checked':''}><label>Include other Entities</label></div>
          ${spec.useCustom ? (allLights.length
            ? `${this._renderAddPicker(allLights, customSel, 'on', 'cpce-cc-add', 'cpce-cc-sel', 'Add any light…')}${this._renderChips(customSel, 'on', 'cpce-cc-chip-x')}`
            : `<div class="cpce-hint">No <code>light.*</code> entities found.</div>`) : ''}
          ${!spec.useDefault && !spec.useCustom ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">No lights selected — this button won't affect any light.</div>` : ''}
        </div>
      </div>
    `;
  }

  _attachPresetListeners() {
    // Scope to preset summaries only (slider sections reuse .cpce-preset-summary but carry
    // data-ss-toggle, not data-preset-toggle) so this doesn't clobber their toggle handler.
    this.querySelectorAll('.cpce-preset-summary[data-preset-toggle]').forEach(summary => {
      summary.onclick = (e) => {
        if (e.target.closest('.cpce-preset-remove') || e.target.closest('.cpce-preset-duplicate') || e.target.closest('.cpce-preset-hide')) return;
        const index = Number(summary.dataset.presetToggle);
        // If we're CLOSING a preset that has unsaved edits to a linked entity, revert its
        // values to the entity's (the entity is the source of truth; edits need explicit Save).
        if (this._openPreset === index) this._revertUnsavedLinkedPreset(index);
        this._openPreset = this._openPreset === index ? null : index;
        this._render();
      };
    });

    this.querySelectorAll('.cpce-preset-editor').forEach(container => {
      const index = Number(container.dataset.index);
      const nameEl = container.querySelector('.cpce-preset-name');
      const iconEl = container.querySelector('.cpce-preset-icon');
      const modeEl = container.querySelector('.cpce-preset-mode');
      const removeBtn = container.querySelector('.cpce-preset-remove');
      const tempSlider = container.querySelector('.cpce-preset-temp');
      const tempVal = container.querySelector('.cpce-temp-val');

      const commitMeta = () => {
        const presets = [...(this._config.presets || [])];
        // Store the icon normalized (bare name → mdi:) so a typed "lightbulb" becomes "mdi:lightbulb".
        presets[index] = { ...presets[index], name: nameEl.value || 'Preset', icon: normalizeIcon(iconEl.value) };
        this._updateConfig({ presets });
      };
      if (nameEl) nameEl.addEventListener('change', commitMeta);
      if (iconEl) iconEl.addEventListener('change', commitMeta);

      if (modeEl) modeEl.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index], name: nameEl.value || 'Preset', icon: iconEl.value || '' };
        const midKelvin = Math.round(((Number(this._config.min_kelvin)||2000) + (Number(this._config.max_kelvin)||6500)) / 2);
        // Default color format: prefer one the target light(s) support (rgb → xy → hs), else rgb.
        const supported = getUnionColorModes(this._hass, this._entityIds ? this._entityIds() : (this._config.entities || []));
        const preferFmt = ['rgb', 'xy', 'hs'].find(f => supported.includes(FORMAT_TO_COLOR_MODE[f])) || 'rgb';
        const seedColor = () => { p[PRESET_COLOR_KEYS[preferFmt]] = preferFmt === 'xy' ? ColorUtils.rgbToXy(255,0,0) : (preferFmt === 'hs' ? ColorUtils.rgbToHs(255,0,0) : [255,0,0]); };
        // Clear every look/link field, then set only what the chosen mode needs. scene_ref is
        // owned by Scene mode only; profile_ref by Profile mode only.
        delete p.action; ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]); delete p.color_kelvin;
        delete p.look_none; delete p.profile_ref; delete p.scene_ref; delete p.transition; delete p.effect;
        const v = modeEl.value;
        // If the icon isn't a user-customized one (empty or a generic/mode default), follow the
        // new mode's default icon so the button glyph matches its function automatically.
        if (!p.icon || GENERIC_DEFAULT_ICONS.has(p.icon)) p.icon = modeDefaultIcon(v);
        p.mode = v;
        if (v === 'off') { p.action = 'turn_off'; delete p.brightness; delete p.input_color_entity; }
        else if (v === 'scene') { p.look_none = true; delete p.brightness; delete p.input_color_entity; }  // scene_ref set by the picker
        else if (v === 'profile') { delete p.brightness; delete p.input_color_entity; }  // profile_ref set by the picker
        else if (v === 'temp') p.color_kelvin = midKelvin;
        else seedColor();  // color
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });

      if (removeBtn) removeBtn.onclick = () => {
        const nm = (this._config.presets || [])[index];
        if (!this._confirmDelete(`Delete the button “${(nm && nm.name) || 'Button'}”? This cannot be undone.`)) return;
        const presets = (this._config.presets || []).filter((_, i) => i !== index);
        if (this._openPreset === index) this._openPreset = null;
        else if (this._openPreset !== null && this._openPreset > index) this._openPreset -= 1;
        this._updateConfig({ presets });
        this._render();
      };

      // Hide/show this button on the card (kept in the editor list either way).
      const hideBtn = container.querySelector('.cpce-preset-hide');
      if (hideBtn) hideBtn.onclick = () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (p.hidden) delete p.hidden; else p.hidden = true;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      };

      // Duplicate this button: deep-copy the preset with a fresh id + "(copy)" name, insert
      // right after it, and open the copy for editing.
      const dupBtn = container.querySelector('.cpce-preset-duplicate');
      if (dupBtn) dupBtn.onclick = () => {
        const presets = [...(this._config.presets || [])];
        const src = presets[index]; if (!src) return;
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = newPresetId();
        copy.name = `${src.name || 'Button'} (copy)`;
        presets.splice(index + 1, 0, copy);
        this._openPreset = index + 1;
        this._updateConfig({ presets });
        this._render();
      };

      if (tempSlider) {
        tempSlider.addEventListener('input', () => {
          const val = parseInt(tempSlider.value, 10);
          if (tempVal) tempVal.textContent = `${val}K`;
        });
        tempSlider.addEventListener('change', () => {
          const presets = [...(this._config.presets || [])];
          presets[index] = { ...presets[index], color_kelvin: parseInt(tempSlider.value, 10) };
          this._updateConfig({ presets });
          this._markPresetDirty(index);
        });
      }

      // Brightness: an enable checkbox (present = set brightness, absent = leave unchanged)
      // plus a 1-100% slider stored as 1-255. Toggling enable re-renders to show/hide it.
      const briEnable = container.querySelector('.cpce-preset-bri-enable');
      if (briEnable) briEnable.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (briEnable.checked) p.brightness = (p.brightness ?? 255);
        else delete p.brightness;
        presets[index] = p;
        this._updateConfig({ presets });
        this._markPresetDirty(index);
        this._render();
      });
      const briSlider = container.querySelector('.cpce-preset-bri');
      const briVal = container.querySelector('.cpce-bri-val');
      if (briSlider) {
        briSlider.addEventListener('input', () => { if (briVal) briVal.textContent = `${parseInt(briSlider.value, 10)}%`; });
        briSlider.addEventListener('change', () => {
          const presets = [...(this._config.presets || [])];
          const pct = clamp(parseInt(briSlider.value, 10) || 1, 1, 100);
          presets[index] = { ...presets[index], brightness: Math.round(pct * 2.55) };
          this._updateConfig({ presets });
          this._markPresetDirty(index);
        });
      }

      // Transition: enable toggle (present = fade, absent = instant) + a 0-10s slider.
      const transEnable = container.querySelector('.cpce-preset-transition-enable');
      if (transEnable) transEnable.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (transEnable.checked) p.transition = (p.transition ?? 1);
        else delete p.transition;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });
      const transSlider = container.querySelector('.cpce-preset-transition');
      const transVal = container.querySelector('.cpce-transition-val');
      if (transSlider) {
        transSlider.addEventListener('input', () => { if (transVal) transVal.textContent = `${parseFloat(transSlider.value)}s`; });
        transSlider.addEventListener('change', () => {
          const presets = [...(this._config.presets || [])];
          presets[index] = { ...presets[index], transition: clamp(parseFloat(transSlider.value) || 0, 0, 10) };
          this._updateConfig({ presets });
        });
      }

      // Effect: a firmware effect name (or "" = none, which removes the key).
      const effectSel = container.querySelector('.cpce-preset-effect');
      if (effectSel) effectSel.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (effectSel.value) p.effect = effectSel.value; else delete p.effect;
        presets[index] = p;
        this._updateConfig({ presets });
      });

      const linkSelect = container.querySelector('.cpce-preset-input-color');
      if (linkSelect) {
        linkSelect.addEventListener('change', () => {
          const presets = [...(this._config.presets || [])];
          const newEntity = linkSelect.value || undefined;
          let p = { ...presets[index] };
          if (!newEntity) {
            // Unlink: the button needs an inline color again. Seed it from the entity's last
            // value (so the color doesn't jump), then it becomes editable inline once more.
            const prevEntity = p.input_color_entity;
            delete p.input_color_entity;
            const st = prevEntity && this._hass && this._hass.states[prevEntity];
            const value = st && inputColorStateToPresetValue(st);
            ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]); delete p.color_kelvin; delete p.brightness;
            if (value && Object.keys(value).length) p = { ...p, ...value };
            else p.rgb_color = [255, 0, 0];
          } else {
            // Link: the entity is now the single source of truth. The button stores NO look of
            // its own — strip color/temp/brightness AND effect/transition (the entity can't
            // store those) so nothing can drift or fire a stale effect.
            p.input_color_entity = newEntity;
            ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]);
            delete p.color_kelvin; delete p.brightness; delete p.effect; delete p.transition;
          }
          presets[index] = p;
          this._updateConfig({ presets });
          this._render();
        });
      }

      // Color Control targeting: two independent checkboxes (Default pool ∪ this button's own
      // lights). We always write explicit use_default_entities / use_custom_entities and drop
      // the legacy target_mode so the new model is authoritative.
      const normalizeTargeting = (patch) => {
        const cur = presetTargetSpec(this._config.presets[index]);
        const next = { use_default_entities: cur.useDefault, use_custom_entities: cur.useCustom, target_entities: cur.custom, ...patch };
        delete next.target_mode;
        const p = { ...this._config.presets[index], ...next };
        delete p.target_mode;
        const presets = [...(this._config.presets || [])]; presets[index] = p;
        this._updateConfig({ presets }); this._render();
      };
      const ccUseDefault = container.querySelector('.cpce-cc-use-default');
      if (ccUseDefault) ccUseDefault.addEventListener('change', () => normalizeTargeting({ use_default_entities: ccUseDefault.checked }));
      const ccUseCustom = container.querySelector('.cpce-cc-use-custom');
      if (ccUseCustom) ccUseCustom.addEventListener('change', () => normalizeTargeting({ use_custom_entities: ccUseCustom.checked }));
      const ccAddLight = (val) => {
        if (!val) return;
        normalizeTargeting({ use_custom_entities: true, target_entities: [...new Set([...(this._config.presets[index].target_entities || []), val])] });
      };
      const ccAdd = container.querySelector('.cpce-cc-add');
      if (ccAdd) ccAdd.onclick = () => { const sel = container.querySelector('.cpce-cc-sel'); ccAddLight(sel && sel.value); };
      // Add on selection too (the ＋ is easy to miss) — picking a light adds it immediately.
      const ccSel = container.querySelector('.cpce-cc-sel');
      if (ccSel) ccSel.addEventListener('change', () => ccAddLight(ccSel.value));
      container.querySelectorAll('.cpce-cc-chip-x').forEach(x => x.onclick = () =>
        normalizeTargeting({ target_entities: (this._config.presets[index].target_entities || []).filter(id => id !== x.dataset.id) }));

      // "Follow Lights for Color" (scene buttons): edit preset.glow_entities. Absent/empty = auto
      // (scene members) → style color → grey.
      const gfPatch = (list) => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        const clean = [...new Set((list || []).filter(Boolean))];
        if (clean.length) p.glow_entities = clean; else delete p.glow_entities;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      };
      const gfAdd = (val) => { if (val) gfPatch([...(this._config.presets[index].glow_entities || []), val]); };
      // Searchable list picker (same UX as Default Entities) — click a row to add.
      this._wireEntitySearchPicker(container, 'cpce-gf-picker', (id) => gfAdd(id));
      container.querySelectorAll('.cpce-gf-chip-x').forEach(x => x.onclick = () =>
        gfPatch((this._config.presets[index].glow_entities || []).filter(id => id !== x.dataset.id)));

      // Scene mode: single-scene selector (this button activates exactly one scene).
      const sceneSel = container.querySelector('.cpce-preset-scene');
      if (sceneSel) sceneSel.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index], mode: 'scene' };
        if (sceneSel.value) p.scene_ref = sceneSel.value; else delete p.scene_ref;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });

      // Button-section assignment.
      const sectionSel = container.querySelector('.cpce-preset-section');
      if (sectionSel) sectionSel.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        presets[index] = { ...presets[index], section_id: sectionSel.value };
        this._updateConfig({ presets });
        this._render();
      });

      // Custom button styling — two INDEPENDENT fixed colors (body + glow), each toggled on its own.
      // Fixed button (body) color.
      const styleEnable = container.querySelector('.cpce-btnstyle-enable');
      if (styleEnable) styleEnable.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (styleEnable.checked) {
          // Seed with the current look-derived color so the picker starts sensibly.
          p.button_style_color = p.button_style_color || ColorUtils.rgbToHex(...presetColorToRgb(this._effectivePreset(p)));
        } else delete p.button_style_color;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });
      const styleColor = container.querySelector('.cpce-btnstyle-color');
      if (styleColor) styleColor.addEventListener('input', () => {
        const presets = [...(this._config.presets || [])];
        presets[index] = { ...presets[index], button_style_color: styleColor.value };
        this._updateConfig({ presets });
      });
      // Fixed glow color (independent of the body color).
      const glowEnable = container.querySelector('.cpce-btnglow-enable');
      if (glowEnable) glowEnable.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (glowEnable.checked) {
          p.button_glow_style_color = p.button_glow_style_color || p.button_style_color || ColorUtils.rgbToHex(...presetColorToRgb(this._effectivePreset(p)));
        } else delete p.button_glow_style_color;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });
      const glowColor = container.querySelector('.cpce-btnglow-color');
      if (glowColor) glowColor.addEventListener('input', () => {
        const presets = [...(this._config.presets || [])];
        presets[index] = { ...presets[index], button_glow_style_color: glowColor.value };
        this._updateConfig({ presets });
      });

      // Fixture Profile selector (Mode = Fixture Profile): "" clears the ref (button applies
      // nothing until one is chosen), lib:<slug> references a shared profile.
      const profSel = container.querySelector('.cpce-preset-profile');
      if (profSel) profSel.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index], mode: 'profile' };
        if (profSel.value) p.profile_ref = profSel.value; else delete p.profile_ref;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });

      // Save this button's current inline look as a shared Fixture Profile, then re-point the button.
      const saveProfileBtn = container.querySelector('.cpce-preset-save-profile');
      if (saveProfileBtn) saveProfileBtn.onclick = () => this._saveButtonAsProfile(index);

      // Scene Selects: add / remove / edit input_select bindings on this preset. Mutations write a
      // clean `selects` array (dropping empty rows on entity change is avoided — an in-progress row
      // with a chosen entity but no option yet is preserved so the option picker can populate).
      const mutateSelects = (fn) => {
        const presets = [...(this._config.presets || [])];
        const cur = Array.isArray(presets[index] && presets[index].selects) ? presets[index].selects.map(b => ({ ...b })) : [];
        fn(cur);
        // Keep every row the user is editing — including a freshly-added blank one and an in-progress
        // row (entity chosen, option pending) — so the pickers can populate. These inert rows are
        // ignored by read-time presetSelects() (which requires both entity+option), so they never
        // affect card rendering/active/press. Normalize each row to {entity, option} strings.
        const rows = cur.map(b => ({ entity: (b && b.entity) || '', option: (b && b.option) || '' }));
        const p = { ...presets[index] };
        if (rows.length) p.selects = rows; else delete p.selects;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      };
      const addSel = container.querySelector('.cpce-select-add');
      if (addSel) addSel.onclick = () => mutateSelects(arr => arr.push({ entity: '', option: '' }));
      container.querySelectorAll('.cpce-select-entity').forEach(sel => sel.addEventListener('change', () => {
        const bi = Number(sel.dataset.bind);
        mutateSelects(arr => { if (!arr[bi]) arr[bi] = { entity: '', option: '' }; arr[bi].entity = sel.value; arr[bi].option = ''; });   // reset option when entity changes
      }));
      container.querySelectorAll('.cpce-select-option').forEach(sel => sel.addEventListener('change', () => {
        const bi = Number(sel.dataset.bind);
        mutateSelects(arr => { if (arr[bi]) arr[bi].option = sel.value; });
      }));
      container.querySelectorAll('.cpce-select-remove').forEach(btn => btn.onclick = () => {
        const bi = Number(btn.dataset.bind);
        mutateSelects(arr => arr.splice(bi, 1));
      });
      // Per-button opt-out from the section's default scene reset.
      const noReset = container.querySelector('.cpce-preset-no-reset');
      if (noReset) noReset.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        const p = { ...presets[index] };
        if (noReset.checked) p.no_scene_reset = true; else delete p.no_scene_reset;
        presets[index] = p;
        this._updateConfig({ presets });
        this._render();
      });

      this._wireColorWheel(container, index);
    });
  }

  // Creates a new blank Fixture Profile in the shared library (prompted for a name), then opens
  // its inline editor so the user sets the look. All profile creation/editing lives here now —
  // buttons only reference profiles (Mode = Fixture Profile), they don't create them.
  // Promote a button's inline look to a shared Fixture Profile, then re-point the button at it
  // (mode → profile, profile_ref → lib:<slug>). The button keeps its name/icon/targets; only the
  // LOOK moves to the library. A subsequent edit to the profile updates every button using it.
  _saveButtonAsProfile(index) {
    const presets = [...(this._config.presets || [])];
    const preset = presets[index]; if (!preset) return;
    const look = extractProfileLook(this._effectivePreset(preset));   // resolved current look (color+bri+effect+transition)
    if (!look || !Object.keys(look).length) { window.alert('This button has no look to save yet.'); return; }
    const scope = this._config.fixture_library_scope || 'system';
    const suggested = preset.name || 'New Profile';
    const name = window.prompt('Name this Fixture Profile:', suggested);
    if (!name || !name.trim()) return;
    const map = { ...fixtureLibraryMap(scope) };
    let slug = fixtureLibSlug(name);
    if (map[slug]) { let n = 2; while (map[`${slug}_${n}`]) n++; slug = `${slug}_${n}`; }
    map[slug] = { name: name.trim(), look };
    // Re-point the button: switch to profile mode, clear the now-migrated inline look fields.
    const p = { ...preset, mode: 'profile', profile_ref: `lib:${slug}` };
    PROFILE_LOOK_KEYS.forEach(k => delete p[k]);
    delete p.input_color_entity;   // a profile-mode button isn't entity-linked
    presets[index] = p;
    saveFixtureLibrary(this._hass, scope, map)
      .then(() => { this._updateConfig({ presets }); this._openProfile = slug; this._render(); })
      .catch(e => { console.error(`${LOG_PREFIX} save button as profile failed`, e); window.alert(`Could not save profile: ${formatWsError(e)}`); });
  }
  _addFixtureProfile() {
    const scope = this._config.fixture_library_scope || 'system';
    const name = window.prompt('Name the new Fixture Profile:', 'New Profile');
    if (!name || !name.trim()) return;
    const map = { ...fixtureLibraryMap(scope) };
    let slug = fixtureLibSlug(name);
    // Avoid clobbering an existing profile — suffix a counter if the slug is taken.
    if (map[slug]) { let n = 2; while (map[`${slug}_${n}`]) n++; slug = `${slug}_${n}`; }
    // Seed a sensible default look: red RGB (matches a new button's default).
    map[slug] = { name: name.trim(), look: { rgb_color: [255, 0, 0] } };
    this._openProfile = slug;   // open its editor immediately
    saveFixtureLibrary(this._hass, scope, map)
      .then(() => this._render())
      .catch(e => { console.error(`${LOG_PREFIX} create profile failed`, e); window.alert(`Could not create the profile: ${formatWsError(e)}`); });
  }

  // One-time migration: the old "(system default)" section value stored an EMPTY style_preset that
  // resolved dynamically through the ★ pointer. That pointer is gone — so pin every such section to
  // the CONCRETE style the default used to resolve to, preserving its current look. Runs once per
  // editor session, only when the library is loaded and at least one section needs it. Writes the
  // card config (config-changed) so the pin persists.
  _migrateSectionDefaults() {
    if (this._migratedSectionDefaults) return;
    if (!BTN_STYLE_LIBRARY.system.loaded) return;   // wait until the library (and legacy pointer) is known
    this._migratedSectionDefaults = true;
    const sections = Array.isArray(this._config && this._config.sections) ? this._config.sections : null;
    if (!sections) return;
    const legacySlug = legacyDefaultResolvedSlug();
    let changed = false;
    const next = sections.map(s => {
      if (s && s.type === 'buttons' && !fixtureRefSlug(s.style_preset)) { changed = true; return { ...s, style_preset: `lib:${legacySlug}` }; }
      return s;
    });
    if (changed) this._updateConfig({ sections: next });
  }

  // Normalize arbitrary imported JSON into a list of layers. Accepts three shapes:
  //   - a full stack export `{ layers:[{groups,when?,hidden?,label?}, …] }` → those layers verbatim
  //     (each layer's groups filtered to recognized keys);
  //   - a flat appearance object (the "Export current look" / flattenButtonStack shape) → one
  //     base layer whose groups are the recognized keys;
  // Returns [] when nothing recognizable is found.
  _importedJsonToLayers(parsed) {
    if (parsed && Array.isArray(parsed.layers) && parsed.layers.length) {
      const layers = parsed.layers.map(l => {
        const groups = extractButtonAppearance((l && l.groups) || {});
        return { groups, ...(l && l.when && typeof l.when === 'object' ? { when: l.when } : {}), ...(l && l.hidden ? { hidden: true } : {}), ...(l && l.label != null && String(l.label).trim() ? { label: String(l.label) } : {}) };
      });
      if (layers.some(l => Object.keys(l.groups).length || l.when)) return layers;
    }
    const clean = extractButtonAppearance(parsed || {});
    if (Object.keys(clean).length) return [{ groups: clean }];
    return [];
  }
  // Import JSON as a brand-new shared library preset. Prompts for a name, then stores it (so it's
  // 100% clear where the imported look landed — a new row in the library).
  _importButtonStyleAsPreset(parsed) {
    const layers = this._importedJsonToLayers(parsed);
    if (!layers.length) { window.alert('No recognized Button Appearance settings found in that JSON.'); return; }
    const name = (window.prompt('Name for the new preset:', 'Imported style') || '').trim();
    if (!name) return;
    let slug = fixtureLibSlug(name);
    const map = { ...buttonStyleLibraryMap() };
    if (map[slug] && !window.confirm(`A preset "${slug}" already exists — overwrite it?`)) return;
    map[slug] = { name, kind: 'button', layers };
    saveButtonStyleLibrary(this._hass, map)
      .then(() => { this._openStackEditor(slug); })
      .catch(e => { console.error(`${LOG_PREFIX} import as preset failed`, e); window.alert(`Could not import: ${formatWsError(e)}`); });
  }
  // Import JSON as new layer(s) appended to the currently-open preset's draft. Each imported layer
  // gets an optional label so the user can tell what it is. Only offered while a preset is open.
  _importButtonStyleAsLayer(slug, parsed) {
    const d = this._stackDraftFor(slug); if (!d) return;
    const layers = this._importedJsonToLayers(parsed);
    if (!layers.length) { window.alert('No recognized Button Appearance settings found in that JSON.'); return; }
    const label = (window.prompt('Optional label for the imported layer(s) (blank = none):', '') || '').trim();
    this._mutateStackDraft(slug, arr => {
      layers.forEach((l, i) => {
        // Appended layers are overlays: default them to an Always-style condition unless the import
        // carried one, and stamp the label (first layer only if multiple).
        const layer = { ...l };
        if (!layer.when) layer.when = { type: 'light_on' };
        if (label && i === 0) layer.label = label;
        // Whole-group model: an imported overlay OWNS whichever groups its JSON touches (completed to
        // the full group key-set from the import's own values). Groups it doesn't mention fall through
        // to the base. So a partial import stays scoped; a full look owns everything.
        const src = layer.groups || {};
        const owned = layerOwnedGroups(src);
        const groups = {};
        owned.forEach(g => BUTTON_STYLE_GROUPS[g].forEach(k => { if (src[k] !== undefined) groups[k] = src[k]; }));
        layer.groups = groups;
        arr.push(layer);
      });
    });
  }

  // Re-render just the Button Style Builder live preview in place (no full editor re-render, so
  // slider/color focus is preserved). Called on any Builder control input.
  _refreshButtonStylePreview() {
    const host = this.querySelector('#cpce-btnstyle-preview-host');
    if (host) host.innerHTML = this._renderButtonStylePreview();
  }
  // Update each layer row's group-list text in place (no full re-render, so Builder control focus is
  // preserved as edits fold into the draft). Mirrors the label logic in _renderButtonStackLayers.
  _refreshLayerRowCounts(slug) {
    const d = this._stackDraftFor(slug); if (!d) return;
    const panel = this.querySelector(`.cpce-btnstyle-layers-panel[data-slug="${slug}"]`);
    if (!panel) return;
    const titles = { layout: 'Layout', background: 'Background', border: 'Line Border', gradient: 'Gradient', glow: 'Glow', shadow: 'Shadow', text: 'Text', icon: 'Icon', sizing: 'Button Shape' };
    panel.querySelectorAll('.cpce-stack-layer').forEach(row => {
      const i = parseInt(row.dataset.idx, 10);
      const l = d.layers[i]; if (!l) return;
      const owned = [...layerOwnedGroups(l.groups)].map(g => titles[g] || g);
      const countEl = row.querySelector('.cpce-stack-layer-groups');
      if (countEl) countEl.textContent = i === 0 ? 'All Settings' : (owned.length ? owned.join(', ') : 'inherits all');
    });
    // Reflect the now-dirty state (banner/Save button appear) without stealing focus mid-edit:
    // only re-render if the dirty banner isn't already shown.
    if (d.dirty && !this.querySelector('.cpce-unsaved-banner')) this._render();
  }

  // ---- Conditional-layer stack editing (draft model) ----
  // Open the layer editor for a stack, seeding an editable draft (deep copy) from the library.
  _openStackEditor(slug) {
    if (this._openButtonStack === slug) { this._closeStackEditor(); return; }
    const e = buttonStyleLibraryMap()[slug]; if (!e) return;
    this._openButtonStack = slug;
    this._stackDraft = { slug, kind: e.kind === 'frame' ? 'frame' : 'button', layers: JSON.parse(JSON.stringify(e.layers || [{ groups: {} }])), dirty: false };
    this._render();
  }
  // Load one layer of an open stack into the Style Builder for editing: unlocks its condition and
  // seeds the EDIT BUFFER (this._layerEditCfg) with the layer's EFFECTIVE look (base beneath +
  // this layer's delta). The buffer — NOT this._config — is what the Builder controls read/write,
  // so editing a style never touches the live card. Toggling the same layer closes the Builder.
  // Shared by the pencil and "New style". Ensures the stack's draft is open first.
  _editLayer(slug, idx) {
    if (this._editingLayer && this._editingLayer.slug === slug && this._editingLayer.idx === idx) {
      this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._render(); return;
    }
    if (this._openButtonStack !== slug) this._openStackEditor(slug);
    const d = this._stackDraftFor(slug); if (!d) return;
    // The Builder controls show the layer's EFFECTIVE look (base beneath + this layer's own groups),
    // so every control has a sensible value. But the layer only OWNS (stores) whole groups it defines.
    const effective = { ...buttonStackBaseBelow(d.layers, idx), ...(d.layers[idx] && d.layers[idx].groups || {}) };
    this._editingLayer = { slug, idx };
    this._layerEditCfg = { ...extractButtonAppearance(this._config), ...extractButtonAppearance(effective) };
    // Groups this layer owns. Layer 1 (base) always owns ALL groups (it's the full look). Overlays
    // own only the groups their stored `groups` object carries keys for.
    this._layerOwned = (idx === 0) ? new Set(BUTTON_STYLE_GROUP_KEYS) : layerOwnedGroups(d.layers[idx] && d.layers[idx].groups);
    this._render();
  }
  // The cfg the Builder controls render FROM while editing a layer: card config overlaid with the
  // live edit buffer. Falls back to this._config when not editing (defensive).
  _builderCfg() {
    return this._layerEditCfg ? { ...this._config, ...this._layerEditCfg } : this._config;
  }
  // Write path for every Builder control: merge the patch into the edit buffer, fold the result
  // into the layer's draft (full look for Layer 1, delta vs base beneath for overlays), mark dirty,
  // and refresh ONLY the preview + layer count — never this._config, never the live card.
  _builderPatch(patch) {
    if (!this._editingLayer || !this._layerEditCfg) return;
    Object.assign(this._layerEditCfg, patch);
    // Touching any control auto-includes its whole group (Frame-style ownership) — so editing a
    // glow control means this layer now owns the Glow group. Then rebuild the layer's stored groups.
    Object.keys(patch).forEach(k => { const g = BUTTON_KEY_GROUP[k]; if (g && this._layerOwned) this._layerOwned.add(g); });
    this._commitOwnedGroups();
  }
  // Rebuild the edited layer's `groups` = the full key-set of every group it OWNS, read from the
  // live buffer. Whole-group storage (no per-key deltas): a group is present in full or absent.
  _commitOwnedGroups() {
    const el = this._editingLayer; if (!el) return;
    const d = this._stackDraftFor(el.slug); if (!d || !d.layers[el.idx]) return;
    const owned = this._layerOwned || new Set();
    const groups = {};
    BUTTON_STYLE_GROUP_KEYS.forEach(g => {
      if (!owned.has(g)) return;
      BUTTON_STYLE_GROUPS[g].forEach(k => { if (this._layerEditCfg[k] !== undefined) groups[k] = this._layerEditCfg[k]; });
    });
    // Only flag dirty when the layer's stored groups actually changed — loading a layer into the
    // Builder re-commits its current groups verbatim, which must NOT count as an edit.
    const changed = JSON.stringify(d.layers[el.idx].groups) !== JSON.stringify(groups);
    d.layers[el.idx].groups = groups;
    if (changed) d.dirty = true;
    this._refreshButtonStylePreview();
    this._refreshLayerRowCounts(el.slug);
  }
  // Include/exclude a whole group on the edited layer (the subpanel's include checkbox). Excluding
  // drops the group (falls through to the base beneath); including captures its current buffer values.
  _toggleBuilderGroup(group, include) {
    if (!this._editingLayer || !this._layerOwned) return;
    if (include) this._layerOwned.add(group); else this._layerOwned.delete(group);
    this._commitOwnedGroups();
    this._render();   // reveal/hide the group's controls
  }
  // Create a brand-new style as a COPY of a chosen STARTER (built-in or existing style), and open its
  // Layer 1 in the Builder. The starter's slug/name are recorded as provenance (shown in the Library).
  // The starter list = built-ins + every stored style; the user picks by number.
  _newButtonStyle() {
    const lib = buttonStyleLibraryMap();
    const choices = [...Object.keys(BUILTIN_BUTTON_STYLES).map(bs => ({ slug: bs, name: BUILTIN_BUTTON_STYLES[bs].name })),
      ...Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b)).map(sl => ({ slug: sl, name: lib[sl].name || sl }))];
    const menu = choices.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    const pick = window.prompt(`Create a new style FROM a starter. Enter the number to copy:\n\n${menu}`, '1');
    if (pick == null) return;                       // cancelled
    const idx = parseInt(String(pick).trim(), 10) - 1;
    const starter = choices[idx];
    if (!starter) { window.alert('Enter a valid number from the list.'); return; }
    const name = (window.prompt('Name for the new style:', `${starter.name} (copy)`) || '').trim();
    if (!name) return;
    let slug = fixtureLibSlug(name); let n = 2;
    const map = { ...lib };
    while (map[slug]) { slug = fixtureLibSlug(`${name} ${n++}`); }
    const src = buttonStyleStack(starter.slug);     // resolves built-in or stored
    const layers = JSON.parse(JSON.stringify((src && src.layers) || [{ groups: {} }]));
    map[slug] = { name, kind: 'button', layers, starter: starter.slug, starter_name: starter.name };
    saveButtonStyleLibrary(this._hass, map)
      .then(() => { this._openStackEditor(slug); this._editLayer(slug, 0); })
      .catch(e => { console.error(`${LOG_PREFIX} new style failed`, e); window.alert(`Could not create style: ${formatWsError(e)}`); });
  }
  _closeStackEditor() { this._openButtonStack = null; this._stackDraft = null; this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._render(); }
  _stackDraftFor(slug) { return (this._stackDraft && this._stackDraft.slug === slug) ? this._stackDraft : null; }
  // Mutate the draft's layers via `fn(layers)`, and mark dirty ONLY if the content actually changed
  // (guards against phantom "unsaved" state from no-op mutations — e.g. a control re-emitting its
  // current value on open). Re-render regardless so UI reflecting the change still updates.
  _mutateStackDraft(slug, fn) {
    const d = this._stackDraftFor(slug); if (!d) return;
    const before = JSON.stringify(d.layers);
    fn(d.layers);
    if (JSON.stringify(d.layers) !== before) d.dirty = true;
    this._render();
  }
  // Guarantee the base layer (idx 0) owns ALL settings groups. "Layer 1 = full look" is decided by
  // POSITION, not stored on the layer — so when layers are reordered (or a partial overlay ends up
  // at the bottom), the new base could be missing groups and render "inherits all" with nothing
  // beneath it. This back-fills any groups the base doesn't define from the flattened look of the
  // ORIGINAL stack (what the user currently sees), falling back to the Built-In look. Idempotent.
  _ensureBaseFullLook(layers, prevFlat) {
    if (!Array.isArray(layers) || !layers.length) return;
    const base = layers[0];
    const owned = layerOwnedGroups(base.groups);
    const missing = BUTTON_STYLE_GROUP_KEYS.filter(g => !owned.has(g));
    if (!missing.length) return;                       // already a full look
    // Source of truth for the missing groups: the pre-move flattened look if given, else Built-In.
    const src = { ...extractButtonAppearance(BUILTIN_BASIC_THEME_GROUPS), ...(prevFlat || {}) };
    const groups = { ...(base.groups || {}) };
    missing.forEach(g => { BUTTON_STYLE_GROUPS[g].forEach(k => { if (src[k] !== undefined) groups[k] = src[k]; }); });
    base.groups = groups;
  }
  // Persist the draft to the shared library after a system-wide confirmation.
  _saveStackDraft(slug) {
    const d = this._stackDraftFor(slug); if (!d || !d.dirty) return;
    const e = buttonStyleLibraryMap()[slug]; if (!e) return;
    const msg = `Save preset "${e.name || slug}"?\n\nReminder: Saved Changes apply to ALL Home Assistant cards using this preset - not just this one.`;
    if (!window.confirm(msg)) return;
    const map = { ...buttonStyleLibraryMap() };
    map[slug] = { ...e, layers: d.layers.map(l => ({ groups: l.groups || {}, ...(l.when ? { when: l.when } : {}), ...(l.hidden ? { hidden: true } : {}), ...(l.label != null && String(l.label).trim() ? { label: String(l.label) } : {}) })) };
    saveButtonStyleLibrary(this._hass, map)
      // On save: close the Style Builder AND the layer editor (per #1 — a clear "editing is done"
      // signal). The preset returns to a clean, collapsed state. Then nudge HA's own preview pane
      // to re-render the live card with the just-saved style (the WS store update alone doesn't
      // reliably repaint the editor's preview) — see _nudgeHaPreview.
      .then(() => { d.dirty = false; this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._openButtonStack = null; this._stackDraft = null; this._render(); this._nudgeHaPreview(); })
      .catch(err => { console.error(`${LOG_PREFIX} save stack layers failed`, err); window.alert(`Could not save: ${formatWsError(err)}`); });
  }
  // Build a `when` object from a chosen condition type, preserving compatible fields.
  _layerWhenFromType(type, prev) {
    prev = prev || {};
    if (!type) return null;
    if (type === 'entity_state') return { type, entity: prev.entity || '', ...(prev.attr ? { attr: prev.attr, op: prev.op || '==', value: prev.value } : { state: prev.state != null ? prev.state : 'on' }) };
    return { type };
  }

  // Wires a section target picker (rendered by _renderTargetPicker) inside `container`.
  // `getSection()` returns the current section object; `applyPatch(patch)` merges the given
  // targeting fields onto it and persists+re-renders. Mirrors the button targeting model:
  // use_default_entities / use_custom_entities / target_entities (any light).
  _wireTargetPicker(container, getSection, applyPatch) {
    const picker = container.querySelector('.cpce-target-picker');
    if (!picker) return;
    const patchFrom = (patch) => {
      const spec = presetTargetSpec(getSection());
      applyPatch({ use_default_entities: spec.useDefault, use_custom_entities: spec.useCustom, target_entities: spec.custom, ...patch });
    };
    const useDefault = picker.querySelector('.cpce-tp-use-default');
    if (useDefault) useDefault.addEventListener('change', () => patchFrom({ use_default_entities: useDefault.checked }));
    const useCustom = picker.querySelector('.cpce-tp-use-custom');
    if (useCustom) useCustom.addEventListener('change', () => patchFrom({ use_custom_entities: useCustom.checked }));
    const addLight = (val) => { if (val) patchFrom({ use_custom_entities: true, target_entities: [...new Set([...(presetTargetSpec(getSection()).custom), val])] }); };
    const addBtn = picker.querySelector('.cpce-tp-add');
    if (addBtn) addBtn.onclick = () => { const sel = picker.querySelector('.cpce-tp-sel'); addLight(sel && sel.value); };
    const selEl = picker.querySelector('.cpce-tp-sel');
    if (selEl) selEl.addEventListener('change', () => addLight(selEl.value));
    picker.querySelectorAll('.cpce-tp-chip-x').forEach(x => x.onclick = () =>
      patchFrom({ target_entities: presetTargetSpec(getSection()).custom.filter(id => id !== x.dataset.id) }));
  }

  // Wires the Slider Sections manager: per-section name, slider checkboxes, target picker,
  // remove buttons, and the Add button. Each mutates the sections array in config.
  _wireSliderSections() {
    const getSections = () => this._orderedSectionsRaw();
    const updateOne = (id, patch) => {
      const sections = getSections().map(s => s.id === id ? { ...s, ...patch } : s);
      this._updateSections(sections);
    };
    // Collapse/expand a slider section by clicking its summary (ignoring the remove button).
    this.querySelectorAll('.cpce-slider-section .cpce-preset-summary').forEach(summary => {
      summary.onclick = (e) => {
        if (e.target.closest('.cpce-ss-remove')) return;
        const id = summary.dataset.ssToggle;
        this._openSliderSection = this._openSliderSection === id ? null : id;
        this._render();
      };
    });
    this.querySelectorAll('.cpce-slider-section').forEach(el => {
      const id = el.dataset.sectionId;
      const nameEl = el.querySelector('.cpce-ss-name');
      if (nameEl) nameEl.addEventListener('change', () => updateOne(id, { name: nameEl.value || 'Sliders' }));
      const readSliders = () => ({
        brightness: el.querySelector('.cpce-ss-brightness').checked,
        temperature: el.querySelector('.cpce-ss-temperature').checked,
        rgb: el.querySelector('.cpce-ss-rgb').checked,
      });
      ['.cpce-ss-brightness', '.cpce-ss-temperature', '.cpce-ss-rgb'].forEach(sel => {
        const cb = el.querySelector(sel);
        if (cb) cb.addEventListener('change', () => { updateOne(id, { sliders: readSliders() }); this._render(); });
      });
      // Target picker (scoped to this section's container) — two-checkbox any-light model.
      this._wireTargetPicker(el,
        () => getSections().find(s => s.id === id) || {},
        (patch) => { updateOne(id, patch); this._render(); });
      // Per-section style: mode toggle (card default | custom) — seed slider_style
      // from the current resolved look on first switch to custom so it's a no-op change.
      const removeBtn = el.querySelector('.cpce-ss-remove');
      if (removeBtn) removeBtn.onclick = () => {
        if (!this._confirmDelete('Remove this Sliders section? This cannot be undone.')) return;
        const sections = getSections().filter(s => s.id !== id);
        this._updateSections(sections);
        this._render();
      };
    });
    const addBtn = this.querySelector('#cpce-add-slider-section');
    if (addBtn) addBtn.onclick = () => {
      const sections = getSections();
      const nid = newSectionId('sliders');
      sections.push({ id: nid, type: 'sliders', name: 'Sliders', sliders: { brightness: true, temperature: true, rgb: true }, target_entities: [] });
      this._openSliderSection = nid; // expand the new one for immediate editing
      this._updateSections(sections);
      this._render();
    };
  }

  // ----- main render -----
  _render() {
    // While editing a style layer, `cfg` reflects the layer's edit buffer overlaid on the card
    // config (so the Builder controls show the LAYER's values). Non-button keys pass through from
    // this._config unchanged (the buffer holds only button-appearance keys). Not editing → identity.
    const cfg = this._builderCfg();
    const labels = this._hass ? getAllLabels(this._hass) : [];
    const groups = this._hass ? getAreas(this._hass) : [];
    this.innerHTML = `
      <style>
        /* ============================================================
           DESIGN TOKENS — shared --ltek-* system (same block as the Easy
           Entity Styler card). Single source of truth: change a value here
           and every control that uses the token updates. Both cards define
           an identical block so the two editors stay visually in sync.
           ============================================================ */
        .cpce {
          /* Font sizes (by role, not by pixel) */
          --ltek-fs-panel-title: 16px;  /* top-level panel / section title */
          --ltek-fs-header: 15px;       /* editor header, panel summary */
          --ltek-fs-group: 14px;        /* group heading inside a panel */
          --ltek-fs-label: 13px;        /* standard field label / row */
          --ltek-fs-body: 12px;         /* body text, most controls */
          --ltek-fs-small: 11px;        /* hints, secondary text */
          --ltek-fs-tiny: 10px;         /* badges, micro-labels */
          /* Font weights */
          --ltek-fw-normal: 400;        /* control labels (recede) */
          --ltek-fw-medium: 500;
          --ltek-fw-semibold: 600;
          --ltek-fw-bold: 700;          /* titles, values (lead) */
          /* Text colors */
          --ltek-c-text: var(--primary-text-color, #e1e1e1);  /* primary */
          --ltek-c-label: #ccc;         /* control labels */
          --ltek-c-muted: #888;         /* hints / disabled */
          --ltek-c-accent: var(--primary-color, #2196F3);
          /* Accent tints — hover / active fills (kept as rgba literals; one place
             to change). Default to the Material blue the cards shipped with. */
          --ltek-c-accent-fade: rgba(var(--rgb-primary-color,33,150,243),0.12);       /* active / pressed fill */
          --ltek-c-accent-fade-soft: rgba(var(--rgb-primary-color,33,150,243),0.08);  /* hover fill */
          --ltek-c-error-fade: rgba(244,67,54,0.15);         /* delete hover fill */
          /* Status colors — defer to the user's theme, fall back to Material. */
          --ltek-c-error: var(--error-color, #f44336);
          --ltek-c-success: var(--success-color, #4caf50);
          --ltek-c-warning: var(--warning-color, #ffb300);
          --ltek-c-info: var(--info-color, #2196F3);
          /* Second accent: the green "library / shared" grouping (distinct from
             the blue layout accent on purpose — NOT tied to --primary-color). */
          --ltek-c-accent-lib: #7fd18a;
          --ltek-c-on-accent: #fff;   /* text/icon on a solid accent fill */
          /* Action icons (edit/copy/hide/etc): neutral idle → brighten on hover.
             Delete stays a status color (error) on its own hover. */
          --ltek-c-icon: #aaa;        /* idle action icon */
          --ltek-c-icon-hover: #fff;  /* hovered action icon */
          /* Surfaces */
          --ltek-c-surface: rgba(255,255,255,0.015);        /* panels */
          --ltek-c-surface-raised: rgba(255,255,255,0.02);  /* cards / rows */
          /* Borders */
          --ltek-c-panel-border: #3a3a3a;   /* panels */
          --ltek-c-border: #444;            /* controls */
          --ltek-c-border-soft: #333;       /* subtle inner dividers */
          /* Radii */
          --ltek-r-panel: 12px;   /* panels */
          --ltek-r-card: 10px;    /* section cards */
          --ltek-r-md: 8px;       /* blocks */
          --ltek-r-ctrl: 6px;     /* inputs, selects, buttons */
          /* Spacing scale (4px base) */
          --ltek-sp-1: 4px;
          --ltek-sp-2: 6px;
          --ltek-sp-3: 8px;
          --ltek-sp-4: 10px;
          --ltek-sp-5: 12px;
          --ltek-sp-6: 16px;
          /* Control padding — uniform input/select/button height. */
          --ltek-ctrl-pad: 6px 10px;
          /* Icon sizes (two clear roles; one-off glyphs stay literal). */
          --ltek-icon-sm: 16px;   /* inline / action icons */
          --ltek-icon-lg: 20px;   /* panel-title icons */
          /* Slider row geometry (shared by every slider) */
          --ltek-slider-val-w: 44px;   /* value readout column width */
          padding:16px; display:flex; flex-direction:column; gap:6px; font-family:var(--paper-font-body1_-_font-family, sans-serif);
        }
        .cpce ha-icon { --mdc-icon-size:18px; vertical-align:middle; }
        /* Top-level panels match the EESC editor: 1px #3a3a3a border, 12px radius,
           subtle surface, 8px top margin. */
        .cpce-sec { border:1px solid var(--ltek-c-panel-border); border-radius:var(--ltek-r-panel); background:var(--ltek-c-surface); overflow:hidden; }
        /* Panel title row matches EESC: 14x16 padding, 17px/700 title text. */
        .cpce-sec-header { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:14px 16px; cursor:pointer; user-select:none; font-size:var(--ltek-fs-panel-title); font-weight:var(--ltek-fw-bold); color:var(--ltek-c-text); }
        /* Top-level panel title icon → theme accent (matches the group dividers). */
        .cpce-sec-header > ha-icon:not(.chev) { color:var(--primary-color); --mdc-icon-size:var(--ltek-icon-lg); width:20px; height:20px; flex-shrink:0; }
        .cpce-sec-header .chev { margin-left:auto; transition:transform 0.2s ease; color:#999; --mdc-icon-size:22px; }
        .cpce-sec.collapsed .cpce-sec-header .chev { transform:rotate(-90deg); }
        .cpce-sec-body { padding:0 16px 16px; }
        .cpce-sec.collapsed .cpce-sec-body { display:none; }
        /* Expanded panel → theme-color border around the whole panel, so it's
           clear which options belong together (matches Section Order's open row). */
        .cpce-sec:not(.collapsed) { border-color:var(--primary-color); }
        /* Row rhythm unified with the Easy Entity Styler card: tight 4px vertical
           padding, and the label HUGS its control (no fixed-width column) so
           short labels sit close and the row isn't artificially tall. */
        .cpce-row { display:flex; align-items:center; gap:var(--ltek-sp-4); padding:var(--ltek-sp-1) 0; flex-wrap:wrap; justify-content:flex-start; }
        .cpce-row label.lbl { color:var(--ltek-c-label); font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-normal); flex:none; }
        /* Scene Save button: grey when saved, accent-blue when there are unsaved changes. */
        .cpce-scene-save { display:inline-flex; align-items:center; gap:var(--ltek-sp-2); padding:8px 14px; border:none; border-radius:var(--ltek-r-ctrl); font-size:var(--ltek-fs-label); cursor:default; background:var(--secondary-background-color,#2a2a2a); color:var(--secondary-text-color); }
        .cpce-scene-save.dirty { background:var(--primary-color); color:#fff; cursor:pointer; }
        .cpce-scene-save ha-icon { --mdc-icon-size:var(--ltek-icon-sm); }
        .cpce-row input[type="text"], .cpce-row select, .cpce-row input[type="number"] {
          flex:1; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a);
          border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-body);
        }
        .cpce-row input[type="range"] { flex:1; min-width:100px; accent-color:var(--ltek-c-accent); cursor:pointer; }
        .cpce-check { display:flex; align-items:center; gap:var(--ltek-sp-2); padding:var(--ltek-sp-1) 0; color:var(--ltek-c-label); font-size:var(--ltek-fs-body); }
        .cpce-inline-check { display:inline-flex; align-items:center; gap:var(--ltek-sp-1); color:var(--primary-text-color); font-size:var(--ltek-fs-body); margin-right:8px; }
        .cpce-mini-btn { padding:4px 10px; margin-right:6px; border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); background:var(--secondary-background-color,#2a2a2a); color:var(--primary-text-color); font-size:var(--ltek-fs-body); cursor:pointer; }
        /* Dashed-accent add button matching the Easy Entity Styler card's
           .seed-ed-add-btn(-sm) — used for the section-list Add row (top). */
        .cpce-add-row { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
        .cpce-ees-add-btn { display:flex; align-items:center; justify-content:center; gap:var(--ltek-sp-2); padding:6px 8px; border:1px dashed var(--primary-color,#2196F3); border-radius:var(--ltek-r-md); background:transparent; color:var(--primary-color,#2196F3); cursor:pointer; font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-semibold); }
        .cpce-ees-add-btn:hover { background:var(--ltek-c-accent-fade-soft,rgba(33,150,243,0.08)); }
        /* Accent (blue text + outline) mini-button, matching the Save buttons. */
        .cpce-mini-btn.cpce-accent-btn { border-color:var(--primary-color); color:var(--primary-color); background:transparent; display:inline-flex; align-items:center; gap:var(--ltek-sp-2); }
        .cpce-mini-btn.cpce-accent-btn:hover { background:var(--ltek-c-accent-fade); }
        .cpce-mini-btn.cpce-accent-btn ha-icon { --mdc-icon-size:var(--ltek-icon-sm); }
        .cpce-mini-btn:hover { border-color:var(--primary-color); }
        .cpce-mini-btn:disabled { opacity:0.4; cursor:not-allowed; color:var(--secondary-text-color); }
        .cpce-mini-btn:disabled:hover { border-color:var(--divider-color,#333); }
        .cpce-mini-btn.cpce-btn-enabled { border-color:var(--primary-color); color:var(--primary-color); }
        .cpce-mini-btn.cpce-btn-enabled ha-icon { color:var(--primary-color); }
        .cpce-hint { font-size:var(--ltek-fs-small); color:var(--ltek-c-muted); margin-bottom:8px; }
        .cpce-sub-title { font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-semibold); color:var(--accent-color,var(--primary-color)); margin:12px 0 4px; border-top:1px solid var(--divider-color,#333); padding-top:10px; }
        /* Slider value readout — shared --ltek- spec (matches EES): bold,
           fixed-width, right-aligned, tabular-nums so it stands out and never
           jitters while dragging. */
        .cpce-strength-val { min-width:var(--ltek-slider-val-w); text-align:right; font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-bold); color:var(--ltek-c-text); font-variant-numeric:tabular-nums; }
        .cpce-row input[type="color"] { width:44px; height:32px; padding:0; border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); background:transparent; cursor:pointer; flex:none; }
        /* Divider config rows — compact layout ported from the Easy Entity Styler
           card (mirrors .seed-ed-font-row / .seed-ed-slider-row): light 12px/400
           labels sit inline before their control, two dropdowns pair per row, and
           sliders stretch full-width (no 200px cap) so they're easier to drag. */
        .cpce-divcfg-row { display:flex; align-items:center; gap:var(--ltek-sp-5); flex-wrap:wrap; padding:var(--ltek-sp-1) 0; }
        .cpce-divcfg-row > label { font-size:var(--ltek-fs-body); color:var(--ltek-c-label); font-weight:var(--ltek-fw-normal); display:flex; align-items:center; gap:var(--ltek-sp-2); }
        .cpce-divcfg-row select { flex:none; background:var(--secondary-background-color,#1c1c1c); border:1px solid var(--ltek-c-border); border-radius:var(--ltek-r-ctrl); padding:var(--ltek-ctrl-pad); color:var(--ltek-c-text); font-size:var(--ltek-fs-body); }
        .cpce-divcfg-row input[type="color"] { width:36px; height:28px; padding:0; border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); background:transparent; cursor:pointer; flex:none; margin-left:6px; }
        .cpce-divcfg-slider { display:flex; align-items:center; gap:var(--ltek-sp-4); padding:var(--ltek-sp-1) 0; flex-wrap:wrap; }
        .cpce-divcfg-slider > label { font-size:var(--ltek-fs-body); color:var(--ltek-c-label); font-weight:var(--ltek-fw-normal); display:flex; align-items:center; gap:var(--ltek-sp-3); }
        .cpce-divcfg-slider input[type="range"] { flex:1; min-width:100px; accent-color:var(--ltek-c-accent); cursor:pointer; }
        .cpce-divcfg-slider input[type="text"] { flex:1; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#1c1c1c); border:1px solid var(--ltek-c-border); border-radius:var(--ltek-r-ctrl); color:var(--ltek-c-text); font-size:var(--ltek-fs-body); }
        .cpce-divcfg-checks { display:flex; align-items:center; gap:var(--ltek-sp-6); flex-wrap:wrap; padding:var(--ltek-sp-1) 0; }
        .cpce-entity-list { max-height:200px; overflow-y:auto; border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); padding:4px; }
        .cpce-entity-list { }
        .cpce-entity-row { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:5px 4px; border-top:1px solid var(--divider-color,#333); font-size:var(--ltek-fs-label); color:var(--primary-text-color); }
        .cpce-entity-row:first-child { border-top:none; }
        .cpce-sel-name { flex-shrink:0; }
        .cpce-entity-id { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cpce-cm-chips { margin-left:auto; display:flex; gap:var(--ltek-sp-1); flex-wrap:wrap; justify-content:flex-end; }
        .cpce-cm-chip { font-size:var(--ltek-fs-tiny); padding:1px 6px; border-radius:999px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); color:var(--secondary-text-color); white-space:nowrap; }
        .cpce-entity-add { flex-shrink:0; width:26px; height:26px; display:flex; align-items:center; justify-content:center; border:none; border-radius:var(--ltek-r-ctrl); background:var(--primary-color); color:#fff; cursor:pointer; font-size:18px; line-height:1; }
        .cpce-entity-add:hover { filter:brightness(1.1); }
        .cpce-entity-added { flex-shrink:0; color:var(--ltek-c-success); --mdc-icon-size:18px; }
        .cpce-search-row { display:flex; gap:var(--ltek-sp-3); margin-bottom:8px; }
        .cpce-search-row input { flex:1; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        .cpce-search-row select { padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        .cpce-selected-list { margin-top:6px; border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); overflow:hidden; }
        .cpce-selected-item { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:6px 8px; border-top:1px solid var(--divider-color,#333); font-size:var(--ltek-fs-label); color:var(--primary-text-color); }
        .cpce-selected-item:first-child { border-top:none; }
        .cpce-sel-remove { flex-shrink:0; background:none; border:none; color:var(--ltek-c-error); cursor:pointer; font-size:16px; font-weight:bold; padding:2px 6px; }
        .cpce-preset-editor { border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-md); margin-bottom:10px; overflow:hidden; }
        /* Local vs Library grouping dividers in the Buttons list. */
        .cpce-preset-group-divider { display:flex; align-items:center; gap:var(--ltek-sp-2); margin:6px 0 8px; color:var(--accent-color,var(--primary-color)); font-size:var(--ltek-fs-small); font-weight:var(--ltek-fw-bold); letter-spacing:0.04em; text-transform:uppercase; }
        .cpce-preset-group-divider::after { content:''; flex:1; height:1px; background:var(--divider-color,#333); margin-left:var(--ltek-sp-2); }
        .cpce-preset-group-divider ha-icon { --mdc-icon-size:16px; flex:0 0 auto; }
        .cpce-preset-group-hint { text-transform:none; letter-spacing:0; font-weight:var(--ltek-fw-medium); color:var(--secondary-text-color); font-size:var(--ltek-fs-tiny); flex:0 0 auto; }
        .cpce-preset-summary { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:10px 12px; cursor:pointer; user-select:none; }
        .cpce-preset-summary .chev { margin-left:auto; transition:transform 0.2s ease; color:var(--secondary-text-color); }
        .cpce-preset-editor.collapsed .cpce-preset-summary .chev { transform:rotate(-90deg); }
        .cpce-preset-editor.collapsed .cpce-preset-body { display:none; }
        .cpce-preset-swatch { width:20px; height:20px; border-radius:50%; border:1px solid var(--divider-color,#333); flex-shrink:0; }
        .cpce-preset-summary-name { color:var(--primary-text-color); font-size:var(--ltek-fs-label); font-weight:var(--ltek-fw-medium); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cpce-preset-editor.cpce-preset-hidden > .cpce-preset-summary .cpce-preset-summary-name { opacity:0.5; font-style:italic; }
        /* Keep the summary action icons grouped tightly (the name flexes to fill the gap). */
        .cpce-preset-summary .cpce-delete-entity-btn { margin-left:0; }
        .cpce-preset-summary .chev { margin-left:0; }
        /* Tighten the action-icon padding in the button summary row so the info chips get more room. */
        .cpce-preset-summary .cpce-icon-btn,
        .cpce-preset-summary .cpce-delete-entity-btn { padding:3px; }
        .cpce-preset-summary { gap:var(--ltek-sp-2); }
        .cpce-link-indicator { --mdc-icon-size:15px; color:var(--primary-color); flex-shrink:0; }
        /* Summary chips in the button row: section name, Color Entity / profile (link icon), "N scenes". */
        .cpce-summary-chip { display:inline-flex; align-items:center; gap:3px; flex:0 0 auto; padding:1px 8px; border-radius:999px; background:var(--ltek-c-accent-fade,rgba(33,150,243,0.15)); color:var(--ltek-c-label,var(--primary-color)); font-size:var(--ltek-fs-tiny,11px); font-weight:var(--ltek-fw-medium,500); white-space:nowrap; max-width:140px; overflow:hidden; text-overflow:ellipsis; }
        .cpce-summary-chip ha-icon { --mdc-icon-size:12px; flex-shrink:0; }
        .cpce-summary-chip.cpce-chip-broken { background:rgba(244,67,54,0.15); color:var(--ltek-c-error,#f44336); }
        .cpce-shared-link { --mdc-icon-size:18px; color:var(--primary-color); flex-shrink:0; }
        .cpce-link-indicator.cpce-link-broken { color:var(--ltek-c-error); }
        .cpce-preset-body { padding:0 10px 10px; }
        /* Sub-group divider within a button panel (groups: Button / Profile / Actions). */
        .cpce-subgroup { display:flex; align-items:center; gap:var(--ltek-sp-3); margin:14px 0 8px; color:var(--secondary-text-color); font-size:var(--ltek-fs-small); font-weight:var(--ltek-fw-bold); letter-spacing:0.04em; text-transform:uppercase; }
        .cpce-subgroup::after { content:''; flex:1; height:1px; background:var(--divider-color,#333); }
        .cpce-subgroup ha-icon { --mdc-icon-size:15px; color:var(--primary-color); }
        .cpce-readonly-val { flex:1; font-size:var(--ltek-fs-label); color:var(--secondary-text-color); font-style:italic; }
        .cpce-input-color-link { margin-top:10px; padding-top:10px; border-top:1px solid var(--divider-color,#333); }
        .cpce-preset-save-entity { display:inline-flex; align-items:center; gap:var(--ltek-sp-2); margin-top:6px; padding:6px 12px; border:none; border-radius:var(--ltek-r-ctrl); background:var(--primary-color); color:#fff; cursor:pointer; font-size:var(--ltek-fs-body); }
        .cpce-preset-save-entity:disabled { opacity:0.4; cursor:default; }
        .cpce-preset-save-entity ha-icon { --mdc-icon-size:14px; }
        .cpce-input-color-link code { font-size:var(--ltek-fs-small); background:var(--secondary-background-color,#2a2a2a); padding:1px 4px; border-radius:3px; }
        .cpce-preset-header { display:flex; align-items:center; gap:var(--ltek-sp-3); flex-wrap:wrap; margin-bottom:4px; }
        .cpce-preset-header input[type="text"] { flex:1; min-width:80px; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        .cpce-preset-header select { padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        /* Action icon buttons — neutral grey idle → brighten on hover, matching
           the Section Order convention (leading row icon stays accent; delete
           uses .cpce-delete-entity-btn = red). Was red-by-default, which bled
           red onto every non-overridden icon (eye/duplicate). */
        .cpce-icon-btn { display:flex; align-items:center; justify-content:center; padding:6px; border:none; border-radius:var(--ltek-r-ctrl); background:transparent; color:var(--ltek-c-icon); --mdc-icon-size:var(--ltek-icon-lg); cursor:pointer; flex-shrink:0; }
        .cpce-icon-btn:hover { color:var(--ltek-c-icon-hover); }
        .cpce-icon-btn:disabled { opacity:0.35; cursor:default; }
        .cpce-icon-btn.active { color:var(--ltek-c-accent); background:var(--ltek-c-accent-fade); }
        .cpce-color-editor { margin-top:10px; }
        .cpce-wheel-row { display:flex; gap:var(--ltek-sp-6); flex-wrap:wrap; }
        .cpce-color-wheel { border-radius:50%; cursor:crosshair; width:150px; height:150px; flex-shrink:0; }
        .cpce-color-fields { flex:1; min-width:200px; }
        .cpce-field-title { font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-semibold); color:var(--primary-color); margin:8px 0 4px; }
        .cpce-field-title:first-child { margin-top:0; }
        .cpce-rgb-fields, .cpce-hs-fields, .cpce-xy-fields { display:flex; gap:var(--ltek-sp-3); }
        .cpce-field-col { display:flex; flex-direction:column; flex:1; }
        .cpce-field-col label { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); margin-bottom:2px; }
        .cpce-field-col input { width:100%; padding:5px 6px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); box-sizing:border-box; }
        .cpce-field-col span { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); margin-top:1px; }
        .cpce-hex-row { display:flex; align-items:center; gap:var(--ltek-sp-3); margin:6px 0; }
        .cpce-hex-preview { width:32px; height:32px; border-radius:var(--ltek-r-ctrl); border:1px solid var(--divider-color,#333); }
        .cpce-hex-input { flex:1; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        .cpce-temp-editor { display:flex; align-items:center; gap:var(--ltek-sp-5); margin-top:8px; }
        .cpce-temp-editor input[type="range"] { flex:1; accent-color:#ff9800; }
        .cpce-temp-val, .cpce-bri-val { font-size:var(--ltek-fs-body); color:var(--secondary-text-color); white-space:nowrap; }
        .cpce-add-btn { display:flex; align-items:center; gap:var(--ltek-sp-2); padding:8px 14px; border:none; border-radius:var(--ltek-r-ctrl); background:var(--primary-color); color:#fff; cursor:pointer; font-size:var(--ltek-fs-label); }
        .cpce-radio-row { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:7px 4px; cursor:pointer; border-top:1px solid var(--divider-color,#333); font-size:var(--ltek-fs-label); color:var(--primary-text-color); }
        .cpce-radio-row:first-of-type { border-top:none; }
        .cpce-radio-row input[type="radio"] { flex-shrink:0; }
        .cpce-radio-label { font-weight:var(--ltek-fw-semibold); flex-shrink:0; min-width:70px; }
        .cpce-radio-desc { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); font-family:var(--code-font-family, monospace); }
        /* Section Order rows unified with the EESC card: each row is its own
           rounded bordered card, an accent leading icon, a plain dark rename box,
           an accent-tinted type badge, bold move arrows, and muted-grey action
           icons that brighten to white on hover (remove → red on hover). */
        .cpce-order-list { display:flex; flex-direction:column; gap:var(--ltek-sp-3); margin-bottom:8px; }
        /* Each entry (row + its expanded config) is one bordered block; the row
           and config panel inside it are borderless. Expanded → accent border. */
        .cpce-order-entry { border:1px solid var(--ltek-c-border); border-radius:var(--ltek-r-card); background:var(--ltek-c-surface-raised); overflow:hidden; }
        .cpce-order-entry.cpce-order-open { border-color:var(--primary-color); }
        .cpce-order-item { display:flex; align-items:center; gap:var(--ltek-sp-2); padding:6px 8px; font-size:var(--ltek-fs-label); color:var(--primary-text-color); }
        /* Wider gap after the leading section icon (matches EES's .seed-ed-section-head sp-3). */
        .cpce-order-item > .cpce-order-icon { margin-right:calc(var(--ltek-sp-3) - var(--ltek-sp-2)); }
        .cpce-order-item.cpce-order-hidden { opacity:0.5; }
        .cpce-order-hide ha-icon { --mdc-icon-size:var(--ltek-icon-lg); }
        .cpce-order-name { flex:1; }
        .cpce-order-divider-label { flex:1; color:var(--primary-text-color); }
        .cpce-order-rename { flex:1; min-width:60px; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        /* Rename locked until the section's config is open — reads as plain text,
           not an editable field. */
        /* Locked (not-editing) rename reads as a plain label — zero its input
           padding/border so its text left-aligns exactly with the divider row's
           plain-span label (fixes the "Buttons" rows sitting indented). */
        .cpce-order-rename-locked { background:transparent; border:none; padding:0; cursor:default; }
        .cpce-order-type { font-size:var(--ltek-fs-tiny); padding:2px 8px; border-radius:var(--ltek-r-card); flex-shrink:0; background:rgba(33,150,243,0.20); border:1px solid rgba(33,150,243,0.40); color:var(--primary-color,#2196F3); }
        /* Leading section icon + type chip act as the config expander (like EESC).
           Sized to --ltek-icon-lg like every other action/leading icon. */
        .cpce-order-item .cpce-order-icon { flex:none; --mdc-icon-size:var(--ltek-icon-lg); width:var(--ltek-icon-lg); height:var(--ltek-icon-lg); color:var(--ltek-c-accent); cursor:pointer; }
        .cpce-order-item .cpce-order-type { cursor:pointer; }
        .cpce-order-open .cpce-order-icon,
        .cpce-order-open .cpce-order-type { filter:brightness(1.25); }
        /* Action icons inherit the base .cpce-icon-btn (grey → brighten on hover,
           --ltek-icon-lg); just tighten the padding in the dense order rows. */
        /* Match EES's action icons in section rows: no button padding (spacing
           comes from the row's gap), so row height = icon height like EES. */
        .cpce-order-item .cpce-icon-btn { padding:0; }
        .cpce-order-item .cpce-icon-btn:hover { color:var(--ltek-c-icon-hover); }
        .cpce-order-item .cpce-icon-btn:disabled { opacity:0.25; }
        .cpce-order-item .cpce-icon-btn.cpce-order-remove { color:var(--ltek-c-icon); }
        .cpce-order-item .cpce-icon-btn.cpce-order-remove:hover { color:var(--ltek-c-error); }
        .cpce-order-style-panel { border:none; border-top:1px solid var(--divider-color,#333); padding:10px; background:var(--secondary-background-color,#1e1e1e); }
        /* Per-location frame condition override — an indented block under an
           applied conditional preset (card / section frame appliers). */
        .cpce-fr-override { padding:2px 0 6px 24px; }
        .cpce-fr-override .cpce-hint { margin-bottom:2px; }
        .cpce-fr-ov-entity, .cpce-fr-ov-op, .cpce-fr-ov-value { padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        /* Slider-section row: the inner .cpce-preset-summary already provides the
           row padding (10px 12px), so the wrapper adds none — removes the doubled
           vertical space inside the bordered box. Expanded → theme-color border
           (matches the other expandable panels). */
        .cpce-slider-section { border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-md); padding:0; margin-bottom:10px; overflow:hidden; }
        .cpce-slider-section:not(.collapsed) { border-color:var(--ltek-c-accent); }
        /* Collapsible sub-header (e.g. Added Entities). */
        /* Collapsible sub-panel header — BLUE accent + chevron (top-level group
           titles stay orange --accent-color; sub-panels are blue --ltek-c-accent). */
        /* Subpanel header matches EES: UPPERCASE accent label, chevron LARGER +
           RIGHT-justified. Chevron points down when open, right when collapsed. */
        .cpce-collapse-head { display:flex; align-items:center; gap:var(--ltek-sp-2); cursor:pointer; user-select:none; font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-semibold); color:var(--ltek-c-accent); margin:0; padding:10px 2px 4px; }
        .cpce-collapse-head .cpce-subpanel-name { text-transform:uppercase; letter-spacing:0.04em; }
        .cpce-collapse-head ha-icon { --mdc-icon-size:22px; margin-left:auto; color:var(--ltek-c-accent); transition:transform 0.2s ease; }
        .cpce-collapse-head.collapsed ha-icon { transform:rotate(-90deg); }
        /* Collapsible subpanels inside a settings panel: accent header, lightly-indented body. */
        /* Flush subpanel divider (EES-matched spacing): thin top line, tight
           padding around the header, modest body padding — no big margins. */
        .cpce-subpanel-head { border-top:1px solid var(--divider-color,#333); }
        .cpce-subpanel-body { padding:0 2px 10px; }
        /* Entity/scene chips (green = color-control/on, red = turn-off, blue = scene). */
        /* Each preset action group; a top border divides Color Control / Scenes / Turn Off. */
        .cpce-action-block { padding-top:10px; margin-top:10px; border-top:1px solid var(--divider-color,#333); }
        .cpce-action-block:first-child { padding-top:0; margin-top:0; border-top:none; }
        .cpce-chips { display:flex; flex-wrap:wrap; gap:var(--ltek-sp-2); margin:6px 0 2px; }
        .cpce-chip { display:inline-flex; align-items:center; gap:var(--ltek-sp-2); padding:3px 10px; border-radius:999px; font-size:var(--ltek-fs-body); border:1px solid var(--divider-color,#333); background:var(--secondary-background-color,#2a2a2a); color:var(--primary-text-color); }
        .cpce-chip.default { border-color:var(--ltek-c-info); }
        .cpce-chip.on { border-color:var(--ltek-c-success); }
        .cpce-chip.off { border-color:var(--ltek-c-error); }
        .cpce-chip.scene { border-color:var(--ltek-c-info); }
        .cpce-chip .cpce-chip-x { cursor:pointer; font-weight:bold; opacity:0.7; line-height:1; }
        .cpce-chip .cpce-chip-x:hover { opacity:1; }
        .cpce-chip-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .cpce-chip.on .cpce-chip-dot { background:var(--ltek-c-success); }
        .cpce-chip.off .cpce-chip-dot { background:var(--ltek-c-error); }
        .cpce-chip.scene .cpce-chip-dot { background:var(--ltek-c-info); }
        .cpce-search-picker { display:flex; flex-direction:column; gap:var(--ltek-sp-2); }
        .cpce-search-picker .cpce-sp-input { padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        .cpce-sp-list { max-height:220px; overflow-y:auto; border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); }
        .cpce-sp-list.collapsed { display:none; }
        .cpce-sp-item { display:flex; flex-direction:column; padding:7px 10px; cursor:pointer; border-top:1px solid var(--divider-color,#333); }
        .cpce-sp-item:first-child { border-top:none; }
        .cpce-sp-item:hover { background:var(--secondary-background-color,#2a2a2a); }
        .cpce-sp-name { font-size:var(--ltek-fs-label); color:var(--primary-text-color); }
        .cpce-addrow { display:flex; align-items:center; gap:var(--ltek-sp-3); }
        .cpce-addrow select, .cpce-addrow input { flex:1; min-width:0; padding:var(--ltek-ctrl-pad); background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); color:var(--primary-text-color); font-size:var(--ltek-fs-label); }
        .cpce-addrow .cpce-add-plus { width:28px; height:28px; flex-shrink:0; border:none; border-radius:var(--ltek-r-ctrl); color:#fff; cursor:pointer; font-size:18px; line-height:1; }
        .cpce-add-plus.on { background:var(--ltek-c-success); }
        .cpce-add-plus.off { background:var(--ltek-c-error); }
        .cpce-add-plus.scene { background:var(--ltek-c-info); }
        .cpce-order-up ha-icon, .cpce-order-down ha-icon { --mdc-icon-size:18px; }
        .cpce-unmatched-list, .cpce-manage-list { border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); overflow:hidden; margin-bottom:8px; }
        .cpce-unmatched-item, .cpce-manage-item { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:8px; border-top:1px solid var(--divider-color,#333); font-size:var(--ltek-fs-label); color:var(--primary-text-color); }
        .cpce-unmatched-item:first-child, .cpce-manage-item:first-child { border-top:none; }
        /* A hidden (disabled) frame layer reads dimmed but stays in the list. */
        .cpce-manage-item.cpce-frame-off { opacity:0.5; }
        .cpce-btnstyle-layers-panel { padding:8px 10px 10px; border-top:1px dashed var(--divider-color,#333); background:var(--ltek-c-surface-raised); }
        .cpce-stack-layer { border:1px solid var(--divider-color,#333); border-radius:var(--ltek-r-ctrl); padding:6px 8px; margin-bottom:6px; display:flex; flex-direction:column; gap:var(--ltek-sp-2); }
        .cpce-stack-layer.cpce-layer-off { opacity:0.5; border-style:dashed; }
        .cpce-stack-layer-hd { display:flex; align-items:center; gap:var(--ltek-sp-1); flex-wrap:nowrap; }
        .cpce-stack-layer-hd .cpce-layer-cond { flex:1 1 auto; min-width:0; }
        /* Icon buttons in a layer header shrink so all controls (incl. the trash) fit the row. */
        .cpce-stack-layer-hd .cpce-icon-btn, .cpce-stack-layer-hd .cpce-delete-entity-btn { flex:0 0 auto; width:26px; height:26px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
        .cpce-stack-layer-hd .cpce-icon-btn ha-icon, .cpce-stack-layer-hd .cpce-delete-entity-btn ha-icon { --mdc-icon-size:18px; }
        .cpce-stack-layer-badge { font-size:var(--ltek-fs-tiny); font-weight:var(--ltek-fw-bold); letter-spacing:.5px; color:var(--primary-color); border:1px solid var(--primary-color); border-radius:var(--ltek-r-ctrl); padding:1px 5px; }
        .cpce-stack-layer-num { font-size:var(--ltek-fs-small); font-weight:var(--ltek-fw-bold); color:var(--primary-color); white-space:nowrap; flex-shrink:0; }
        .cpce-stack-layer-label { margin-left:6px; padding:1px 6px; border-radius:999px; background:var(--ltek-c-accent-fade); color:var(--ltek-c-label); font-size:var(--ltek-fs-tiny); font-weight:var(--ltek-fw-medium); }
        .cpce-stack-layer-count { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); white-space:nowrap; }
        /* Read-only condition summary pill (no icon) shown in the collapsed layer header. */
        .cpce-stack-cond-pill { flex:0 1 auto; min-width:0; padding:1px 8px; border-radius:999px; background:var(--ltek-c-accent-fade); color:var(--ltek-c-label); font-size:var(--ltek-fs-tiny); font-weight:var(--ltek-fw-medium); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        /* Pushes the icon controls to the right so a long condition pill can't shove them off-screen. */
        .cpce-stack-layer-spacer { flex:1 1 auto; min-width:4px; }
        /* Second row: the enabled settings-groups summary, small muted text (wraps freely). */
        .cpce-stack-layer-groups { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); margin-top:2px; padding-left:2px; line-height:1.4; }
        /* Per-group include toggle on Style-Builder subpanels (overlay layers) — far LEFT, before the title. */
        .cpce-group-include { display:inline-flex; align-items:center; margin-right:8px; cursor:pointer; flex:0 0 auto; }
        .cpce-group-include input { margin:0; }
        /* Inherited (unchecked) group: no chevron, and the title reads as disabled. */
        .cpce-subpanel-head.cpce-subpanel-nochevron { cursor:default; }
        .cpce-subpanel-head.cpce-subpanel-inherited .cpce-subpanel-name { opacity:0.55; }
        .cpce-stack-layer.cpce-layer-editing { border-color:var(--ltek-c-warning); box-shadow:0 0 0 1px var(--ltek-c-warning) inset; }
        .cpce-stack-layer.cpce-layer-editing .cpce-stack-layer-num { color:var(--ltek-c-warning); }
        .cpce-editing-tag { display:inline-flex; align-items:center; gap:var(--ltek-sp-1); font-size:var(--ltek-fs-small); font-weight:var(--ltek-fw-semibold); color:var(--ltek-c-warning); }
        .cpce-layer-save-row { margin-bottom:var(--ltek-sp-3); padding:var(--ltek-sp-2) 0; }
        .cpce-preview-title { font-weight:var(--ltek-fw-bold); color:var(--primary-color); }
        /* Unsaved-preset state — RED so it's unmistakable the user must save. */
        /* Block (not flex) so the icon + text + inline <code> flow as ONE
           sentence. Flex made each child a separate item, so a mid-sentence
           <code> couldn't wrap and the text jumbled around it. */
        .cpce-unsaved-banner { display:block; padding:7px 10px; margin:6px 0 8px; border:1px solid var(--ltek-c-error); border-radius:var(--ltek-r-ctrl); background:rgba(244,67,54,0.12); color:var(--ltek-c-error); font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-semibold); line-height:1.6; }
        .cpce-unsaved-banner ha-icon { --mdc-icon-size:var(--ltek-icon-sm); vertical-align:-3px; margin-right:var(--ltek-sp-2); }
        /* Inline code flows with the sentence — matches the banner's size/line-height. */
        .cpce-unsaved-banner code { font-size:var(--ltek-fs-body); font-family:var(--code-font-family, monospace); background:rgba(0,0,0,0.18); padding:0 4px; border-radius:3px; white-space:nowrap; }
        /* Live preview swatch for the open Frame builder (painted by
           _paintFramePreviews). Mirrors the EES card's preview swatch. */
        .cpce-frame-preview { height:56px; border-radius:var(--ltek-r-card); margin:6px 0 10px; background:#1a1a1a; display:flex; align-items:center; justify-content:center; color:var(--ltek-c-muted); font-size:var(--ltek-fs-body); box-sizing:border-box; }
        .cpce-btnstyle-layers-panel.cpce-panel-unsaved { outline:2px solid var(--ltek-c-error); outline-offset:-2px; border-radius:var(--ltek-r-ctrl); }
        .cpce-manage-item.cpce-item-unsaved { box-shadow:inset 3px 0 0 var(--ltek-c-error); }
        .cpce-manage-item.cpce-item-default { box-shadow:inset 3px 0 0 var(--ltek-c-warning); }
        .cpce-manage-item.cpce-item-default.cpce-item-unsaved { box-shadow:inset 3px 0 0 var(--ltek-c-error); }
        .cpce-manage-item.cpce-item-unsaved .cpce-entity-id { color:var(--ltek-c-error); font-weight:var(--ltek-fw-bold); }
        .cpce-unsaved-dot { color:var(--ltek-c-error); font-size:var(--ltek-fs-group); }
        .cpce-create-preset-btn.cpce-unsaved { background:var(--ltek-c-error); border-color:var(--ltek-c-error); color:#fff; }
        /* Header Rule Set inline builder (Libraries → Header Rules). */
        .cpce-hdr-builder-panel { padding:var(--ltek-sp-4); border-top:1px solid var(--ltek-c-border-soft); background:var(--ltek-c-surface); }
        .cpce-hdr-builder-panel.cpce-panel-unsaved { outline:2px solid var(--ltek-c-error); outline-offset:-2px; border-radius:var(--ltek-r-ctrl); }
        .cpce-hr-row { border:1px solid var(--ltek-c-border-soft); border-radius:var(--ltek-r-md); margin:6px 0; background:var(--ltek-c-surface-raised); overflow:hidden; }
        .cpce-hr-row.cpce-hr-open { border-color:var(--ltek-c-accent); }
        .cpce-hr-summary { display:flex; align-items:center; gap:var(--ltek-sp-2); padding:var(--ltek-sp-2) var(--ltek-sp-3); cursor:pointer; }
        .cpce-hr-num { font-size:var(--ltek-fs-body); font-weight:var(--ltek-fw-semibold); color:var(--ltek-c-text); flex-shrink:0; }
        .cpce-hr-chev { --mdc-icon-size:var(--ltek-icon-sm); color:var(--ltek-c-icon); flex-shrink:0; }
        .cpce-hr-chips { display:inline-flex; align-items:center; gap:4px; flex-wrap:wrap; }
        .cpce-hr-chip { display:inline-flex; align-items:center; gap:3px; padding:1px 6px; border-radius:999px; background:var(--ltek-c-accent-fade); color:var(--ltek-c-label); font-size:var(--ltek-fs-tiny); font-weight:var(--ltek-fw-medium); }
        .cpce-hr-chip ha-icon { --mdc-icon-size:12px; }
        .cpce-hr-swatch { width:10px; height:10px; border-radius:3px; border:1px solid rgba(255,255,255,0.25); flex-shrink:0; }
        .cpce-hr-body { padding:var(--ltek-sp-3); border-top:1px solid var(--ltek-c-border-soft); }
        .cpce-hr-preview { margin-bottom:var(--ltek-sp-3); }
        .cpce-hr-prev { display:flex; align-items:center; gap:var(--ltek-sp-3); padding:var(--ltek-sp-3); border-radius:var(--ltek-r-md); background:#1a1a1a; }
        .cpce-hr-prev-sec { font-size:var(--ltek-fs-small); color:var(--secondary-text-color); margin-top:2px; }
        .cpce-btnstyle-layers.active { background:rgba(var(--rgb-primary-color,33,150,243),0.15); border-radius:var(--ltek-r-ctrl); }
        .cpce-esm-item { display:flex; flex-direction:column; gap:var(--ltek-sp-2); padding:8px; border-top:1px solid var(--divider-color,#333); }
        .cpce-esm-item:first-child { border-top:none; }
        .cpce-esm-name { font-size:var(--ltek-fs-label); color:var(--primary-text-color); display:flex; flex-direction:column; }
        .cpce-esm-controls { display:flex; gap:var(--ltek-sp-4); flex-wrap:wrap; }
        .cpce-esm-field { display:flex; flex-direction:column; gap:2px; font-size:var(--ltek-fs-small); color:var(--secondary-text-color); flex:1; min-width:130px; }
        .cpce-esm-field select { font-size:var(--ltek-fs-body); }
        .cpce-ce-name { display:flex; flex-direction:column; flex:1; min-width:0; }
        .cpce-link-unused { color:var(--secondary-text-color); opacity:0.6; }
        .cpce-ce-edit-panel, .cpce-scene-edit-panel { padding:10px 8px; border-top:1px solid var(--divider-color,#333); background:var(--secondary-background-color,rgba(255,255,255,0.03)); }
        .cpce-ce-create-preset { padding:4px 8px; font-size:var(--ltek-fs-body); }
        .cpce-create-preset-btn {
          display:flex; align-items:center; gap:4px; margin-left:auto; padding:5px 10px;
          border:none; border-radius:var(--ltek-r-ctrl); background:var(--primary-color); color:#fff; cursor:pointer; font-size:var(--ltek-fs-body); white-space:nowrap;
        }
        .cpce-create-preset-btn ha-icon { --mdc-icon-size:14px; }
        .cpce-manage-entities { margin-top:16px; padding-top:12px; border-top:1px dashed var(--divider-color,#333); }
        .cpce-delete-entity-btn {
          display:flex; align-items:center; justify-content:center; margin-left:auto; padding:6px;
          border:none; border-radius:var(--ltek-r-ctrl); background:transparent; color:var(--ltek-c-error); --mdc-icon-size:var(--ltek-icon-lg); cursor:pointer;
        }
        .cpce-delete-entity-btn:hover { background:var(--ltek-c-error-fade); }
        .cpce-editor-header { display:flex; align-items:center; gap:8px; padding:2px 2px 10px; border-bottom:1px solid var(--divider-color,#333); }
        .cpce-editor-header ha-icon { --mdc-icon-size:22px; color:var(--primary-color); }
        .cpce-editor-title { font-size:var(--ltek-fs-header); font-weight:var(--ltek-fw-semibold); color:var(--primary-text-color); }
        .cpce-editor-build { margin-left:auto; font-size:var(--ltek-fs-small); color:var(--secondary-text-color); font-family:var(--code-font-family, monospace); }
        /* Group divider separating the two logical panel groups (Visuals vs Management). */
        .cpce-group-divider { display:flex; align-items:center; gap:10px; margin:18px 2px 10px; color:var(--primary-color); font-size:var(--ltek-fs-label); font-weight:var(--ltek-fw-bold); letter-spacing:0.02em; text-transform:uppercase; }
        .cpce-group-divider::before, .cpce-group-divider::after { content:''; flex:1; height:2px; background:linear-gradient(to right, transparent, var(--primary-color)); opacity:0.5; }
        .cpce-group-divider::before { background:linear-gradient(to left, transparent, var(--primary-color)); }
        .cpce-group-divider ha-icon { --mdc-icon-size:18px; }
      </style>
      <div class="cpce">
        <div class="cpce-editor-header">
          <ha-icon icon="mdi:palette"></ha-icon>
          <span class="cpce-editor-title">${CARD_NAME}</span>
          <span class="cpce-editor-build">${BUILD_NUMBER}</span>
        </div>
        <div class="cpce-group-divider"><ha-icon icon="mdi:eye-outline"></ha-icon>Card</div>

        ${this._section('mdi:palette-outline', 'Card Appearance', 'appearance', `
          <div class="cpce-check"><input type="checkbox" id="cpce-card-collapsible" ${cfg.card_collapsible?'checked':''}><label for="cpce-card-collapsible">Make card collapsible (click title to expand/collapse)</label></div>
          ${cfg.card_collapsible ? `
            <div class="cpce-check"><input type="checkbox" id="cpce-card-show-chevron" ${cfg.card_show_chevron!==false?'checked':''}><label for="cpce-card-show-chevron">Show chevron in title</label></div>
            ${!cfg.title ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">A Card Title (below) is recommended for the collapsible header.</div>` : `<div class="cpce-hint">The card starts collapsed; clicking the title expands it.</div>`}
          ` : ''}

          ${this._subpanel('card-header', 'Header', `
          <div class="cpce-sub-title">Title Text</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-show-title" ${cfg.show_title!==false?'checked':''}><label for="cpce-show-title">Show card title</label></div>
          <div class="cpce-row"><label class="lbl">Card Title</label><input type="text" id="cpce-title" value="${escapeHtml(cfg.title||'')}"></div>
          ${cfg.show_title!==false ? this._textStyleControls('cpce-title', { size: cfg.title_font_size, weight: cfg.title_font_weight, color: cfg.title_color }, 18) : ''}

          <div class="cpce-sub-title">Title Icon</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-show-title-icon" ${cfg.show_title_icon!==false?'checked':''}><label for="cpce-show-title-icon">Show title icon</label></div>
          <div class="cpce-row"><label class="lbl">Icon</label><input type="text" id="cpce-icon" placeholder="mdi:palette" value="${escapeHtml(cfg.icon||'')}"></div>
          <div class="cpce-row"><label class="lbl">Icon Size</label><input type="range" id="cpce-icon-size" min="12" max="48" value="${Number(cfg.icon_size)||22}"><span class="cpce-strength-val" id="cpce-icon-size-val">${Number(cfg.icon_size)||22}px</span></div>
          <div class="cpce-check"><input type="checkbox" id="cpce-icon-color-enabled" ${cfg.icon_color_enabled?'checked':''}><label for="cpce-icon-color-enabled">Enable icon color</label></div>
          ${cfg.icon_color_enabled ? `
            <div class="cpce-row"><label class="lbl">Icon Color</label>
              <select id="cpce-icon-color-mode">
                <option value="fixed" ${(cfg.icon_color_mode!=='light'&&cfg.icon_color_mode!=='active')?'selected':''}>Fixed color</option>
                <option value="light" ${cfg.icon_color_mode==='light'?'selected':''}>Light's current color</option>
                <option value="active" ${cfg.icon_color_mode==='active'?'selected':''}>Last-pressed button's color</option>
              </select>
            </div>
            ${cfg.icon_color_mode !== 'light' ? `<div class="cpce-row"><label class="lbl">${cfg.icon_color_mode==='active'?'Fallback Color':'Fixed Icon Color'}</label><input type="color" id="cpce-icon-color" value="${cfg.icon_color || '#2196F3'}"></div>${cfg.icon_color_mode==='active'?`<div class="cpce-hint">Used until a button is pressed.</div>`:''}` : `
              <div class="cpce-row"><label class="lbl">When Light Off</label>
                <select id="cpce-icon-off-mode">
                  <option value="theme" ${cfg.icon_off_color_mode!=='fixed'?'selected':''}>Theme default</option>
                  <option value="fixed" ${cfg.icon_off_color_mode==='fixed'?'selected':''}>Specific color</option>
                </select>
              </div>
              ${cfg.icon_off_color_mode === 'fixed' ? `<div class="cpce-row"><label class="lbl">Off Color</label><input type="color" id="cpce-icon-off-color" value="${cfg.icon_off_color || '#666666'}"></div>` : ''}
            `}
          ` : `<div class="cpce-hint">Off uses the theme's default icon color.</div>`}

          <div class="cpce-sub-title">Header Rules</div>
          ${this._renderCardHeaderApply()}`)}

          ${this._subpanel('card-bg', 'Background', `
          <div class="cpce-row">
            <label class="lbl">Card Background</label>
            <select id="cpce-card-bg-mode">
              <option value="theme" ${(cfg.card_bg_mode||'theme')==='theme'?'selected':''}>Theme Default</option>
              <option value="transparent" ${cfg.card_bg_mode==='transparent'?'selected':''}>Transparent</option>
              <option value="custom" ${cfg.card_bg_mode==='custom'?'selected':''}>Custom Color</option>
            </select>
          </div>
          ${cfg.card_bg_mode === 'custom' ? `<div class="cpce-row"><label class="lbl">Custom Color</label><input type="color" id="cpce-card-bg-color" value="${cfg.card_bg_color || '#1c1c1c'}"></div>` : ''}
          <div class="cpce-hint">Transparent forces the background to be invisible; Theme Default uses whatever color your Home Assistant theme applies to cards.</div>`)}

          ${this._subpanel('card-frame', 'Card Frame', this._renderCardFrameApply())}

          ${this._subpanel('card-sizing', 'Scaling', `
          <div class="cpce-row"><label class="lbl">Overall Scale</label><input type="range" id="cpce-scale" min="0.6" max="1.8" step="0.05" value="${Number(cfg.scale)||1.0}"><span class="cpce-strength-val" id="cpce-scale-val">${(Number(cfg.scale)||1.0).toFixed(2)}x</span></div>
          <div class="cpce-hint">Overall Scale multiplies every other size (button/slider height and text) as a global multiplier.</div>`)}
        `)}

        ${this._section('mdi:tune-variant', 'Send Methods', 'options', `
          <div class="cpce-hint">Send methods compensate for a specific <strong>controller's firmware</strong> — how it wants white color temperature delivered, and whether it needs a color and an effect sent separately. Because these depend on the physical light (and one button can drive several different fixtures), set a <strong>card default</strong> below, then override <strong>per light</strong> for any fixture that behaves differently.</div>

          ${this._subpanel('sm-white-temp', 'Card Default — White Temperature Send Method', `
          <div class="cpce-hint">How a white color temperature is sent — applies to <strong>both</strong> the manual temperature slider and Custom Temperature buttons. Leave on <strong>Kelvin</strong> for most lights. If your controller (e.g. some RGBWW firmwares) shows the wrong color, try <strong>XY</strong>, or <strong>RGBWW</strong> if it has dedicated cold/warm white channels.</div>
          ${[
            ['kelvin', 'Kelvin', 'color_temp_kelvin — standard, correct for most lights'],
            ['xy', 'XY', 'xy_color — accurate CIE white point'],
            ['hs', 'HS', 'hs_color — hue/saturation'],
            ['rgb', 'RGB', 'rgb_color — approximate white via RGB channels'],
            ['rgbw', 'RGBW', 'rgbw_color — dedicated single white LED'],
            ['rgbww', 'RGBWW', 'rgbww_color — dedicated cold + warm white LEDs'],
          ].map(([val, label, desc]) => `
            <label class="cpce-radio-row">
              <input type="radio" name="cpce-temp-output-format" value="${val}" ${(cfg.temperature_output_format||'kelvin')===val?'checked':''}>
              <span class="cpce-radio-label">${label}</span>
              <span class="cpce-radio-desc">${desc}</span>
            </label>
          `).join('')}
          <div class="cpce-hint">Note: XY / HS / RGB put the light in color mode approximating white. RGBW / RGBWW use the light's dedicated white LEDs (RGBWW mixes cold/warm based on your Min/Max Kelvin range). Home Assistant lights are in one color mode at a time — pick the method your controller's mode expects.</div>
          `)}

          ${this._subpanel('sm-effect', 'Card Default — Effect Send Method', `
          <div class="cpce-hint">For a button that sets <strong>both</strong> a color and an effect, choose how they're sent. Effects run on the bulb's own firmware (e.g. Zigbee identify / color-loop) — the card only sends the effect name; its speed isn't adjustable and most effects override the button's color.</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-effect-separate" ${cfg.effect_separate_call?'checked':''}><label for="cpce-effect-separate">Send effect in a separate command (color first, then effect)</label></div>
          <div class="cpce-hint">Some controllers (e.g. Gledopto RGBWW via Zigbee2MQTT) re-trigger the effect from the color change when both are sent together, adding an extra flash. Turn this on to send them as two commands. Leave off (one command) for most lights.</div>
          `)}

          ${this._subpanel('sm-per-light', 'Per-Light Overrides', `
          ${this._renderEntitySendMethods()}
          `)}
        `)}

        <div class="cpce-group-divider"><ha-icon icon="mdi:view-dashboard-outline"></ha-icon>Sections</div>

        ${this._section('mdi:view-grid-outline', 'Section Layout &amp; Config', 'layout', `
          <div class="cpce-add-row">
            <button class="cpce-ees-add-btn" id="cpce-add-buttons-section"><ha-icon icon="mdi:plus"></ha-icon> Buttons</button>
            <button class="cpce-ees-add-btn" id="cpce-add-values-section"><ha-icon icon="mdi:plus"></ha-icon> Color Values</button>
            <button class="cpce-ees-add-btn" id="cpce-add-tracker-section"><ha-icon icon="mdi:view-grid-plus-outline"></ha-icon> Scene Tracker</button>
            <button class="cpce-ees-add-btn" id="cpce-add-divider-section"><ha-icon icon="mdi:minus"></ha-icon> Divider</button>
            <button class="cpce-ees-add-btn" id="cpce-import-section"><ha-icon icon="mdi:import"></ha-icon> Import Section…</button>
          </div>
          <div class="cpce-order-list">
            ${this._orderedSections().map((s, i, arr) => {
              const typeLabel = { buttons: 'Buttons', sliders: 'Sliders', values: 'Color Values', divider: 'Divider', scene_tracker: 'Scene Tracker' }[s.type] || s.type;
              const open = this._openSectionStyle === s.id;
              const isDivider = s.type === 'divider';
              const typeIcon = { buttons:'mdi:gesture-tap-button', sliders:'mdi:tune-variant', values:'mdi:palette', divider:'mdi:minus', scene_tracker:'mdi:view-grid-outline' }[s.type] || 'mdi:shape-outline';
              return `<div class="cpce-order-entry${open?' cpce-order-open':''}">
                <div class="cpce-order-item${s.hidden?' cpce-order-hidden':''}" data-section-id="${s.id}">
                ${isDivider
                  ? `<ha-icon class="cpce-order-icon cpce-order-style" data-key="${s.id}" title="Configure this section" icon="${s.icon ? escapeHtml(normalizeIcon(s.icon)) : 'mdi:minus'}"></ha-icon><span class="cpce-order-divider-label">${s.label ? escapeHtml(s.label) : 'Divider'}</span><span class="cpce-order-type cpce-order-style" data-key="${s.id}" title="Configure this section">${typeLabel}</span>`
                  : `<ha-icon class="cpce-order-icon cpce-order-style" data-key="${s.id}" title="Configure this section" icon="${typeIcon}"></ha-icon><input type="text" class="cpce-order-rename${open ? '' : ' cpce-order-rename-locked'}" value="${escapeHtml(s.name || typeLabel)}" title="${open ? 'Section name' : 'Open this section (click its icon) to rename'}"${open ? '' : ' readonly'}><span class="cpce-order-type cpce-order-style" data-key="${s.id}" title="Configure this section">${typeLabel}</span>`}
                <button class="cpce-icon-btn cpce-order-up" data-key="${s.id}" ${i === 0 ? 'disabled' : ''} title="Move up"><ha-icon icon="mdi:arrow-up-bold"></ha-icon></button>
                <button class="cpce-icon-btn cpce-order-down" data-key="${s.id}" ${i === arr.length - 1 ? 'disabled' : ''} title="Move down"><ha-icon icon="mdi:arrow-down-bold"></ha-icon></button>
                <button class="cpce-icon-btn cpce-order-duplicate" data-key="${s.id}" title="Duplicate this section"><ha-icon icon="mdi:content-duplicate"></ha-icon></button>
                <button class="cpce-icon-btn cpce-order-export" data-key="${s.id}" title="Export this section (+ its buttons) as JSON"><ha-icon icon="mdi:download"></ha-icon></button>
                <button class="cpce-icon-btn cpce-order-hide" data-key="${s.id}" title="${s.hidden?'Show on card':'Hide from card'}"><ha-icon icon="${s.hidden?'mdi:eye-off':'mdi:eye'}"></ha-icon></button>
                <button class="cpce-delete-entity-btn cpce-order-remove" data-key="${s.id}" title="Remove"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
              </div>
              ${open ? `<div class="cpce-order-style-panel" data-section-id="${s.id}">
                ${isDivider ? this._renderDividerConfig(s) : `
                <div class="cpce-check"><input type="checkbox" class="cpce-sn-show" ${s.name_show?'checked':''}><label>Show name heading above this section</label></div>
                ${s.name_show ? this._textStyleControls(`cpce-sn-${s.id}`, { size: s.name_font_size, weight: s.name_font_weight, color: s.name_color }, 13) : ''}
                ${s.name_show ? `
                <div class="cpce-check"><input type="checkbox" class="cpce-sn-collapsible" data-id="${s.id}" ${s.collapsible?'checked':''}><label>Collapsible (click the heading to expand/collapse this section)</label></div>
                ${s.collapsible ? `<div class="cpce-check"><input type="checkbox" class="cpce-sn-collapsed-default" data-id="${s.id}" ${s.collapsed_default?'checked':''}><label>Start collapsed</label></div>` : ''}` : ''}
                ${s.type === 'buttons' ? (() => {
                  const lib = buttonStyleLibraryMap();
                  // Every section names a concrete style. An unset ref resolves to Basic Theme, so a
                  // blank selection preselects Basic Theme (the neutral built-in) — no hidden default.
                  const cur = fixtureRefSlug(s.style_preset) || BTN_STYLE_BASIC_SLUG;
                  const entries = [...Object.keys(BUILTIN_BUTTON_STYLES).map(bs => ({ slug: bs, name: BUILTIN_BUTTON_STYLES[bs].name })),
                    ...Object.keys(lib).map(sl => ({ slug: sl, name: lib[sl].name || sl }))];
                  entries.sort((a, b) => a.name.localeCompare(b.name));
                  const opts = entries.map(e => {
                    const value = `lib:${escapeHtml(e.slug)}`;
                    return `<option value="${value}" ${cur === e.slug ? 'selected' : ''}>${escapeHtml(e.name)}</option>`;
                  }).join('');
                  const missing = cur && !isBuiltinButtonSlug(cur) && !lib[cur]
                    ? `<option value="lib:${escapeHtml(cur)}" selected>${escapeHtml(cur)} (missing)</option>` : '';
                  return `<div class="cpce-sub-title">Button Style</div>
                    <div class="cpce-row"><label class="lbl">Style Preset</label>
                      <select class="cpce-sn-style-preset" data-id="${s.id}">
                        ${opts}${missing}
                      </select>
                    </div>
                    <div class="cpce-hint">Pick the style for this section. Edit styles in the <strong>Button Styles</strong> library — changes there update every section using that style.</div>
                    ${this._renderSectionDefaultScene(s)}` ;
                })() : ''}
                ${s.type === 'values' ? `<div class="cpce-sub-title">Monitored Lights</div>
                  <div class="cpce-hint">Which light(s) this section reads color values from.</div>
                  ${this._renderTargetPicker(s, `data-vs-target="${s.id}"`)}` : ''}
                ${s.type === 'scene_tracker' ? this._renderSceneTrackerConfig(s) : ''}
                ${this._renderSectionFramePicker(s)}
                ${this._renderSectionHeaderApply(s)}`}
              </div>` : ''}
              </div>`;
            }).join('')}
          </div>
        `, 'Select and Order the card sections. Click the section icon to edit the section settings.')}

        ${this._section('mdi:lightbulb-multiple-outline', 'Buttons', 'presets', `
          <div class="cpce-hint">Configure the quick-select buttons. Use the color wheel for precise color selection.</div>
          <div id="cpce-preset-list">${(() => {
            // Group buttons by where their look is STORED: Local (inline look on the button) vs Library
            // (follows a shared Fixture Profile via profile_ref). Original indices are preserved so
            // each editor still edits the right preset. Each group's header shows whenever that group
            // is non-empty (so the labels act as organizers even in an all-local setup).
            const all = (cfg.presets || []).map((p, i) => ({ p, i }));
            const library = all.filter(x => fixtureRefSlug(x.p.profile_ref));
            const local = all.filter(x => !fixtureRefSlug(x.p.profile_ref));
            const div = (icon, label, hint) => `<div class="cpce-preset-group-divider"><ha-icon icon="${icon}"></ha-icon><span>${label}</span><span class="cpce-preset-group-hint">${hint}</span></div>`;
            let html = '';
            if (local.length) html += div('mdi:cellphone', 'Local', 'this card only');
            html += local.map(x => this._renderPresetEditor(x.p, x.i)).join('');
            if (library.length) html += div('mdi:bookshelf', 'Library', 'shared Fixture Profiles');
            html += library.map(x => this._renderPresetEditor(x.p, x.i)).join('');
            return html;
          })()}</div>
          <button class="cpce-add-btn" id="cpce-add-preset"><ha-icon icon="mdi:plus"></ha-icon> Add Button</button>
        `)}

        ${this._section('mdi:tune', 'Sliders', 'sliders', `
          <div class="cpce-hint">Each slider section shows the sliders you pick and controls its own target entities. Add multiple sections to control different lights independently. Styling below (orientation, size, gradient, text) is shared across all slider sections.</div>
          ${this._orderedSectionsRaw().filter(s => s.type === 'sliders').map((s, i, arr) => {
            const sel = s.sliders || { brightness: true, temperature: true, rgb: true };
            const collapsed = this._openSliderSection === s.id ? '' : ' collapsed';
            const chips = ['brightness','temperature','rgb'].filter(k => sel[k]).map(k => k === 'rgb' ? 'RGB' : k.charAt(0).toUpperCase()+k.slice(1)).join(', ') || 'none';
            return `
            <div class="cpce-preset-editor cpce-slider-section${collapsed}" data-section-id="${s.id}">
              <div class="cpce-preset-summary" data-ss-toggle="${s.id}">
                <ha-icon icon="mdi:tune"></ha-icon>
                <span class="cpce-preset-summary-name">${escapeHtml(s.name || 'Sliders')}</span>
                <span class="cpce-order-type">${chips}</span>
                <button class="cpce-icon-btn cpce-ss-remove" title="Remove section" ${arr.length <= 1 ? 'disabled' : ''}><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
                <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
              </div>
              <div class="cpce-preset-body">
                <div class="cpce-row"><label class="lbl">Name</label><input type="text" class="cpce-ss-name" value="${escapeHtml(s.name || 'Sliders')}" placeholder="Section name"></div>
                <div class="cpce-row" style="gap:14px;">
                  <label class="cpce-inline-check"><input type="checkbox" class="cpce-ss-brightness" ${sel.brightness?'checked':''}> Brightness</label>
                  <label class="cpce-inline-check"><input type="checkbox" class="cpce-ss-temperature" ${sel.temperature?'checked':''}> Temperature</label>
                  <label class="cpce-inline-check"><input type="checkbox" class="cpce-ss-rgb" ${sel.rgb?'checked':''}> RGB</label>
                </div>
                ${this._renderTargetPicker(s, `data-ss-target="${s.id}"`)}
                <div class="cpce-hint">Slider appearance (orientation, size, handle, gradient, text) is set once for all slider sections in the <strong>Sliders</strong> panel below.</div>
              </div>
            </div>`;
          }).join('')}
          <button class="cpce-add-btn" id="cpce-add-slider-section"><ha-icon icon="mdi:plus"></ha-icon> Add Slider Section</button>

          ${this._subpanel('sl-shared', 'Shared Slider Settings', `
          <div class="cpce-hint">Kelvin range and movement smoothing apply to <strong>all</strong> slider sections. The visual style below is the <strong>card default</strong> — each slider section can override it with its own "Custom" styling.</div>
          <div class="cpce-row"><label class="lbl">Min Kelvin (Warm)</label><input type="range" id="cpce-min-kelvin" min="1000" max="10000" step="100" value="${Number(cfg.min_kelvin)||2000}"><span class="cpce-strength-val" id="cpce-min-kelvin-val">${Number(cfg.min_kelvin)||2000}K</span></div>
          <div class="cpce-row"><label class="lbl">Max Kelvin (Cool)</label><input type="range" id="cpce-max-kelvin" min="1000" max="10000" step="100" value="${Number(cfg.max_kelvin)||6500}"><span class="cpce-strength-val" id="cpce-max-kelvin-val">${Number(cfg.max_kelvin)||6500}K</span></div>
          <div class="cpce-row"><label class="lbl">Movement Smoothing</label><input type="range" id="cpce-slider-debounce" min="0" max="1000" step="10" value="${Number(cfg.slider_debounce_ms)??100}"><span class="cpce-strength-val" id="cpce-slider-debounce-val">${Number(cfg.slider_debounce_ms)??100}ms</span></div>
          <div class="cpce-hint">Smoothing: how long to wait during a drag before sending a position to the light. Higher values smooth out rapid movement at the cost of a slight delay.</div>
          `)}

          ${this._subpanel('sl-gradient', 'Brightness Slider Gradient', `
          <div class="cpce-hint">Card default. Each slider section can override this under its own Styling.</div>
          <div class="cpce-row"><label class="lbl">Dark Color (left)</label><input type="color" id="cpce-brightness-start-color" value="${cfg.brightness_start_color || '#000000'}"></div>
          <div class="cpce-row"><label class="lbl">Bright Color (right)</label>
            <select id="cpce-brightness-end-mode">
              <option value="current" ${cfg.brightness_end_color_mode==='current'?'selected':''}>Use current light color</option>
              <option value="default" ${cfg.brightness_end_color_mode==='default'?'selected':''}>Use a fixed color</option>
            </select>
          </div>
          ${cfg.brightness_end_color_mode === 'default' ? `<div class="cpce-row"><label class="lbl">Fixed Bright Color</label><input type="color" id="cpce-brightness-end-color" value="${cfg.brightness_end_color || '#ffffff'}"></div>` : ''}
          <div class="cpce-row"><label class="lbl">Gradient Strength</label><input type="range" id="cpce-brightness-strength" min="10" max="90" value="${Number(cfg.brightness_gradient_strength)||50}"><span class="cpce-strength-val">${Number(cfg.brightness_gradient_strength)||50}%</span></div>
          <div class="cpce-hint">Strength controls where the midpoint of the gradient sits — lower values keep more of the bar dark before it lightens.</div>
          `)}

          ${this._subpanel('sl-orientation', 'Orientation', `
          <div class="cpce-row"><label class="lbl">Slider Orientation</label>
            <select id="cpce-slider-orientation">
              <option value="horizontal" ${cfg.slider_orientation!=='vertical'?'selected':''}>Horizontal</option>
              <option value="vertical" ${cfg.slider_orientation==='vertical'?'selected':''}>Vertical</option>
            </select>
          </div>
          ${cfg.slider_orientation === 'vertical' ? `
            <div class="cpce-row"><label class="lbl">Vertical Spacing</label>
              <select id="cpce-vertical-slider-alignment">
                <option value="left" ${(cfg.vertical_slider_alignment||'left')==='left'?'selected':''}>Left</option>
                <option value="center" ${cfg.vertical_slider_alignment==='center'?'selected':''}>Center</option>
                <option value="right" ${cfg.vertical_slider_alignment==='right'?'selected':''}>Right</option>
                <option value="even" ${cfg.vertical_slider_alignment==='even'?'selected':''}>Evenly spaced across width</option>
              </select>
            </div>
          ` : ''}
          `)}

          ${this._subpanel('sl-handle', 'Slider Handle', `
          <div class="cpce-row"><label class="lbl">Handle Color</label><input type="color" id="cpce-handle-color" value="${cfg.slider_handle_color || '#ffffff'}"></div>
          <div class="cpce-row"><label class="lbl">Handle Opacity</label><input type="range" id="cpce-handle-opacity" min="10" max="100" value="${Number(cfg.slider_handle_opacity)||100}"><span class="cpce-strength-val" id="cpce-handle-opacity-val">${Number(cfg.slider_handle_opacity)||100}%</span></div>
          <div class="cpce-row"><label class="lbl">Handle Shape</label>
            <select id="cpce-handle-shape">
              <option value="round" ${cfg.slider_handle_shape==='round'?'selected':''}>Round</option>
              <option value="square" ${cfg.slider_handle_shape==='square'?'selected':''}>Square</option>
              <option value="diamond" ${cfg.slider_handle_shape==='diamond'?'selected':''}>Diamond</option>
              <option value="line" ${cfg.slider_handle_shape==='line'?'selected':''}>Line</option>
            </select>
          </div>
          `)}

          ${this._subpanel('sl-sizing', 'Sizing', `
          ${cfg.slider_orientation === 'vertical' ? `
            <div class="cpce-row"><label class="lbl">Slider Width</label><input type="range" id="cpce-slider-width-vertical" min="24" max="100" value="${Number(cfg.slider_width_vertical)||44}"><span class="cpce-strength-val" id="cpce-slider-width-vertical-val">${Number(cfg.slider_width_vertical)||44}px</span></div>
            <div class="cpce-row"><label class="lbl">Slider Length</label><input type="range" id="cpce-slider-length-vertical" min="60" max="400" value="${Number(cfg.slider_length_vertical)||180}"><span class="cpce-strength-val" id="cpce-slider-length-vertical-val">${Number(cfg.slider_length_vertical)||180}px</span></div>
          ` : `
            <div class="cpce-row"><label class="lbl">Slider Width</label><input type="range" id="cpce-slider-width-horizontal" min="24" max="100" value="${Number(cfg.slider_width_horizontal)||44}"><span class="cpce-strength-val" id="cpce-slider-width-horizontal-val">${Number(cfg.slider_width_horizontal)||44}px</span></div>
            <div class="cpce-row"><label class="lbl">Slider Length</label><input type="range" id="cpce-slider-length-horizontal" min="20" max="100" value="${Number(cfg.slider_length_horizontal)||100}"><span class="cpce-strength-val" id="cpce-slider-length-horizontal-val">${Number(cfg.slider_length_horizontal)||100}%</span></div>
          `}
          <div class="cpce-row"><label class="lbl">Slider Text Size</label><input type="range" id="cpce-slider-font-size" min="8" max="28" value="${Number(cfg.slider_font_size)||13}"><span class="cpce-strength-val" id="cpce-slider-font-size-val">${Number(cfg.slider_font_size)||13}px</span></div>
          <div class="cpce-row"><label class="lbl">Slider Text Color</label>
            <select id="cpce-slider-text-color-mode">
              <option value="theme" ${!cfg.slider_text_color?'selected':''}>Theme default</option>
              <option value="fixed" ${cfg.slider_text_color?'selected':''}>Custom color</option>
            </select>
          </div>
          ${cfg.slider_text_color ? `<div class="cpce-row"><label class="lbl">Custom Text Color</label><input type="color" id="cpce-slider-text-color" value="${cfg.slider_text_color}"></div>` : ''}
          <div class="cpce-row"><label class="lbl">Corner Radius</label><input type="range" id="cpce-slider-border-radius" min="0" max="30" value="${Number(cfg.slider_border_radius)??10}"><span class="cpce-strength-val" id="cpce-slider-border-radius-val">${Number(cfg.slider_border_radius)??10}px</span></div>
          `)}

          ${this._subpanel('sl-text-placement', 'Text Placement', `
          ${cfg.slider_orientation === 'vertical' ? `
            <div class="cpce-row"><label class="lbl">Text Placement</label>
              <select id="cpce-slider-text-placement-vertical">
                <option value="inside" ${(cfg.slider_text_placement_vertical||'inside')==='inside'?'selected':''}>Inside the slider</option>
                <option value="outside" ${cfg.slider_text_placement_vertical==='outside'?'selected':''}>Outside (top &amp; bottom)</option>
              </select>
            </div>
          ` : `
            <div class="cpce-row"><label class="lbl">Text Placement</label>
              <select id="cpce-slider-text-placement-horizontal">
                <option value="above" ${cfg.slider_text_placement_horizontal==='above'?'selected':''}>Above the slider</option>
                <option value="below" ${cfg.slider_text_placement_horizontal==='below'?'selected':''}>Below the slider</option>
                <option value="inside" ${(cfg.slider_text_placement_horizontal||'inside')==='inside'?'selected':''}>Inside the slider</option>
              </select>
            </div>
          `}
          `)}

          ${this._subpanel('sl-text-visibility', 'Text Visibility', `
          ${['brightness', 'temperature', 'rgb'].map(type => `
            <div class="cpce-row"><label class="lbl">${type === 'rgb' ? 'RGB' : type.charAt(0).toUpperCase() + type.slice(1)}</label>
              <label class="cpce-inline-check"><input type="checkbox" id="cpce-${type}-show-label" ${cfg[`${type}_show_label`]!==false?'checked':''}> Name</label>
              <select id="cpce-${type}-label-position" ${cfg[`${type}_show_label`]===false?'disabled':''}>
                <option value="left" ${(cfg[`${type}_label_position`]||'left')==='left'?'selected':''}>Left</option>
                <option value="center" ${cfg[`${type}_label_position`]==='center'?'selected':''}>Center</option>
                <option value="right" ${cfg[`${type}_label_position`]==='right'?'selected':''}>Right</option>
              </select>
            </div>
            <div class="cpce-row"><label class="lbl"></label>
              <label class="cpce-inline-check"><input type="checkbox" id="cpce-${type}-show-value" ${cfg[`${type}_show_value`]!==false?'checked':''}> Value</label>
              <select id="cpce-${type}-value-position" ${cfg[`${type}_show_value`]===false?'disabled':''}>
                <option value="left" ${cfg[`${type}_value_position`]==='left'?'selected':''}>Left</option>
                <option value="center" ${cfg[`${type}_value_position`]==='center'?'selected':''}>Center</option>
                <option value="right" ${(cfg[`${type}_value_position`]||'right')==='right'?'selected':''}>Right</option>
              </select>
            </div>
          `).join('')}
          `)}
        `)}

        ${this._section('mdi:format-list-numbered', 'Color Values', 'value-display', `
          <div class="cpce-hint">A read-only readout of the light's current color values (RGB / Kelvin / HS / XY, plus W / CW / WW when the light reports them) — handy for reading a color to save into a preset. Add a “Color Values” section in the <strong>Section Order</strong> section; these settings apply to it.</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-temp-show-mired" ${cfg.temperature_show_mired?'checked':''}><label for="cpce-temp-show-mired">Show the mired value next to Kelvin (e.g. "2000K / 500m")</label></div>
          <div class="cpce-row"><label class="lbl">Column Justification</label>
            <select id="cpce-cv-justify">
              <option value="left" ${(cfg.current_values_justify||'left')==='left'?'selected':''}>Left</option>
              <option value="center" ${cfg.current_values_justify==='center'?'selected':''}>Center</option>
              <option value="right" ${cfg.current_values_justify==='right'?'selected':''}>Right</option>
            </select>
          </div>
          <div class="cpce-hint">Note: the mired display option also applies to the temperature slider readout.</div>
        `)}

        ${this._section('mdi:palette-swatch-outline', 'Scratchpad', 'favorites', `
          <div class="cpce-check"><input type="checkbox" id="cpce-show-favorites" ${cfg.show_favorites?'checked':''}><label for="cpce-show-favorites">Show scratchpad bar on the card</label></div>
          <div class="cpce-hint">Scratchpad colors are temporary and saved in this browser only (not synced across devices), shared across all Color Light & Scene Manager cards in it. Use them to quickly stash a color you're experimenting with.</div>
        `)}

        ${this._section('mdi:lightbulb-group', 'Default Entities', 'entities', `
          <div class="cpce-hint">A shared pool of lights. Each button can include this pool <strong>live</strong> ("Use Default Entities") and/or add its own lights — so changing this list updates every button that uses it. It's also what the card glow / header icon follow (in "light" mode) and where per-light Send Method overrides come from. Optional — you can leave it empty and give each button its own lights.</div>
          <div class="cpce-search-row">
            <input type="text" id="cpce-search" placeholder="Search entities…" value="${escapeHtml(this._entitySearch)}">
            <select id="cpce-filter-type">
              <option value="none" ${this._entityFilter.type==='none'?'selected':''}>No Filter</option>
              <option value="label" ${this._entityFilter.type==='label'?'selected':''}>Label</option>
              <option value="group" ${this._entityFilter.type==='group'?'selected':''}>Group</option>
              <option value="text" ${this._entityFilter.type==='text'?'selected':''}>Text</option>
            </select>
          </div>
          ${this._entityFilter.type === 'label' ? `<div class="cpce-row"><select id="cpce-filter-label"><option value="">All Labels</option>${labels.map(l => `<option value="${escapeHtml(l)}" ${this._entityFilter.value===l?'selected':''}>${escapeHtml(l)}</option>`).join('')}</select></div>` : ''}
          ${this._entityFilter.type === 'group' ? `<div class="cpce-row"><select id="cpce-filter-group"><option value="">All Groups</option>${groups.map(g => `<option value="${escapeHtml(g.id)}" ${this._entityFilter.value===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}</select></div>` : ''}
          ${this._entityFilter.type === 'text' ? `<div class="cpce-row"><input type="text" id="cpce-filter-text" placeholder="Filter text…" value="${escapeHtml(this._entityFilter.value)}"></div>` : ''}
          <div class="cpce-entity-list" id="cpce-entity-list">${this._renderEntityListInner()}</div>
          <div class="cpce-collapse-head${this._addedEntitiesCollapsed ? ' collapsed' : ''}" id="cpce-added-toggle"><span class="cpce-subpanel-name">Default Entities (${(cfg.entities||[]).length})</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
          ${this._addedEntitiesCollapsed ? '' : `<div id="cpce-selected-list">${this._renderSelectedList()}</div>`}
        `)}

        <div class="cpce-group-divider"><ha-icon icon="mdi:cog-outline"></ha-icon>Libraries</div>
        <div class="cpce-hint" style="margin:0 2px 10px;">Create and manage color entities, styles, profiles, and scenes.</div>

        ${this._section('mdi:link-variant', 'Color Entities', 'color-entities', `
          <div class="cpce-hint">
            <code>color.*</code> (Color helper) entities store a reusable color/brightness. A button set to
            <strong>Custom Color/Temperature</strong> can link to one — the button then applies that entity's
            value <strong>live</strong> (edit it here, every linked button updates). Legacy <code>input_color.*</code> helpers still work.
          </div>

          <div class="cpce-collapse-head${this._ceCollapsed.manage ? ' collapsed' : ''}" data-ce-toggle="manage"><span class="cpce-subpanel-name">Manage Entities (${this._allInputColorEntities.length})</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
          ${this._ceCollapsed.manage ? '' : this._renderColorEntitiesManageList()}

          <div class="cpce-collapse-head${this._ceCollapsed.create ? ' collapsed' : ''}" data-ce-toggle="create"><span class="cpce-subpanel-name">Create New Entity</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
          ${this._ceCollapsed.create ? '' : `
            <div class="cpce-row">
              <input type="text" id="cpce-new-input-color-name" placeholder="Entity name (e.g. Theater Golden)">
              <button class="cpce-create-preset-btn" id="cpce-create-input-color-entity"><ha-icon icon="mdi:plus"></ha-icon> Create Entity</button>
            </div>
            <div class="cpce-hint">Creates a new <code>color</code> helper entity and, once confirmed, a new preset automatically linked to it. If the entity can't be created, no preset is created.</div>`}

          <div class="cpce-collapse-head${this._ceCollapsed.orphans ? ' collapsed' : ''}" data-ce-toggle="orphans"><span class="cpce-subpanel-name">Clean Up Orphans</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
          ${this._ceCollapsed.orphans ? '' : `
            <div class="cpce-hint">
              Older integration versions could leave behind orphaned color entities (ones "no longer
              provided by the integration") that Home Assistant won't let you delete normally. Scan for
              and remove any such orphaned <code>color.*</code> / <code>input_color.*</code> entities here.
            </div>
            <button class="cpce-add-btn" id="cpce-cleanup-orphans"><ha-icon icon="mdi:broom"></ha-icon> Scan &amp; Remove Orphans</button>`}
        `)}

        ${this._section('mdi:card-multiple-outline', 'Fixture Profiles', 'profile-library', this._renderProfileLibrarySection())}

        ${this._section('mdi:auto-fix', 'Frame Styles', 'frame-library', this._renderFramePresets())}

        ${this._section('mdi:format-list-checks', 'Header Rules', 'header-library', this._renderHeaderRuleSets())}

        ${this._section('mdi:gesture-tap-button', 'Button Styles', 'button-appearance', `
          <div class="cpce-group-divider"><ha-icon icon="mdi:bookshelf"></ha-icon>Style Library</div>
          ${this._renderButtonStylePresets()}

          ${this._editingLayer ? `
          <div class="cpce-group-divider"><ha-icon icon="mdi:gesture-tap-button"></ha-icon>Style Builder — Editing Layer ${this._editingLayer.idx + 1}</div>
          <div class="cpce-hint">Edit on Layer at a time. Layer 1 always sets All Settings. Other layers you use check boxes to enable/dsiable settings groups. Only enabled settings will be saved in the Style itself.</div>
          <div id="cpce-btnstyle-preview-host">${this._renderButtonStylePreview()}</div>
          <div class="cpce-row" style="gap:8px;margin:6px 0;">
            ${this._stackDraftFor(this._editingLayer.slug) && this._stackDraftFor(this._editingLayer.slug).dirty ? `
            <button class="cpce-create-preset-btn cpce-layer-save cpce-unsaved" data-slug="${escapeHtml(this._editingLayer.slug)}" style="flex:1;justify-content:center;" title="Save changes to the shared library (applies system-wide to every card using this preset)"><ha-icon icon="mdi:content-save"></ha-icon> Save Changes</button>
            <button class="cpce-mini-btn cpce-layer-discard" data-slug="${escapeHtml(this._editingLayer.slug)}" title="Undo unsaved edits — reloads the layers as currently saved"><ha-icon icon="mdi:undo"></ha-icon> Discard changes</button>` : ''}
            <button class="cpce-mini-btn" id="cpce-btnstyle-export-current" title="Export this layer's settings as JSON"><ha-icon icon="mdi:download"></ha-icon> Export Layer</button>
          </div>

          ${this._btnGroupSubpanel('btn-layout', 'layout', 'Button Layout', `
          <div class="cpce-row"><label class="lbl">Layout Type</label>
            <select id="cpce-layout">
              <option value="stack" ${cfg.layout==='stack'?'selected':''}>Stack (vertical)</option>
              <option value="columns" ${cfg.layout==='columns'?'selected':''}>Columns (row)</option>
              <option value="grid" ${cfg.layout==='grid'?'selected':''}>Grid</option>
            </select>
          </div>
          <div class="cpce-row"><label class="lbl">Grid Columns</label><input type="range" id="cpce-columns" min="1" max="6" value="${Number(cfg.columns)||3}"><span class="cpce-strength-val" id="cpce-columns-val">${Number(cfg.columns)||3}</span></div>
          <div class="cpce-row"><label class="lbl">Gap (px)</label><input type="range" id="cpce-gap" min="0" max="48" value="${Number(cfg.gap)||8}"><span class="cpce-strength-val" id="cpce-gap-val">${Number(cfg.gap)||8}px</span></div>
          <div class="cpce-check"><input type="checkbox" id="cpce-wrap" ${cfg.wrap?'checked':''}><label for="cpce-wrap">Allow buttons to wrap</label></div>`)}

          ${this._btnGroupSubpanel('btn-style', 'background', 'Background', `
          <div class="cpce-row"><label class="lbl">Background Type</label>
            <select id="cpce-button-style">
              <option value="solid" ${(cfg.button_style==='solid'||cfg.button_style==='tile'||!['tinted','theme','transparent'].includes(cfg.button_style))?'selected':''}>Solid (button color)</option>
              <option value="tinted" ${cfg.button_style==='tinted'?'selected':''}>Tinted (color gradient)</option>
              <option value="theme" ${cfg.button_style==='theme'?'selected':''}>Theme surface</option>
              <option value="transparent" ${cfg.button_style==='transparent'?'selected':''}>Transparent</option>
            </select>
          </div>`)}

          ${this._btnGroupSubpanel('btn-border', 'border', 'Line Border', `
          <div class="cpce-check"><input type="checkbox" id="cpce-button-border-enabled" ${cfg.button_border_enabled?'checked':''}><label for="cpce-button-border-enabled">Enable button border</label></div>
          ${cfg.button_border_enabled ? `
            <div class="cpce-row"><label class="lbl">Border Color</label>
              <select id="cpce-button-border-color-mode">
                <option value="match" ${cfg.button_border_color_mode==='match'?'selected':''}>Match button color (lighter shade)</option>
                <option value="fixed" ${(cfg.button_border_color_mode||'fixed')==='fixed'?'selected':''}>Specific color</option>
                <option value="none" ${cfg.button_border_color_mode==='none'?'selected':''}>None (disable)</option>
              </select>
            </div>
            ${(cfg.button_border_color_mode||'fixed')==='fixed' ? `<div class="cpce-row"><label class="lbl">Border Color</label><input type="color" id="cpce-button-border-color" value="${cfg.button_border_color || '#2196F3'}"></div>` : ''}
            <div class="cpce-row"><label class="lbl">Border Weight</label><input type="range" id="cpce-button-border-width" min="1" max="10" value="${Number(cfg.button_border_width)||1}"><span class="cpce-strength-val" id="cpce-button-border-width-val">${Number(cfg.button_border_width)||1}px</span></div>
            <div class="cpce-row"><label class="lbl">Sides</label><span class="cpce-side-toggles">
              ${(() => { const on = buttonBorderSides(cfg); return [['top','Top'],['bottom','Bottom'],['left','Left'],['right','Right']].map(([s,l])=>`<label><input type="checkbox" class="cpce-button-border-side" data-side="${s}" ${on.includes(s)?'checked':''}> ${l}</label>`).join(''); })()}
            </span></div>
          ` : ''}`)}

          ${this._btnGroupSubpanel('btn-gradient', 'gradient', 'Gradient Border', `
          <div class="cpce-hint">Layered gradient lines, independent of the solid Line Border and glow.</div>
          <div class="cpce-row"><label class="lbl">Gradient Color</label>
            <select id="cpce-button-gradient-color-mode">
              <option value="match" ${(cfg.button_border_gradient_color_mode||'match')==='match'?'selected':''}>Match button color</option>
              <option value="fixed" ${cfg.button_border_gradient_color_mode==='fixed'?'selected':''}>Specific color (uses stops below)</option>
              <option value="none" ${cfg.button_border_gradient_color_mode==='none'?'selected':''}>None (disable)</option>
            </select>
          </div>
          ${this._renderGradientBorderEditor(cfg.button_border_gradient, 'btngb', cfg.button_border_color || '#2196F3')}`)}

          ${this._btnGroupSubpanel('btn-glow', 'glow', 'Glow', `
          <div class="cpce-check"><input type="checkbox" id="cpce-button-glow-enabled" ${cfg.button_glow_enabled?'checked':''}><label for="cpce-button-glow-enabled">Enable button glow</label></div>
          ${cfg.button_glow_enabled ? `
            <div class="cpce-row"><label class="lbl">Glow Color</label>
              <select id="cpce-button-glow-color-mode">
                <option value="match" ${cfg.button_glow_color_mode==='match'?'selected':''}>Match button/light color</option>
                <option value="fixed" ${(cfg.button_glow_color_mode||'fixed')==='fixed'?'selected':''}>Specific color</option>
                <option value="none" ${cfg.button_glow_color_mode==='none'?'selected':''}>None (disable)</option>
              </select>
            </div>
            ${(cfg.button_glow_color_mode||'fixed')==='fixed' ? `<div class="cpce-row"><label class="lbl">Glow Color</label><input type="color" id="cpce-button-glow-color" value="${cfg.button_glow_color || '#2196F3'}"></div>` : ''}
            <div class="cpce-row"><label class="lbl">Glow Blur</label><input type="range" id="cpce-button-glow-blur" min="0" max="40" value="${Number.isFinite(Number(cfg.button_glow_blur))?Number(cfg.button_glow_blur):12}"><span class="cpce-strength-val" id="cpce-button-glow-blur-val">${Number.isFinite(Number(cfg.button_glow_blur))?Number(cfg.button_glow_blur):12}px</span></div>
            <div class="cpce-row"><label class="lbl">Glow Spread</label><input type="range" id="cpce-button-glow-spread" min="-10" max="20" value="${Number.isFinite(Number(cfg.button_glow_spread))?Number(cfg.button_glow_spread):2}"><span class="cpce-strength-val" id="cpce-button-glow-spread-val">${Number.isFinite(Number(cfg.button_glow_spread))?Number(cfg.button_glow_spread):2}px</span></div>
            <div class="cpce-row"><label class="lbl">Glow Opacity</label><input type="range" id="cpce-button-glow-opacity" min="0" max="100" value="${Math.round((Number.isFinite(Number(cfg.button_glow_opacity))?Number(cfg.button_glow_opacity):0.5)*100)}"><span class="cpce-strength-val" id="cpce-button-glow-opacity-val">${Math.round((Number.isFinite(Number(cfg.button_glow_opacity))?Number(cfg.button_glow_opacity):0.5)*100)}%</span></div>
            <div class="cpce-row"><label class="lbl">Glow When</label>
              <select id="cpce-button-glow-condition">
                <option value="always" ${cfg.button_glow_condition==='always'?'selected':''}>Always on</option>
                <option value="when_active" ${cfg.button_glow_condition==='when_active'?'selected':''}>Preset is active (matches light state)</option>
              </select>
            </div>
          ` : ''}`)}

          ${this._btnGroupSubpanel('btn-shadow', 'shadow', 'Drop Shadow', `
          <div class="cpce-hint">A plain elevation shadow on each button, separate from the colored glow above.</div>
          <div class="cpce-row"><label class="lbl">Shadow Color</label><input type="color" id="cpce-button-shadow-color" value="${cfg.button_shadow_color || '#000000'}"><label class="cpce-inline-check"><input type="checkbox" id="cpce-button-shadow-enabled" ${cfg.button_shadow_enabled?'checked':''}> Enable</label></div>
          ${cfg.button_shadow_enabled ? `
            <div class="cpce-row"><label class="lbl">X Offset</label><input type="range" id="cpce-button-shadow-x" min="-20" max="20" value="${Number(cfg.button_shadow_x)||0}"><span class="cpce-strength-val" id="cpce-button-shadow-x-val">${Number(cfg.button_shadow_x)||0}px</span></div>
            <div class="cpce-row"><label class="lbl">Y Offset</label><input type="range" id="cpce-button-shadow-y" min="-20" max="20" value="${Number(cfg.button_shadow_y)||4}"><span class="cpce-strength-val" id="cpce-button-shadow-y-val">${Number(cfg.button_shadow_y)||4}px</span></div>
            <div class="cpce-row"><label class="lbl">Blur</label><input type="range" id="cpce-button-shadow-blur" min="0" max="40" value="${Number(cfg.button_shadow_blur)||12}"><span class="cpce-strength-val" id="cpce-button-shadow-blur-val">${Number(cfg.button_shadow_blur)||12}px</span></div>
            <div class="cpce-row"><label class="lbl">Spread</label><input type="range" id="cpce-button-shadow-spread" min="-20" max="20" value="${Number(cfg.button_shadow_spread)||0}"><span class="cpce-strength-val" id="cpce-button-shadow-spread-val">${Number(cfg.button_shadow_spread)||0}px</span></div>
            <div class="cpce-row"><label class="lbl">Opacity</label><input type="range" id="cpce-button-shadow-opacity" min="0" max="100" value="${Math.round((Number(cfg.button_shadow_opacity)??0.35)*100)}"><span class="cpce-strength-val" id="cpce-button-shadow-opacity-val">${Math.round((Number(cfg.button_shadow_opacity)??0.35)*100)}%</span></div>
          ` : ''}`)}

          ${this._btnGroupSubpanel('btn-text', 'text', 'Text', `
          <div class="cpce-row"><label class="lbl">Name Text Size</label><input type="range" id="cpce-button-font-size" min="8" max="32" value="${Number(cfg.button_font_size)||14}"><span class="cpce-strength-val" id="cpce-button-font-size-val">${Number(cfg.button_font_size)||14}px</span></div>
          <div class="cpce-row"><label class="lbl">Name Text Weight</label>
            <select id="cpce-button-name-weight">
              ${['300','400','500','600','700'].map(w => `<option value="${w}" ${(cfg.button_name_weight||'600')===w?'selected':''}>${w}</option>`).join('')}
            </select>
          </div>
          <div class="cpce-row"><label class="lbl">Name Text Color</label>
            <select id="cpce-button-name-color-mode">
              <option value="inherit" ${(cfg.button_name_color_mode||'inherit')==='inherit'?'selected':''}>Inherit (theme/default)</option>
              <option value="match" ${cfg.button_name_color_mode==='match'?'selected':''}>Match button color</option>
              <option value="fixed" ${cfg.button_name_color_mode==='fixed'?'selected':''}>Specific color</option>
            </select>
          </div>
          ${cfg.button_name_color_mode==='fixed' ? `<div class="cpce-row"><label class="lbl">Name Color</label><input type="color" id="cpce-button-name-color" value="${cfg.button_name_color || '#2196F3'}"></div>` : ''}
          <div class="cpce-check"><input type="checkbox" id="cpce-button-name-wrap" ${cfg.button_name_wrap?'checked':''}><label for="cpce-button-name-wrap">Word-wrap button names (multi-word names break to lines instead of widening)</label></div>
          <div class="cpce-row"><label class="lbl">Icon–Label Spacing</label><input type="range" id="cpce-button-icon-gap" min="0" max="24" value="${Number(cfg.button_icon_gap)??8}"><span class="cpce-strength-val" id="cpce-button-icon-gap-val">${Number(cfg.button_icon_gap)??8}px</span></div>`)}

          ${this._btnGroupSubpanel('btn-icon', 'icon', 'Icon', `
          <div class="cpce-row"><label class="lbl">Custom Icon</label><input type="text" id="cpce-button-icon" placeholder="(use each button's icon)" value="${escapeHtml(cfg.button_icon || '')}"></div>
          <div class="cpce-hint">Leave blank to use each button's own icon; set an <code>mdi:*</code> to force the same icon on every button.</div>
          <div class="cpce-row"><label class="lbl">Icon Size</label><input type="range" id="cpce-button-icon-size" min="0" max="48" value="${Number(cfg.button_icon_size)||0}"><span class="cpce-strength-val" id="cpce-button-icon-size-val">${Number(cfg.button_icon_size) ? `${Number(cfg.button_icon_size)}px` : 'Auto'}</span></div>
          <div class="cpce-row"><label class="lbl">Icon Color</label>
            <select id="cpce-button-icon-color-mode">
              <option value="" ${!cfg.button_icon_color_mode?'selected':''}>Default (per background)</option>
              <option value="match" ${cfg.button_icon_color_mode==='match'?'selected':''}>Match button color</option>
              <option value="fixed" ${cfg.button_icon_color_mode==='fixed'?'selected':''}>Specific color</option>
              <option value="none" ${cfg.button_icon_color_mode==='none'?'selected':''}>None (leave default)</option>
            </select>
          </div>
          ${cfg.button_icon_color_mode==='fixed' ? `<div class="cpce-row"><label class="lbl">Icon Color</label><input type="color" id="cpce-button-icon-color" value="${cfg.button_icon_color || '#2196F3'}"></div>` : ''}`)}

          ${this._btnGroupSubpanel('btn-sizing', 'sizing', 'Button Shape', `
          <div class="cpce-row"><label class="lbl">Corner Radius</label><input type="range" id="cpce-button-border-radius" min="0" max="40" value="${Number(cfg.button_border_radius)||10}"><span class="cpce-strength-val" id="cpce-button-border-radius-val">${Number(cfg.button_border_radius)||10}px</span></div>
          <div class="cpce-row"><label class="lbl">Button Height</label><input type="range" id="cpce-button-height" min="24" max="100" value="${Number(cfg.button_height)||44}"><span class="cpce-strength-val" id="cpce-button-height-val">${Number(cfg.button_height)||44}px</span></div>
          <div class="cpce-row"><label class="lbl">Max Button Width</label><input type="range" id="cpce-button-max-width" min="0" max="300" step="5" value="${Number(cfg.button_max_width)||0}"><span class="cpce-strength-val" id="cpce-button-max-width-val">${Number(cfg.button_max_width) ? `${Number(cfg.button_max_width)}px` : 'Auto'}</span></div>
          <div class="cpce-hint">Set Max Width (and enable word-wrap in Text) for uniform button sizes; 0 = Auto. Heights are aligned so wrapped buttons match single-line ones.</div>`)}
          ` : ''}
        `)}

        ${this._section('mdi:movie-open-cog-outline', 'Scenes', 'scene-builder', this._renderSceneBuilderSection())}

        ${this._section('mdi:form-dropdown', 'Scene Groups', 'scene-groups', this._renderSceneGroupsSection())}

      </div>
    `;
    this._wireEvents();
    this._paintFramePreviews();
  }

  // Paint the live preview swatch for the open Frame builder. Composes
  // box-shadow / border / background / edges directly from the preset object
  // (draft-aware) so it matches the renderer's _resolveFrame output. Ported from
  // the EES card's _paintFramePreviews (self-contained — no renderer dependency).
  _paintFramePreviews() {
    const iconColor = (this._config.colors && this._config.colors.icon) || '#2196F3';
    this.querySelectorAll('[data-frame-preview]').forEach(el => {
      const id = el.dataset.framePreview;
      // Prefer the live draft (unsaved edits), else the stored preset.
      const fx = (this._frameDraft && this._frameDraft.id === id)
        ? this._frameDraft.fx
        : (this._framePresetsById()[id] || null);
      if (!fx) { el.style.boxShadow = 'none'; el.style.border = 'none'; el.style.backgroundColor = '#1a1a1a'; el.style.backgroundImage = ''; return; }
      const parts = [];
      if (fx.glow) {
        const g = fx.glow, intensity = g.intensity || 1;
        const blur = 12 * intensity, spread = -4 * intensity, offset = 4 * intensity;
        const gc = g.follow_icon ? iconColor : g.color;
        if (!g.borders_only) { parts.push(`0 0 ${blur}px ${spread}px ${gc}`); }
        else {
          const bsides = (fx.border && Array.isArray(fx.border.sides)) ? fx.border.sides : ['top','bottom','left','right'];
          if (bsides.includes('top')) parts.push(`0 -${offset}px ${blur}px ${spread}px ${gc}`);
          if (bsides.includes('bottom')) parts.push(`0 ${offset}px ${blur}px ${spread}px ${gc}`);
          if (bsides.includes('left')) parts.push(`-${offset}px 0 ${blur}px ${spread}px ${gc}`);
          if (bsides.includes('right')) parts.push(`${offset}px 0 ${blur}px ${spread}px ${gc}`);
        }
      }
      if (fx.shadow) {
        const s = fx.shadow;
        parts.push(`${s.x || 0}px ${s.y ?? 4}px ${s.blur ?? 12}px ${s.spread || 0}px ${ColorUtils.hexToRgba(s.follow_icon ? iconColor : (s.color || '#000000'), s.opacity ?? 0.35)}`);
      }
      el.style.boxShadow = parts.filter(p => p && p !== 'none').join(', ') || 'none';
      if (fx.border) {
        const bc = fx.border.follow_icon ? iconColor : fx.border.color;
        const on = s => (fx.border.sides || ['top','bottom','left','right']).includes(s);
        el.style.borderTop = on('top') ? `${fx.border.width}px solid ${bc}` : 'none';
        el.style.borderBottom = on('bottom') ? `${fx.border.width}px solid ${bc}` : 'none';
        el.style.borderLeft = on('left') ? `${fx.border.width}px solid ${bc}` : 'none';
        el.style.borderRight = on('right') ? `${fx.border.width}px solid ${bc}` : 'none';
        const cn = Array.isArray(fx.border.corners) && fx.border.corners.length === 4 ? fx.border.corners : [true,true,true,true];
        const r = fx.border.radius;
        el.style.borderRadius = `${cn[0]?r:0}px ${cn[1]?r:0}px ${cn[2]?r:0}px ${cn[3]?r:0}px`;
      } else { el.style.border = 'none'; el.style.borderRadius = '8px'; }
      if (fx.background) {
        const bm = fx.background.mode || 'custom';
        el.style.backgroundColor = bm === 'transparent' ? 'transparent'
          : bm === 'theme' ? 'var(--secondary-background-color, #1c1c1c)'
          : (fx.background.color || '#1a1a1a');
      } else { el.style.backgroundColor = '#1a1a1a'; }
      const edgeMatch = (fx.border && !fx.border.follow_icon && fx.border.color) ? fx.border.color : iconColor;
      const edge = fx.edges ? buildEdgeBackground(fx.edges, edgeMatch) : null;
      if (edge) { el.style.backgroundImage = edge.image; el.style.backgroundSize = edge.size; el.style.backgroundPosition = edge.position; el.style.backgroundRepeat = edge.repeat; }
      else { el.style.backgroundImage = ''; }
    });
  }

  _wireEvents() {
    // Accordion
    this.querySelectorAll('.cpce-sec-header').forEach(header => {
      header.onclick = () => {
        const sec = header.closest('.cpce-sec');
        const id = sec.dataset.secId;
        this._openSection = this._openSection === id ? null : id;
        this._render();
      };
    });
    // Collapsible subpanels (Card/Button Appearance groups) — toggle open state by key.
    this.querySelectorAll('.cpce-subpanel-head').forEach(head => {
      head.onclick = (ev) => {
        // Clicks on the group-include checkbox/label are handled separately — don't also toggle collapse.
        if (ev.target && ev.target.closest && ev.target.closest('.cpce-group-include')) return;
        // Inherited (unchecked) groups have no body to reveal — the header isn't a collapse toggle.
        if (head.classList.contains('cpce-subpanel-nochevron')) return;
        const key = head.dataset.subpanel;
        if (this._openSubpanels.has(key)) this._openSubpanels.delete(key); else this._openSubpanels.add(key);
        this._render();
      };
    });
    // Per-group "Override" include toggles on overlay-layer Style-Builder subpanels.
    this.querySelectorAll('.cpce-btn-group-toggle').forEach(cb => {
      cb.addEventListener('change', (ev) => { ev.stopPropagation(); this._toggleBuilderGroup(cb.dataset.group, cb.checked); });
      cb.addEventListener('click', (ev) => ev.stopPropagation());
    });

    // Entity picker
    const searchEl = this.querySelector('#cpce-search');
    if (searchEl) searchEl.addEventListener('input', () => { this._entitySearch = searchEl.value; this._updateEntityList(); });
    const filterType = this.querySelector('#cpce-filter-type');
    if (filterType) filterType.addEventListener('change', () => { this._entityFilter = { type: filterType.value, value: '' }; this._render(); });
    const filterLabel = this.querySelector('#cpce-filter-label');
    if (filterLabel) filterLabel.addEventListener('change', () => { this._entityFilter.value = filterLabel.value; this._updateEntityList(); });
    const filterGroup = this.querySelector('#cpce-filter-group');
    if (filterGroup) filterGroup.addEventListener('change', () => { this._entityFilter.value = filterGroup.value; this._updateEntityList(); });
    const filterText = this.querySelector('#cpce-filter-text');
    if (filterText) filterText.addEventListener('input', () => { this._entityFilter.value = filterText.value; this._updateEntityList(); });
    this._attachEntityAddListeners();
    this._attachSelectedRemoveListeners();
    // Collapsible "Added Entities" header.
    const addedToggle = this.querySelector('#cpce-added-toggle');
    if (addedToggle) addedToggle.onclick = () => { this._addedEntitiesCollapsed = !this._addedEntitiesCollapsed; this._render(); };
    // Scene Manager: search, add/remove, collapsible added list.
    const sceneSearch = this.querySelector('#cpce-scene-search');
    if (sceneSearch) sceneSearch.addEventListener('input', () => { this._sceneSearch = sceneSearch.value; this._updateSceneList(); });
    this._attachSceneListeners();
    const addedScenesToggle = this.querySelector('#cpce-added-scenes-toggle');
    if (addedScenesToggle) addedScenesToggle.onclick = () => { this._addedScenesCollapsed = !this._addedScenesCollapsed; this._render(); };

    // Config fields
    const bind = (id, key, transform) => {
      const el = this.querySelector(id); if (!el) return;
      const evt = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input');
      el.addEventListener(evt, () => { let value = el.type === 'checkbox' ? el.checked : el.value; if (transform) value = transform(value); this._updateConfig({ [key]: value }); });
    };
    // Button-appearance controls write to the LAYER edit buffer (not this._config), so editing a
    // style never mutates the live card. Same signature as bind(); routes through _builderPatch.
    const bindBtn = (id, key, transform) => {
      const el = this.querySelector(id); if (!el) return;
      const evt = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input');
      el.addEventListener(evt, () => { let value = el.type === 'checkbox' ? el.checked : el.value; if (transform) value = transform(value); this._builderPatch({ [key]: value }); });
    };
    // A button-appearance mode <select> whose change also re-renders (to reveal/hide a color picker).
    const bindBtnMode = (id, key) => {
      const el = this.querySelector(id); if (!el) return;
      el.addEventListener('change', () => { this._builderPatch({ [key]: el.value }); this._render(); });
    };
    bind('#cpce-title', 'title');
    // Show/hide title + icon (re-render to reveal/hide dependent styling controls).
    const showTitleEl = this.querySelector('#cpce-show-title');
    if (showTitleEl) showTitleEl.addEventListener('change', () => { this._updateConfig({ show_title: showTitleEl.checked }); this._render(); });
    const showTitleIconEl = this.querySelector('#cpce-show-title-icon');
    if (showTitleIconEl) showTitleIconEl.addEventListener('change', () => { this._updateConfig({ show_title_icon: showTitleIconEl.checked }); this._render(); });
    // Title text styling.
    this._wireTextStyleControls(this, 'cpce-title', (patch) => {
      const map = {};
      if ('size' in patch) map.title_font_size = patch.size;
      if ('weight' in patch) map.title_font_weight = patch.weight;
      if ('color' in patch) map.title_color = patch.color;
      this._updateConfig(map);
    }, '#ffffff');
    bind('#cpce-icon', 'icon', v => normalizeIcon(v));
    bind('#cpce-icon-size', 'icon_size', v => clamp(parseInt(v,10)||22, 12, 48));
    bind('#cpce-icon-color', 'icon_color');
    const iconColorEnabledEl = this.querySelector('#cpce-icon-color-enabled');
    if (iconColorEnabledEl) iconColorEnabledEl.addEventListener('change', () => { this._updateConfig({ icon_color_enabled: iconColorEnabledEl.checked }); this._render(); });
    const iconColorModeEl = this.querySelector('#cpce-icon-color-mode');
    if (iconColorModeEl) iconColorModeEl.addEventListener('change', () => { this._updateConfig({ icon_color_mode: iconColorModeEl.value }); this._render(); });
    const iconOffModeEl = this.querySelector('#cpce-icon-off-mode');
    if (iconOffModeEl) iconOffModeEl.addEventListener('change', () => { this._updateConfig({ icon_off_color_mode: iconOffModeEl.value }); this._render(); });
    bind('#cpce-icon-off-color', 'icon_off_color');
    bindBtn('#cpce-layout', 'layout');
    bindBtn('#cpce-columns', 'columns', v => clamp(parseInt(v,10)||3,1,6));
    bindBtn('#cpce-gap', 'gap', v => clamp(parseInt(v,10)||0,0,48));
    bindBtn('#cpce-button-icon-gap', 'button_icon_gap', v => clamp(parseInt(v,10)||0,0,24));
    bindBtn('#cpce-wrap', 'wrap');
    // Section ordering: move a section up/down in the order (by id) and re-render.
    const moveSection = (id, dir) => {
      // Reorder the actual sections array (in the SAME order the list shows — _orderedSections),
      // then persist both sections + section_order together so raw order, section_order, the live
      // card, and this list all stay in lockstep.
      const ordered = this._orderedSections();
      const i = ordered.findIndex(s => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ordered.length) return;
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      this._updateSections(ordered);
      this._render();
    };
    this.querySelectorAll('.cpce-order-up').forEach(btn => { btn.onclick = () => moveSection(btn.dataset.key, -1); });
    this.querySelectorAll('.cpce-order-down').forEach(btn => { btn.onclick = () => moveSection(btn.dataset.key, 1); });
    // Inline rename per section.
    this.querySelectorAll('.cpce-order-rename').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = inp.closest('.cpce-order-item').dataset.sectionId;
        const sections = this._orderedSectionsRaw().map(s => s.id === id ? { ...s, name: inp.value || s.type } : s);
        this._updateSections(sections);
      });
    });
    // Duplicate a section (any type). Deep-copies it with a new id, inserts it right after the
    // original, and — for buttons sections — clones the preset buttons assigned to it too.
    this.querySelectorAll('.cpce-order-duplicate').forEach(btn => btn.onclick = () => this._duplicateSection(btn.dataset.key));
    // Per-section name heading + text style panel.
    const patchSection = (id, patch) => this._updateSections(this._orderedSectionsRaw().map(s => s.id === id ? { ...s, ...patch } : s));
    this.querySelectorAll('.cpce-order-style').forEach(btn => {
      btn.onclick = () => { this._openSectionStyle = this._openSectionStyle === btn.dataset.key ? null : btn.dataset.key; this._render(); };
    });
    this.querySelectorAll('.cpce-order-style-panel').forEach(panel => {
      const id = panel.dataset.sectionId;
      const showCb = panel.querySelector('.cpce-sn-show');
      if (showCb) showCb.addEventListener('change', () => { patchSection(id, { name_show: showCb.checked }); this._render(); });
      // Per-section collapse toggles.
      const collCb = panel.querySelector('.cpce-sn-collapsible');
      if (collCb) collCb.addEventListener('change', () => { patchSection(id, { collapsible: collCb.checked }); this._render(); });
      const collDefCb = panel.querySelector('.cpce-sn-collapsed-default');
      if (collDefCb) collDefCb.addEventListener('change', () => { patchSection(id, { collapsed_default: collDefCb.checked }); this._render(); });
      // Per-section Button Style preset: '' = Card Default (clear ref), else lib:<slug>.
      const stylePresetSel = panel.querySelector('.cpce-sn-style-preset');
      if (stylePresetSel) stylePresetSel.addEventListener('change', () => { patchSection(id, { style_preset: stylePresetSel.value || undefined }); this._render(); });
      // Section default scene reset: group + option.
      const defGroupSel = panel.querySelector('.cpce-sn-default-group');
      if (defGroupSel) defGroupSel.addEventListener('change', () => {
        const g = defGroupSel.value || undefined;
        // Default the option to '-none-' if that group has it, else its first option.
        let opt;
        if (g) {
          const grp = this._allInputSelectEntities().find(x => x.entity === g);
          const o = (grp && grp.options) || [];
          opt = o.includes('-none-') ? '-none-' : (o[0] || '-none-');
        }
        patchSection(id, { default_scene_group: g, default_scene_option: g ? opt : undefined });
        this._render();
      });
      const defOptSel = panel.querySelector('.cpce-sn-default-option');
      if (defOptSel) defOptSel.addEventListener('change', () => { patchSection(id, { default_scene_option: defOptSel.value || undefined }); this._render(); });

      // Scene Tracker Areas: add / edit / remove. Each Area = { name, entity, light? }. Blank-entity
      // rows are kept while editing (render tolerates them); the card render ignores Areas with no entity.
      const areasMutate = (fn) => {
        const cur = this._orderedSectionsRaw().find(x => x.id === id) || {};
        const arr = Array.isArray(cur.areas) ? cur.areas.map(a => ({ ...a })) : [];
        fn(arr);
        patchSection(id, { areas: arr });
        this._render();
      };
      // Scene Tracker: bind (or clear) a Button Style for the tiles.
      const trackerStyle = panel.querySelector('.cpce-tracker-style');
      if (trackerStyle) trackerStyle.addEventListener('change', () => { patchSection(id, { style_preset: trackerStyle.value || undefined }); this._render(); });
      const areaAdd = panel.querySelector('.cpce-area-add');
      if (areaAdd) areaAdd.onclick = () => areasMutate(arr => arr.push({ name: '', entity: '' }));
      panel.querySelectorAll('.cpce-area-name').forEach(el => el.addEventListener('change', () => { const i = Number(el.dataset.area); areasMutate(arr => { if (arr[i]) arr[i].name = el.value; }); }));
      panel.querySelectorAll('.cpce-area-entity').forEach(el => el.addEventListener('change', () => { const i = Number(el.dataset.area); areasMutate(arr => { if (arr[i]) arr[i].entity = el.value; }); }));
      panel.querySelectorAll('.cpce-area-light').forEach(el => el.addEventListener('change', () => { const i = Number(el.dataset.area); areasMutate(arr => { if (arr[i]) { if (el.value) arr[i].light = el.value; else delete arr[i].light; } }); }));
      panel.querySelectorAll('.cpce-area-remove').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.area); areasMutate(arr => arr.splice(i, 1)); });
      // Per-section Frame Style stack (layered, like the Card Frame) — supports
      // a base style plus conditional overlays. Mutates section.frame.presets.
      const sfMutate = (fn) => {
        const cur = this._orderedSectionsRaw().find(x => x.id === id) || {};
        const fr = JSON.parse(JSON.stringify(cur.frame || { presets: [] }));
        fr.presets = Array.isArray(fr.presets) ? fr.presets : [];
        fn(fr);
        patchSection(id, { frame: fr.presets.length ? fr : undefined });
        this._render();
      };
      const sfAdd = panel.querySelector('.cpce-sf-add');
      if (sfAdd) sfAdd.onclick = () => {
        const pick = panel.querySelector('.cpce-sf-add-pick'); const fid = pick && pick.value; if (!fid) return;
        sfMutate(fr => { fr.presets.push(fid); });
      };
      panel.querySelectorAll('.cpce-sf-remove').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.idx); sfMutate(fr => fr.presets.splice(i, 1)); });
      panel.querySelectorAll('.cpce-sf-up').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.idx); if (i > 0) sfMutate(fr => { const [x] = fr.presets.splice(i, 1); fr.presets.splice(i - 1, 0, x); }); });
      panel.querySelectorAll('.cpce-sf-down').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.idx); sfMutate(fr => { if (i < fr.presets.length - 1) { const [x] = fr.presets.splice(i, 1); fr.presets.splice(i + 1, 0, x); } }); });
      panel.querySelectorAll('.cpce-sf-ignore').forEach(cb => cb.addEventListener('change', () => {
        const fid = cb.dataset.fid;
        sfMutate(fr => {
          const set = new Set(Array.isArray(fr.ignore_conditions) ? fr.ignore_conditions : []);
          if (cb.checked) set.add(fid); else set.delete(fid);
          const list = fr.presets.filter(pid => set.has(pid));
          if (list.length) fr.ignore_conditions = list; else delete fr.ignore_conditions;
        });
      }));
      panel.querySelectorAll('.cpce-sf-hide').forEach(btn => btn.onclick = () => {
        const fid = btn.dataset.fid;
        sfMutate(fr => {
          const set = new Set(Array.isArray(fr.disabled) ? fr.disabled : []);
          if (set.has(fid)) set.delete(fid); else set.add(fid);
          const list = fr.presets.filter(pid => set.has(pid));
          if (list.length) fr.disabled = list; else delete fr.disabled;
        });
      });
      // Per-location condition override (entity / op / value) on a section frame.
      // Mutate section.frame.overrides[fid] WITHOUT a full re-render on text edits
      // (keeps focus); op change + clear re-render so the reset button updates.
      const sfSetOverride = (fid, field, value, rerender) => {
        const cur = this._orderedSectionsRaw().find(x => x.id === id) || {};
        const fr = JSON.parse(JSON.stringify(cur.frame || { presets: [] }));
        fr.presets = Array.isArray(fr.presets) ? fr.presets : [];
        fr.overrides = (fr.overrides && typeof fr.overrides === 'object') ? fr.overrides : {};
        const o = fr.overrides[fid] || {};
        if (field === 'entity') { if (value) o.when_entity = value; else delete o.when_entity; }
        else { const w = (o.when && typeof o.when === 'object') ? o.when : {};
          if (field === 'op') { if (value) w.op = value; else delete w.op; }
          if (field === 'value') { if (value !== '') w.value = value; else delete w.value; }
          if (w.op) o.when = w; else delete o.when; }
        if (Object.keys(o).length) fr.overrides[fid] = o; else delete fr.overrides[fid];
        Object.keys(fr.overrides).forEach(k => { if (!fr.presets.includes(k)) delete fr.overrides[k]; });
        if (!Object.keys(fr.overrides).length) delete fr.overrides;
        patchSection(id, { frame: fr.presets.length ? fr : undefined });   // config-only, no re-render (keeps focus)
        if (rerender) this._render();
      };
      panel.querySelectorAll('.cpce-fr-ov-entity').forEach(el => {
        el.addEventListener('input', () => sfSetOverride(el.dataset.fid, 'entity', el.value.trim(), false));
        el.addEventListener('change', () => sfSetOverride(el.dataset.fid, 'entity', el.value.trim(), true));
      });
      panel.querySelectorAll('.cpce-fr-ov-op').forEach(el => el.addEventListener('change', () => sfSetOverride(el.dataset.fid, 'op', el.value, true)));
      panel.querySelectorAll('.cpce-fr-ov-value').forEach(el => {
        el.addEventListener('input', () => sfSetOverride(el.dataset.fid, 'value', el.value, false));
        el.addEventListener('change', () => sfSetOverride(el.dataset.fid, 'value', el.value, true));
      });
      panel.querySelectorAll('.cpce-fr-ov-clear').forEach(el => el.onclick = () => sfMutate(fr => { if (fr.overrides) { delete fr.overrides[el.dataset.fid]; if (!Object.keys(fr.overrides).length) delete fr.overrides; } }));
      this._wireTextStyleControls(panel, `cpce-sn-${id}`, (p) => {
        const map = {};
        if ('size' in p) map.name_font_size = p.size;
        if ('weight' in p) map.name_font_weight = p.weight;
        if ('color' in p) map.name_color = p.color;
        patchSection(id, map);
      }, '#ffffff');
      // Values-section "Monitored Lights" target picker (two-checkbox any-light model).
      this._wireTargetPicker(panel,
        () => this._orderedSectionsRaw().find(s => s.id === id) || {},
        (patch) => { patchSection(id, patch); this._render(); });
      // Divider appearance config. Style/justify/gradient toggle visible fields or the preview,
      // so those re-render; color/thickness/length update live (preview refreshes on re-render).
      const divStyle = panel.querySelector('.cpce-div-style');
      if (divStyle) divStyle.addEventListener('change', () => { patchSection(id, { line_style: divStyle.value }); this._render(); });
      const divJustify = panel.querySelector('.cpce-div-justify');
      if (divJustify) divJustify.addEventListener('change', () => { patchSection(id, { justify: divJustify.value }); this._render(); });
      const divGrad = panel.querySelector('.cpce-div-gradient');
      if (divGrad) divGrad.addEventListener('change', () => {
        const cur = this._orderedSectionsRaw().find(s => s.id === id) || {};
        // Turning gradient on seeds two default stops (0% + 100%) so the preview is meaningful.
        const seedStops = (Array.isArray(cur.stops) && cur.stops.length >= 2) ? cur.stops
          : [{ pos: 0, color: cur.color && /^#/.test(cur.color) ? cur.color : '#444444' }, { pos: 100, color: '#2196F3' }];
        patchSection(id, divGrad.checked ? { gradient: true, stops: seedStops } : { gradient: false });
        this._render();
      });
      // Gradient stops. Live edits (position drag, color pick) update the config AND repaint the
      // small preview in place — WITHOUT a full editor re-render, so the color picker stays open
      // and focus isn't lost. Only structural changes (add/remove/pattern/transparent) re-render.
      const getStops = () => { const s = this._orderedSectionsRaw().find(x => x.id === id); return Array.isArray(s && s.stops) ? s.stops.map(st => ({ ...st })) : []; };
      const refreshDivPreview = () => {
        const sec = this._orderedSectionsRaw().find(x => x.id === id);
        const prev = panel.querySelector(`.cpce-div-preview[data-id="${id}"]`) || this.querySelector(`.cpce-div-preview[data-id="${id}"]`);
        if (sec && prev) prev.innerHTML = this._dividerLineHtml(sec);
      };
      // Manually editing any stop makes the pattern "Custom" (clears the saved pattern index).
      panel.querySelectorAll('.cpce-div-stop-pos').forEach(sl => {
        const readout = sl.parentElement && sl.parentElement.querySelector('.cpce-div-stop-pos-val');
        const commit = () => { const stops = getStops(); const i = Number(sl.dataset.idx); if (stops[i]) { stops[i].pos = clamp(parseInt(sl.value,10)||0,0,100); patchSection(id, { stops, gradient_pattern: undefined }); refreshDivPreview(); } };
        sl.addEventListener('input', () => { if (readout) readout.textContent = `${sl.value}%`; commit(); });
        sl.addEventListener('change', commit);
      });
      panel.querySelectorAll('.cpce-div-stop-color').forEach(col => col.addEventListener('input', () => {
        const stops = getStops(); const i = Number(col.dataset.idx); if (stops[i]) { stops[i].color = col.value; patchSection(id, { stops, gradient_pattern: undefined }); refreshDivPreview(); }
      }));
      // Stop color source: Color (keep/restore a hex) | Theme (theme divider color) | Transparent.
      panel.querySelectorAll('.cpce-div-stop-mode').forEach(sel => sel.addEventListener('change', () => {
        const stops = getStops(); const i = Number(sel.dataset.idx); if (!stops[i]) return;
        stops[i].color = sel.value === 'transparent' ? 'transparent' : sel.value === 'theme' ? 'theme'
          : (/^#[0-9a-f]{6}$/i.test(stops[i].color || '') ? stops[i].color : '#2196F3');
        patchSection(id, { stops, gradient_pattern: undefined }); this._render();   // structural: toggles the color picker's visibility
      }));
      panel.querySelectorAll('.cpce-div-stop-remove').forEach(btn => btn.onclick = () => {
        const stops = getStops(); stops.splice(Number(btn.dataset.idx), 1); patchSection(id, { stops, gradient_pattern: undefined }); this._render();
      });
      const divStopAdd = panel.querySelector('.cpce-div-stop-add');
      if (divStopAdd) divStopAdd.onclick = () => { const stops = getStops(); stops.push({ pos: 100, color: '#ffffff' }); patchSection(id, { stops, gradient_pattern: undefined }); this._render(); };
      // Preset pattern: fill in null placeholders with the current base color, then apply. Persist
      // the chosen index so the dropdown stays on it (was reverting to "Custom" on re-render).
      const divPattern = panel.querySelector('.cpce-div-pattern');
      if (divPattern) divPattern.addEventListener('change', () => {
        const pi = divPattern.value;
        if (pi === '') { patchSection(id, { gradient_pattern: undefined }); return; }
        const pat = DIVIDER_GRADIENT_PATTERNS[Number(pi)]; if (!pat) return;
        const cur = this._orderedSectionsRaw().find(x => x.id === id) || {};
        const base = (cur.color && /^#/.test(cur.color)) ? cur.color : '#2196F3';
        const stops = pat.stops.map(st => ({ pos: st.pos, color: st.color === null ? base : st.color }));
        patchSection(id, { gradient: true, stops, gradient_pattern: Number(pi) }); this._render();
      });
      const divMode = panel.querySelector('.cpce-div-color-mode');
      if (divMode) divMode.addEventListener('change', () => { patchSection(id, { color: divMode.value === 'fixed' ? (this._orderedSectionsRaw().find(s => s.id === id) || {}).color || '#444444' : '' }); this._render(); });
      const divColor = panel.querySelector('.cpce-div-color');
      if (divColor) divColor.addEventListener('input', () => { patchSection(id, { color: divColor.value }); this._render(); });
      const divThick = panel.querySelector('.cpce-div-thickness');
      if (divThick) { divThick.addEventListener('input', () => { const v = divThick.nextElementSibling; if (v) v.textContent = `${divThick.value}px`; }); divThick.addEventListener('change', () => { patchSection(id, { thickness: clamp(parseInt(divThick.value,10)||1,1,20) }); this._render(); }); }
      const divLen = panel.querySelector('.cpce-div-length');
      if (divLen) { divLen.addEventListener('input', () => { const v = divLen.nextElementSibling; if (v) v.textContent = `${divLen.value}%`; }); divLen.addEventListener('change', () => { patchSection(id, { length: clamp(parseInt(divLen.value,10)||100,5,100) }); this._render(); }); }
      // Divider Text & Icon. Label/icon presence toggles the dependent controls → re-render;
      // size/weight/color update live + repaint the preview in place.
      const divLabel = panel.querySelector('.cpce-div-label');
      if (divLabel) divLabel.addEventListener('change', () => { const had = !!(this._orderedSectionsRaw().find(s => s.id === id) || {}).label; patchSection(id, { label: divLabel.value }); if (!!divLabel.value.trim() !== had) this._render(); else refreshDivPreview(); });
      const divIcon = panel.querySelector('.cpce-div-icon');
      if (divIcon) divIcon.addEventListener('change', () => { patchSection(id, { icon: divIcon.value.trim() ? normalizeIcon(divIcon.value.trim()) : '' }); this._render(); });
      const divTextSize = panel.querySelector('.cpce-div-text-size');
      if (divTextSize) { divTextSize.addEventListener('input', () => { const v = divTextSize.nextElementSibling; if (v) v.textContent = `${divTextSize.value}px`; }); divTextSize.addEventListener('change', () => { patchSection(id, { text_size: clamp(parseInt(divTextSize.value,10)||13,8,32) }); refreshDivPreview(); }); }
      const divTextWeight = panel.querySelector('.cpce-div-text-weight');
      if (divTextWeight) divTextWeight.addEventListener('change', () => { patchSection(id, { text_weight: divTextWeight.value }); refreshDivPreview(); });
      // Text color mode: line | theme | fixed. Store the mode; keep a hex only for 'fixed'.
      const divTextColorMode = panel.querySelector('.cpce-div-text-color-mode');
      if (divTextColorMode) divTextColorMode.addEventListener('change', () => { const v = divTextColorMode.value; patchSection(id, { text_color_mode: v, text_color: v === 'fixed' ? ((this._orderedSectionsRaw().find(s => s.id === id) || {}).text_color || '#ffffff') : '' }); this._render(); });
      const divTextColor = panel.querySelector('.cpce-div-text-color');
      if (divTextColor) divTextColor.addEventListener('input', () => { patchSection(id, { text_color_mode: 'fixed', text_color: divTextColor.value }); refreshDivPreview(); });
      const divIconSize = panel.querySelector('.cpce-div-icon-size');
      if (divIconSize) { divIconSize.addEventListener('input', () => { const v = divIconSize.nextElementSibling; if (v) v.textContent = `${divIconSize.value}px`; }); divIconSize.addEventListener('change', () => { patchSection(id, { icon_size: clamp(parseInt(divIconSize.value,10)||16,10,48) }); refreshDivPreview(); }); }
      // Icon color mode: text | theme | fixed.
      const divIconColorMode = panel.querySelector('.cpce-div-icon-color-mode');
      if (divIconColorMode) divIconColorMode.addEventListener('change', () => { const v = divIconColorMode.value; patchSection(id, { icon_color_mode: v, icon_color: v === 'fixed' ? ((this._orderedSectionsRaw().find(s => s.id === id) || {}).icon_color || '#ffffff') : '' }); this._render(); });
      const divIconColor = panel.querySelector('.cpce-div-icon-color');
      if (divIconColor) divIconColor.addEventListener('input', () => { patchSection(id, { icon_color_mode: 'fixed', icon_color: divIconColor.value }); refreshDivPreview(); });
      // Show toggles (inverse of the stored hide_* flags). Line toggle re-renders (it shows/hides
      // the Text "Position vs Line" + mirror controls); text/icon just repaint the preview.
      const divShowLine = panel.querySelector('.cpce-div-show-line');
      if (divShowLine) divShowLine.addEventListener('change', () => { patchSection(id, { hide_line: !divShowLine.checked }); this._render(); });
      const divShowText = panel.querySelector('.cpce-div-show-text');
      if (divShowText) divShowText.addEventListener('change', () => { patchSection(id, { hide_text: !divShowText.checked }); refreshDivPreview(); });
      const divShowIcon = panel.querySelector('.cpce-div-show-icon');
      if (divShowIcon) divShowIcon.addEventListener('change', () => { patchSection(id, { hide_icon: !divShowIcon.checked }); refreshDivPreview(); });
      const divTextPos = panel.querySelector('.cpce-div-text-position');
      if (divTextPos) divTextPos.addEventListener('change', () => { patchSection(id, { text_position: divTextPos.value }); this._render(); });   // re-render: toggles the mirror option's visibility
      const divContentJustify = panel.querySelector('.cpce-div-content-justify');
      if (divContentJustify) divContentJustify.addEventListener('change', () => { patchSection(id, { content_justify: divContentJustify.value }); this._render(); });   // re-render: toggles the mirror option's visibility
      const divMirror = panel.querySelector('.cpce-div-mirror-center');
      if (divMirror) divMirror.addEventListener('change', () => { patchSection(id, { mirror_center: divMirror.checked }); refreshDivPreview(); });
      const divIndent = panel.querySelector('.cpce-div-indent');
      if (divIndent) { divIndent.addEventListener('input', () => { const v = divIndent.nextElementSibling; if (v) v.textContent = `${divIndent.value}px`; }); divIndent.addEventListener('change', () => { patchSection(id, { indent: clamp(parseInt(divIndent.value,10)||0,0,200) }); refreshDivPreview(); }); }
    });
    // Hide/show a section on the card (kept in the order list either way).
    this.querySelectorAll('.cpce-order-hide').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.key;
      const s = this._orderedSectionsRaw().find(x => x.id === id);
      patchSection(id, { hidden: !(s && s.hidden) });
      this._render();
    });
    // Remove a section. Guard: keep at least one buttons section (presets need a home).
    this.querySelectorAll('.cpce-order-remove').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.key;
        const all = this._orderedSectionsRaw();
        const target = all.find(s => s.id === id);
        if (target && target.type === 'buttons' && all.filter(s => s.type === 'buttons').length <= 1) {
          window.alert('Keep at least one Buttons section — presets need somewhere to display.');
          return;
        }
        if (!this._confirmDelete(`Remove the “${(target && target.name) || 'section'}” section? This cannot be undone.`)) return;
        this._updateSections(all.filter(s => s.id !== id));
        this._render();
      };
    });
    const addButtonsSection = this.querySelector('#cpce-add-buttons-section');
    if (addButtonsSection) addButtonsSection.onclick = () => {
      const sections = this._orderedSectionsRaw();
      sections.push({ id: newSectionId('buttons'), type: 'buttons', name: 'Buttons' });
      this._updateSections(sections); this._render();
    };
    const addValuesSection = this.querySelector('#cpce-add-values-section');
    if (addValuesSection) addValuesSection.onclick = () => {
      const sections = this._orderedSectionsRaw();
      sections.push({ id: newSectionId('values'), type: 'values', name: 'Color Values', target_entities: [] });
      this._updateSections(sections); this._render();
    };
    const addDividerSection = this.querySelector('#cpce-add-divider-section');
    if (addDividerSection) addDividerSection.onclick = () => {
      const sections = this._orderedSectionsRaw();
      sections.push({ id: newSectionId('divider'), type: 'divider' });
      this._updateSections(sections); this._render();
    };
    const addTrackerSection = this.querySelector('#cpce-add-tracker-section');
    if (addTrackerSection) addTrackerSection.onclick = () => {
      const sections = this._orderedSectionsRaw();
      sections.push({ id: newSectionId('tracker'), type: 'scene_tracker', name: 'Scene Tracker', areas: [] });
      this._updateSections(sections); this._render();
    };
    // Export a section (+ its buttons) as portable JSON — copied to the clipboard. Buttons are bundled
    // because they have no shared library (they live inline in cfg.presets), so the payload carries
    // them. Clipboard, not window.prompt: prompt truncates large payloads (the "..." import bug).
    this.querySelectorAll('.cpce-order-export').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.key;
      const section = this._orderedSectionsRaw().find(s => s.id === id);
      if (!section) return;
      const presets = this._presetsBelongingTo(id);   // [] for non-buttons sections
      const json = serializeSection(section, presets, this._nowIso());
      this._exportJson(json, `Section JSON (${presets.length} button${presets.length === 1 ? '' : 's'} bundled). Import it into another card via “Import Section…”.`);
    });
    const importSection = this.querySelector('#cpce-import-section');
    if (importSection) importSection.onclick = () => this._importJson('Paste exported Section JSON:', (txt) => {
      const res = parseSectionBlob(txt);
      if (!res.ok) { window.alert(`Could not import: ${res.error}`); return; }
      this._importSection(res.section, res.presets);
    });
    bind('#cpce-card-show-chevron', 'card_show_chevron');
    // Toggling collapsible shows/hides its sub-options, so it needs a full re-render.
    const collapsibleEl = this.querySelector('#cpce-card-collapsible');
    if (collapsibleEl) collapsibleEl.addEventListener('change', () => { this._updateConfig({ card_collapsible: collapsibleEl.checked }); this._render(); });
    this.querySelectorAll('input[name="cpce-temp-output-format"]').forEach(radio => {
      radio.addEventListener('change', () => { if (radio.checked) this._updateConfig({ temperature_output_format: radio.value }); });
    });
    bind('#cpce-temp-show-mired', 'temperature_show_mired');
    // Card default effect timing — re-render so per-light "Card default (…)" labels update.
    const effSepEl = this.querySelector('#cpce-effect-separate');
    if (effSepEl) effSepEl.addEventListener('change', () => { this._updateConfig({ effect_separate_call: effSepEl.checked }); this._render(); });
    // Per-light send-method overrides. Empty value clears the field (inherit card default);
    // when a row has no overrides left, its entry is removed from entity_send_methods.
    const patchEntitySend = (id, patch) => {
      const map = { ...(this._config.entity_send_methods || {}) };
      const cur = { ...(map[id] || {}) };
      Object.keys(patch).forEach(k => { if (patch[k] === undefined) delete cur[k]; else cur[k] = patch[k]; });
      if (Object.keys(cur).length) map[id] = cur; else delete map[id];
      this._updateConfig({ entity_send_methods: map });
    };
    this.querySelectorAll('.cpce-esm-temp').forEach(sel => sel.addEventListener('change', () =>
      patchEntitySend(sel.dataset.entity, { temperature_output_format: sel.value || undefined })));
    this.querySelectorAll('.cpce-esm-effect').forEach(sel => sel.addEventListener('change', () =>
      patchEntitySend(sel.dataset.entity, { effect_separate_call: sel.value === '' ? undefined : (sel.value === 'separate') })));
    this._wireSliderSections();
    bind('#cpce-cv-justify', 'current_values_justify');
    bind('#cpce-min-kelvin', 'min_kelvin', v => parseInt(v,10)||2000);
    bind('#cpce-max-kelvin', 'max_kelvin', v => parseInt(v,10)||6500);
    bind('#cpce-show-favorites', 'show_favorites');
    bind('#cpce-brightness-start-color', 'brightness_start_color');
    bind('#cpce-brightness-end-color', 'brightness_end_color');
    bind('#cpce-brightness-strength', 'brightness_gradient_strength', v => clamp(parseInt(v,10)||50, 10, 90));
    const orientationEl = this.querySelector('#cpce-slider-orientation');
    if (orientationEl) orientationEl.addEventListener('change', () => { this._updateConfig({ slider_orientation: orientationEl.value }); this._render(); });
    bind('#cpce-handle-color', 'slider_handle_color');
    bind('#cpce-handle-opacity', 'slider_handle_opacity', v => clamp(parseInt(v,10)||100, 10, 100));
    bind('#cpce-handle-shape', 'slider_handle_shape');
    // (Native card border/glow/shadow handlers removed — card frame styling is
    // defined by Frame Styles → Card Frame now. See the Frame Styles panel.)
    bind('#cpce-slider-border-radius', 'slider_border_radius', v => clamp(parseInt(v,10)||10, 0, 40));
    bind('#cpce-vertical-slider-alignment', 'vertical_slider_alignment');
    bind('#cpce-scale', 'scale', v => clamp(parseFloat(v)||1.0, 0.6, 1.8));
    bindBtn('#cpce-button-style', 'button_style');
    bindBtn('#cpce-button-font-size', 'button_font_size', v => clamp(parseInt(v,10)||14, 8, 32));
    bindBtn('#cpce-button-name-weight', 'button_name_weight');
    bindBtn('#cpce-button-name-color', 'button_name_color');
    // Mode change re-renders to reveal/hide the Fixed Name Color picker (only shown for 'fixed').
    bindBtnMode('#cpce-button-name-color-mode', 'button_name_color_mode');
    bindBtn('#cpce-button-name-wrap', 'button_name_wrap');
    bindBtn('#cpce-button-max-width', 'button_max_width', v => clamp(parseInt(v,10)||0, 0, 300));
    bindBtn('#cpce-button-height', 'button_height', v => clamp(parseInt(v,10)||44, 24, 100));
    bind('#cpce-slider-width-horizontal', 'slider_width_horizontal', v => clamp(parseInt(v,10)||44, 24, 100));
    bind('#cpce-slider-length-horizontal', 'slider_length_horizontal', v => clamp(parseInt(v,10)||100, 20, 100));
    bind('#cpce-slider-width-vertical', 'slider_width_vertical', v => clamp(parseInt(v,10)||44, 24, 100));
    bind('#cpce-slider-length-vertical', 'slider_length_vertical', v => clamp(parseInt(v,10)||180, 60, 400));
    bind('#cpce-slider-text-placement-horizontal', 'slider_text_placement_horizontal');
    bind('#cpce-slider-text-placement-vertical', 'slider_text_placement_vertical');
    bind('#cpce-slider-font-size', 'slider_font_size', v => clamp(parseInt(v,10)||13, 8, 28));
    const sliderTextColorModeEl = this.querySelector('#cpce-slider-text-color-mode');
    if (sliderTextColorModeEl) sliderTextColorModeEl.addEventListener('change', () => {
      this._updateConfig({ slider_text_color: sliderTextColorModeEl.value === 'fixed' ? (this._config.slider_text_color || '#ffffff') : '' });
      this._render();
    });
    bind('#cpce-slider-text-color', 'slider_text_color');
    bind('#cpce-slider-debounce', 'slider_debounce_ms', v => clamp(parseInt(v,10)||100, 0, 1000));
    bind('#cpce-brightness-show-label', 'brightness_show_label');
    bind('#cpce-brightness-show-value', 'brightness_show_value');
    bind('#cpce-temperature-show-label', 'temperature_show_label');
    bind('#cpce-temperature-show-value', 'temperature_show_value');
    bind('#cpce-rgb-show-label', 'rgb_show_label');
    bind('#cpce-rgb-show-value', 'rgb_show_value');
    bindBtn('#cpce-button-border-color', 'button_border_color');
    bindBtn('#cpce-button-border-width', 'button_border_width', v => clamp(parseInt(v,10)||1, 1, 10));
    // Per-side border toggles → maintain the button_border_sides array on the layer edit buffer.
    this.querySelectorAll('.cpce-button-border-side').forEach(el => el.addEventListener('change', () => {
      const set = new Set(buttonBorderSides(this._builderCfg()));
      if (el.checked) set.add(el.dataset.side); else set.delete(el.dataset.side);
      const sides = BUTTON_BORDER_SIDES.filter(s => set.has(s));
      // All four selected → store the explicit array (a layer delta needs the concrete value; unlike
      // the card config we can't rely on "absent = all", since the base beneath may differ).
      this._builderPatch({ button_border_sides: sides });
    }));
    bindBtn('#cpce-button-border-radius', 'button_border_radius', v => clamp(parseInt(v,10)||10, 0, 40));
    // Button gradient border editor (universal — applies to every button). Reads/writes the layer
    // edit buffer via _builderCfg/_builderPatch so it never mutates the live card.
    this._wireGradientBorderEditor(this, 'btngb',
      () => this._builderCfg().button_border_gradient || {},
      (patch) => { const g = { ...(this._builderCfg().button_border_gradient || {}), ...patch }; this._builderPatch({ button_border_gradient: g }); },
      () => this._builderCfg().button_border_color || '#2196F3');

    // Button Appearance Presets: new/apply/rename/delete + export/import.
    const bsNew = this.querySelector('#cpce-btnstyle-new');
    if (bsNew) bsNew.onclick = () => this._newButtonStyle();
    // Duplicate any preset (incl. the synthetic Built-In) into a new editable "… (copy)" entry.
    this.querySelectorAll('.cpce-btnstyle-duplicate').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.slug; const e = buttonStyleStack(slug); if (!e) return;
      const baseName = `${e.name || slug} (copy)`;
      let newSlug = fixtureLibSlug(baseName); let n = 2;
      const map = { ...buttonStyleLibraryMap() };
      while (map[newSlug]) { newSlug = fixtureLibSlug(`${baseName} ${n++}`); }
      map[newSlug] = { name: baseName, kind: e.kind === 'frame' ? 'frame' : 'button', layers: JSON.parse(JSON.stringify(e.layers || [{ groups: {} }])) };
      saveButtonStyleLibrary(this._hass, map).then(() => this._render()).catch(err => { console.error(`${LOG_PREFIX} duplicate button style failed`, err); window.alert(`Could not duplicate: ${formatWsError(err)}`); });
    });
    // Live preview: any Builder control input/change repaints the sample in place (no full re-render).
    const bsSec = this.querySelector('[data-sec-id="button-appearance"] .cpce-sec-body');
    if (bsSec) ['input', 'change'].forEach(evt => bsSec.addEventListener(evt, (ev) => {
      const t = ev.target;
      if (t && t.closest && t.closest('.cpce-btnstyle-layers-panel')) return;   // layer-editor fields aren't Builder controls
      this._refreshButtonStylePreview();
    }));
    // Rename lives inside a preset's layer editor now (the row name is a fixed label).
    this.querySelectorAll('.cpce-btnstyle-rename').forEach(inp => inp.addEventListener('change', () => {
      const map = { ...buttonStyleLibraryMap() }; const e = map[inp.dataset.slug]; if (!e) return;
      if (!window.confirm(`Rename the shared preset to "${inp.value || inp.dataset.slug}"? This name change applies system-wide.`)) { this._render(); return; }
      map[inp.dataset.slug] = { ...e, name: inp.value || inp.dataset.slug };
      saveButtonStyleLibrary(this._hass, map).catch(err => console.warn(`${LOG_PREFIX} rename button style failed`, err));
    }));
    // Optional note on a button style (saved system-wide; no confirm needed).
    this.querySelectorAll('.cpce-btnstyle-note').forEach(inp => inp.addEventListener('change', () => {
      const map = { ...buttonStyleLibraryMap() }; const e = map[inp.dataset.slug]; if (!e) return;
      const note = inp.value.trim();
      map[inp.dataset.slug] = note ? { ...e, note } : (() => { const c = { ...e }; delete c.note; return c; })();
      saveButtonStyleLibrary(this._hass, map).catch(err => console.warn(`${LOG_PREFIX} button style note save failed`, err));
    }));
    this.querySelectorAll('.cpce-btnstyle-delete').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.slug; const e = buttonStyleLibraryMap()[slug];
      const usedBy = this._orderedSectionsRaw().filter(s => s && s.type === 'buttons' && (fixtureRefSlug(s.style_preset) || BTN_STYLE_BASIC_SLUG) === slug).length;
      const usedMsg = usedBy ? ` ${usedBy} section${usedBy === 1 ? '' : 's'} using it will fall back to Basic Theme.` : '';
      if (!this._confirmDelete(`Delete the shared style "${(e && e.name) || slug}"?${usedMsg} This applies to every card that uses it.`)) return;
      const map = { ...buttonStyleLibraryMap() }; delete map[slug];
      saveButtonStyleLibrary(this._hass, map).then(() => this._render()).catch(err => { console.warn(`${LOG_PREFIX} delete button style failed`, err); window.alert(`Could not delete: ${formatWsError(err)}`); });
    });
    // Export a stack's flattened look as JSON (copied to clipboard). "Export look".
    this.querySelectorAll('.cpce-btnstyle-export').forEach(btn => btn.onclick = () => {
      const e = buttonStyleStack(btn.dataset.slug); if (!e) return;
      this._exportJson(JSON.stringify(flattenButtonStack(e, () => true)), 'Button Appearance JSON — paste into another card via Import.');
    });
    const bsExportCur = this.querySelector('#cpce-btnstyle-export-current');
    if (bsExportCur) bsExportCur.onclick = () => this._exportJson(JSON.stringify(extractButtonAppearance(this._config)), 'Layer Appearance JSON.');
    const bsImport = this.querySelector('#cpce-btnstyle-import');
    if (bsImport) bsImport.onclick = () => this._importJson('Paste Button Appearance JSON to create a NEW shared preset:', (txt) => {
      let parsed; try { parsed = JSON.parse(txt); } catch (e) { window.alert('That isn\'t valid JSON.'); return; }
      this._importButtonStyleAsPreset(parsed);
    });

    // ---- Frame Styles library (shared ltek_frame_library) ----
    const frameScope = () => (this._config && this._config.frame_library_scope) || 'system';
    const framePresetById = (id) => {
      if (id === BUILTIN_FRAME_ID) return builtinFramePreset();
      if (typeof id === 'string' && id.startsWith('lib:')) return frameLibraryMap(frameScope())[id.slice(4)] || null;
      return null;
    };
    // New Frame — creates an editable System frame (seeded with a soft glow).
    const frameAdd = this.querySelector('#cpce-frame-add');
    if (frameAdd) frameAdd.onclick = () => {
      const scope = frameScope();
      const map = { ...frameLibraryMap(scope) };
      const base = 'New Frame'; let slug = frameLibSlug(base), n = 2;
      while (map[slug]) { slug = frameLibSlug(`${base} ${n++}`); }
      map[slug] = normalizeFramePreset({ name: n > 2 ? `${base} ${n - 1}` : base, glow: { color: '#2196F3', intensity: 1.0, borders_only: false } });
      saveFrameLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not create frame: ${formatWsError(err)}`));
    };
    // Duplicate (Built-In or System) → new editable System frame.
    this.querySelectorAll('.cpce-frame-duplicate').forEach(btn => btn.onclick = () => {
      const src = framePresetById(btn.dataset.frameId); if (!src) return;
      const scope = frameScope();
      const map = { ...frameLibraryMap(scope) };
      const base = `${src.name || 'Frame'} (copy)`; let slug = frameLibSlug(base), n = 2;
      while (map[slug]) { slug = frameLibSlug(`${base} ${n++}`); }
      const copy = portableFramePreset(src, true); copy.name = base; delete copy._builtin;
      map[slug] = copy;
      saveFrameLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not duplicate: ${formatWsError(err)}`));
    });
    // Export one frame as JSON.
    this.querySelectorAll('.cpce-frame-export').forEach(btn => btn.onclick = () => {
      const src = framePresetById(btn.dataset.frameId); if (!src) return;
      this._exportJson(serializeFramePresets([src], {}), 'Frame Style JSON — paste into another card via Import.');
    });
    // Delete a System frame (warn if the card uses it).
    this.querySelectorAll('.cpce-frame-delete').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.frameId; if (!id.startsWith('lib:')) return;
      const slug = id.slice(4); const src = frameLibraryMap(frameScope())[slug];
      const cf = (this._config && this._config.card_frame) || { presets: [] };
      const usedHere = Array.isArray(cf.presets) && cf.presets.includes(id);
      if (!this._confirmDelete(`Delete the shared frame "${(src && src.name) || slug}"?${usedHere ? ' This card uses it — it will lose that frame.' : ''} This applies system-wide.`)) return;
      const map = { ...frameLibraryMap(frameScope()) }; delete map[slug];
      // Drop any open builder/draft for the frame being deleted.
      if (this._openFrame === id) { this._openFrame = null; this._frameDraft = null; }
      saveFrameLibrary(this._hass, frameScope(), map).then(() => {
        if (usedHere) { const next = { ...cf, presets: cf.presets.filter(p => p !== id) }; this._updateConfig({ card_frame: next }); }
        this._render();
      }).catch(err => window.alert(`Could not delete: ${formatWsError(err)}`));
    });
    // Import frame JSON into the shared library.
    const frameImport = this.querySelector('#cpce-frame-import');
    if (frameImport) frameImport.onclick = () => this._importJson('Paste exported Frame Style JSON to add to the shared library:', (txt) => {
      const res = parseFramePresetBlob(txt);
      if (!res.ok) { window.alert('Import failed: ' + res.error); return; }
      const scope = frameScope(); const map = { ...frameLibraryMap(scope) };
      res.presets.forEach(p => { let slug = frameLibSlug(p.name); let n = 2; while (map[slug]) { slug = frameLibSlug(`${p.name} ${n++}`); } const clean = portableFramePreset(p, true); map[slug] = clean; });
      saveFrameLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not import: ${formatWsError(err)}`));
    });
    // Card Frame: apply / reorder / remove which frames layer onto the card.
    const cfMutate = (fn) => {
      const cf = JSON.parse(JSON.stringify((this._config && this._config.card_frame) || { presets: [] }));
      cf.presets = Array.isArray(cf.presets) ? cf.presets : [];
      fn(cf);
      this._updateConfig({ card_frame: cf });
      this._render();
    };
    const cfAdd = this.querySelector('#cpce-cf-add');
    if (cfAdd) cfAdd.onclick = () => {
      const pick = this.querySelector('#cpce-cf-add-pick'); const id = pick && pick.value; if (!id) return;
      cfMutate(cf => { cf.presets.push(id); });
    };
    this.querySelectorAll('.cpce-cf-remove').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.idx); cfMutate(cf => cf.presets.splice(i, 1)); });
    this.querySelectorAll('.cpce-cf-ignore').forEach(cb => cb.addEventListener('change', () => {
      const fid = cb.dataset.fid;
      cfMutate(cf => {
        const set = new Set(Array.isArray(cf.ignore_conditions) ? cf.ignore_conditions : []);
        if (cb.checked) set.add(fid); else set.delete(fid);
        const list = cf.presets.filter(id => set.has(id));
        if (list.length) cf.ignore_conditions = list; else delete cf.ignore_conditions;
      });
    }));
    // Hide / show a layer without removing it (toggles card_frame.disabled).
    this.querySelectorAll('.cpce-cf-hide').forEach(btn => btn.onclick = () => {
      const fid = btn.dataset.fid;
      cfMutate(cf => {
        const set = new Set(Array.isArray(cf.disabled) ? cf.disabled : []);
        if (set.has(fid)) set.delete(fid); else set.add(fid);
        const list = cf.presets.filter(id => set.has(id));
        if (list.length) cf.disabled = list; else delete cf.disabled;
      });
    });
    this.querySelectorAll('.cpce-cf-up').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.idx); if (i > 0) cfMutate(cf => { const [x] = cf.presets.splice(i, 1); cf.presets.splice(i - 1, 0, x); }); });
    this.querySelectorAll('.cpce-cf-down').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.idx); cfMutate(cf => { if (i < cf.presets.length - 1) { const [x] = cf.presets.splice(i, 1); cf.presets.splice(i + 1, 0, x); } }); });
    // Per-location condition override (entity / op / value) on the card frame.
    // Text edits write config WITHOUT a re-render (keep focus); op/clear re-render.
    const cfSetOverride = (fid, field, value, rerender) => {
      const cf = JSON.parse(JSON.stringify((this._config && this._config.card_frame) || { presets: [] }));
      cf.presets = Array.isArray(cf.presets) ? cf.presets : [];
      cf.overrides = (cf.overrides && typeof cf.overrides === 'object') ? cf.overrides : {};
      const o = cf.overrides[fid] || {};
      if (field === 'entity') { if (value) o.when_entity = value; else delete o.when_entity; }
      else { const w = (o.when && typeof o.when === 'object') ? o.when : {};
        if (field === 'op') { if (value) w.op = value; else delete w.op; }
        if (field === 'value') { if (value !== '') w.value = value; else delete w.value; }
        if (w.op) o.when = w; else delete o.when; }
      if (Object.keys(o).length) cf.overrides[fid] = o; else delete cf.overrides[fid];
      Object.keys(cf.overrides).forEach(k => { if (!cf.presets.includes(k)) delete cf.overrides[k]; });
      if (!Object.keys(cf.overrides).length) delete cf.overrides;
      this._updateConfig({ card_frame: cf });   // config-only, no re-render
      if (rerender) this._render();
    };
    this.querySelectorAll('.cpce-fr-ov-entity').forEach(el => {
      if (el.closest('.cpce-order-style-panel')) return;   // section-scoped ones handled elsewhere
      el.addEventListener('input', () => cfSetOverride(el.dataset.fid, 'entity', el.value.trim(), false));
      el.addEventListener('change', () => cfSetOverride(el.dataset.fid, 'entity', el.value.trim(), true));
    });
    this.querySelectorAll('.cpce-fr-ov-op').forEach(el => { if (el.closest('.cpce-order-style-panel')) return; el.addEventListener('change', () => cfSetOverride(el.dataset.fid, 'op', el.value, true)); });
    this.querySelectorAll('.cpce-fr-ov-value').forEach(el => {
      if (el.closest('.cpce-order-style-panel')) return;
      el.addEventListener('input', () => cfSetOverride(el.dataset.fid, 'value', el.value, false));
      el.addEventListener('change', () => cfSetOverride(el.dataset.fid, 'value', el.value, true));
    });
    this.querySelectorAll('.cpce-fr-ov-clear').forEach(el => { if (el.closest('.cpce-order-style-panel')) return; el.onclick = () => cfMutate(cf => { if (cf.overrides) { delete cf.overrides[el.dataset.fid]; if (!Object.keys(cf.overrides).length) delete cf.overrides; } }); });

    // ---- Frame Builder (edit a System frame's visuals in a DRAFT) ----
    // Toggle the inline builder for a frame row. Opening seeds a working-copy
    // draft; nothing is written to the shared library until the user hits Save.
    this.querySelectorAll('.cpce-frame-edit').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.frameId;
      if (this._openFrame === id) { this._openFrame = null; this._frameDraft = null; }
      else {
        const cur = frameLibraryMap(frameScope())[id.slice(4)];
        this._openFrame = id;
        this._frameDraft = cur ? { id, fx: JSON.parse(JSON.stringify(cur)), dirty: false } : null;
      }
      this._render();
    });
    // Mutate the OPEN frame's DRAFT (not the store). `live` true = value edit
    // (no re-render, keep focus); false = structural (re-render). Marks dirty.
    const patchFrame = (id, fn, live) => {
      if (!id || !id.startsWith('lib:')) return;
      const d = (this._frameDraft && this._frameDraft.id === id) ? this._frameDraft : null;
      if (!d) return;
      const wasDirty = d.dirty;
      fn(d.fx);
      d.fx = normalizeFramePreset(d.fx); d.fx.id = id;
      d.dirty = true;
      if (!live) { this._render(); return; }
      // Live value edit (no re-render, keep focus): repaint the preview swatch in
      // place, and enable Save/Discard the first time it goes dirty.
      this._paintFramePreviews();
      if (!wasDirty) {
        this.querySelectorAll(`.cpce-frame-save[data-frame-id="${id}"], .cpce-frame-discard[data-frame-id="${id}"]`).forEach(b => { b.disabled = false; b.classList.add('cpce-btn-enabled'); });
      }
    };
    // Save the draft → shared library (system-wide confirm). Commit + clear dirty.
    this.querySelectorAll('.cpce-frame-save').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.frameId;
      const d = (this._frameDraft && this._frameDraft.id === id) ? this._frameDraft : null;
      if (!d || !d.dirty) return;
      const scope = frameScope(); const slug = id.slice(4);
      const nm = d.fx.name || slug;
      if (!window.confirm(`Save "${nm}"?\n\nThis is a shared Frame Style — the change applies to EVERY card using it across your Home Assistant, not just this one.`)) return;
      const map = { ...frameLibraryMap(scope) };
      map[slug] = normalizeFramePreset(d.fx); map[slug].id = id;
      SEED_FRAME_LIBRARY[scope === 'system' ? 'system' : 'user'].map = map;
      saveFrameLibrary(this._hass, scope, map)
        .then(() => { d.dirty = false; this._render(); })
        .catch(err => { console.error(`${LOG_PREFIX} save frame failed`, err); window.alert(`Could not save: ${formatWsError(err)}`); });
    });
    // Discard the draft → reseed from the stored preset.
    this.querySelectorAll('.cpce-frame-discard').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.frameId;
      const cur = frameLibraryMap(frameScope())[id.slice(4)];
      this._frameDraft = cur ? { id, fx: JSON.parse(JSON.stringify(cur)), dirty: false } : null;
      this._render();
    });
    // Dotted-path setter (numeric segment → array index).
    const fbSet = (obj, path, val) => {
      const ks = path.split('.'); let o = obj;
      for (let i = 0; i < ks.length - 1; i++) { const k = ks[i]; if (o[k] == null) o[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; o = o[k]; }
      o[ks[ks.length - 1]] = val;
    };
    // Group enable/disable toggles (glow/shadow/border/background).
    this.querySelectorAll('.fb-toggle').forEach(el => el.addEventListener('change', () => {
      const id = el.dataset.fbId, key = el.dataset.fbKey;
      const defs = {
        glow: { color: '#2196F3', intensity: 1.0, borders_only: false },
        shadow: { color: '#000000', x: 0, y: 4, blur: 12, spread: 0, opacity: 0.35 },
        border: { color: '#2196F3', width: 1, radius: 12, corners: [true, true, true, true], follow_icon: false, sides: ['top', 'bottom', 'left', 'right'] },
        background: { mode: 'custom', color: '#1c1c1c' }
      };
      patchFrame(id, fx => { if (el.checked) fx[key] = defs[key]; else delete fx[key]; }, false);
    }));
    // Generic value inputs (color/text/select/range/checkbox at a dotted path).
    this.querySelectorAll('.fb-input').forEach(el => {
      const structural = el.dataset.fbPath === 'background.mode' || el.dataset.fbPath === 'glow.follow_icon' || el.dataset.fbPath === 'shadow.follow_icon' || el.dataset.fbPath === 'border.follow_icon' || el.dataset.fbPath === 'when.op';
      const apply = () => {
        const id = el.dataset.fbId, path = el.dataset.fbPath;
        let val = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'range') { val = Number(el.value); const lbl = this.querySelector(`.fb-val[data-fb-id="${id}"][data-fb-path="${path}"]`); if (lbl) lbl.textContent = String(val); }
        patchFrame(id, fx => fbSet(fx, path, val), !structural);
      };
      el.addEventListener('input', () => { if (el.type !== 'checkbox' && el.tagName !== 'SELECT') apply(); });
      el.addEventListener('change', apply);
    });
    // Border side toggles → maintain border.sides array.
    this.querySelectorAll('.fb-side').forEach(el => el.addEventListener('change', () => {
      patchFrame(el.dataset.fbId, fx => {
        fx.border = fx.border || {}; const set = new Set(Array.isArray(fx.border.sides) ? fx.border.sides : ['top', 'bottom', 'left', 'right']);
        if (el.checked) set.add(el.dataset.fbSide); else set.delete(el.dataset.fbSide);
        fx.border.sides = ['top', 'bottom', 'left', 'right'].filter(s => set.has(s));
      }, true);
    }));
    // Edge enable + mode.
    this.querySelectorAll('.fb-edge-enable').forEach(el => el.addEventListener('change', () => {
      patchFrame(el.dataset.fbId, fx => {
        fx.edges = fx.edges || {}; const s = el.dataset.fbSide;
        fx.edges[s] = fx.edges[s] || { thickness: 1, gradient: true, pattern: 'center_fade', stops: JSON.parse(JSON.stringify(EDGE_GRADIENT_PATTERNS.center_fade)) };
        fx.edges[s].enabled = el.checked;
      }, false);
    }));
    this.querySelectorAll('.fb-edge-mode').forEach(el => el.addEventListener('change', () => {
      patchFrame(el.dataset.fbId, fx => {
        fx.edges = fx.edges || {}; const s = el.dataset.fbSide; const cur = fx.edges[s] || { enabled: true, thickness: 1 };
        if (el.value === 'solid') fx.edges[s] = { enabled: true, thickness: cur.thickness || 1, gradient: false, color: cur.color || 'match' };
        else fx.edges[s] = { enabled: true, thickness: cur.thickness || 1, gradient: true, pattern: 'center_fade', stops: JSON.parse(JSON.stringify(EDGE_GRADIENT_PATTERNS.center_fade)) };
      }, false);
    }));
    this.querySelectorAll('.fb-edge-color').forEach(el => el.addEventListener('input', () => {
      patchFrame(el.dataset.fbId, fx => { fx.edges = fx.edges || {}; const s = el.dataset.fbSide; fx.edges[s] = fx.edges[s] || { enabled: true, thickness: 1, gradient: false }; fx.edges[s].color = el.value; }, true);
    }));
    // Solid-edge color SOURCE: Match / Theme / Custom (structural → re-render so
    // the Custom color picker shows/hides).
    this.querySelectorAll('.fb-edge-solid-mode').forEach(el => el.addEventListener('change', () => {
      const mode = el.value;
      patchFrame(el.dataset.fbId, fx => {
        fx.edges = fx.edges || {}; const s = el.dataset.fbSide;
        const cur = fx.edges[s] || { enabled: true, thickness: 1, gradient: false };
        if (mode === 'match') cur.color = 'match';
        else if (mode === 'theme') cur.color = 'theme';
        else if (!/^#[0-9a-f]{6}$/i.test(cur.color || '')) cur.color = '#2196F3';
        cur.gradient = false;
        fx.edges[s] = cur;
      }, false);
    }));
    // Edge thickness slider.
    this.querySelectorAll('.fb-edge-thickness').forEach(el => el.addEventListener('input', () => {
      const id = el.dataset.fbId, s = el.dataset.fbSide, val = Number(el.value);
      const lbl = this.querySelector(`.fb-edge-thickness-val[data-fb-id="${id}"][data-fb-side="${s}"]`); if (lbl) lbl.textContent = val + 'px';
      patchFrame(id, fx => { fx.edges = fx.edges || {}; fx.edges[s] = fx.edges[s] || { enabled: true, thickness: 1 }; fx.edges[s].thickness = val; }, true);
    }));
    // Edge gradient pattern picker → replaces stops with the pattern preset (structural: re-renders stop rows).
    this.querySelectorAll('.fb-edge-pattern').forEach(el => el.addEventListener('change', () => {
      const p = el.value;
      patchFrame(el.dataset.fbId, fx => {
        fx.edges = fx.edges || {}; const s = el.dataset.fbSide;
        fx.edges[s] = fx.edges[s] || { enabled: true, thickness: 1, gradient: true };
        fx.edges[s].gradient = true;
        if (p && EDGE_GRADIENT_PATTERNS[p]) {
          fx.edges[s].pattern = p;
          fx.edges[s].stops = JSON.parse(JSON.stringify(EDGE_GRADIENT_PATTERNS[p]));
        } else {
          delete fx.edges[s].pattern;   // Custom: keep current stops, drop the tag
        }
      }, false);
    }));
    // Per-stop position slider (live, updates the % readout) + color picker + source mode.
    this.querySelectorAll('.fb-edge-stop-pos').forEach(el => el.addEventListener('input', () => {
      const val = Math.max(0, Math.min(100, Number(el.value) || 0));
      const lbl = this.querySelector(`.fb-edge-stop-pos-val[data-fb-id="${el.dataset.fbId}"][data-fb-side="${el.dataset.fbSide}"][data-fb-idx="${el.dataset.fbIdx}"]`);
      if (lbl) lbl.textContent = val + '%';
      patchFrame(el.dataset.fbId, fx => {
        const s = el.dataset.fbSide, i = Number(el.dataset.fbIdx);
        if (fx.edges && fx.edges[s] && Array.isArray(fx.edges[s].stops) && fx.edges[s].stops[i]) { fx.edges[s].stops[i].pos = val; delete fx.edges[s].pattern; }
      }, true);
    }));
    this.querySelectorAll('.fb-edge-stop-color').forEach(el => el.addEventListener('input', () => {
      patchFrame(el.dataset.fbId, fx => {
        const s = el.dataset.fbSide, i = Number(el.dataset.fbIdx);
        if (fx.edges && fx.edges[s] && Array.isArray(fx.edges[s].stops) && fx.edges[s].stops[i]) { fx.edges[s].stops[i].color = el.value; delete fx.edges[s].pattern; }
      }, true);
    }));
    // Stop color SOURCE mode: Color / Match / Transparent (structural → re-render
    // so the color picker enables/disables).
    this.querySelectorAll('.fb-edge-stop-mode').forEach(el => el.addEventListener('change', () => {
      const mode = el.value;
      patchFrame(el.dataset.fbId, fx => {
        const s = el.dataset.fbSide, i = Number(el.dataset.fbIdx);
        const st = fx.edges && fx.edges[s] && Array.isArray(fx.edges[s].stops) ? fx.edges[s].stops[i] : null;
        if (!st) return;
        if (mode === 'match') st.color = 'match';
        else if (mode === 'transparent') st.color = 'transparent';
        else if (!/^#[0-9a-f]{6}$/i.test(st.color || '')) st.color = '#2196F3';
        delete fx.edges[s].pattern;
      }, false);
    }));
    // Add / remove stop (structural → re-render).
    this.querySelectorAll('.fb-edge-stop-add').forEach(el => el.addEventListener('click', (ev) => {
      ev.preventDefault();
      patchFrame(el.dataset.fbId, fx => {
        fx.edges = fx.edges || {}; const s = el.dataset.fbSide;
        fx.edges[s] = fx.edges[s] || { enabled: true, thickness: 1, gradient: true, stops: [] };
        fx.edges[s].gradient = true; if (!Array.isArray(fx.edges[s].stops)) fx.edges[s].stops = [];
        const last = fx.edges[s].stops[fx.edges[s].stops.length - 1];
        fx.edges[s].stops.push({ pos: last ? Math.min(100, (Number(last.pos) || 0) + 10) : 50, color: 'match' });
        fx.edges[s].pattern = '';
      }, false);
    }));
    this.querySelectorAll('.fb-edge-stop-del').forEach(el => el.addEventListener('click', (ev) => {
      ev.preventDefault();
      patchFrame(el.dataset.fbId, fx => {
        const s = el.dataset.fbSide, i = Number(el.dataset.fbIdx);
        if (fx.edges && fx.edges[s] && Array.isArray(fx.edges[s].stops)) { fx.edges[s].stops.splice(i, 1); fx.edges[s].pattern = ''; }
      }, false);
    }));
    // Condition master toggle.
    this.querySelectorAll('.fb-cond-toggle').forEach(el => el.addEventListener('change', () => {
      patchFrame(el.dataset.fbId, fx => {
        if (el.checked) { fx.when = fx.when || { op: 'eq', value: '' }; fx.when_entity = fx.when_entity || ''; }
        else { delete fx.when; delete fx.when_entity; delete fx.when_kind; delete fx.when_section; }
      }, false);
    }));

    // ============ Header Rules wiring ============
    const hdrScope = () => this._hdrScope();
    const headerSetById = (id) => {
      if (id === BUILTIN_HEADER_ID) return builtinHeaderRuleSet();
      if (typeof id === 'string' && id.startsWith('lib:')) return headerLibraryMap(hdrScope())[id.slice(4)] || null;
      return null;
    };
    // New Rule Set — creates an editable System set (seeded with an on/off pair).
    const hdrAdd = this.querySelector('#cpce-hdr-add');
    if (hdrAdd) hdrAdd.onclick = () => {
      const scope = hdrScope(); const map = { ...headerLibraryMap(scope) };
      const base = 'New Rule Set'; let slug = headerLibSlug(base), n = 2;
      while (map[slug]) { slug = headerLibSlug(`${base} ${n++}`); }
      const created = normalizeHeaderRuleSet({ name: n > 2 ? `${base} ${n - 1}` : base, rules: [{ when: { op: 'is_on' }, set_icon_color: '#2196F3' }] });
      created.id = 'lib:' + slug;
      map[slug] = created;
      SEED_HEADER_LIBRARY[scope === 'system' ? 'system' : 'user'].map = map;
      this._openHeaderSet = slug; this._headerDraft = { slug, set: JSON.parse(JSON.stringify(created)), dirty: false };
      saveHeaderLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not create rule set: ${formatWsError(err)}`));
    };
    // Duplicate (Built-In or System) → new editable System set.
    this.querySelectorAll('.cpce-hdr-duplicate').forEach(btn => btn.onclick = () => {
      const src = headerSetById(btn.dataset.hdrId); if (!src) return;
      const scope = hdrScope(); const map = { ...headerLibraryMap(scope) };
      const base = `${src.name || 'Rule Set'} (copy)`; let slug = headerLibSlug(base), n = 2;
      while (map[slug]) { slug = headerLibSlug(`${base} ${n++}`); }
      const copy = normalizeHeaderRuleSet(src); delete copy.id; delete copy._builtin; copy.name = base;
      map[slug] = copy;
      SEED_HEADER_LIBRARY[scope === 'system' ? 'system' : 'user'].map = map;
      saveHeaderLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not duplicate: ${formatWsError(err)}`));
    });
    // Export one set as JSON.
    this.querySelectorAll('.cpce-hdr-export').forEach(btn => btn.onclick = () => {
      const src = headerSetById(btn.dataset.hdrId); if (!src) return;
      this._exportJson(serializeHeaderRuleSets([src]), 'Header Rule Set JSON — paste into another card via Import.');
    });
    // Delete a System set (warn if the card uses it — refs go missing gracefully).
    this.querySelectorAll('.cpce-hdr-delete').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.hdrId; if (!id.startsWith('lib:')) return;
      const slug = id.slice(4); const src = headerLibraryMap(hdrScope())[slug];
      const usedHere = ((this._config && this._config.card_header_rules) || []).some(r => r.ref === id)
        || this._orderedSectionsRaw().some(s => (s.header_rule_refs || []).some(r => r.ref === id));
      if (!this._confirmDelete(`Delete the shared Header Rule Set "${(src && src.name) || slug}"?${usedHere ? ' This card applies it — that header will fall back to its own logic.' : ''} This applies system-wide.`)) return;
      const scope = hdrScope(); const map = { ...headerLibraryMap(scope) }; delete map[slug];
      SEED_HEADER_LIBRARY[scope === 'system' ? 'system' : 'user'].map = map;
      if (this._openHeaderSet === slug) { this._openHeaderSet = null; this._headerDraft = null; }
      saveHeaderLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not delete: ${formatWsError(err)}`));
    });
    // Import a Header Rule Set from JSON.
    const hdrImport = this.querySelector('#cpce-hdr-import');
    if (hdrImport) hdrImport.onclick = () => this._importJson('Paste exported Header Rule Set JSON to add to the shared library:', (txt) => {
      const res = parseHeaderRuleSetBlob(txt);
      if (!res.ok) { window.alert('Import failed: ' + res.error); return; }
      const scope = hdrScope(); const map = { ...headerLibraryMap(scope) };
      res.sets.forEach(set => { const nm = set.name || 'Rule Set'; let slug = headerLibSlug(nm), n = 2; while (map[slug]) { slug = headerLibSlug(`${nm} ${n++}`); } const clean = normalizeHeaderRuleSet(set); delete clean.id; map[slug] = clean; });
      SEED_HEADER_LIBRARY[scope === 'system' ? 'system' : 'user'].map = map;
      saveHeaderLibrary(this._hass, scope, map).then(() => this._render()).catch(err => window.alert(`Could not import: ${formatWsError(err)}`));
    });
    // ---- Header Rule Set builder (edit a System set in a DRAFT) ----
    this.querySelectorAll('.cpce-hdr-edit').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.hdrSlug;
      if (this._openHeaderSet === slug) { this._openHeaderSet = null; this._headerDraft = null; }
      else {
        const cur = headerLibraryMap(hdrScope())[slug];
        this._openHeaderSet = slug;
        this._headerDraft = cur ? { slug, set: JSON.parse(JSON.stringify(cur)), dirty: false } : null;
      }
      this._render();
    });
    // Mutate the OPEN set's DRAFT. `live` true = value edit (no re-render, keep
    // focus); false = structural (re-render). Normalizes + marks dirty.
    const patchHeaderSet = (slug, fn, live) => {
      const d = (this._headerDraft && this._headerDraft.slug === slug) ? this._headerDraft : null;
      if (!d) return;
      const wasDirty = d.dirty;
      fn(d.set);
      d.set = normalizeHeaderRuleSet(d.set);
      d.dirty = true;
      if (!live) { this._render(); return; }
      // Live value edit (no re-render, keep focus): repaint each open rule's
      // preview box in place so icon/color/size/secondary edits show immediately
      // (structural edits already refresh via the re-render above).
      (d.set.rules || []).forEach((rule, i) => {
        const prev = this.querySelector(`.cpce-hr-preview[data-hdr-slug="${slug}"][data-hr-idx="${i}"]`);
        if (prev) prev.innerHTML = this._headerRulePreviewHtml(rule);
      });
      if (!wasDirty) {
        this.querySelectorAll(`.cpce-hdr-save[data-hdr-slug="${slug}"], .cpce-hdr-discard[data-hdr-slug="${slug}"]`).forEach(b => { b.disabled = false; b.classList.add('cpce-btn-enabled'); });
      }
    };
    // Set-level fields (name / default entity) — live value edits.
    this.querySelectorAll('.hdr-name').forEach(el => el.addEventListener('input', () => patchHeaderSet(el.dataset.hdrSlug, set => { set.name = el.value; }, true)));
    this.querySelectorAll('.hdr-default-entity').forEach(el => el.addEventListener('input', () => patchHeaderSet(el.dataset.hdrSlug, set => { if (el.value) set.default_entity = el.value; else delete set.default_entity; }, true)));
    // Add a rule (structural).
    this.querySelectorAll('.cpce-hr-add').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.hdrSlug;
      patchHeaderSet(slug, set => { set.rules = Array.isArray(set.rules) ? set.rules : []; set.rules.push({ when: { op: 'is_on' } }); }, false);
    });
    // Toggle a rule row open/closed.
    this.querySelectorAll('.cpce-hr-toggle').forEach(el => el.addEventListener('click', (ev) => {
      if (ev.target.closest('.cpce-hr-del')) return;
      const key = el.dataset.hdrSlug + '::' + el.dataset.hrIdx;
      if (this._openHeaderRules.has(key)) this._openHeaderRules.delete(key); else this._openHeaderRules.add(key);
      this._render();
    }));
    // Delete a rule (structural). Drop its open-row key.
    this.querySelectorAll('.cpce-hr-del').forEach(btn => btn.onclick = (ev) => {
      ev.stopPropagation();
      const slug = btn.dataset.hdrSlug, i = Number(btn.dataset.hrIdx);
      this._openHeaderRules.delete(slug + '::' + i);
      patchHeaderSet(slug, set => { if (Array.isArray(set.rules)) set.rules.splice(i, 1); }, false);
    });
    // Rule condition op (structural: shows/hides the value input + preview).
    this.querySelectorAll('.hr-op').forEach(el => el.addEventListener('change', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx);
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (!r) return; r.when = r.when || {}; r.when.op = el.value; if (!this._hdrOpNeedsValue(el.value)) delete r.when.value; }, false);
    }));
    // Generic rule text inputs at a dotted path (when.value, set_icon, secondary.*).
    this.querySelectorAll('.hr-input').forEach(el => el.addEventListener('input', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx), path = el.dataset.hrPath;
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (!r) return; fbSet(r, path, el.value); }, true);
    }));
    // Color enable checkbox (structural: reveals/hides the picker; sets a default color / clears).
    this.querySelectorAll('.hr-color-enable').forEach(el => el.addEventListener('change', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx), key = el.dataset.hrPath;
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (!r) return; if (el.checked) r[key] = r[key] || '#2196F3'; else delete r[key]; }, false);
    }));
    // Color picker (live).
    this.querySelectorAll('.hr-color').forEach(el => el.addEventListener('input', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx), key = el.dataset.hrPath;
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (r) r[key] = el.value; }, true);
    }));
    // Size slider (live; 0 = Not set → key omitted by normalize).
    this.querySelectorAll('.hr-slider').forEach(el => el.addEventListener('input', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx), key = el.dataset.hrPath, val = Number(el.value);
      const lbl = this.querySelector(`.hr-slider-val[data-hdr-slug="${slug}"][data-hr-idx="${i}"][data-hr-path="${key}"]`);
      if (lbl) lbl.textContent = val > 0 ? val + 'px' : 'Not set';
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (r) r[key] = val; }, true);
    }));
    // Secondary-info enable (structural: reveals source/attr/prefix).
    this.querySelectorAll('.hr-sec-enable').forEach(el => el.addEventListener('change', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx);
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (!r) return; r.set_secondary = r.set_secondary || {}; r.set_secondary.enabled = el.checked; }, false);
    }));
    // Secondary source (structural: attribute field shows only for 'attribute').
    this.querySelectorAll('.hr-sec-source').forEach(el => el.addEventListener('change', () => {
      const slug = el.dataset.hdrSlug, i = Number(el.dataset.hrIdx);
      patchHeaderSet(slug, set => { const r = set.rules[i]; if (!r) return; r.set_secondary = r.set_secondary || { enabled: true }; r.set_secondary.source = el.value; }, false);
    }));
    // Save the set draft → shared library (system-wide confirm).
    this.querySelectorAll('.cpce-hdr-save').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.hdrSlug;
      const d = (this._headerDraft && this._headerDraft.slug === slug) ? this._headerDraft : null;
      if (!d || !d.dirty) return;
      const scope = hdrScope(); const nm = d.set.name || slug;
      if (!window.confirm(`Save "${nm}"?\n\nThis is a shared Header Rule Set — the change applies to EVERY card using it across your Home Assistant, not just this one.`)) return;
      const map = { ...headerLibraryMap(scope) }; map[slug] = normalizeHeaderRuleSet(d.set); map[slug].id = 'lib:' + slug;
      SEED_HEADER_LIBRARY[scope === 'system' ? 'system' : 'user'].map = map;
      saveHeaderLibrary(this._hass, scope, map)
        .then(() => { d.dirty = false; this._render(); })
        .catch(err => { console.error(`${LOG_PREFIX} save header set failed`, err); window.alert(`Could not save: ${formatWsError(err)}`); });
    });
    // Discard the draft → reseed from the stored set.
    this.querySelectorAll('.cpce-hdr-discard').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.hdrSlug;
      const cur = headerLibraryMap(hdrScope())[slug];
      this._headerDraft = cur ? { slug, set: JSON.parse(JSON.stringify(cur)), dirty: false } : null;
      this._render();
    });

    // ---- Applied Header Rule refs (card title + per section) ----
    // Route a ref mutation to the right config location by scope marker.
    const hdrRefMutate = (el, fn) => {
      const sid = el.dataset.hdrTargetSid;
      if (sid) {
        const cur = this._orderedSectionsRaw().find(x => x.id === sid) || {};
        const refs = normalizeHeaderRuleRefs(cur.header_rule_refs);
        fn(refs);
        const cleaned = normalizeHeaderRuleRefs(refs);
        this._updateSections(this._orderedSectionsRaw().map(s => s.id === sid ? { ...s, header_rule_refs: cleaned.length ? cleaned : undefined } : s));
      } else {
        const refs = normalizeHeaderRuleRefs((this._config && this._config.card_header_rules) || []);
        fn(refs);
        const cleaned = normalizeHeaderRuleRefs(refs);
        this._updateConfig({ card_header_rules: cleaned.length ? cleaned : undefined });
      }
      this._render();
    };
    this.querySelectorAll('.cpce-hr-ref-add').forEach(btn => btn.onclick = () => {
      const pick = btn.parentElement.querySelector('.cpce-hr-ref-add-pick'); const id = pick && pick.value; if (!id) return;
      hdrRefMutate(btn, refs => refs.push({ ref: id, entity: '' }));
    });
    this.querySelectorAll('.cpce-hr-ref-remove').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.hrRefIdx); hdrRefMutate(btn, refs => refs.splice(i, 1)); });
    this.querySelectorAll('.cpce-hr-ref-up').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.hrRefIdx); if (i > 0) hdrRefMutate(btn, refs => { const [x] = refs.splice(i, 1); refs.splice(i - 1, 0, x); }); });
    this.querySelectorAll('.cpce-hr-ref-down').forEach(btn => btn.onclick = () => { const i = Number(btn.dataset.hrRefIdx); hdrRefMutate(btn, refs => { if (i < refs.length - 1) { const [x] = refs.splice(i, 1); refs.splice(i + 1, 0, x); } }); });
    // Per-ref entity binding (commit on change so it doesn't re-render each keystroke).
    this.querySelectorAll('.cpce-hr-ref-entity').forEach(el => el.addEventListener('change', () => {
      const i = Number(el.dataset.hrRefIdx);
      hdrRefMutate(el, refs => { if (refs[i]) refs[i].entity = el.value ? el.value : ''; });
    }));

    // ---- Conditional-layer stack editor ----
    this.querySelectorAll('.cpce-btnstyle-layers').forEach(btn => btn.onclick = () => this._openStackEditor(btn.dataset.slug));
    this.querySelectorAll('.cpce-layer-add').forEach(btn => btn.onclick = () =>
      this._mutateStackDraft(btn.dataset.slug, layers => layers.push({ groups: {}, when: { type: 'light_on' } })));
    this.querySelectorAll('.cpce-layer-import').forEach(btn => btn.onclick = () => {
      const slug = btn.dataset.slug;   // capture before the async clipboard read
      this._importJson('Paste Button Appearance JSON to append as new layer(s):', (txt) => {
        let parsed; try { parsed = JSON.parse(txt); } catch (e) { window.alert('That isn\'t valid JSON.'); return; }
        this._importButtonStyleAsLayer(slug, parsed);
      });
    });
    this.querySelectorAll('.cpce-layer-discard').forEach(btn => btn.onclick = () => { this._stackDraft = null; this._openButtonStack = null; this._editingLayer = null; this._openStackEditor(btn.dataset.slug); });
    this.querySelectorAll('.cpce-layer-save').forEach(btn => btn.onclick = () => this._saveStackDraft(btn.dataset.slug));
    this.querySelectorAll('.cpce-stack-layer').forEach(row => {
      const slug = row.dataset.slug; const idx = parseInt(row.dataset.idx, 10);
      const cond = row.querySelector('.cpce-layer-cond');
      if (cond) cond.addEventListener('change', () => this._mutateStackDraft(slug, layers => {
        const w = this._layerWhenFromType(cond.value, layers[idx] && layers[idx].when);
        if (w) layers[idx].when = w; else delete layers[idx].when;
      }));
      const bindWhen = (sel, fn) => { const el = row.querySelector(sel); if (el) el.addEventListener('change', () => this._mutateStackDraft(slug, layers => { layers[idx].when = layers[idx].when || { type: 'entity_state' }; fn(layers[idx].when, el.value); })); };
      bindWhen('.cpce-layer-ent', (w, v) => { w.entity = v.trim(); });
      bindWhen('.cpce-layer-attr', (w, v) => { const a = v.trim(); if (a) { w.attr = a; w.op = w.op || '=='; if (w.value == null) w.value = w.state != null ? w.state : ''; delete w.state; } else { delete w.attr; delete w.op; if (w.value != null) { w.state = w.value; delete w.value; } } });
      bindWhen('.cpce-layer-op', (w, v) => { w.op = v; });
      bindWhen('.cpce-layer-val', (w, v) => { if (w.attr) w.value = v; else w.state = v; });
      // Optional per-layer label (fires on blur; re-render is fine there).
      const lbl = row.querySelector('.cpce-layer-label');
      if (lbl) lbl.addEventListener('change', () => this._mutateStackDraft(slug, layers => { const v = lbl.value.trim(); if (v) layers[idx].label = v; else delete layers[idx].label; }));
      // Reorder/remove change layer indices, which would leave _editingLayer pointing at the wrong
      // layer — stop editing before mutating so the Builder isn't silently bound to a moved layer.
      const up = row.querySelector('.cpce-layer-up');
      if (up) up.onclick = () => { this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._mutateStackDraft(slug, layers => { if (idx > 0) { const prevFlat = flattenButtonStack({ layers }, () => true); const t = layers[idx - 1]; layers[idx - 1] = layers[idx]; layers[idx] = t; this._ensureBaseFullLook(layers, prevFlat); } }); };
      const dn = row.querySelector('.cpce-layer-down');
      if (dn) dn.onclick = () => { this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._mutateStackDraft(slug, layers => { if (idx < layers.length - 1) { const prevFlat = flattenButtonStack({ layers }, () => true); const t = layers[idx + 1]; layers[idx + 1] = layers[idx]; layers[idx] = t; this._ensureBaseFullLook(layers, prevFlat); } }); };
      const rm = row.querySelector('.cpce-layer-remove');
      if (rm) rm.onclick = () => { if (!this._confirmDelete('Remove this layer? This cannot be undone (until you Discard changes).')) return; this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._mutateStackDraft(slug, layers => { if (layers.length > 1) { const prevFlat = flattenButtonStack({ layers }, () => true); layers.splice(idx, 1); this._ensureBaseFullLook(layers, prevFlat); } }); };
      // Duplicate this layer — insert a deep copy directly after the source. Stop editing first
      // (indices shift). A duplicated base (idx 0) becomes an overlay that happens to own every
      // group (valid); its label gets a "(copy)" suffix so the two are distinguishable.
      const dup = row.querySelector('.cpce-layer-duplicate');
      if (dup) dup.onclick = () => { this._editingLayer = null; this._layerEditCfg = null; this._layerOwned = null; this._mutateStackDraft(slug, layers => {
        const copy = JSON.parse(JSON.stringify(layers[idx]));
        if (copy.label) copy.label = `${copy.label} (copy)`;
        layers.splice(idx + 1, 0, copy);
      }); };
      // Hide/show this layer (draft-level; previews the stack without it).
      const hide = row.querySelector('.cpce-layer-hide');
      if (hide) hide.onclick = () => this._mutateStackDraft(slug, layers => { layers[idx].hidden = !layers[idx].hidden; });
      // Single pencil = the edit toggle. Opening a layer unlocks its condition AND loads its
      // EFFECTIVE look (base beneath it + this layer's delta) into the Builder; clicking the pencil
      // of the already-open layer closes the editor.
      const edit = row.querySelector('.cpce-layer-edit');
      if (edit) edit.onclick = () => this._editLayer(slug, idx);
    });

    bindBtn('#cpce-button-glow-color', 'button_glow_color');
    bindBtn('#cpce-button-glow-blur', 'button_glow_blur', v => clamp(parseInt(v,10)||0, 0, 40));
    bindBtn('#cpce-button-glow-spread', 'button_glow_spread', v => clamp(parseInt(v,10)||0, -10, 20));
    bindBtn('#cpce-button-glow-opacity', 'button_glow_opacity', v => clamp(parseInt(v,10)||50, 0, 100) / 100);
    bindBtn('#cpce-button-glow-condition', 'button_glow_condition');
    // Button drop-shadow controls (enable toggles the sub-options → re-render).
    const btnShadowEnable = this.querySelector('#cpce-button-shadow-enabled');
    if (btnShadowEnable) btnShadowEnable.addEventListener('change', () => { this._builderPatch({ button_shadow_enabled: btnShadowEnable.checked }); this._render(); });
    bindBtn('#cpce-button-shadow-color', 'button_shadow_color');
    bindBtn('#cpce-button-shadow-x', 'button_shadow_x', v => clamp(parseInt(v,10)||0, -20, 20));
    bindBtn('#cpce-button-shadow-y', 'button_shadow_y', v => clamp(parseInt(v,10)||0, -20, 20));
    bindBtn('#cpce-button-shadow-blur', 'button_shadow_blur', v => clamp(parseInt(v,10)||0, 0, 40));
    bindBtn('#cpce-button-shadow-spread', 'button_shadow_spread', v => clamp(parseInt(v,10)||0, -20, 20));
    bindBtn('#cpce-button-shadow-opacity', 'button_shadow_opacity', v => clamp(parseInt(v,10)||35, 0, 100) / 100);
    ['brightness', 'temperature', 'rgb'].forEach(type => {
      bind(`#cpce-${type}-label-position`, `${type}_label_position`);
      bind(`#cpce-${type}-value-position`, `${type}_value_position`);
    });
    // Switching fixed-vs-current mode changes which field is shown, so it needs a full re-render.
    const endModeEl = this.querySelector('#cpce-brightness-end-mode');
    if (endModeEl) endModeEl.addEventListener('change', () => { this._updateConfig({ brightness_end_color_mode: endModeEl.value }); this._render(); });
    // Button color-mode selects (match/fixed/none) — write to the layer buffer, re-render to
    // reveal/hide the fixed-color picker.
    bindBtnMode('#cpce-button-border-color-mode', 'button_border_color_mode');
    bindBtnMode('#cpce-button-glow-color-mode', 'button_glow_color_mode');
    bindBtnMode('#cpce-button-gradient-color-mode', 'button_border_gradient_color_mode');
    bindBtn('#cpce-button-icon', 'button_icon', v => normalizeIcon(v));
    bindBtn('#cpce-button-icon-size', 'button_icon_size', v => clamp(parseInt(v,10)||0, 0, 48));
    bindBtn('#cpce-button-icon-color', 'button_icon_color');
    bindBtnMode('#cpce-button-icon-color-mode', 'button_icon_color_mode');
    // Enabling/disabling a slider's label/value text also enables/disables its position dropdown.
    ['brightness', 'temperature', 'rgb'].forEach(type => {
      const labelCb = this.querySelector(`#cpce-${type}-show-label`);
      if (labelCb) labelCb.addEventListener('change', () => this._render());
      const valueCb = this.querySelector(`#cpce-${type}-show-value`);
      if (valueCb) valueCb.addEventListener('change', () => this._render());
    });
    // (Card per-corner toggles, card enable toggles, and card border sides/
    // corners All/None buttons removed — card frame styling is in Frame Styles.)
    // Button border/glow enable toggles reveal dependent fields → re-render.
    ['#cpce-button-border-enabled', '#cpce-button-glow-enabled'].forEach(sel => {
      const el = this.querySelector(sel);
      const keyMap = {
        '#cpce-button-border-enabled': 'button_border_enabled',
        '#cpce-button-glow-enabled': 'button_glow_enabled',
      };
      if (el) el.addEventListener('change', () => { this._builderPatch({ [keyMap[sel]]: el.checked }); this._render(); });
    });
    const cardBgColorEl = this.querySelector('#cpce-card-bg-color');
    if (cardBgColorEl) cardBgColorEl.addEventListener('input', () => this._updateConfig({ card_bg_color: cardBgColorEl.value }));
    const cardBgModeEl = this.querySelector('#cpce-card-bg-mode');
    if (cardBgModeEl) cardBgModeEl.addEventListener('change', () => { this._updateConfig({ card_bg_mode: cardBgModeEl.value }); this._render(); });
    // Live-update the numeric readout next to each range slider as it's dragged.
    const wireRangeReadout = (sliderId, valueId, suffix) => {
      const slider = this.querySelector(sliderId);
      const val = valueId ? this.querySelector(valueId) : (slider && slider.nextElementSibling);
      if (slider && val) slider.addEventListener('input', () => { val.textContent = `${slider.value}${suffix}`; });
    };
    wireRangeReadout('#cpce-brightness-strength', null, '%');
    wireRangeReadout('#cpce-handle-opacity', '#cpce-handle-opacity-val', '%');
    wireRangeReadout('#cpce-scale', '#cpce-scale-val', 'x');
    wireRangeReadout('#cpce-button-glow-blur', '#cpce-button-glow-blur-val', 'px');
    wireRangeReadout('#cpce-button-glow-spread', '#cpce-button-glow-spread-val', 'px');
    wireRangeReadout('#cpce-button-glow-opacity', '#cpce-button-glow-opacity-val', '%');
    wireRangeReadout('#cpce-button-border-width', '#cpce-button-border-width-val', 'px');
    wireRangeReadout('#cpce-button-shadow-x', '#cpce-button-shadow-x-val', 'px');
    wireRangeReadout('#cpce-button-shadow-y', '#cpce-button-shadow-y-val', 'px');
    wireRangeReadout('#cpce-button-shadow-blur', '#cpce-button-shadow-blur-val', 'px');
    wireRangeReadout('#cpce-button-shadow-spread', '#cpce-button-shadow-spread-val', 'px');
    wireRangeReadout('#cpce-button-shadow-opacity', '#cpce-button-shadow-opacity-val', '%');
    wireRangeReadout('#cpce-slider-border-radius', '#cpce-slider-border-radius-val', 'px');
    wireRangeReadout('#cpce-icon-size', '#cpce-icon-size-val', 'px');
    wireRangeReadout('#cpce-divider-thickness', '#cpce-divider-thickness-val', 'px');
    wireRangeReadout('#cpce-divider-length', '#cpce-divider-length-val', '%');
    wireRangeReadout('#cpce-columns', '#cpce-columns-val', '');
    wireRangeReadout('#cpce-gap', '#cpce-gap-val', 'px');
    wireRangeReadout('#cpce-button-icon-gap', '#cpce-button-icon-gap-val', 'px');
    wireRangeReadout('#cpce-button-icon-size', '#cpce-button-icon-size-val', 'px');
    wireRangeReadout('#cpce-slider-width-horizontal', '#cpce-slider-width-horizontal-val', 'px');
    wireRangeReadout('#cpce-slider-length-horizontal', '#cpce-slider-length-horizontal-val', '%');
    wireRangeReadout('#cpce-slider-width-vertical', '#cpce-slider-width-vertical-val', 'px');
    wireRangeReadout('#cpce-slider-length-vertical', '#cpce-slider-length-vertical-val', 'px');
    wireRangeReadout('#cpce-slider-font-size', '#cpce-slider-font-size-val', 'px');
    wireRangeReadout('#cpce-button-border-radius', '#cpce-button-border-radius-val', 'px');
    wireRangeReadout('#cpce-button-font-size', '#cpce-button-font-size-val', 'px');
    wireRangeReadout('#cpce-button-height', '#cpce-button-height-val', 'px');
    // Max-width readout shows "Auto" at 0, else "<n>px".
    const maxWEl = this.querySelector('#cpce-button-max-width');
    const maxWVal = this.querySelector('#cpce-button-max-width-val');
    if (maxWEl && maxWVal) maxWEl.addEventListener('input', () => { maxWVal.textContent = Number(maxWEl.value) ? `${maxWEl.value}px` : 'Auto'; });
    wireRangeReadout('#cpce-min-kelvin', '#cpce-min-kelvin-val', 'K');
    wireRangeReadout('#cpce-max-kelvin', '#cpce-max-kelvin-val', 'K');
    wireRangeReadout('#cpce-slider-debounce', '#cpce-slider-debounce-val', 'ms');

    // Color Entities — create a brand new input_color helper entity, then (only once its
    // existence is confirmed in hass.states) create a preset auto-linked to it. If the
    // entity can't be created/confirmed, an error is surfaced and NO preset is created.
    const createEntityBtn = this.querySelector('#cpce-create-input-color-entity');
    if (createEntityBtn) {
      createEntityBtn.onclick = () => {
        const nameInput = this.querySelector('#cpce-new-input-color-name');
        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) { window.alert('Enter a name for the new entity.'); return; }
        createEntityBtn.disabled = true;
        // Log what this specific install's input_color integration actually supports,
        // then attempt creation. The diagnostics land in the browser console alongside
        // any create error, so we can see exactly why creation is/ isn't possible here.
        this._diagnoseInputColor()
          .then(() => this._createInputColorEntity(name))
          .then(entityId => {
            // _createInputColorEntity only returns a non-null id AFTER confirming the new
            // entity appeared in state (it drives the config flow and diffs state). On a
            // null return it already surfaced the reason — so we simply create no preset.
            if (!entityId) return;
            if (nameInput) nameInput.value = '';
            // Entity confirmed — create a preset auto-LINKED to it. A linked button stores NO
            // color of its own (the entity is the source of truth), so we don't copy values in.
            const presets = [...(this._config.presets || [])];
            presets.push({
              id: newPresetId(),
              name,
              icon: modeDefaultIcon('color'),
              mode: 'color',
              input_color_entity: entityId,
            });
            this._openPreset = presets.length - 1;
            this._openSection = 'presets';
            this._unmatchedInputColors = this._unmatchedInputColors.filter(id => id !== entityId);
            console.log(`${LOG_PREFIX} Created preset "${name}" linked to Color Entity "${entityId}".`);
            this._updateConfig({ presets });
            this._render();
          })
          .finally(() => { createEntityBtn.disabled = false; });
      };
    }

    // Color Entities — create a preset from an unmatched entity.
    // Scoped to buttons carrying a data-entity so it can't hijack the "Create Entity"
    // button, which shares the .cpce-create-preset-btn class purely for styling.
    this.querySelectorAll('.cpce-create-preset-btn[data-entity]').forEach(btn => {
      btn.onclick = () => {
        const entityId = btn.dataset.entity;
        // Linked button stores NO color of its own — the entity is the source of truth.
        const presets = [...(this._config.presets || [])];
        presets.push({
          id: newPresetId(),
          name: friendlyName(this._hass, entityId),
          icon: modeDefaultIcon('color'),
          mode: 'color',
          input_color_entity: entityId,
        });
        this._openPreset = presets.length - 1;
        this._openSection = 'presets';
        this._unmatchedInputColors = this._unmatchedInputColors.filter(id => id !== entityId);
        this._updateConfig({ presets });
        this._render();
      };
    });

    // Color Entities — delete the entity itself. Completely separate from preset
    // deletion/editing, with its own confirmation, so a preset action can never
    // accidentally remove an entity.
    // NOTE: scope to .cpce-ce-delete only. The red delete styling class .cpce-delete-entity-btn is
    // shared by many buttons (layer-remove, stop-remove, preset-remove, profile/btnstyle-delete),
    // each with its OWN handler — binding this Color-Entity handler to all of them ran late and
    // clobbered those, so e.g. deleting a style layer tried to delete an entity "undefined".
    this.querySelectorAll('.cpce-ce-delete').forEach(btn => {
      btn.onclick = () => {
        const entityId = btn.dataset.entity;
        if (!this._confirmDelete(`Permanently delete the entity "${entityId}"? Any button linked to it will apply no color until relinked or given an inline color.`)) return;
        btn.disabled = true;
        this._deleteColorEntity(entityId)
          .then(ok => {
            if (!ok) { btn.disabled = false; return; }
            // The entity is gone from HA. Record it so it's dropped from every list even if
            // the editor's hass.states snapshot keeps reporting it, and unlink it from any
            // preset config that still references it (that stale link is what was keeping
            // the deleted entity in the YAML — and thus visible in the list).
            this._deletedColorEntities.add(entityId);
            const presets = (this._config.presets || []).map(p => {
              if (p.input_color_entity !== entityId) return p;
              const { input_color_entity, ...rest } = p;
              return rest;
            });
            this._unmatchedInputColors = this._unmatchedInputColors.filter(id => id !== entityId);
            this._allInputColorEntities = this._allInputColorEntities.filter(id => id !== entityId);
            this._updateConfig({ presets });
            this._syncInputColorMatches();
            this._render();
          });
      };
    });

    // Color Entities — scan for and remove orphaned color entities the integration's
    // buggy setup dialog leaves behind (and that HA's own UI often won't let you delete).
    const cleanupBtn = this.querySelector('#cpce-cleanup-orphans');
    if (cleanupBtn) {
      cleanupBtn.onclick = () => {
        cleanupBtn.disabled = true;
        this._findOrphanedColorEntities()
          .then(orphans => {
            if (!orphans.length) { window.alert('No orphaned color entities found.'); return null; }
            const ids = orphans.map(o => o.entity_id);
            if (!window.confirm(`Found ${ids.length} orphaned color ${ids.length === 1 ? 'entity' : 'entities'}:\n\n${ids.join('\n')}\n\nRemove ${ids.length === 1 ? 'it' : 'them all'}?`)) return null;
            return this._cleanupOrphanedColorEntities().then(removed => {
              window.alert(`Removed ${removed} orphaned ${removed === 1 ? 'entity' : 'entities'}.`);
              ids.forEach(id => this._deletedColorEntities.add(id));
              this._syncInputColorMatches();
              this._render();
            });
          })
          .catch(e => { console.error(`${LOG_PREFIX} orphan cleanup failed:`, e); window.alert(`Orphan cleanup failed: ${formatWsError(e)}`); })
          .finally(() => { cleanupBtn.disabled = false; });
      };
    }

    // Color Entities — collapse toggles for the three sub-areas.
    this.querySelectorAll('.cpce-collapse-head[data-ce-toggle]').forEach(head => {
      head.onclick = () => { const k = head.dataset.ceToggle; this._ceCollapsed[k] = !this._ceCollapsed[k]; this._render(); };
    });

    // Color Entities — per-entity edit-panel toggle (pencil). Opening/closing
    // clears any buffered draft (edits only persist via Save).
    this.querySelectorAll('.cpce-ce-edit').forEach(btn => {
      btn.onclick = () => {
        this._openColorEntity = this._openColorEntity === btn.dataset.entity ? null : btn.dataset.entity;
        this._entityColorDraft = null;
        this._render();
      };
    });
    // Save / Discard the buffered Color Entity edits.
    this.querySelectorAll('.cpce-ce-save').forEach(btn => btn.onclick = () => this._saveEntityDraft(btn.dataset.entity));
    this.querySelectorAll('.cpce-ce-discard').forEach(btn => btn.onclick = () => this._discardEntityDraft(btn.dataset.entity));

    // Color Entities — per-entity edit panels: color wheel + hex + temp + brightness, each
    // writing straight to the entity via set_color (linked buttons follow it live).
    this.querySelectorAll('.cpce-ce-edit-panel').forEach(panel => {
      const id = panel.dataset.entity;
      const modeEl = panel.querySelector('.cpce-ce-mode');
      if (modeEl) modeEl.addEventListener('change', () => {
        if (modeEl.value === 'temp') {
          const midK = Math.round(((Number(this._config.min_kelvin)||2000) + (Number(this._config.max_kelvin)||6500)) / 2);
          this._mutateEntityDraft(id, { color_temp_kelvin: midK });
        } else {
          this._mutateEntityDraft(id, { rgb_color: this._entityEffectiveValue(id).rgb_color || [255, 0, 0] });
        }
        this._render();
      });
      // Color wheel + hex.
      const canvas = panel.querySelector('.cpce-ce-wheel');
      if (canvas) {
        const cur = this._entityEffectiveValue(id);
        const rgb0 = cur.rgb_color || [255, 255, 255];
        const hs0 = ColorUtils.rgbToHs(rgb0[0], rgb0[1], rgb0[2]);
        this._drawColorWheel(canvas, hs0[0], hs0[1]);
        const cx = canvas.width / 2, cy = canvas.height / 2, radius = Math.min(cx, cy) - 4;
        const fromWheel = (clientX, clientY) => {
          const rect = canvas.getBoundingClientRect();
          const px = (clientX - rect.left) * (canvas.width / rect.width) - cx;
          const py = (clientY - rect.top) * (canvas.height / rect.height) - cy;
          const dist = Math.min(Math.sqrt(px*px + py*py), radius);
          let angle = Math.atan2(py, px) * 180 / Math.PI; if (angle < 0) angle += 360;
          const rgb = ColorUtils.hsToRgb(Math.round(angle) % 360, Math.round((dist / radius) * 100));
          // Buffer into the draft (no write); update the preview live.
          this._mutateEntityDraft(id, { rgb_color: rgb });
          const prev = panel.querySelector('.cpce-hex-preview'); const hexIn = panel.querySelector('.cpce-ce-hex');
          const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
          if (prev) prev.style.background = hex; if (hexIn && document.activeElement !== hexIn) hexIn.value = hex;
          const sw = this.querySelector(`.cpce-manage-item[data-entity="${id}"] .cpce-fav-swatch`); if (sw) sw.style.background = hex;
          this._drawColorWheel(canvas, ColorUtils.rgbToHs(rgb[0],rgb[1],rgb[2])[0], ColorUtils.rgbToHs(rgb[0],rgb[1],rgb[2])[1]);
          this._syncEntityDirtyButtons(id);
        };
        const startDrag = () => { this._ceWheelDragging = true; };
        const endDrag = () => { this._ceWheelDragging = false; this._render(); };
        canvas.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(); fromWheel(e.clientX, e.clientY); });
        window.addEventListener('mousemove', (e) => { if (this._ceWheelDragging) fromWheel(e.clientX, e.clientY); });
        window.addEventListener('mouseup', () => { if (this._ceWheelDragging) endDrag(); });
        canvas.addEventListener('touchstart', (e) => { startDrag(); fromWheel(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
        window.addEventListener('touchmove', (e) => { if (this._ceWheelDragging) fromWheel(e.touches[0].clientX, e.touches[0].clientY); }, {passive:true});
        window.addEventListener('touchend', () => { if (this._ceWheelDragging) endDrag(); });
      }
      const hexEl = panel.querySelector('.cpce-ce-hex');
      if (hexEl) hexEl.addEventListener('change', () => { const rgb = ColorUtils.hexToRgb(hexEl.value); if (rgb) { this._mutateEntityDraft(id, { rgb_color: rgb }); this._render(); } });
      const tempEl = panel.querySelector('.cpce-ce-temp'); const tempVal = panel.querySelector('.cpce-temp-val');
      if (tempEl) { tempEl.addEventListener('input', () => { if (tempVal) tempVal.textContent = `${tempEl.value}K`; }); tempEl.addEventListener('change', () => { this._mutateEntityDraft(id, { color_temp_kelvin: parseInt(tempEl.value,10) }); this._syncEntityDirtyButtons(id); }); }
      const briEn = panel.querySelector('.cpce-ce-bri-enable');
      if (briEn) briEn.addEventListener('change', () => {
        const cur = this._entityEffectiveValue(id);
        this._mutateEntityDraft(id, { brightness: briEn.checked ? (cur.brightness ?? 255) : null });
        this._render();
      });
      const briEl = panel.querySelector('.cpce-ce-bri'); const briVal = panel.querySelector('.cpce-bri-val');
      if (briEl) { briEl.addEventListener('input', () => { if (briVal) briVal.textContent = `${briEl.value}%`; }); briEl.addEventListener('change', () => { this._mutateEntityDraft(id, { brightness: Math.round(clamp(parseInt(briEl.value,10)||1,1,100)*2.55) }); this._syncEntityDirtyButtons(id); }); }
    });

    // Fixture Profile name + note — edit the DRAFT (Save commits). These inputs
    // live inside the profile edit panel, so a draft is already open.
    this.querySelectorAll('.cpce-profile-rename').forEach(inp => {
      inp.addEventListener('input', () => {
        this._mutateProfileDraft(inp.dataset.slug, e => { e.name = inp.value || inp.dataset.slug; });
        this._syncProfileDirtyButtons(inp.dataset.slug);
      });
    });
    this.querySelectorAll('.cpce-profile-note').forEach(inp => {
      inp.addEventListener('input', () => {
        this._mutateProfileDraft(inp.dataset.slug, e => { const n = inp.value.trim(); if (n) e.note = n; else delete e.note; });
        this._syncProfileDirtyButtons(inp.dataset.slug);
      });
    });
    this.querySelectorAll('.cpce-profile-lib-delete').forEach(btn => {
      btn.onclick = () => {
        const slug = btn.dataset.slug;
        const used = (this._config.presets || []).some(p => fixtureRefSlug(p && p.profile_ref) === slug);
        const msg = used
          ? `Delete profile "${slug}" from the library? Buttons referencing it will fall back to their inline values.`
          : `Delete profile "${slug}" from the library?`;
        if (!this._confirmDelete(msg)) return;
        const map = { ...fixtureLibraryMap('system') };
        delete map[slug];
        // Drop any open editor/draft for the profile being deleted.
        if (this._openProfile === slug) { this._openProfile = null; this._profileDraft = null; }
        saveFixtureLibrary(this._hass, 'system', map)
          .then(() => this._render())
          .catch(e => { console.warn(`${LOG_PREFIX} delete profile failed`, e); window.alert(`Could not delete: ${formatWsError(e)}`); });
      };
    });
    // Toggle a library profile's inline edit panel. Opening seeds a working-copy
    // draft; nothing is written to the shared library until the user hits Save.
    this.querySelectorAll('.cpce-profile-edit').forEach(btn => {
      btn.onclick = () => {
        const slug = btn.dataset.slug;
        if (this._openProfile === slug) { this._openProfile = null; this._profileDraft = null; }
        else {
          const cur = fixtureLibraryMap('system')[slug];
          this._openProfile = slug;
          this._profileDraft = cur ? { slug, entry: JSON.parse(JSON.stringify(cur)), dirty: false } : null;
        }
        this._render();
      };
    });
    // Save / Discard the open profile draft.
    this.querySelectorAll('.cpce-profile-save').forEach(btn => btn.onclick = () => this._saveProfileDraft(btn.dataset.slug));
    this.querySelectorAll('.cpce-profile-discard').forEach(btn => btn.onclick = () => this._discardProfileDraft(btn.dataset.slug));
    // Create a new profile (opens its editor).
    const addProfileBtn = this.querySelector('#cpce-add-profile');
    if (addProfileBtn) addProfileBtn.onclick = () => this._addFixtureProfile();
    // Library profile edit-panel field wiring (writes straight to the shared library).
    this.querySelectorAll('.cpce-profile-edit-panel').forEach(panel => {
      const slug = panel.dataset.slug;
      const q = (sel) => panel.querySelector(sel);
      const modeEl = q('.cpce-pe-mode');
      if (modeEl) modeEl.addEventListener('change', () => {
        this._mutateProfileDraft(slug, e => {
          const look = { ...(e.look || {}) };
          ALL_PRESET_COLOR_KEYS.forEach(k => delete look[k]); delete look.color_kelvin; delete look.action; delete look.look_none;
          const midK = Math.round(((Number(this._config.min_kelvin)||2000) + (Number(this._config.max_kelvin)||6500)) / 2);
          if (modeEl.value === 'temp') look.color_kelvin = midK;
          else { const rgb = presetColorToRgb(e.look || {}); look.rgb_color = rgb; }  // keep current color as rgb
          e.look = look;
        });
        this._render();
      });
      // Color wheel + hex + native fields (same UI as a Custom Color button).
      this._wireProfileColorWheel(panel, slug);
      const tempEl = q('.cpce-pe-temp'); const tempVal = q('.cpce-temp-val');
      if (tempEl) { tempEl.addEventListener('input', () => { if (tempVal) tempVal.textContent = `${tempEl.value}K`; }); tempEl.addEventListener('change', () => this._patchProfileLook(slug, { color_kelvin: parseInt(tempEl.value,10) })); }
      const briEn = q('.cpce-pe-bri-enable');
      if (briEn) briEn.addEventListener('change', () => { this._patchProfileLook(slug, { brightness: briEn.checked ? (this._profileLook(slug).brightness ?? 255) : null }); this._render(); });
      const briEl = q('.cpce-pe-bri'); const briVal = q('.cpce-bri-val');
      if (briEl) { briEl.addEventListener('input', () => { if (briVal) briVal.textContent = `${briEl.value}%`; }); briEl.addEventListener('change', () => this._patchProfileLook(slug, { brightness: Math.round(clamp(parseInt(briEl.value,10)||1,1,100)*2.55) })); }
      const trEn = q('.cpce-pe-trans-enable');
      if (trEn) trEn.addEventListener('change', () => { this._patchProfileLook(slug, { transition: trEn.checked ? (this._profileLook(slug).transition ?? 1) : null }); this._render(); });
      const trEl = q('.cpce-pe-trans'); const trVal = q('.cpce-transition-val');
      if (trEl) { trEl.addEventListener('input', () => { if (trVal) trVal.textContent = `${trEl.value}s`; }); trEl.addEventListener('change', () => this._patchProfileLook(slug, { transition: clamp(parseFloat(trEl.value)||0,0,10) })); }
      const efEl = q('.cpce-pe-effect');
      if (efEl) efEl.addEventListener('change', () => this._patchProfileLook(slug, { effect: efEl.value.trim() || null }));
    });


    // Scene Manager — collapse/expand the two sub-areas.
    const sceneCreateToggle = this.querySelector('#cpce-scene-create-toggle');
    if (sceneCreateToggle) sceneCreateToggle.onclick = () => { this._sceneCreateCollapsed = !this._sceneCreateCollapsed; this._render(); };
    const sceneNewTr = this.querySelector('#cpce-scene-new-transition');
    const sceneNewTrVal = this.querySelector('#cpce-scene-new-transition-val');
    if (sceneNewTr && sceneNewTrVal) sceneNewTr.addEventListener('input', () => { sceneNewTrVal.textContent = `${sceneNewTr.value} sec`; });
    const sceneListToggle = this.querySelector('#cpce-scene-list-toggle');
    if (sceneListToggle) sceneListToggle.onclick = () => { this._sceneListCollapsed = !this._sceneListCollapsed; this._render(); };

    // ---- Scene Groups (input_select helper management) ----
    // Scene Group filter (card-level). Debounce the text input so typing doesn't re-render per keystroke.
    const sgFilterStr = this.querySelector('#cpce-sg-filter-str');
    if (sgFilterStr) {
      let t;
      sgFilterStr.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { this._updateConfig({ scene_group_filter_str: sgFilterStr.value }); this._render(); }, 400); });
    }
    const sgFilterLabel = this.querySelector('#cpce-sg-filter-label');
    if (sgFilterLabel) sgFilterLabel.addEventListener('change', () => { this._updateConfig({ scene_group_filter_label: sgFilterLabel.value || undefined }); this._render(); });
    const shCreateToggle = this.querySelector('#cpce-sh-create-toggle');
    if (shCreateToggle) shCreateToggle.onclick = () => { this._sceneHelperCreateOpen = !this._sceneHelperCreateOpen; this._render(); };
    // Persist the create-form fields into a draft so a re-render (e.g. from a hass tick) doesn't wipe
    // in-progress typing.
    const shDraftSet = (patch) => { this._sceneHelperDraft = { ...(this._sceneHelperDraft || {}), ...patch }; };
    const shName = this.querySelector('#cpce-sh-name');
    if (shName) shName.addEventListener('input', () => shDraftSet({ name: shName.value }));
    const shOpts = this.querySelector('#cpce-sh-new-options');
    if (shOpts) shOpts.addEventListener('input', () => shDraftSet({ options: shOpts.value }));
    const shInit = this.querySelector('#cpce-sh-initial');
    if (shInit) shInit.addEventListener('input', () => shDraftSet({ initial: shInit.value }));
    const shIcon = this.querySelector('#cpce-sh-icon');
    if (shIcon) shIcon.addEventListener('input', () => shDraftSet({ icon: shIcon.value }));
    const shCreate = this.querySelector('#cpce-sh-create');
    if (shCreate) shCreate.onclick = () => {
      const d = this._sceneHelperDraft || {};
      const name = (d.name || '').trim();
      const options = (d.options || '').split('\n').map(o => o.trim()).filter(Boolean);
      if (!name) { window.alert('Enter a name for the helper.'); return; }
      if (!options.length) { window.alert('Enter at least one option (one per line).'); return; }
      const initial = (d.initial || '').trim();
      if (initial && !options.includes(initial)) { window.alert('The initial option must be one of the listed options.'); return; }
      wsInputSelectCreate(this._hass, { name, options, initial: initial || undefined, icon: (d.icon || '').trim() || undefined })
        .then(() => { this._sceneHelperDraft = null; this._sceneHelperCreateOpen = false; this._sceneHelpers = null; this._ensureSceneHelpers(); this._render(); })
        .catch(e => window.alert(`Could not create helper: ${formatWsError(e)}`));
    };
    // Edit-options toggle (opens the textarea panel for a helper).
    this.querySelectorAll('.cpce-sh-edit').forEach(btn => btn.onclick = () => {
      const ent = btn.dataset.entity;
      this._sceneHelperEditing = this._sceneHelperEditing === ent ? null : ent;
      this._render();
    });
    // Save edited options.
    this.querySelectorAll('.cpce-sh-options-save').forEach(btn => btn.onclick = () => {
      const ent = btn.dataset.entity;
      const ta = this.querySelector(`.cpce-sh-options[data-entity="${ent}"]`);
      const options = ta ? ta.value.split('\n').map(o => o.trim()).filter(Boolean) : [];
      if (!options.length) { window.alert('A helper needs at least one option.'); return; }
      const id = this._helperCollectionId(ent);
      if (!id) { window.alert('Could not resolve this helper for editing (it may be YAML-defined).'); return; }
      // HA's input_select/update is a FULL-object update: `name` is required. Send the current name
      // (+ icon) alongside the new options, else it rejects with "required key not provided @ name".
      const st = this._hass.states[ent];
      const name = friendlyName(this._hass, ent);
      const icon = st && st.attributes && st.attributes.icon;
      wsInputSelectUpdate(this._hass, id, { name, options, icon })
        .then(() => { this._sceneHelperEditing = null; this._sceneHelpers = null; this._ensureSceneHelpers(); this._render(); })
        .catch(e => window.alert(`Could not save options: ${formatWsError(e)}`));
    });
    // Rename helper.
    this.querySelectorAll('.cpce-sh-rename').forEach(btn => btn.onclick = () => {
      const ent = btn.dataset.entity;
      const cur = friendlyName(this._hass, ent);
      const name = (window.prompt('New name for this helper:', cur) || '').trim();
      if (!name || name === cur) return;
      const id = this._helperCollectionId(ent);
      if (!id) { window.alert('Could not resolve this helper for editing.'); return; }
      // Full-object update: carry the existing options + icon so a rename doesn't wipe them.
      const st = this._hass.states[ent];
      const options = (st && st.attributes && Array.isArray(st.attributes.options)) ? st.attributes.options : [];
      const icon = st && st.attributes && st.attributes.icon;
      wsInputSelectUpdate(this._hass, id, { name, options, icon })
        .then(() => { this._sceneHelpers = null; this._ensureSceneHelpers(); this._render(); })
        .catch(e => window.alert(`Could not rename: ${formatWsError(e)}`));
    });
    // Delete helper — warn about references and offer to clean them up.
    this.querySelectorAll('.cpce-sh-delete').forEach(btn => btn.onclick = () => {
      const ent = btn.dataset.entity;
      const id = this._helperCollectionId(ent);
      if (!id) { window.alert('Could not resolve this helper for deletion (it may be YAML-defined).'); return; }
      const refs = this._sceneHelperReferences(ent);
      const refMsg = refs.total ? `\n\n${refs.total} reference${refs.total===1?'':'s'} (${refs.buttons} button${refs.buttons===1?'':'s'}, ${refs.areas} tracker area${refs.areas===1?'':'s'}) point at it and will be removed.` : '';
      if (!this._confirmDelete(`Delete the helper "${friendlyName(this._hass, ent)}"?${refMsg} This deletes the Home Assistant helper itself.`)) return;
      wsInputSelectDelete(this._hass, id)
        .then(() => { if (refs.total) this._cleanupHelperReferences(ent); this._sceneHelpers = null; this._ensureSceneHelpers(); this._render(); })
        .catch(e => window.alert(`Could not delete: ${formatWsError(e)}`));
    });

    // Scene Builder — capture-set picker (which entities the next capture snapshots).
    const capAdd = this.querySelector('.cpce-scene-cap-add');
    if (capAdd) capAdd.onclick = () => {
      const sel = this.querySelector('.cpce-scene-cap-sel'); if (!sel || !sel.value) return;
      this._sceneCaptureSet = [...new Set([...this._sceneCaptureIds(), sel.value])];
      this._render();
    };
    const capSel = this.querySelector('.cpce-scene-cap-sel');
    if (capSel) capSel.addEventListener('change', () => { if (!capSel.value) return; this._sceneCaptureSet = [...new Set([...this._sceneCaptureIds(), capSel.value])]; this._render(); });
    this.querySelectorAll('.cpce-scene-cap-x').forEach(x => x.onclick = () => {
      this._sceneCaptureSet = this._sceneCaptureIds().filter(id => id !== x.dataset.id);
      this._render();
    });

    // Scene Builder: capture the chosen entities' current state into a new HA scene; activate;
    // re-capture (snapshots the scene's OWN members' current state); delete.
    const sceneCaptureBtn = this.querySelector('#cpce-scene-capture');
    if (sceneCaptureBtn) sceneCaptureBtn.onclick = () => {
      const nameEl = this.querySelector('#cpce-scene-new-name');
      const name = nameEl ? nameEl.value.trim() : '';
      if (!name) { window.alert('Enter a name for the new scene.'); return; }
      const trEl = this.querySelector('#cpce-scene-new-transition');
      const transition = trEl ? parseFloat(trEl.value) : 0;
      const iconEl = this.querySelector('#cpce-scene-new-icon');
      const entities = this._captureSceneEntities(this._sceneCaptureIds(), transition);
      if (!Object.keys(entities).length) { window.alert('No entities selected to capture.'); return; }
      sceneCaptureBtn.disabled = true;
      this._saveSceneConfig(newSceneConfigId(), name, entities, iconEl && iconEl.value)
        .then(() => { if (nameEl) nameEl.value = ''; this._sceneCaptureSet = null; this._render(); })
        .catch(e => { console.error(`${LOG_PREFIX} scene save failed`, e); window.alert(`Could not save the scene: ${formatWsError(e)}`); })
        .finally(() => { sceneCaptureBtn.disabled = false; });
    };
    this.querySelectorAll('.cpce-scene-activate').forEach(btn => btn.onclick = () => {
      this._hass && this._hass.callService('scene', 'turn_on', { entity_id: btn.dataset.scene })
        .catch(e => window.alert(`Could not activate scene: ${formatWsError(e)}`));
    });
    // Duplicate a scene: fetch its config, save a new scene (fresh id) with a copied name.
    this.querySelectorAll('.cpce-scene-duplicate').forEach(btn => btn.onclick = () => {
      const sceneEntity = btn.dataset.scene;
      const cfgId = this._sceneConfigId(sceneEntity);
      if (!cfgId || typeof this._hass.callApi !== 'function') { window.alert('This scene has no editable config id (likely YAML/packages) and can’t be duplicated here.'); return; }
      const base = friendlyName(this._hass, sceneEntity);
      const name = window.prompt('Name for the duplicated scene:', `${base} (copy)`);
      if (!name || !name.trim()) return;
      btn.disabled = true;
      this._hass.callApi('GET', `config/scene/config/${cfgId}`)
        .then(cfg => this._saveSceneConfig(newSceneConfigId(), name.trim(), cfg.entities || {}, cfg.icon))
        .then(() => this._render())
        .catch(e => { console.error(`${LOG_PREFIX} scene duplicate failed`, e); window.alert(`Could not duplicate the scene: ${formatWsError(e)}`); })
        .finally(() => { btn.disabled = false; });
    });
    this.querySelectorAll('.cpce-scene-recapture').forEach(btn => btn.onclick = () => {
      const sceneEntity = btn.dataset.scene;
      const cfgId = this._sceneConfigId(sceneEntity);
      if (!cfgId) { window.alert('This scene has no editable config id (likely defined in YAML/packages) and can’t be re-captured here.'); return; }
      // Re-capture snapshots the scene's OWN current members' state (not the Default pool).
      const st = this._hass && this._hass.states[sceneEntity];
      const members = (st && st.attributes && Array.isArray(st.attributes.entity_id)) ? st.attributes.entity_id : [];
      if (!window.confirm(`Overwrite "${friendlyName(this._hass, sceneEntity)}" with the current state of its ${members.length} member ${members.length===1?'entity':'entities'}?`)) return;
      const entities = this._captureSceneEntities(members);
      if (!Object.keys(entities).length) { window.alert('No capturable members found for this scene.'); return; }
      btn.disabled = true;
      this._saveSceneConfig(cfgId, friendlyName(this._hass, sceneEntity), entities)
        .then(() => this._render())
        .catch(e => { console.error(`${LOG_PREFIX} scene recapture failed`, e); window.alert(`Could not update the scene: ${formatWsError(e)}`); })
        .finally(() => { btn.disabled = false; });
    });
    this.querySelectorAll('.cpce-scene-delete').forEach(btn => btn.onclick = () => {
      const sceneEntity = btn.dataset.scene;
      const cfgId = this._sceneConfigId(sceneEntity);
      if (!cfgId) { window.alert('This scene has no editable config id (likely defined in YAML/packages) and can’t be deleted here.'); return; }
      if (!this._confirmDelete(`Delete the scene "${friendlyName(this._hass, sceneEntity)}"? Any button that triggers it will no longer find it.`)) return;
      btn.disabled = true;
      this._deleteSceneConfig(cfgId)
        .then(() => this._render())
        .catch(e => { console.error(`${LOG_PREFIX} scene delete failed`, e); window.alert(`Could not delete the scene: ${formatWsError(e)}`); });
    });
    // Expand/collapse a scene's edit panel (fetch its config on first open).
    this.querySelectorAll('.cpce-scene-edit').forEach(btn => btn.onclick = () => {
      const sceneEntity = btn.dataset.scene;
      if (this._openScene === sceneEntity) { this._openScene = null; this._render(); return; }
      this._openScene = sceneEntity;
      if (!this._sceneConfigCache[sceneEntity] || this._sceneConfigCache[sceneEntity]._error) this._loadSceneConfig(sceneEntity);
      this._render();
    });
    // Scene edit-panel field wiring (edits are cached + dirty until Save Scene).
    this.querySelectorAll('.cpce-scene-edit-panel').forEach(panel => {
      const sceneEntity = panel.dataset.scene;
      panel.querySelectorAll('.cpce-scene-light-state').forEach(sel => sel.addEventListener('change', () => {
        const on = sel.value === 'on';
        this._patchSceneRow(sceneEntity, sel.dataset.id, on ? { state: 'on' } : { state: 'off', brightness: undefined, rgb_color: undefined, xy_color: undefined, hs_color: undefined, rgbw_color: undefined, rgbww_color: undefined, color_temp_kelvin: undefined, effect: undefined, transition: undefined });
        this._render();
      }));
      panel.querySelectorAll('.cpce-scene-row-color').forEach(col => col.addEventListener('input', () => {
        const rgb = ColorUtils.hexToRgb(col.value); if (!rgb) return;
        // Editing a color here normalizes the entry to rgb_color (drops other color keys).
        this._patchSceneRow(sceneEntity, col.dataset.id, { rgb_color: rgb, xy_color: undefined, hs_color: undefined, rgbw_color: undefined, rgbww_color: undefined, color_temp_kelvin: undefined });
        const c = this._sceneConfigCache[sceneEntity]; if (c) c._dirty = true;
      }));
      panel.querySelectorAll('.cpce-scene-row-bri-en').forEach(cb => cb.addEventListener('change', () => {
        const cur = ((this._sceneConfigCache[sceneEntity]||{}).entities||{})[cb.dataset.id] || {};
        this._patchSceneRow(sceneEntity, cb.dataset.id, { brightness: cb.checked ? (cur.brightness ?? 255) : undefined });
        this._render();
      }));
      panel.querySelectorAll('.cpce-scene-row-bri').forEach(sl => sl.addEventListener('change', () => {
        this._patchSceneRow(sceneEntity, sl.dataset.id, { brightness: Math.round(clamp(parseInt(sl.value,10)||1,1,100)*2.55) });
        this._render();
      }));
      // Generic per-domain attribute controls (select/number → value; empty select clears the key).
      panel.querySelectorAll('.cpce-scene-attr').forEach(el => el.addEventListener('change', () => {
        const attr = el.dataset.attr;
        let v = el.value;
        if (v === '') { this._patchSceneRow(sceneEntity, el.dataset.id, { [attr]: undefined }); this._render(); return; }
        if (el.type === 'number') { v = parseFloat(v); if (!Number.isFinite(v)) return; }
        this._patchSceneRow(sceneEntity, el.dataset.id, { [attr]: v });
        this._render();
      }));
      panel.querySelectorAll('.cpce-scene-attr-bool').forEach(cb => cb.addEventListener('change', () => {
        this._patchSceneRow(sceneEntity, cb.dataset.id, { [cb.dataset.attr]: cb.checked });
      }));
      // Media volume slider: 0-100 UI → 0-1 stored.
      panel.querySelectorAll('.cpce-scene-attr-vol').forEach(sl => sl.addEventListener('change', () => {
        this._patchSceneRow(sceneEntity, sl.dataset.id, { volume_level: clamp(parseInt(sl.value,10)||0,0,100) / 100 });
        this._render();
      }));
      // Ranged numeric attributes rendered as sliders: live readout on drag, commit on release.
      panel.querySelectorAll('.cpce-scene-slider').forEach(sl => {
        const valEl = sl.parentElement && sl.parentElement.querySelector('.cpce-scene-slider-val');
        const suffix = valEl ? (valEl.textContent.replace(/^[\d.]+/, '').trim()) : '';
        sl.addEventListener('input', () => { if (valEl) valEl.textContent = `${sl.value}${suffix?` ${suffix}`:''}`; });
        sl.addEventListener('change', () => {
          const v = parseFloat(sl.value); if (!Number.isFinite(v)) return;
          this._patchSceneRow(sceneEntity, sl.dataset.id, { [sl.dataset.attr]: v });
          this._render();
        });
      });
      // Remove an entity from the scene.
      panel.querySelectorAll('.cpce-scene-row-remove').forEach(btn => btn.onclick = () => {
        const c = this._sceneConfigCache[sceneEntity]; if (!c || !c.entities) return;
        if (!window.confirm(`Remove "${friendlyName(this._hass, btn.dataset.id)}" from this scene?`)) return;
        delete c.entities[btn.dataset.id]; c._dirty = true;
        this._render();
      });
      // Scene name / icon (edit-panel header).
      const nameEl2 = panel.querySelector('.cpce-scene-name');
      if (nameEl2) nameEl2.addEventListener('change', () => { const c = this._sceneConfigCache[sceneEntity]; if (!c) return; c.name = nameEl2.value; c._dirty = true; this._render(); });
      const iconEl2 = panel.querySelector('.cpce-scene-icon');
      if (iconEl2) iconEl2.addEventListener('change', () => { const c = this._sceneConfigCache[sceneEntity]; if (!c) return; c.icon = iconEl2.value; c._dirty = true; this._render(); });
      // Add an entity to the scene (searchable, cross-platform). Seeds a default/live entry.
      this._wireEntitySearchPicker(panel, 'cpce-scene-add-picker', (id) => {
        const c = this._sceneConfigCache[sceneEntity]; if (!c || !id) return;
        if (!c.entities) c.entities = {};
        if (!c.entities[id]) { c.entities[id] = this._defaultSceneEntry(id); c._dirty = true; this._render(); }
      });
      const saveBtn = panel.querySelector('.cpce-scene-save');
      if (saveBtn) saveBtn.onclick = () => {
        const c = this._sceneConfigCache[sceneEntity]; if (!c || !c._cfgId || !c._dirty) return;
        saveBtn.disabled = true;
        this._saveSceneConfig(c._cfgId, c.name || friendlyName(this._hass, sceneEntity), c.entities, c.icon)
          .then(() => { c._dirty = false; this._render(); })
          .catch(e => { console.error(`${LOG_PREFIX} scene edit save failed`, e); window.alert(`Could not save the scene: ${formatWsError(e)}`); saveBtn.disabled = false; });
      };
    });

    // Presets
    this._attachPresetListeners();
    const addBtn = this.querySelector('#cpce-add-preset');
    if (addBtn) addBtn.onclick = () => this._addNewPreset();
  }

  // Adds a new preset, optionally creating and linking a new input_color entity
  // for it when the user opts in.
  _addNewPreset() {
    // Seed the new button's color in the NATIVE format of the target lights (rgb → xy → hs),
    // so it's stored/sent without a lossy conversion — same rule the mode switcher uses.
    const supported = getUnionColorModes(this._hass, this._entityIds ? this._entityIds() : (this._config.entities || []));
    const preferFmt = ['rgb', 'xy', 'hs'].find(f => supported.includes(FORMAT_TO_COLOR_MODE[f])) || 'rgb';
    const seedVal = preferFmt === 'xy' ? ColorUtils.rgbToXy(255, 0, 0) : (preferFmt === 'hs' ? ColorUtils.rgbToHs(255, 0, 0) : [255, 0, 0]);
    const newPreset = { id: newPresetId(), name: 'New Preset', icon: modeDefaultIcon('color'), mode: 'color', [PRESET_COLOR_KEYS[preferFmt]]: seedVal };

    const finish = (preset) => {
      const presets = [...(this._config.presets || []), preset];
      this._openPreset = presets.length - 1;
      this._updateConfig({ presets });
      this._render();
    };

    if (!this._hass || !window.confirm('Create a linked Color Entity (color helper) for this new preset?')) {
      finish(newPreset);
      return;
    }

    const entityName = window.prompt('Name for the new Color Entity:', newPreset.name);
    if (!entityName || !entityName.trim()) { finish(newPreset); return; }

    newPreset.name = entityName.trim();
    this._createInputColorEntity(entityName.trim(), newPreset).then(entityId => {
      if (entityId) newPreset.input_color_entity = entityId;
      finish(newPreset);
    });
  }
}

// ============ REGISTER ============
if (!customElements.get('color-light-manager-card')) customElements.define('color-light-manager-card', ColorLightManagerCard);
if (!customElements.get('color-light-manager-card-editor')) customElements.define('color-light-manager-card-editor', ColorLightManagerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({ type: 'color-light-manager-card', name: 'Color Light & Scene Manager', description: 'Control colored lights (color temp / RGB / RGBWW) and author Home Assistant scenes — with preset buttons, Fixture Profiles, and Color Entity management.', preview: true });

console.log(`${LOG_PREFIX} Loaded ${BUILD_NUMBER}`);
