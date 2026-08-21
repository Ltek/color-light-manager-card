// ============================================================================
// Color Light Manager for Home Assistant
//
// Create Fixture Profiles & Dashboard controls, and manage Color entities — all from a
// single GUI-driven UI, backed by the Color helper (the `color` domain; legacy
// `input_color.*` entities are still supported for existing configs).
//
// Version: v2026.08.21.86
//
// Author:  LTek
// Card:    https://github.com/Ltek/color-light-manager-card
//
// ============================================================================

const BUILD_NUMBER = 'v2026.08.21.86';
const CARD_NAME = 'Color Light Manager';
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
  scene: 'mdi:palette',
  temp: 'mdi:thermometer',
  color: 'mdi:palette-outline',
};
function modeDefaultIcon(mode) { return MODE_DEFAULT_ICON[mode] || 'mdi:lightbulb'; }
// Icons we treat as "not user-customized" — the generic old defaults plus every mode default.
// A preset carrying one of these gets the CURRENT mode's default at render time, so buttons
// created before per-mode icons (all saved as mdi:lightbulb) still reflect their Mode.
const GENERIC_DEFAULT_ICONS = new Set(['mdi:lightbulb', 'mdi:lightbulb-off', ...Object.values(MODE_DEFAULT_ICON)]);
// The icon a button should display: the user's custom icon if they set a non-generic one,
// otherwise the default glyph for its mode.
function resolvePresetIcon(preset, mode) {
  const icon = preset && preset.icon;
  if (icon && !GENERIC_DEFAULT_ICONS.has(icon)) return icon;
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
// Ported from the Easy Entity Styler card's proven Frame Preset Library.
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
      map[slug] = { id: 'lib:' + slug, slug, name: p.name || slug, look };
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
    profiles[slug] = { name: e.name || slug, look: extractProfileLook(e.look || {}) };
  });
  const value = { color_light_manager_fixtures: FIXTURE_LIB_VERSION, profiles };
  return hass.connection.sendMessagePromise({ type: _fixtureLibWs(scope, 'set'), key: FIXTURE_LIB_KEY, value });
}
// Is a value a library reference (lib:<slug>)? Returns the slug or null.
function fixtureRefSlug(ref) {
  return (typeof ref === 'string' && ref.startsWith('lib:')) ? ref.slice(4) : null;
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
  // Already migrated? Use as-is (filtered to known types).
  if (Array.isArray(cfg.sections) && cfg.sections.length) {
    return cfg.sections.filter(s => s && ['buttons', 'sliders', 'values'].includes(s.type));
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
      button_glow_enabled: false,
      button_glow_color: '#2196F3',
      button_glow_color_mode: 'fixed', // fixed | match (match = current light color)
      button_glow_intensity: 1.0,
      button_glow_condition: 'always', // always | when_active (only relevant when button_glow_enabled is true)
      // ---- Button appearance ----
      // solid = filled with the preset color (default); tile = large card-style tile with
      // a subtle color-tinted gradient background and a colored icon (Mushroom-room look).
      button_style: 'solid',
      // ---- Button sizing ----
      button_font_size: 14,
      button_name_weight: '600', // 300|400|500|600|700 — weight of the button label text
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
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    this._config = { ...ColorLightManagerCard.getStubConfig(), ...config };
    // Heal any duplicate preset ids from older builds (they broke per-button glow lookups).
    this._config.presets = dedupePresetIds(this._config.presets);
    DEBUG = this._config.debug || false;
    // Collapsible cards start collapsed. Resolve the initial state only once so a later
    // config round-trip (or hass update) doesn't re-collapse a card the user has expanded.
    if (!this._collapseInitialized) {
      this._cardCollapsed = this._config.card_collapsible === true;
      this._collapseInitialized = true;
    }
    this.renderCard();
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
    if (!this._rendered) { this.renderCard(); this._rendered = true; return; }
    // Linked buttons take their color/brightness live from their Color Entity. A button's
    // color/tint is computed at full render (not in updateStates), so when any linked entity's
    // state changes, re-render so those buttons reflect the entity. These helper entities only
    // change on a deliberate set_color, so this is rare and cheap.
    if (prev && this._linkedColorEntitiesChanged(prev, hass)) { this.renderCard(); return; }
    this.updateStates();
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

  // True if any preset resolves its look from a library profile (lib:<slug> ref).
  _usesFixtureLibraryRef() {
    const presets = this._config && this._config.presets;
    return Array.isArray(presets) && presets.some(p => !!fixtureRefSlug(p && p.profile_ref));
  }

  connectedCallback() {
    this._favoritesUnsub = favoritesService.subscribe(favs => { this._favorites = favs; this._renderFavoritesBar(); });
    this._favorites = favoritesService.getFavorites();
  }
  disconnectedCallback() { if (this._favoritesUnsub) { this._favoritesUnsub(); this._favoritesUnsub = null; } }
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
  // Representative state for a section's live readout — its first target light.
  _sectionPrimaryState(section) {
    const ids = this._sectionTargetIds(section);
    if (!ids.length || !this._hass) return null;
    return this._hass.states[ids[0]] || null;
  }
  _primaryState(targetEntities) {
    const ids = targetEntities ? this._targetIds(targetEntities) : this._entityIds();
    if (!ids.length || !this._hass) return null;
    return this._hass.states[ids[0]] || null;
  }
  // The representative light state for a preset's active/glow detection — its first
  // color-control light, or (no color targets) the card's first entity as a fallback.
  _presetPrimaryState(preset) {
    const ids = this._presetColorIds(preset);
    const use = ids.length ? ids : this._entityIds();
    if (!use.length || !this._hass) return null;
    return this._hass.states[use[0]] || null;
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

  // A preset is an additive bundle of actions, all fired in parallel on press:
  //   1. color/temp OR off — on its Color Control Lights (unless target mode is None)
  //   2. activate any linked Scenes (scene.turn_on)
  //   3. turn off its Turn-Off entity set (light.turn_off)
  _applyPreset(rawPreset) {
    if (!rawPreset) return;
    // Resolve the look from a referenced library profile (if any) before applying. Targets,
    // scenes, and turn-off set stay on the raw preset (button-owned); only the look resolves.
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

    // 2. Activate scenes (button-owned; each button picks any scene.* directly — there's no
    // card-level scene pool to validate against). Fire only entities that still exist.
    (rawPreset.scenes || []).forEach(scene => {
      if (!this._hass) return;
      if (!this._hass.states[scene]) { console.warn(`[ColorLightManagerCard] scene ${scene} not found`); return; }
      this._hass.callService('scene', 'turn_on', { entity_id: scene })
        .catch(e => console.warn('[ColorLightManagerCard] scene.turn_on failed', e));
    });

    // 3. Turn off the preset's turn-off set (button-owned; limited to the card's entities).
    const offIds = this._targetIds(rawPreset.turn_off_entities).filter(id => (rawPreset.turn_off_entities || []).includes(id));
    if (offIds.length) this._callLightService('turn_off', {}, offIds);
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

  _brightnessEndColor(currentRgb) {
    const cfg = this._config;
    if (cfg.brightness_end_color_mode === 'current') return currentRgb;
    return ColorUtils.hexToRgb(cfg.brightness_end_color) || [255, 255, 255];
  }

  // Builds a 3-stop gradient (start -> midpoint -> end) so "strength" can shift how
  // much of the bar stays dark before lightening, without needing canvas rendering.
  // Direction follows the handle mapping: horizontal goes dark(left)->bright(right);
  // vertical goes dark(bottom)->bright(top), matching pct=0 at the bottom.
  _brightnessGradientCss(currentRgb) {
    const cfg = this._config;
    const startRgb = ColorUtils.hexToRgb(cfg.brightness_start_color) || [0, 0, 0];
    const endRgb = this._brightnessEndColor(currentRgb);
    const midRgb = ColorUtils.mixRgb(startRgb, endRgb, 0.5);
    const strength = clamp(Number(cfg.brightness_gradient_strength), 0, 100);
    const midPct = Number.isFinite(strength) ? strength : 50;
    const startHex = ColorUtils.rgbToHex(...startRgb);
    const midHex = ColorUtils.rgbToHex(...midRgb);
    const endHex = ColorUtils.rgbToHex(...endRgb);
    const direction = cfg.slider_orientation === 'vertical' ? 'to top' : 'to right';
    return `linear-gradient(${direction}, ${startHex} 0%, ${midHex} ${midPct}%, ${endHex} 100%)`;
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
    const presetsHtml = (cfg.presets || []).map(p => this._renderPresetButton(p)).join('');

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

    const glowShadow = this._cardGlowCss(currentRgb);
    const dropShadow = this._cardDropShadowCss();
    const combinedShadow = [glowShadow !== 'none' ? glowShadow : null, dropShadow].filter(Boolean).join(', ') || 'none';

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
      ? `<div class="${headerClasses}" id="cpc-header">${showTitleIcon ? `<ha-icon class="cpc-title-icon" id="cpc-title-icon" icon="${escapeHtml(cfg.icon)}"></ha-icon>` : ''}${showTitleText ? `<span class="cpc-title-text">${escapeHtml(cfg.title)}</span>` : (collapsible ? '<span class="cpc-title-text"></span>' : '')}${showChevron ? `<ha-icon class="cpc-chevron${expanded ? ' expanded' : ''}" icon="mdi:chevron-down"></ha-icon>` : ''}</div>`
      : '';

    this.innerHTML = `
      <style>
        .cpc-card {
          background: ${this._cardBackgroundCss()};
          ${this._cardRadiusCss()}
          padding: calc(16px * ${scale});
          box-sizing: border-box;
          ${this._cardBorderCss()}
          box-shadow: ${combinedShadow};
        }
        .cpc-header { display:flex; align-items:center; gap:8px; margin-bottom:calc(14px * ${scale}); color:${titleColor}; font-size:calc(${titleFontSize}px * ${scale}); font-weight:${titleFontWeight}; }
        .cpc-header ha-icon { --mdc-icon-size:calc(${iconSize}px * ${scale}); }
        .cpc-header ha-icon.cpc-title-icon { color:${this._headerIconColorCss(state)}; }
        .cpc-header.collapsible { cursor:pointer; user-select:none; }
        /* Minimal bar when collapsible but no title/icon: reserve a small clickable height. */
        .cpc-header-minimal { min-height:calc(20px * ${scale}); margin-bottom:${collapsible && this._cardCollapsed ? '0' : `calc(14px * ${scale})`}; justify-content:flex-end; }
        .cpc-header .cpc-title-text { flex:1; }
        .cpc-section-name { margin-bottom:calc(6px * ${scale}); }
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
  _isPresetActive(preset, state) {
    if (!state) return false;
    const attrs = state.attributes || {};
    const mode = presetMode(preset);
    if (mode === 'off') return state.state === 'off';
    if (state.state !== 'on') return false;
    // Compare the preset's color to the light's current color. Prefer comparing in the SAME
    // native format both sides report (xy↔xy, hs↔hs) to avoid lossy cross-conversion — a
    // gamut-shifting controller's xy→rgb differs from ours, which made XY presets never match.
    // Otherwise fall back to an RGB approximation with a generous tolerance for such controllers.
    const fmt = presetColorFormat(preset);
    const near = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const colorMatches = () => {
      if (fmt === 'xy' && Array.isArray(attrs.xy_color)) return near(preset.xy_color, attrs.xy_color, 0.05);
      if (fmt === 'hs' && Array.isArray(attrs.hs_color)) return near(preset.hs_color, attrs.hs_color, 8);
      // RGB comparison fallback (tolerance widened to 32 for controllers that gamut-shift).
      const target = presetColorToRgb(preset);
      const cur = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
        : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
      return near(target, cur, 32);
    };
    const tempMatches = () => {
      const k = attrsToKelvin(attrs);
      if (k !== undefined) return Math.abs(k - preset.color_kelvin) <= 40;
      // The light is driven in a color mode (the configured temperature send format) and
      // reports no kelvin. Compare in that same format where possible to avoid lossy math.
      const outFmt = this._config.temperature_output_format;
      if (outFmt === 'xy' && Array.isArray(attrs.xy_color)) return near(ColorUtils.kelvinToXy(preset.color_kelvin), attrs.xy_color, 0.05);
      if (outFmt === 'hs' && Array.isArray(attrs.hs_color)) return near(ColorUtils.kelvinToHs(preset.color_kelvin), attrs.hs_color, 8);
      const target = ColorUtils.kelvinToRgb(preset.color_kelvin);
      const cur = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
        : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
      return near(target, cur, 32);
    };
    if (mode === 'color') return colorMatches();
    if (mode === 'temp') return tempMatches();
    return false;
  }

  _presetBorderAndGlowCss(preset, state) {
    const cfg = this._config;
    const parts = { border: '', boxShadow: 'none' };
    if (cfg.button_border_enabled) {
      const w = Number(cfg.button_border_width) || 1;
      let color = cfg.button_border_color || '#2196F3';
      // "Match Button Color": border = a lighter shade of this button's own preset color
      // (mix ~45% toward white), matching the room-card look where the outline is the
      // lightest shade of the tile. Off presets (no color) keep the fixed/theme color.
      if (cfg.button_border_color_mode === 'match') {
        const isOff = preset.action === 'turn_off';
        if (!isOff) {
          const rgb = presetColorToRgb(preset);
          if (rgb) color = ColorUtils.rgbToHex(...ColorUtils.mixRgb(rgb, [255, 255, 255], 0.45));
        }
      }
      parts.border = `border: ${w}px solid ${color};`;
    }
    if (cfg.button_glow_enabled) {
      const condition = cfg.button_glow_condition || 'never';
      const shouldGlow = condition === 'always' || (condition === 'when_active' && this._isPresetActive(preset, state));
      if (shouldGlow) {
        let color = cfg.button_glow_color || '#2196F3';
        // "match" mode uses the light's current color (falls back to the fixed color when off/unknown).
        if (cfg.button_glow_color_mode === 'match') {
          const attrs = (state && state.attributes) || {};
          let rgb = Array.isArray(attrs.rgb_color) ? attrs.rgb_color
            : (Array.isArray(attrs.xy_color) ? ColorUtils.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]) : null);
          if (!rgb) { const k = attrsToKelvin(attrs); if (k !== undefined) rgb = ColorUtils.kelvinToRgb(k); }
          if (rgb && state && state.state === 'on') color = ColorUtils.rgbToHex(...rgb);
        }
        const intensity = Number(cfg.button_glow_intensity) || 1.0;
        parts.boxShadow = `0 0 ${12 * intensity}px ${-2 * intensity}px ${color}`;
      }
    }
    return parts;
  }

  _renderPresetButton(preset) {
    const cfg = this._config;
    // Visual look (color/action) resolves through any referenced library profile; name/icon/
    // id stay button-owned (read from `preset`).
    const look = this._effectivePreset(preset);
    const isOff = look.action === 'turn_off';
    // Styling color: an explicit per-button style color overrides the look-derived color
    // (so scene-only/None buttons can still look intentional); else derive from the look.
    const styleOverride = preset.button_style_color ? ColorUtils.hexToRgb(preset.button_style_color) : null;
    const rgb = styleOverride || presetColorToRgb(look);
    const bg = ColorUtils.rgbToHex(...rgb);
    const hasStyleOverride = !!styleOverride;
    // Active-state/glow follows the preset's OWN target light, not the card's primary.
    const state = this._presetPrimaryState(preset);
    const { border, boxShadow } = this._presetBorderAndGlowCss(look, state);
    const radius = Number(cfg.button_border_radius);
    const icon = escapeHtml(resolvePresetIcon(preset, buttonMode(preset)));
    // Raise glowing buttons above neighbors so their halo isn't overpainted (see .cpc-glowing).
    const glowCls = boxShadow && boxShadow !== 'none' ? ' cpc-glowing' : '';

    // Tinted style: a large card-style button with a subtle color-tinted gradient background
    // and a colored icon (the "room card" look). The preset color drives the tint + icon;
    // for Off (no color) we fall back to a neutral tile with theme text color.
    // (Accepts legacy value "tile" for backward compatibility with older configs.)
    if (cfg.button_style === 'tinted' || cfg.button_style === 'tile') {
      const radiusCss = Number.isFinite(radius) ? `border-radius:${radius}px;` : '';
      let bgCss, iconColor;
      if (isOff && !hasStyleOverride) {
        bgCss = 'background:linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));';
        iconColor = 'var(--secondary-text-color)';
      } else {
        // Diagonal tint from a stronger corner to near-transparent, over the dark card.
        bgCss = `background:linear-gradient(135deg, ${ColorUtils.hexToRgba(bg, 0.35)}, ${ColorUtils.hexToRgba(bg, 0.06)});`;
        iconColor = bg;
      }
      const styleAttr = `style="${bgCss}${border}${radiusCss}box-shadow:${boxShadow};--cpc-tile-icon-color:${iconColor};"`;
      return `<button class="cpc-preset-btn cpc-tile${glowCls} ${isOff ? 'off-style' : ''}" data-preset-id="${escapeHtml(preset.id)}" ${styleAttr}><ha-icon icon="${icon}"></ha-icon><span class="cpc-tile-name cpc-btn-label">${escapeHtml(preset.name)}</span></button>`;
    }

    const radiusCss = Number.isFinite(radius) ? `border-radius:${radius}px;` : '';
    const bgCss = (isOff && !hasStyleOverride) ? '' : `background:${bg};`;
    const styleAttr = `style="${bgCss}${border}${radiusCss}box-shadow:${boxShadow};"`;
    return `<button class="cpc-preset-btn${glowCls} ${isOff ? 'off-style' : ''}" data-preset-id="${escapeHtml(preset.id)}" ${styleAttr}><ha-icon icon="${icon}"></ha-icon><span class="cpc-btn-label">${escapeHtml(preset.name)}</span></button>`;
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
  _renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, includeText, sliderId) {
    const trackStyle = gradientCss ? ` style="background:${gradientCss};"` : '';
    const vertical = this._config.slider_orientation === 'vertical';
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
    const vertical = cfg.slider_orientation === 'vertical';
    const placement = vertical ? (cfg.slider_text_placement_vertical || 'inside') : (cfg.slider_text_placement_horizontal || 'inside');

    if (vertical) {
      // "inside": label/value overlaid on the bar (top/bottom of the bar itself).
      // "outside": label sits in its own row above the bar, value in a row below.
      if (placement === 'outside') {
        return `
          <div class="cpc-slider-row">
            ${this._renderTextRow(label, '', showLabel, false, labelPos, valuePos)}
            ${this._renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, false, sliderId)}
            ${this._renderTextRow('', value, false, showValue, labelPos, valuePos)}
          </div>
        `;
      }
      return `<div class="cpc-slider-row">${this._renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, true, sliderId)}</div>`;
    }

    // Horizontal: "inside" overlays the bar; "above"/"below" render a single text
    // row (label + value together) on that side of the bar instead.
    const bar = this._renderSliderBar(type, pct, label, value, gradientCss, showLabel, showValue, labelPos, valuePos, placement === 'inside', sliderId);
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

    this.querySelectorAll('.cpc-preset-btn').forEach(btn => {
      btn.onclick = () => {
        const preset = (this._config.presets || []).find(p => p.id === btn.dataset.presetId);
        // Remember the last-pressed preset id so glow/header "active" color mode can follow the
        // color the card most recently applied (pure intent — independent of live light state).
        if (preset) this._lastPressedPresetId = preset.id;
        this._applyPreset(preset);
        // Refresh glow/header immediately so "active" color mode reflects this press.
        if (this._config.card_glow_color_mode === 'active' || this._config.icon_color_mode === 'active') this.updateStates();
      };
    });

    const debounceMs = clamp(Number(this._config.slider_debounce_ms) || 100, 0, 1000);

    // Wire every slider in every slider section, each acting on its OWN section target.
    this._orderedSections().filter(s => s.type === 'sliders').forEach(section => {
      const ids = () => this._sectionTargetIds(section);
      const sid = `#cpc-slider-${section.id}`;

      // onCommit receives the raw pct (rAF-decoupled from onVisual); each converts pct→value.
      const commitBrightness = throttle((pct) => this._setBrightness(pct, ids()), debounceMs);
      this._wireSlider(`${sid}-brightness`, {
        onVisual: (pct) => this._updateSliderVisual(`${sid}-brightness`, pct, `${Math.round(pct)}%`),
        onCommit: commitBrightness,
        onFinal: (pct) => { commitBrightness.cancel(); this._setBrightness(pct, ids()); },
      });

      const commitTemp = throttle((pct) => this._setColorTemp(this._pctToKelvin(pct, this._config), ids()), debounceMs);
      this._wireSlider(`${sid}-temperature`, {
        onVisual: (pct) => {
          const kelvin = this._pctToKelvin(pct, this._config);
          this._updateSliderVisual(`${sid}-temperature`, pct, this._tempReadout(kelvin), true);
        },
        onCommit: commitTemp,
        onFinal: (pct) => { commitTemp.cancel(); this._setColorTemp(this._pctToKelvin(pct, this._config), ids()); },
      });

      const commitRgb = throttle((pct) => { const hue = Math.round((pct / 100) * 360); this._setRgb(ColorUtils.hsToRgb(hue, 100), ids()); }, debounceMs);
      this._wireSlider(`${sid}-rgb`, {
        onVisual: (pct) => {
          const hue = Math.round((pct / 100) * 360); const rgb = ColorUtils.hsToRgb(hue, 100);
          this._updateSliderVisual(`${sid}-rgb`, pct, `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
        },
        onCommit: commitRgb,
        onFinal: (pct) => {
          commitRgb.cancel();
          const hue = Math.round((pct / 100) * 360);
          this._setRgb(ColorUtils.hsToRgb(hue, 100), ids());
        },
      });
    });
  }

  // Splits visual feedback (instant, every move) from the actual service call
  // (throttled during drag, plus one guaranteed final call on release) so dragging
  // feels smooth and doesn't flood Home Assistant with requests.
  _wireSlider(selector, { onVisual, onCommit, onFinal }) {
    const el = this.querySelector(selector);
    if (!el) return;
    let dragging = false;
    let lastPct = 0;
    const vertical = this._config.slider_orientation === 'vertical';
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
  _updateSliderVisual(selector, pct, valueText, isHtml) {
    const el = this.querySelector(selector);
    if (!el) return;
    const handle = el.querySelector('.cpc-bar-handle');
    const val = el.querySelector('.cpc-bar-value');
    if (handle) {
      if (this._config.slider_orientation === 'vertical') { handle.style.bottom = `${pct}%`; handle.style.left = ''; }
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
    return ordered;
  }

  // Optional per-section name heading, with configurable size/weight/color.
  _sectionHeading(section) {
    if (!section.name_show || !section.name) return '';
    const size = Number(section.name_font_size) || 13;
    const weight = section.name_font_weight || '600';
    const color = section.name_color || 'var(--primary-text-color)';
    const scale = Number(this._config.scale) || 1.0;
    return `<div class="cpc-section-name" style="font-size:calc(${size}px * ${scale});font-weight:${weight};color:${color};">${escapeHtml(section.name)}</div>`;
  }

  // Renders one section object. Slider/values sections read their OWN target's state.
  _renderSection(section, ctx) {
    const cfg = this._config;
    const heading = this._sectionHeading(section);
    if (section.type === 'buttons') {
      const layoutClass = `layout-${cfg.layout || 'columns'}`;
      const div = `${cfg.divider_buttons_top ? ' cpc-div-top' : ''}${cfg.divider_buttons_bottom ? ' cpc-div-bottom' : ''}`;
      // Presets belonging to this section (a preset's section_id; unassigned → first buttons section).
      const presetsHtml = this._presetsForSection(section.id).map(p => this._renderPresetButton(p)).join('');
      return `<div class="cpc-section${div}" data-section-id="${section.id}">${heading}<div class="cpc-presets ${layoutClass}">${presetsHtml}</div></div>`;
    }
    if (section.type === 'sliders') {
      const div = `${cfg.divider_sliders_top ? ' cpc-div-top' : ''}${cfg.divider_sliders_bottom ? ' cpc-div-bottom' : ''}`;
      const sel = section.sliders || { brightness: true, temperature: true, rgb: true };
      // This section's own target state drives its slider positions.
      const st = this._sectionPrimaryState(section);
      const attrs = (st && st.attributes) || {};
      const briPct = attrs.brightness ? Math.round((attrs.brightness / 255) * 100) : 0;
      const kelvin = attrsToKelvin(attrs) || Math.round(((Number(cfg.min_kelvin)||2000) + (Number(cfg.max_kelvin)||6500)) / 2);
      const rgb = attrs.rgb_color || [255, 255, 255];
      return `<div class="cpc-section${div}" data-section-id="${section.id}">${heading}<div class="cpc-sliders">
        ${sel.brightness ? this._renderSlider('brightness', briPct, null, this._brightnessGradientCss(rgb), section.id) : ''}
        ${sel.temperature ? this._renderSlider('temperature', this._kelvinToPct(kelvin, cfg), kelvin, null, section.id) : ''}
        ${sel.rgb ? this._renderSlider('rgb', this._rgbToPct(rgb), rgb, null, section.id) : ''}
      </div></div>`;
    }
    if (section.type === 'values') {
      // A values section renders by virtue of existing (its presence is the enable). It reads
      // its own target's state and uses a per-section DOM id so multiple can coexist.
      const div = `${cfg.divider_values_top ? ' cpc-div-top' : ''}${cfg.divider_values_bottom ? ' cpc-div-bottom' : ''}`;
      const st = this._sectionPrimaryState(section);
      return `<div class="cpc-section${div}" data-section-id="${section.id}">${heading}${this._currentValuesBlock(st, section.id)}</div>`;
    }
    return '';
  }

  // Presets assigned to a section. A preset's section_id names its section; presets with no
  // section_id (or a stale one) fall back to the FIRST buttons section so none are orphaned.
  _presetsForSection(sectionId) {
    const presets = this._config.presets || [];
    const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
    const firstButtonsId = buttonsSections.length ? buttonsSections[0].id : null;
    const validIds = new Set(buttonsSections.map(s => s.id));
    return presets.filter(p => {
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

      const brightnessEl = this.querySelector(`${sid}-brightness`);
      if (attrs.brightness !== undefined && brightnessEl && !brightnessEl._dragging) {
        const pct = Math.round((attrs.brightness / 255) * 100);
        if (!this._sliderSettling(brightnessEl, pct)) {
          this._updateSliderVisual(`${sid}-brightness`, pct, `${pct}%`);
          if (cfg.brightness_end_color_mode === 'current' && attrs.rgb_color) {
            const track = brightnessEl.querySelector('.cpc-bar-track');
            if (track) track.style.background = this._brightnessGradientCss(attrs.rgb_color);
          }
        }
      }

      const tempEl = this.querySelector(`${sid}-temperature`);
      const kelvin = attrsToKelvin(attrs);
      if (kelvin !== undefined && tempEl && !tempEl._dragging) {
        const pct = this._kelvinToPct(kelvin, cfg);
        if (!this._sliderSettling(tempEl, pct)) this._updateSliderVisual(`${sid}-temperature`, pct, this._tempReadout(kelvin), true);
      }

      const rgbEl = this.querySelector(`${sid}-rgb`);
      if (attrs.rgb_color && rgbEl && !rgbEl._dragging) {
        const pct = this._rgbToPct(attrs.rgb_color);
        if (!this._sliderSettling(rgbEl, pct)) this._updateSliderVisual(`${sid}-rgb`, pct, `rgb(${attrs.rgb_color[0]}, ${attrs.rgb_color[1]}, ${attrs.rgb_color[2]})`);
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

    // Refresh the card glow live whenever its appearance could depend on what changed: the
    // light's color ('light' mode), the last-pressed color ('active' mode), or on/off
    // (when_light_on condition).
    if (cfg.card_glow_enabled && (cfg.card_glow_color_mode === 'light' || cfg.card_glow_color_mode === 'active' || cfg.card_glow_condition === 'when_light_on')) {
      const cardEl = this.querySelector('.cpc-card');
      if (cardEl) {
        const glowShadow = this._cardGlowCss(attrs.rgb_color);
        const dropShadow = this._cardDropShadowCss();
        cardEl.style.boxShadow = [glowShadow !== 'none' ? glowShadow : null, dropShadow].filter(Boolean).join(', ') || 'none';
      }
    }

    // Refresh button glow live when it depends on state: the "when_active" condition, or
    // "match" color mode (glow tracks the light's current color).
    if (cfg.button_glow_enabled && (cfg.button_glow_condition === 'when_active' || cfg.button_glow_color_mode === 'match')) {
      const byId = new Map((cfg.presets || []).map(p => [p.id, p]));
      const btns = this.querySelectorAll('.cpc-preset-btn');
      const rows = DEBUG ? [] : null;
      btns.forEach(btn => {
        const preset = byId.get(btn.dataset.presetId);
        if (!preset) return;
        try {
          const look = this._effectivePreset(preset);
          const st = this._presetPrimaryState(preset);
          const { boxShadow } = this._presetBorderAndGlowCss(look, st);
          btn.style.boxShadow = boxShadow;
          btn.classList.toggle('cpc-glowing', !!boxShadow && boxShadow !== 'none');
          if (rows) rows.push({ name: preset.name, mode: presetMode(look), active: this._isPresetActive(look, st), glow: boxShadow !== 'none' });
        } catch (e) {
          console.warn(`${LOG_PREFIX} glow update failed for preset ${btn.dataset.presetId}:`, e);
        }
      });
      if (rows) { debugLog(`glow refresh — condition=${cfg.button_glow_condition}, colorMode=${cfg.button_glow_color_mode}`); console.table(rows); }
    }
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
    this._openColorEntity = null;        // entity_id whose inline edit panel is open (Color Entities)
    // Collapse state for the Color Entities sub-areas (they can get long with many entities).
    this._ceCollapsed = { manage: false, create: true, orphans: true };
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

  // Section objects (migrating legacy configs on the fly). The editor is a separate class
  // from the card, so it has its own copies of these helpers.
  _orderedSectionsRaw() { return buildSections(this._config); }
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

  // Persists an updated sections array (also normalizes section_order to match).
  _updateSections(sections) {
    const order = sections.map(s => s.id);
    this._updateConfig({ sections, section_order: order });
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

  _section(icon, title, id, bodyHtml) {
    const collapsed = this._openSection === id ? '' : ' collapsed';
    return `<div class="cpce-sec${collapsed}" data-sec-id="${id}"><div class="cpce-sec-header" data-target="${id}"><ha-icon icon="${icon}"></ha-icon><span>${title}</span><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></div><div class="cpce-sec-body">${bodyHtml}</div></div>`;
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
        <button class="cpce-scene-remove" data-scene="${escapeHtml(id)}" title="Remove">×</button>
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
  _presetSwatch(preset) {
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
    // Color Entity link
    const linked = preset.input_color_entity;
    if (linked) {
      const exists = this._allInputColorEntities.includes(linked);
      badges.push(exists
        ? `<ha-icon class="cpce-link-indicator" icon="mdi:link-variant" title="Linked to Color Entity ${escapeHtml(linked)}"></ha-icon>`
        : `<ha-icon class="cpce-link-indicator cpce-link-broken" icon="mdi:link-variant-off" title="Broken link — Color Entity ${escapeHtml(linked)} no longer exists"></ha-icon>`);
    }
    // Fixture Profile reference
    const slug = fixtureRefSlug(preset.profile_ref);
    if (slug) {
      const entry = fixtureLibraryMap(this._config && this._config.fixture_library_scope)[slug];
      badges.push(entry
        ? `<ha-icon class="cpce-link-indicator" icon="mdi:palette-swatch" title="Uses Fixture Profile “${escapeHtml(entry.name || slug)}”"></ha-icon>`
        : `<ha-icon class="cpce-link-indicator cpce-link-broken" icon="mdi:palette-swatch" title="References missing Fixture Profile “${escapeHtml(slug)}”"></ha-icon>`);
    }
    // Scene(s)
    const scenes = (preset.scenes || []).filter(s => (this._config.scenes || []).includes(s));
    if (scenes.length) {
      badges.push(`<ha-icon class="cpce-link-indicator" icon="mdi:palette" title="Triggers ${scenes.length} scene${scenes.length === 1 ? '' : 's'}"></ha-icon>`);
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

  // Target-lights picker for a slider/values section — SAME model as buttons: two checkboxes
  // (Default Entities pool ∪ this section's own any-light list). `section` is the section
  // object; `dataAttr` carries data-ss-target / data-vs-target so wiring can route the update.
  _renderTargetPicker(section, dataAttr) {
    const cardEntities = this._config.entities || [];
    const spec = presetTargetSpec(section);
    const allLights = getLightEntities(this._hass);
    return `
      <div class="cpce-target-picker" ${dataAttr}>
        <div class="cpce-check"><input type="checkbox" class="cpce-tp-use-default" ${spec.useDefault?'checked':''}><label>Use Default Entities${cardEntities.length ? ` (${cardEntities.length})` : ' — none set'}</label></div>
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
             <div class="cpce-hint">This button has <strong>no color of its own</strong> — it always applies <code>${escapeHtml(linked)}</code>'s current value, in real time. To change the color or brightness, edit the entity in <strong>Color Entities</strong> (Entity &amp; Profile Management). Every button linked to it updates together.</div>`
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
              <button class="cpce-icon-btn cpce-ce-edit${open?' active':''}" data-entity="${escapeHtml(id)}" title="Edit color / brightness" style="color:var(--primary-color);"><ha-icon icon="mdi:pencil"></ha-icon></button>
              ${count ? '' : `<button class="cpce-create-preset-btn cpce-ce-create-preset" data-entity="${escapeHtml(id)}" title="Create a button linked to this entity"><ha-icon icon="mdi:plus"></ha-icon> Preset</button>`}
              <button class="cpce-delete-entity-btn cpce-ce-delete" data-entity="${escapeHtml(id)}" title="Delete entity"><ha-icon icon="mdi:delete-forever"></ha-icon></button>
            </div>${open ? `<div class="cpce-ce-edit-panel" data-entity="${escapeHtml(id)}">${this._renderEntityEditPanel(id)}</div>` : ''}`;
        }).join('')}
      </div>
    `;
  }

  // Inline per-entity editor (color wheel + brightness) that writes to the entity via
  // set_color. Reads the entity's live value; every button linked to it follows instantly.
  _renderEntityEditPanel(id) {
    const st = this._hass && this._hass.states[id];
    const value = st ? inputColorStateToPresetValue(st) : {};
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
      <div class="cpce-hint">Saved to <code>${escapeHtml(id)}</code> immediately. Buttons linked to it apply this value live.</div>
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
      <div class="cpce-preset-editor${collapsed}" data-index="${index}">
        <div class="cpce-preset-summary" data-preset-toggle="${index}">
          <span class="cpce-preset-swatch" style="background:${this._presetSwatch(preset)};"></span>
          <ha-icon icon="${escapeHtml(resolvePresetIcon(preset, mode))}"></ha-icon>
          <span class="cpce-preset-summary-name">${escapeHtml(preset.name || 'Preset')}</span>
          ${this._presetLinkIcon(preset)}
          <button class="cpce-icon-btn cpce-preset-remove" title="Remove"><ha-icon icon="mdi:delete"></ha-icon></button>
          <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
        </div>
        <div class="cpce-preset-body">
          <div class="cpce-subgroup"><ha-icon icon="mdi:gesture-tap-button"></ha-icon>Button</div>
          <div class="cpce-preset-header">
            <input type="text" class="cpce-preset-name" value="${escapeHtml(preset.name)}" placeholder="Name">
            <input type="text" class="cpce-preset-icon" value="${escapeHtml(preset.icon && !GENERIC_DEFAULT_ICONS.has(preset.icon) ? preset.icon : '')}" placeholder="${escapeHtml(modeDefaultIcon(mode))}">
          </div>
          ${(() => {
            const buttonsSections = this._orderedSectionsRaw().filter(s => s.type === 'buttons');
            const firstId = buttonsSections.length ? buttonsSections[0].id : '';
            const current = buttonsSections.some(s => s.id === preset.section_id) ? preset.section_id : firstId;
            return `<div class="cpce-row"><label class="lbl">In Button Section</label>
              <select class="cpce-preset-section" data-index="${index}">
                ${buttonsSections.map(s => `<option value="${s.id}" ${s.id===current?'selected':''}>${escapeHtml(s.name || 'Buttons')}</option>`).join('')}
              </select>
            </div>`;
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
          ${isScene ? `<div class="cpce-hint">This button applies no color of its own — use it for scene-only buttons. Set a Custom button styling color below so it still looks intentional.</div>` : ''}
          ${showButtonStyle ? this._renderButtonStyling(preset, index) : ''}

          ${isProfile ? `<div class="cpce-subgroup"><ha-icon icon="mdi:palette-swatch-outline"></ha-icon>Fixture Profile</div>
          ${this._renderPresetProfileLink(preset, index)}` : ''}

          ${(isColor || isTemp) ? `<div class="cpce-subgroup"><ha-icon icon="mdi:palette-outline"></ha-icon>Custom ${isTemp ? 'Temperature' : 'Color'} (the look)</div>` : ''}
          ${showLook ? `
          ${isColor ? this._renderColorWheelEditor(preset, index) : ''}
          ${isTemp ? `<div class="cpce-field-title">Color Temperature</div><div class="cpce-temp-editor"><input type="range" class="cpce-preset-temp" min="${min}" max="${max}" step="50" value="${kelvin}"><span class="cpce-temp-val">${kelvin}K</span></div>` : ''}
          <div class="cpce-field-title">Brightness</div>
          <div class="cpce-check"><input type="checkbox" class="cpce-preset-bri-enable" ${hasBrightness ? 'checked' : ''}><label>Set brightness with this button</label></div>
          ${hasBrightness ? `<div class="cpce-temp-editor"><input type="range" class="cpce-preset-bri" min="1" max="100" value="${brightnessPct}"><span class="cpce-bri-val">${brightnessPct}%</span></div>` : `<div class="cpce-hint">When off, this button leaves the light's current brightness unchanged.</div>`}
          ${this._renderPresetExtras(preset, index, false)}
          ` : ''}
          ${(isColor || isTemp) ? this._renderInputColorLink(preset, index) : ''}

          <div class="cpce-subgroup"><ha-icon icon="mdi:cog-outline"></ha-icon>Actions &amp; Targets</div>
          ${this._renderPresetActions(preset, index, mode)}
        </div>
      </div>
    `;
  }

  // Optional Button Styling: an explicit color used ONLY for how the button looks
  // (swatch/tint/glow/icon), independent of what it does — so scene-only / None-target /
  // Off buttons can still look intentional. When unset, styling derives from the look.
  // "Copy From…" clones another button's style color for quick consistency.
  _renderButtonStyling(preset, index) {
    const enabled = !!preset.button_style_color;
    const others = (this._config.presets || [])
      .map((p, i) => ({ p, i }))
      .filter(o => o.i !== index && o.p.button_style_color);
    return `
      <div class="cpce-check"><input type="checkbox" class="cpce-btnstyle-enable" data-index="${index}" ${enabled?'checked':''}><label>Custom button styling color</label></div>
      ${enabled ? `
        <div class="cpce-row"><label class="lbl">Style Color</label><input type="color" class="cpce-btnstyle-color" data-index="${index}" value="${preset.button_style_color}"></div>
        ${others.length ? `<div class="cpce-row"><label class="lbl">Copy From…</label>
          <select class="cpce-btnstyle-copy" data-index="${index}">
            <option value="">Choose a button…</option>
            ${others.map(o => `<option value="${o.p.button_style_color}">${escapeHtml(o.p.name || 'Button')}</option>`).join('')}
          </select></div>` : ''}
        <div class="cpce-hint">Overrides the look-derived color for this button's appearance only (not what it sends).</div>
      ` : `<div class="cpce-hint">Off: the button's appearance follows its profile/look color.</div>`}
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
            : `<div class="cpce-hint">${slugs.length ? 'Pick a saved profile above.' : 'No profiles yet — create one in the Fixture Profile Library (Entity &amp; Profile Management), then select it here.'}</div>`)}
      </div>
    `;
  }

  // The Fixture Profile Library manager: lists saved profiles with rename/delete, a scope
  // toggle, and a swatch. Profiles are shared across all Color Light Manager cards.
  _renderProfileLibrarySection() {
    const lib = fixtureLibraryMap('system');
    const slugs = Object.keys(lib).sort((a, b) => (lib[a].name || a).localeCompare(lib[b].name || b));
    // Which library slugs are referenced by this card's presets (usage badge).
    const usedSlugs = new Set((this._config.presets || []).map(p => fixtureRefSlug(p && p.profile_ref)).filter(Boolean));
    return `
      <div class="cpce-hint">Reusable fixture profiles (color/brightness/transition/effect) shared across all Color Light Manager cards via Home Assistant's built-in store. Create and edit profiles here; a button uses one by setting Mode = Fixture Profile — one edit updates every button referencing it.</div>
      ${slugs.length
        ? `<div class="cpce-manage-list">${slugs.map(s => {
            const e = lib[s];
            const rgb = presetColorToRgb(e.look || {});
            const sw = (e.look && e.look.action === 'turn_off') ? 'transparent' : ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
            const open = this._openProfile === s;
            return `<div class="cpce-manage-item" data-slug="${escapeHtml(s)}">
              <span class="cpce-fav-swatch" style="background:${sw};"></span>
              <span class="cpce-ce-name">${escapeHtml(e.name || s)}</span>
              ${usedSlugs.has(s) ? '<span class="cpce-order-type">in use</span>' : ''}
              <button class="cpce-icon-btn cpce-profile-edit${open?' active':''}" data-slug="${escapeHtml(s)}" title="Edit profile" style="color:var(--primary-color);"><ha-icon icon="mdi:pencil"></ha-icon></button>
              <button class="cpce-delete-entity-btn cpce-profile-lib-delete" data-slug="${escapeHtml(s)}" title="Delete profile from library"><ha-icon icon="mdi:delete-forever"></ha-icon></button>
            </div>${open ? `<div class="cpce-profile-edit-panel" data-slug="${escapeHtml(s)}">${this._renderProfileEditPanel(s, e)}</div>` : ''}`;
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
      <div class="cpce-hint">Editing here updates every button that references this profile.</div>
    `;
  }

  // Merge a partial look change into a library profile and persist it.
  _patchProfileLook(slug, patch) {
    const map = { ...fixtureLibraryMap('system') };
    const e = map[slug];
    if (!e) return;
    const look = { ...(e.look || {}), ...patch };
    // Drop empty keys so a cleared effect/transition doesn't linger.
    Object.keys(look).forEach(k => { if (look[k] === null || look[k] === undefined || look[k] === '') delete look[k]; });
    map[slug] = { ...e, look };
    saveFixtureLibrary(this._hass, 'system', map).catch(err => console.warn(`${LOG_PREFIX} profile edit save failed`, err));
  }

  // Stores a library profile's color under a specific native format+value (clearing other
  // color keys and kelvin/action), mirroring _storePresetColor but for the shared library.
  _storeProfileColor(slug, fmt, value) {
    const map = { ...fixtureLibraryMap('system') };
    const e = map[slug]; if (!e) return;
    const look = { ...(e.look || {}) };
    ALL_PRESET_COLOR_KEYS.forEach(k => delete look[k]);
    look[PRESET_COLOR_KEYS[fmt]] = value;
    delete look.color_kelvin; delete look.action; delete look.look_none;
    map[slug] = { ...e, look };
    return saveFixtureLibrary(this._hass, 'system', map).catch(err => console.warn(`${LOG_PREFIX} profile color save failed`, err));
  }

  // Wheel/hex give an RGB triple; convert to the profile's current format and store.
  _setProfileColorFromRgb(slug, rgb) {
    const look = (fixtureLibraryMap('system')[slug] || {}).look || {};
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
    const look = (fixtureLibraryMap('system')[slug] || {}).look || {};
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
    const look = (fixtureLibraryMap('system')[slug] || {}).look || {};
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
    const look = (fixtureLibraryMap('system')[slug] || {}).look || {};
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
  }

  // Wires the real color wheel + hex + native fields inside a library profile's edit panel.
  _wireProfileColorWheel(panel, slug) {
    const fmtSel = panel.querySelector('.cpce-color-format');
    if (fmtSel) fmtSel.addEventListener('change', () => this._setProfileColorFormat(slug, fmtSel.value));
    const canvas = panel.querySelector('.cpce-color-wheel');
    if (canvas) {
      const look = (fixtureLibraryMap('system')[slug] || {}).look || {};
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

  // The additive-actions block for a preset: Color Control Lights (Default Entities + custom),
  // Scenes to trigger (any scene.*), and a Turn-Off entity set. `mode` is the button mode;
  // color-control targeting is hidden for Scene buttons (they apply no color). The Color Entity
  // Link is NOT here — it lives with the Custom look editor.
  _renderPresetActions(preset, index, mode) {
    const cardEntities = this._config.entities || [];
    const isOff = mode === 'off';
    const showColorControl = mode !== 'scene';
    const spec = presetTargetSpec(preset);
    const customSel = spec.custom;
    const allLights = getLightEntities(this._hass);
    const allScenes = getSceneEntities(this._hass);
    const scenes = preset.scenes || [];   // any scene.*; no card-level pool to filter against
    const offIds = (preset.turn_off_entities || []).filter(id => cardEntities.includes(id));

    return `
      <div class="cpce-preset-actions" data-index="${index}">
        ${showColorControl ? `<div class="cpce-action-block">
          <div class="cpce-field-title">Color Control Lights</div>
          <div class="cpce-hint">Which lights get this button's ${isOff ? 'off command' : mode === 'profile' ? "profile's look" : 'color/temperature'}. Combine the shared Default Entities pool with this button's own lights — or uncheck both for a scene/turn-off-only button.</div>
          <div class="cpce-check"><input type="checkbox" class="cpce-cc-use-default" ${spec.useDefault?'checked':''}><label>Use Default Entities${cardEntities.length ? ` (${cardEntities.length})` : ' — none set'}</label></div>
          ${spec.useDefault && cardEntities.length ? `<div style="margin-left:22px;">${this._renderStaticChips(cardEntities, 'default')}</div>` : ''}
          <div class="cpce-check"><input type="checkbox" class="cpce-cc-use-custom" ${spec.useCustom?'checked':''}><label>Include other Entities</label></div>
          ${spec.useCustom ? (allLights.length
            ? `${this._renderAddPicker(allLights, customSel, 'on', 'cpce-cc-add', 'cpce-cc-sel', 'Add any light…')}${this._renderChips(customSel, 'on', 'cpce-cc-chip-x')}`
            : `<div class="cpce-hint">No <code>light.*</code> entities found.</div>`) : ''}
          ${!spec.useDefault && !spec.useCustom ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">No lights selected — this button applies no color (scene / turn-off only).</div>` : ''}
        </div>` : ''}

        <div class="cpce-action-block">
          <div class="cpce-field-title">Trigger Scenes</div>
          ${allScenes.length
            ? `${this._renderAddPicker(allScenes, scenes, 'scene', 'cpce-scene-chip-add', 'cpce-scene-chip-sel', 'Add any scene…')}${this._renderChips(scenes, 'scene', 'cpce-scene-chip-x')}`
            : `<div class="cpce-hint">No <code>scene.*</code> entities found on this system.</div>`}
        </div>

        <div class="cpce-action-block">
          <div class="cpce-field-title">Turn Off These</div>
          ${cardEntities.length
            ? `${this._renderAddPicker(cardEntities, offIds, 'off', 'cpce-off-add', 'cpce-off-sel', 'Add a light to turn off…')}${this._renderChips(offIds, 'off', 'cpce-off-chip-x')}`
            : `<div class="cpce-hint">Add lights to Default Entities first.</div>`}
        </div>
      </div>
    `;
  }

  _attachPresetListeners() {
    // Scope to preset summaries only (slider sections reuse .cpce-preset-summary but carry
    // data-ss-toggle, not data-preset-toggle) so this doesn't clobber their toggle handler.
    this.querySelectorAll('.cpce-preset-summary[data-preset-toggle]').forEach(summary => {
      summary.onclick = (e) => {
        if (e.target.closest('.cpce-preset-remove')) return;
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
        presets[index] = { ...presets[index], name: nameEl.value || 'Preset', icon: iconEl.value || '' };
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
        // Clear every look/link field, then set only what the chosen mode needs.
        delete p.action; ALL_PRESET_COLOR_KEYS.forEach(k => delete p[k]); delete p.color_kelvin;
        delete p.look_none; delete p.profile_ref; delete p.transition; delete p.effect;
        const v = modeEl.value;
        // If the icon isn't a user-customized one (empty or a generic/mode default), follow the
        // new mode's default icon so the button glyph matches its function automatically.
        if (!p.icon || GENERIC_DEFAULT_ICONS.has(p.icon)) p.icon = modeDefaultIcon(v);
        p.mode = v;
        if (v === 'off') { p.action = 'turn_off'; delete p.brightness; delete p.input_color_entity; }
        else if (v === 'scene') { p.look_none = true; delete p.brightness; delete p.input_color_entity; }
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

      // Preset actions: Color Control mode + chips, Scenes chips, Turn-Off chips.
      const patchPreset = (patch) => {
        const presets = [...(this._config.presets || [])];
        presets[index] = { ...presets[index], ...patch };
        this._updateConfig({ presets });
        this._render();
      };
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

      const scAdd = container.querySelector('.cpce-scene-chip-add');
      if (scAdd) scAdd.onclick = () => {
        const sel = container.querySelector('.cpce-scene-chip-sel'); if (!sel || !sel.value) return;
        patchPreset({ scenes: [...new Set([...(this._config.presets[index].scenes || []), sel.value])] });
      };
      container.querySelectorAll('.cpce-scene-chip-x').forEach(x => x.onclick = () =>
        patchPreset({ scenes: (this._config.presets[index].scenes || []).filter(id => id !== x.dataset.id) }));

      const offAdd = container.querySelector('.cpce-off-add');
      if (offAdd) offAdd.onclick = () => {
        const sel = container.querySelector('.cpce-off-sel'); if (!sel || !sel.value) return;
        patchPreset({ turn_off_entities: [...new Set([...(this._config.presets[index].turn_off_entities || []), sel.value])] });
      };
      container.querySelectorAll('.cpce-off-chip-x').forEach(x => x.onclick = () =>
        patchPreset({ turn_off_entities: (this._config.presets[index].turn_off_entities || []).filter(id => id !== x.dataset.id) }));

      // Button-section assignment.
      const sectionSel = container.querySelector('.cpce-preset-section');
      if (sectionSel) sectionSel.addEventListener('change', () => {
        const presets = [...(this._config.presets || [])];
        presets[index] = { ...presets[index], section_id: sectionSel.value };
        this._updateConfig({ presets });
        this._render();
      });

      // Button Styling: enable toggle, color, and Copy From…
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
      const styleCopy = container.querySelector('.cpce-btnstyle-copy');
      if (styleCopy) styleCopy.addEventListener('change', () => {
        if (!styleCopy.value) return;
        const presets = [...(this._config.presets || [])];
        presets[index] = { ...presets[index], button_style_color: styleCopy.value };
        this._updateConfig({ presets });
        this._render();
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
      this._wireColorWheel(container, index);
    });
  }

  // Creates a new blank Fixture Profile in the shared library (prompted for a name), then opens
  // its inline editor so the user sets the look. All profile creation/editing lives here now —
  // buttons only reference profiles (Mode = Fixture Profile), they don't create them.
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
    const cfg = this._config;
    const labels = this._hass ? getAllLabels(this._hass) : [];
    const groups = this._hass ? getAreas(this._hass) : [];
    this.innerHTML = `
      <style>
        .cpce { padding:16px; display:flex; flex-direction:column; gap:12px; font-family:var(--paper-font-body1_-_font-family, sans-serif); }
        .cpce ha-icon { --mdc-icon-size:18px; vertical-align:middle; }
        .cpce-sec { border:1px solid var(--divider-color,#333); border-radius:8px; background:var(--ha-card-background,#1a1a1a); overflow:hidden; }
        .cpce-sec-header { display:flex; align-items:center; gap:8px; padding:12px; cursor:pointer; user-select:none; font-weight:500; color:var(--primary-text-color); }
        .cpce-sec-header .chev { margin-left:auto; transition:transform 0.2s ease; color:var(--secondary-text-color); }
        .cpce-sec.collapsed .cpce-sec-header .chev { transform:rotate(-90deg); }
        .cpce-sec-body { padding:0 12px 12px; }
        .cpce-sec.collapsed .cpce-sec-body { display:none; }
        .cpce-row { display:flex; align-items:center; gap:12px; padding:6px 0; flex-wrap:wrap; }
        .cpce-row label.lbl { min-width:130px; color:var(--primary-text-color); font-size:13px; }
        .cpce-row input[type="text"], .cpce-row select, .cpce-row input[type="number"] {
          flex:1; padding:6px 10px; background:var(--secondary-background-color,#2a2a2a);
          border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px;
        }
        .cpce-row input[type="range"] { flex:1; max-width:200px; accent-color:#2196F3; cursor:pointer; }
        .cpce-check { display:flex; align-items:center; gap:8px; padding:6px 0; color:var(--primary-text-color); font-size:13px; }
        .cpce-inline-check { display:inline-flex; align-items:center; gap:4px; color:var(--primary-text-color); font-size:12px; margin-right:8px; }
        .cpce-mini-btn { padding:4px 10px; margin-right:6px; border:1px solid var(--divider-color,#333); border-radius:4px; background:var(--secondary-background-color,#2a2a2a); color:var(--primary-text-color); font-size:12px; cursor:pointer; }
        .cpce-mini-btn:hover { border-color:var(--primary-color); }
        .cpce-hint { font-size:12px; color:var(--secondary-text-color); margin-bottom:8px; }
        .cpce-sub-title { font-size:12px; font-weight:600; color:var(--primary-color); margin:12px 0 4px; border-top:1px solid var(--divider-color,#333); padding-top:10px; }
        .cpce-strength-val { font-size:12px; color:var(--secondary-text-color); min-width:36px; }
        .cpce-row input[type="color"] { width:44px; height:32px; padding:0; border:1px solid var(--divider-color,#333); border-radius:4px; background:transparent; cursor:pointer; flex:none; }
        .cpce-entity-list { max-height:200px; overflow-y:auto; border:1px solid var(--divider-color,#333); border-radius:6px; padding:4px; }
        .cpce-entity-list { }
        .cpce-entity-row { display:flex; align-items:center; gap:8px; padding:5px 4px; border-top:1px solid var(--divider-color,#333); font-size:13px; color:var(--primary-text-color); }
        .cpce-entity-row:first-child { border-top:none; }
        .cpce-sel-name { flex-shrink:0; }
        .cpce-entity-id { font-size:11px; color:var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cpce-cm-chips { margin-left:auto; display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; }
        .cpce-cm-chip { font-size:10px; padding:1px 6px; border-radius:999px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); color:var(--secondary-text-color); white-space:nowrap; }
        .cpce-entity-add { flex-shrink:0; width:26px; height:26px; display:flex; align-items:center; justify-content:center; border:none; border-radius:4px; background:var(--primary-color); color:#fff; cursor:pointer; font-size:18px; line-height:1; }
        .cpce-entity-add:hover { filter:brightness(1.1); }
        .cpce-entity-added { flex-shrink:0; color:var(--success-color,#4caf50); --mdc-icon-size:18px; }
        .cpce-search-row { display:flex; gap:8px; margin-bottom:8px; }
        .cpce-search-row input { flex:1; padding:6px 10px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-search-row select { padding:6px 10px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-selected-list { margin-top:6px; border:1px solid var(--divider-color,#333); border-radius:6px; overflow:hidden; }
        .cpce-selected-item { display:flex; align-items:center; gap:8px; padding:6px 8px; border-top:1px solid var(--divider-color,#333); font-size:13px; color:var(--primary-text-color); }
        .cpce-selected-item:first-child { border-top:none; }
        .cpce-sel-remove { flex-shrink:0; background:none; border:none; color:var(--error-color,#f44336); cursor:pointer; font-size:16px; font-weight:bold; padding:2px 6px; }
        .cpce-preset-editor { border:1px solid var(--divider-color,#333); border-radius:8px; margin-bottom:10px; overflow:hidden; }
        .cpce-preset-summary { display:flex; align-items:center; gap:8px; padding:10px 12px; cursor:pointer; user-select:none; }
        .cpce-preset-summary .chev { margin-left:auto; transition:transform 0.2s ease; color:var(--secondary-text-color); }
        .cpce-preset-editor.collapsed .cpce-preset-summary .chev { transform:rotate(-90deg); }
        .cpce-preset-editor.collapsed .cpce-preset-body { display:none; }
        .cpce-preset-swatch { width:20px; height:20px; border-radius:50%; border:1px solid var(--divider-color,#333); flex-shrink:0; }
        .cpce-preset-summary-name { color:var(--primary-text-color); font-size:13px; font-weight:500; }
        .cpce-link-indicator { --mdc-icon-size:15px; color:var(--info-color,#2196F3); flex-shrink:0; }
        .cpce-shared-link { --mdc-icon-size:18px; color:var(--info-color,#2196F3); flex-shrink:0; }
        .cpce-link-indicator.cpce-link-broken { color:var(--error-color,#f44336); }
        .cpce-preset-body { padding:0 10px 10px; }
        /* Sub-group divider within a button panel (groups: Button / Profile / Actions). */
        .cpce-subgroup { display:flex; align-items:center; gap:8px; margin:14px 0 8px; color:var(--secondary-text-color); font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; }
        .cpce-subgroup::after { content:''; flex:1; height:1px; background:var(--divider-color,#333); }
        .cpce-subgroup ha-icon { --mdc-icon-size:15px; color:var(--primary-color); }
        .cpce-readonly-val { flex:1; font-size:13px; color:var(--secondary-text-color); font-style:italic; }
        .cpce-input-color-link { margin-top:10px; padding-top:10px; border-top:1px solid var(--divider-color,#333); }
        .cpce-preset-save-entity { display:inline-flex; align-items:center; gap:6px; margin-top:6px; padding:6px 12px; border:none; border-radius:4px; background:var(--primary-color); color:#fff; cursor:pointer; font-size:12px; }
        .cpce-preset-save-entity:disabled { opacity:0.4; cursor:default; }
        .cpce-preset-save-entity ha-icon { --mdc-icon-size:14px; }
        .cpce-input-color-link code { font-size:11px; background:var(--secondary-background-color,#2a2a2a); padding:1px 4px; border-radius:3px; }
        .cpce-preset-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
        .cpce-preset-header input[type="text"] { flex:1; min-width:80px; padding:6px 8px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-preset-header select { padding:6px 8px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-icon-btn { display:flex; align-items:center; justify-content:center; padding:6px; border:none; border-radius:4px; background:transparent; color:var(--error-color,#f44336); cursor:pointer; }
        .cpce-color-editor { margin-top:10px; }
        .cpce-wheel-row { display:flex; gap:16px; flex-wrap:wrap; }
        .cpce-color-wheel { border-radius:50%; cursor:crosshair; width:150px; height:150px; flex-shrink:0; }
        .cpce-color-fields { flex:1; min-width:200px; }
        .cpce-field-title { font-size:12px; font-weight:600; color:var(--primary-color); margin:8px 0 4px; }
        .cpce-field-title:first-child { margin-top:0; }
        .cpce-rgb-fields, .cpce-hs-fields, .cpce-xy-fields { display:flex; gap:8px; }
        .cpce-field-col { display:flex; flex-direction:column; flex:1; }
        .cpce-field-col label { font-size:11px; color:var(--secondary-text-color); margin-bottom:2px; }
        .cpce-field-col input { width:100%; padding:5px 6px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; box-sizing:border-box; }
        .cpce-field-col span { font-size:11px; color:var(--secondary-text-color); margin-top:1px; }
        .cpce-hex-row { display:flex; align-items:center; gap:8px; margin:6px 0; }
        .cpce-hex-preview { width:32px; height:32px; border-radius:6px; border:1px solid var(--divider-color,#333); }
        .cpce-hex-input { flex:1; padding:6px 10px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-temp-editor { display:flex; align-items:center; gap:12px; margin-top:8px; }
        .cpce-temp-editor input[type="range"] { flex:1; accent-color:#ff9800; }
        .cpce-temp-val, .cpce-bri-val { font-size:12px; color:var(--secondary-text-color); white-space:nowrap; }
        .cpce-add-btn { display:flex; align-items:center; gap:6px; padding:8px 14px; border:none; border-radius:6px; background:var(--primary-color); color:#fff; cursor:pointer; font-size:13px; }
        .cpce-radio-row { display:flex; align-items:center; gap:8px; padding:7px 4px; cursor:pointer; border-top:1px solid var(--divider-color,#333); font-size:13px; color:var(--primary-text-color); }
        .cpce-radio-row:first-of-type { border-top:none; }
        .cpce-radio-row input[type="radio"] { flex-shrink:0; }
        .cpce-radio-label { font-weight:600; flex-shrink:0; min-width:70px; }
        .cpce-radio-desc { font-size:11px; color:var(--secondary-text-color); font-family:var(--code-font-family, monospace); }
        .cpce-order-list { border:1px solid var(--divider-color,#333); border-radius:6px; overflow:hidden; margin-bottom:8px; }
        .cpce-order-item { display:flex; align-items:center; gap:8px; padding:8px; border-top:1px solid var(--divider-color,#333); font-size:13px; color:var(--primary-text-color); }
        .cpce-order-item:first-child { border-top:none; }
        .cpce-order-name { flex:1; }
        .cpce-order-rename { flex:1; min-width:60px; padding:5px 8px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-order-type { font-size:10px; padding:1px 6px; border-radius:999px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); color:var(--secondary-text-color); flex-shrink:0; }
        .cpce-order-remove { width:28px; height:28px; border:1px solid var(--divider-color,#333); border-radius:4px; background:transparent; color:var(--error-color,#f44336); cursor:pointer; font-weight:bold; flex-shrink:0; }
        .cpce-order-style { width:28px; height:28px; display:flex; align-items:center; justify-content:center; border:1px solid var(--divider-color,#333); border-radius:4px; background:var(--secondary-background-color,#2a2a2a); color:var(--primary-text-color); cursor:pointer; flex-shrink:0; }
        .cpce-order-style ha-icon { --mdc-icon-size:16px; }
        .cpce-order-style.active { border-color:var(--primary-color); color:var(--primary-color); }
        .cpce-order-style-panel { border:1px solid var(--divider-color,#333); border-top:none; border-radius:0 0 6px 6px; padding:8px; margin:-8px 0 8px; background:var(--secondary-background-color,#1e1e1e); }
        .cpce-slider-section { border:1px solid var(--divider-color,#333); border-radius:8px; padding:10px; margin-bottom:10px; }
        /* Collapsible sub-header (e.g. Added Entities). */
        .cpce-collapse-head { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; font-size:12px; font-weight:600; color:var(--primary-color); margin:12px 0 6px; }
        .cpce-collapse-head ha-icon { --mdc-icon-size:16px; transition:transform 0.2s ease; }
        .cpce-collapse-head.collapsed ha-icon { transform:rotate(-90deg); }
        /* Entity/scene chips (green = color-control/on, red = turn-off, blue = scene). */
        /* Each preset action group; a top border divides Color Control / Scenes / Turn Off. */
        .cpce-action-block { padding-top:10px; margin-top:10px; border-top:1px solid var(--divider-color,#333); }
        .cpce-action-block:first-child { padding-top:0; margin-top:0; border-top:none; }
        .cpce-chips { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 2px; }
        .cpce-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px; font-size:12px; border:1px solid var(--divider-color,#333); background:var(--secondary-background-color,#2a2a2a); color:var(--primary-text-color); }
        .cpce-chip.default { border-color:var(--info-color,#2196F3); }
        .cpce-chip.on { border-color:var(--success-color,#4caf50); }
        .cpce-chip.off { border-color:var(--error-color,#f44336); }
        .cpce-chip.scene { border-color:var(--info-color,#2196F3); }
        .cpce-chip .cpce-chip-x { cursor:pointer; font-weight:bold; opacity:0.7; line-height:1; }
        .cpce-chip .cpce-chip-x:hover { opacity:1; }
        .cpce-chip-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .cpce-chip.on .cpce-chip-dot { background:var(--success-color,#4caf50); }
        .cpce-chip.off .cpce-chip-dot { background:var(--error-color,#f44336); }
        .cpce-chip.scene .cpce-chip-dot { background:var(--info-color,#2196F3); }
        .cpce-addrow { display:flex; align-items:center; gap:8px; }
        .cpce-addrow select { flex:1; padding:6px 10px; background:var(--secondary-background-color,#2a2a2a); border:1px solid var(--divider-color,#333); border-radius:4px; color:var(--primary-text-color); font-size:13px; }
        .cpce-addrow .cpce-add-plus { width:28px; height:28px; flex-shrink:0; border:none; border-radius:4px; color:#fff; cursor:pointer; font-size:18px; line-height:1; }
        .cpce-add-plus.on { background:var(--success-color,#4caf50); }
        .cpce-add-plus.off { background:var(--error-color,#f44336); }
        .cpce-add-plus.scene { background:var(--info-color,#2196F3); }
        .cpce-order-up, .cpce-order-down { display:flex; align-items:center; justify-content:center; width:28px; height:28px; border:1px solid var(--divider-color,#333); border-radius:4px; background:var(--secondary-background-color,#2a2a2a); color:var(--primary-text-color); cursor:pointer; }
        .cpce-order-up:disabled, .cpce-order-down:disabled { opacity:0.35; cursor:default; }
        .cpce-order-up ha-icon, .cpce-order-down ha-icon { --mdc-icon-size:18px; }
        .cpce-unmatched-list, .cpce-manage-list { border:1px solid var(--divider-color,#333); border-radius:6px; overflow:hidden; margin-bottom:8px; }
        .cpce-unmatched-item, .cpce-manage-item { display:flex; align-items:center; gap:8px; padding:8px; border-top:1px solid var(--divider-color,#333); font-size:13px; color:var(--primary-text-color); }
        .cpce-unmatched-item:first-child, .cpce-manage-item:first-child { border-top:none; }
        .cpce-esm-item { display:flex; flex-direction:column; gap:6px; padding:8px; border-top:1px solid var(--divider-color,#333); }
        .cpce-esm-item:first-child { border-top:none; }
        .cpce-esm-name { font-size:13px; color:var(--primary-text-color); display:flex; flex-direction:column; }
        .cpce-esm-controls { display:flex; gap:10px; flex-wrap:wrap; }
        .cpce-esm-field { display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--secondary-text-color); flex:1; min-width:130px; }
        .cpce-esm-field select { font-size:12px; }
        .cpce-ce-name { display:flex; flex-direction:column; flex:1; min-width:0; }
        .cpce-link-unused { color:var(--secondary-text-color); opacity:0.6; }
        .cpce-ce-edit-panel { padding:10px 8px; border-top:1px solid var(--divider-color,#333); background:var(--secondary-background-color,rgba(255,255,255,0.03)); }
        .cpce-ce-create-preset { padding:4px 8px; font-size:12px; }
        .cpce-create-preset-btn {
          display:flex; align-items:center; gap:4px; margin-left:auto; padding:5px 10px;
          border:none; border-radius:4px; background:var(--primary-color); color:#fff; cursor:pointer; font-size:12px; white-space:nowrap;
        }
        .cpce-create-preset-btn ha-icon { --mdc-icon-size:14px; }
        .cpce-manage-entities { margin-top:16px; padding-top:12px; border-top:1px dashed var(--divider-color,#333); }
        .cpce-delete-entity-btn {
          display:flex; align-items:center; justify-content:center; margin-left:auto; padding:6px;
          border:none; border-radius:4px; background:transparent; color:var(--error-color,#f44336); cursor:pointer;
        }
        .cpce-delete-entity-btn:hover { background:rgba(244,67,54,0.15); }
        .cpce-editor-header { display:flex; align-items:center; gap:8px; padding:2px 2px 10px; border-bottom:1px solid var(--divider-color,#333); }
        .cpce-editor-header ha-icon { --mdc-icon-size:22px; color:var(--primary-color); }
        .cpce-editor-title { font-size:15px; font-weight:600; color:var(--primary-text-color); }
        .cpce-editor-build { margin-left:auto; font-size:11px; color:var(--secondary-text-color); font-family:var(--code-font-family, monospace); }
        /* Group divider separating the two logical panel groups (Visuals vs Management). */
        .cpce-group-divider { display:flex; align-items:center; gap:10px; margin:18px 2px 10px; color:var(--primary-color); font-size:13px; font-weight:700; letter-spacing:0.02em; text-transform:uppercase; }
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
        <div class="cpce-group-divider"><ha-icon icon="mdi:eye-outline"></ha-icon>Card Builder</div>

        ${this._section('mdi:view-grid-outline', 'Section Order', 'layout', `
          <div class="cpce-hint">Order of the card's sections (top → bottom). Rename inline; use arrows to move; ✕ to remove. The gear button configures a section-name heading, its text styling, and (for Color Values) which lights it monitors.</div>
          <div class="cpce-order-list">
            ${this._orderedSections().map((s, i, arr) => {
              const typeLabel = { buttons: 'Buttons', sliders: 'Sliders', values: 'Color Values' }[s.type] || s.type;
              const open = this._openSectionStyle === s.id;
              return `<div class="cpce-order-item" data-section-id="${s.id}">
                <input type="text" class="cpce-order-rename" value="${escapeHtml(s.name || typeLabel)}" title="Section name">
                <span class="cpce-order-type">${typeLabel}</span>
                <button class="cpce-order-style${open?' active':''}" data-key="${s.id}" title="Configure this section"><ha-icon icon="mdi:cog"></ha-icon></button>
                <button class="cpce-order-up" data-key="${s.id}" ${i === 0 ? 'disabled' : ''} title="Move up"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
                <button class="cpce-order-down" data-key="${s.id}" ${i === arr.length - 1 ? 'disabled' : ''} title="Move down"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
                <button class="cpce-order-remove" data-key="${s.id}" title="Remove section">✕</button>
              </div>
              ${open ? `<div class="cpce-order-style-panel" data-section-id="${s.id}">
                <div class="cpce-check"><input type="checkbox" class="cpce-sn-show" ${s.name_show?'checked':''}><label>Show name heading above this section</label></div>
                ${s.name_show ? this._textStyleControls(`cpce-sn-${s.id}`, { size: s.name_font_size, weight: s.name_font_weight, color: s.name_color }, 13) : ''}
                ${s.type === 'values' ? `<div class="cpce-sub-title">Monitored Lights</div>
                  <div class="cpce-hint">Which light(s) this section reads color values from.</div>
                  ${this._renderTargetPicker(s, `data-vs-target="${s.id}"`)}` : ''}
              </div>` : ''}`;
            }).join('')}
          </div>
          <div class="cpce-row" style="gap:8px;">
            <button class="cpce-mini-btn" id="cpce-add-buttons-section"><ha-icon icon="mdi:plus"></ha-icon> Buttons Section</button>
            <button class="cpce-mini-btn" id="cpce-add-values-section"><ha-icon icon="mdi:plus"></ha-icon> Color Values Section</button>
          </div>
        `)}

        ${this._section('mdi:palette-outline', 'Card Appearance', 'appearance', `
          <div class="cpce-check"><input type="checkbox" id="cpce-card-collapsible" ${cfg.card_collapsible?'checked':''}><label for="cpce-card-collapsible">Make card collapsible (click title to expand/collapse)</label></div>
          ${cfg.card_collapsible ? `
            <div class="cpce-check"><input type="checkbox" id="cpce-card-show-chevron" ${cfg.card_show_chevron!==false?'checked':''}><label for="cpce-card-show-chevron">Show chevron in title</label></div>
            ${!cfg.title ? `<div class="cpce-hint" style="color:var(--warning-color,#ff9800);">A Card Title (below) is recommended for the collapsible header.</div>` : `<div class="cpce-hint">The card starts collapsed; clicking the title expands it.</div>`}
          ` : ''}

          <div class="cpce-field-title">Card Title</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-show-title" ${cfg.show_title!==false?'checked':''}><label for="cpce-show-title">Show card title</label></div>
          <div class="cpce-row"><label class="lbl">Card Title</label><input type="text" id="cpce-title" value="${escapeHtml(cfg.title||'')}"></div>
          ${cfg.show_title!==false ? this._textStyleControls('cpce-title', { size: cfg.title_font_size, weight: cfg.title_font_weight, color: cfg.title_color }, 18) : ''}

          <div class="cpce-field-title">Title Icon</div>
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


          <div class="cpce-row">
            <label class="lbl">Card Background</label>
            <select id="cpce-card-bg-mode">
              <option value="theme" ${(cfg.card_bg_mode||'theme')==='theme'?'selected':''}>Theme Default</option>
              <option value="transparent" ${cfg.card_bg_mode==='transparent'?'selected':''}>Transparent</option>
              <option value="custom" ${cfg.card_bg_mode==='custom'?'selected':''}>Custom Color</option>
            </select>
          </div>
          ${cfg.card_bg_mode === 'custom' ? `<div class="cpce-row"><label class="lbl">Custom Color</label><input type="color" id="cpce-card-bg-color" value="${cfg.card_bg_color || '#1c1c1c'}"></div>` : ''}
          <div class="cpce-hint">Transparent forces the background to be invisible; Theme Default uses whatever color your Home Assistant theme applies to cards.</div>

          <div class="cpce-field-title">Border</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-card-border-enabled" ${cfg.card_border_enabled?'checked':''}><label for="cpce-card-border-enabled">Enable card border</label></div>
          ${cfg.card_border_enabled ? `
            <div class="cpce-row"><label class="lbl">Border Color</label><input type="color" id="cpce-card-border-color" value="${cfg.card_border_color || '#2196F3'}"></div>
            <div class="cpce-row"><label class="lbl">Border Weight</label><input type="range" id="cpce-card-border-width" min="1" max="10" value="${Number(cfg.card_border_width)||1}"><span class="cpce-strength-val" id="cpce-card-border-width-val">${Number(cfg.card_border_width)||1}px</span></div>
            <div class="cpce-row"><label class="lbl">Corner Radius</label><input type="range" id="cpce-card-border-radius" min="0" max="40" value="${Number(cfg.card_border_radius)||12}"><span class="cpce-strength-val" id="cpce-card-border-radius-val">${Number(cfg.card_border_radius)||12}px</span></div>
            <div class="cpce-row">
              <label class="lbl">Sides</label>
              <button class="cpce-mini-btn" id="cpce-card-border-sides-all" type="button">All</button>
              <button class="cpce-mini-btn" id="cpce-card-border-sides-none" type="button">None</button>
            </div>
            <div class="cpce-row">
              <label class="lbl"></label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-border-side" id="cpce-card-border-top" ${cfg.card_border_top!==false?'checked':''}> Top</label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-border-side" id="cpce-card-border-bottom" ${cfg.card_border_bottom!==false?'checked':''}> Bottom</label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-border-side" id="cpce-card-border-left" ${cfg.card_border_left!==false?'checked':''}> Left</label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-border-side" id="cpce-card-border-right" ${cfg.card_border_right!==false?'checked':''}> Right</label>
            </div>
            <div class="cpce-hint">Corners: TL, TR, BR, BL. The Corner Radius value above applies uniformly to every checked corner; uncheck a corner to keep it square.</div>
            <div class="cpce-row">
              <label class="lbl"></label>
              <button class="cpce-mini-btn" id="cpce-card-corners-all" type="button">All</button>
              <button class="cpce-mini-btn" id="cpce-card-corners-none" type="button">None</button>
            </div>
            <div class="cpce-row">
              <label class="lbl"></label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-corner" id="cpce-card-corner-0" ${(cfg.card_border_corners||[true,true,true,true])[0]?'checked':''}> TL</label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-corner" id="cpce-card-corner-1" ${(cfg.card_border_corners||[true,true,true,true])[1]?'checked':''}> TR</label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-corner" id="cpce-card-corner-2" ${(cfg.card_border_corners||[true,true,true,true])[2]?'checked':''}> BR</label>
              <label class="cpce-inline-check"><input type="checkbox" class="cpce-card-corner" id="cpce-card-corner-3" ${(cfg.card_border_corners||[true,true,true,true])[3]?'checked':''}> BL</label>
            </div>
          ` : ''}

          <div class="cpce-field-title">Glow</div>
          <div class="cpce-hint">Glow works independently of the border above — it can be enabled with or without a visible border.</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-card-glow-enabled" ${cfg.card_glow_enabled?'checked':''}><label for="cpce-card-glow-enabled">Enable card glow</label></div>
          ${cfg.card_glow_enabled ? `
            <div class="cpce-row"><label class="lbl">Glow Condition</label>
              <select id="cpce-card-glow-condition">
                <option value="always" ${cfg.card_glow_condition!=='when_light_on'?'selected':''}>Always</option>
                <option value="when_light_on" ${cfg.card_glow_condition==='when_light_on'?'selected':''}>When any target light is on</option>
              </select>
            </div>
            <div class="cpce-row"><label class="lbl">Glow Color</label>
              <select id="cpce-card-glow-color-mode">
                <option value="fixed" ${(cfg.card_glow_color_mode!=='light'&&cfg.card_glow_color_mode!=='active')?'selected':''}>Fixed color</option>
                <option value="light" ${cfg.card_glow_color_mode==='light'?'selected':''}>Light's current color</option>
                <option value="active" ${cfg.card_glow_color_mode==='active'?'selected':''}>Last-pressed button's color</option>
              </select>
            </div>
            ${cfg.card_glow_color_mode !== 'light' ? `<div class="cpce-row"><label class="lbl">${cfg.card_glow_color_mode==='active'?'Fallback Glow Color':'Fixed Glow Color'}</label><input type="color" id="cpce-card-glow-color" value="${cfg.card_glow_color || '#2196F3'}"></div>${cfg.card_glow_color_mode==='active'?`<div class="cpce-hint">Used until a button is pressed.</div>`:''}` : ''}
            <div class="cpce-row"><label class="lbl">Glow Intensity</label><input type="range" id="cpce-card-glow-intensity" min="0.2" max="3" step="0.1" value="${Number(cfg.card_glow_intensity)||1.0}"><span class="cpce-strength-val" id="cpce-card-glow-intensity-val">${(Number(cfg.card_glow_intensity)||1.0).toFixed(1)}x</span></div>
            <div class="cpce-check"><input type="checkbox" id="cpce-card-glow-borders-only" ${cfg.card_glow_borders_only!==false?'checked':''}><label for="cpce-card-glow-borders-only">Glow stronger on sides with borders (when borders enabled)</label></div>
          ` : ''}

          <div class="cpce-field-title">Drop Shadow</div>
          <div class="cpce-hint">A plain elevation shadow, separate from the colored Glow effect above.</div>
          <div class="cpce-row">
            <label class="lbl">Shadow Color</label>
            <input type="color" id="cpce-card-shadow-color" value="${cfg.card_shadow_color || '#000000'}">
            <label class="cpce-inline-check"><input type="checkbox" id="cpce-card-shadow-enabled" ${cfg.card_shadow_enabled?'checked':''}> Enable drop-shadow</label>
          </div>
          ${cfg.card_shadow_enabled ? `
            <div class="cpce-row"><label class="lbl">X Offset</label><input type="range" id="cpce-card-shadow-x" min="-20" max="20" value="${Number(cfg.card_shadow_x)||0}"><span class="cpce-strength-val" id="cpce-card-shadow-x-val">${Number(cfg.card_shadow_x)||0}px</span></div>
            <div class="cpce-row"><label class="lbl">Y Offset</label><input type="range" id="cpce-card-shadow-y" min="-20" max="20" value="${Number(cfg.card_shadow_y)||4}"><span class="cpce-strength-val" id="cpce-card-shadow-y-val">${Number(cfg.card_shadow_y)||4}px</span></div>
            <div class="cpce-row"><label class="lbl">Blur</label><input type="range" id="cpce-card-shadow-blur" min="0" max="40" value="${Number(cfg.card_shadow_blur)||16}"><span class="cpce-strength-val" id="cpce-card-shadow-blur-val">${Number(cfg.card_shadow_blur)||16}px</span></div>
            <div class="cpce-row"><label class="lbl">Spread</label><input type="range" id="cpce-card-shadow-spread" min="-20" max="20" value="${Number(cfg.card_shadow_spread)||0}"><span class="cpce-strength-val" id="cpce-card-shadow-spread-val">${Number(cfg.card_shadow_spread)||0}px</span></div>
            <div class="cpce-row"><label class="lbl">Opacity</label><input type="range" id="cpce-card-shadow-opacity" min="0" max="100" value="${Math.round((Number(cfg.card_shadow_opacity)??0.35)*100)}"><span class="cpce-strength-val" id="cpce-card-shadow-opacity-val">${Math.round((Number(cfg.card_shadow_opacity)??0.35)*100)}%</span></div>
          ` : ''}

          <div class="cpce-field-title">Sizing</div>
          <div class="cpce-row"><label class="lbl">Overall Scale</label><input type="range" id="cpce-scale" min="0.6" max="1.8" step="0.05" value="${Number(cfg.scale)||1.0}"><span class="cpce-strength-val" id="cpce-scale-val">${(Number(cfg.scale)||1.0).toFixed(2)}x</span></div>
          <div class="cpce-hint">Overall Scale multiplies every other size (button/slider height and text) as a global multiplier.</div>
        `)}

        ${this._section('mdi:gesture-tap-button', 'Button Appearance', 'button-appearance', `
          <div class="cpce-hint">Visual formatting for the preset buttons themselves — separate from the card's own border/glow above.</div>

          <div class="cpce-field-title">Button Layout</div>
          <div class="cpce-row"><label class="lbl">Layout Type</label>
            <select id="cpce-layout">
              <option value="stack" ${cfg.layout==='stack'?'selected':''}>Stack (vertical)</option>
              <option value="columns" ${cfg.layout==='columns'?'selected':''}>Columns (row)</option>
              <option value="grid" ${cfg.layout==='grid'?'selected':''}>Grid</option>
            </select>
          </div>
          <div class="cpce-row"><label class="lbl">Grid Columns</label><input type="range" id="cpce-columns" min="1" max="6" value="${Number(cfg.columns)||3}"><span class="cpce-strength-val" id="cpce-columns-val">${Number(cfg.columns)||3}</span></div>
          <div class="cpce-row"><label class="lbl">Gap (px)</label><input type="range" id="cpce-gap" min="0" max="48" value="${Number(cfg.gap)||8}"><span class="cpce-strength-val" id="cpce-gap-val">${Number(cfg.gap)||8}px</span></div>
          <div class="cpce-check"><input type="checkbox" id="cpce-wrap" ${cfg.wrap?'checked':''}><label for="cpce-wrap">Allow buttons to wrap</label></div>
          <div class="cpce-row"><label class="lbl">Icon–Label Spacing</label><input type="range" id="cpce-button-icon-gap" min="0" max="24" value="${Number(cfg.button_icon_gap)??8}"><span class="cpce-strength-val" id="cpce-button-icon-gap-val">${Number(cfg.button_icon_gap)??8}px</span></div>

          <div class="cpce-field-title">Style</div>
          <div class="cpce-row"><label class="lbl">Button Color Style</label>
            <select id="cpce-button-style">
              <option value="solid" ${cfg.button_style!=='tinted'?'selected':''}>Solid</option>
              <option value="tinted" ${cfg.button_style==='tinted'?'selected':''}>Tinted</option>
            </select>
          </div>

          <div class="cpce-field-title">Border</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-button-border-enabled" ${cfg.button_border_enabled?'checked':''}><label for="cpce-button-border-enabled">Enable button border</label></div>
          ${cfg.button_border_enabled ? `
            <div class="cpce-row"><label class="lbl">Border Color</label>
              <select id="cpce-button-border-color-mode">
                <option value="fixed" ${cfg.button_border_color_mode!=='match'?'selected':''}>Fixed color</option>
                <option value="match" ${cfg.button_border_color_mode==='match'?'selected':''}>Match button color (lighter shade)</option>
              </select>
            </div>
            ${cfg.button_border_color_mode !== 'match' ? `<div class="cpce-row"><label class="lbl">Fixed Border Color</label><input type="color" id="cpce-button-border-color" value="${cfg.button_border_color || '#2196F3'}"></div>` : ''}
            <div class="cpce-row"><label class="lbl">Border Weight</label><input type="range" id="cpce-button-border-width" min="1" max="10" value="${Number(cfg.button_border_width)||1}"><span class="cpce-strength-val" id="cpce-button-border-width-val">${Number(cfg.button_border_width)||1}px</span></div>
          ` : ''}
          <div class="cpce-row"><label class="lbl">Corner Radius</label><input type="range" id="cpce-button-border-radius" min="0" max="40" value="${Number(cfg.button_border_radius)||10}"><span class="cpce-strength-val" id="cpce-button-border-radius-val">${Number(cfg.button_border_radius)||10}px</span></div>

          <div class="cpce-field-title">Glow</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-button-glow-enabled" ${cfg.button_glow_enabled?'checked':''}><label for="cpce-button-glow-enabled">Enable button glow</label></div>
          ${cfg.button_glow_enabled ? `
            <div class="cpce-row"><label class="lbl">Glow Color</label>
              <select id="cpce-button-glow-color-mode">
                <option value="fixed" ${cfg.button_glow_color_mode!=='match'?'selected':''}>Fixed color</option>
                <option value="match" ${cfg.button_glow_color_mode==='match'?'selected':''}>Match current light color</option>
              </select>
            </div>
            ${cfg.button_glow_color_mode !== 'match' ? `<div class="cpce-row"><label class="lbl">Fixed Glow Color</label><input type="color" id="cpce-button-glow-color" value="${cfg.button_glow_color || '#2196F3'}"></div>` : ''}
            <div class="cpce-row"><label class="lbl">Glow Intensity</label><input type="range" id="cpce-button-glow-intensity" min="0.2" max="3" step="0.1" value="${Number(cfg.button_glow_intensity)||1.0}"><span class="cpce-strength-val" id="cpce-button-glow-intensity-val">${(Number(cfg.button_glow_intensity)||1.0).toFixed(1)}x</span></div>
            <div class="cpce-row"><label class="lbl">Glow When</label>
              <select id="cpce-button-glow-condition">
                <option value="always" ${cfg.button_glow_condition==='always'?'selected':''}>Always on</option>
                <option value="when_active" ${cfg.button_glow_condition==='when_active'?'selected':''}>Preset is active (matches light state)</option>
              </select>
            </div>
          ` : ''}

          <div class="cpce-field-title">Sizing</div>
          <div class="cpce-row"><label class="lbl">Button Text Size</label><input type="range" id="cpce-button-font-size" min="8" max="32" value="${Number(cfg.button_font_size)||14}"><span class="cpce-strength-val" id="cpce-button-font-size-val">${Number(cfg.button_font_size)||14}px</span></div>
          <div class="cpce-row"><label class="lbl">Name Text Weight</label>
            <select id="cpce-button-name-weight">
              ${['300','400','500','600','700'].map(w => `<option value="${w}" ${(cfg.button_name_weight||'600')===w?'selected':''}>${w}</option>`).join('')}
            </select>
          </div>
          <div class="cpce-row"><label class="lbl">Button Height</label><input type="range" id="cpce-button-height" min="24" max="100" value="${Number(cfg.button_height)||44}"><span class="cpce-strength-val" id="cpce-button-height-val">${Number(cfg.button_height)||44}px</span></div>
          <div class="cpce-check"><input type="checkbox" id="cpce-button-name-wrap" ${cfg.button_name_wrap?'checked':''}><label for="cpce-button-name-wrap">Word-wrap button names (multi-word names break to lines instead of widening)</label></div>
          <div class="cpce-row"><label class="lbl">Max Button Width</label><input type="range" id="cpce-button-max-width" min="0" max="300" step="5" value="${Number(cfg.button_max_width)||0}"><span class="cpce-strength-val" id="cpce-button-max-width-val">${Number(cfg.button_max_width) ? `${Number(cfg.button_max_width)}px` : 'Auto'}</span></div>
          <div class="cpce-hint">Set Max Width (and enable word-wrap) for uniform button sizes; 0 = Auto. Heights are aligned so wrapped buttons match single-line ones.</div>
        `)}

        ${this._section('mdi:minus', 'Section Dividers', 'dividers', `
          <div class="cpce-hint">Show a divider line above and/or below each section on the card.</div>
          ${[
            ['Buttons', 'buttons'],
            ['Sliders', 'sliders'],
            ['Color Values', 'values'],
          ].map(([label, key]) => `
            <div class="cpce-row"><label class="lbl">${label}</label>
              <label class="cpce-inline-check"><input type="checkbox" id="cpce-div-${key}-top" ${cfg[`divider_${key}_top`]?'checked':''}> Top</label>
              <label class="cpce-inline-check"><input type="checkbox" id="cpce-div-${key}-bottom" ${cfg[`divider_${key}_bottom`]?'checked':''}> Bottom</label>
            </div>
          `).join('')}
          <div class="cpce-sub-title">Divider Appearance</div>
          <div class="cpce-row"><label class="lbl">Line Color</label>
            <select id="cpce-divider-color-mode">
              <option value="theme" ${!cfg.divider_color?'selected':''}>Theme default</option>
              <option value="fixed" ${cfg.divider_color?'selected':''}>Custom color</option>
            </select>
          </div>
          ${cfg.divider_color ? `<div class="cpce-row"><label class="lbl">Custom Color</label><input type="color" id="cpce-divider-color" value="${cfg.divider_color}"></div>` : ''}
          <div class="cpce-row"><label class="lbl">Thickness</label><input type="range" id="cpce-divider-thickness" min="1" max="10" value="${Number(cfg.divider_thickness)||1}"><span class="cpce-strength-val" id="cpce-divider-thickness-val">${Number(cfg.divider_thickness)||1}px</span></div>
          <div class="cpce-row"><label class="lbl">Length</label><input type="range" id="cpce-divider-length" min="5" max="100" value="${Number(cfg.divider_length)||100}"><span class="cpce-strength-val" id="cpce-divider-length-val">${Number(cfg.divider_length)||100}%</span></div>
        `)}

        ${this._section('mdi:palette-swatch-outline', 'Scratchpad', 'favorites', `
          <div class="cpce-check"><input type="checkbox" id="cpce-show-favorites" ${cfg.show_favorites?'checked':''}><label for="cpce-show-favorites">Show scratchpad bar on the card</label></div>
          <div class="cpce-hint">Scratchpad colors are temporary and saved in this browser only (not synced across devices), shared across all Color Light Manager cards in it. Use them to quickly stash a color you're experimenting with.</div>
        `)}

        <div class="cpce-group-divider"><ha-icon icon="mdi:view-dashboard-outline"></ha-icon>Section Builder</div>

        ${this._section('mdi:lightbulb-multiple-outline', 'Buttons', 'presets', `
          <div class="cpce-hint">Configure the quick-select buttons. Use the color wheel for precise color selection.</div>
          <div id="cpce-preset-list">${(cfg.presets||[]).map((p, i) => this._renderPresetEditor(p, i)).join('')}</div>
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
                <button class="cpce-icon-btn cpce-ss-remove" title="Remove section" ${arr.length <= 1 ? 'disabled' : ''}><ha-icon icon="mdi:delete"></ha-icon></button>
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
              </div>
            </div>`;
          }).join('')}
          <button class="cpce-add-btn" id="cpce-add-slider-section"><ha-icon icon="mdi:plus"></ha-icon> Add Slider Section</button>

          <div class="cpce-sub-title">Shared Slider Settings</div>
          <div class="cpce-row"><label class="lbl">Min Kelvin (Warm)</label><input type="range" id="cpce-min-kelvin" min="1000" max="10000" step="100" value="${Number(cfg.min_kelvin)||2000}"><span class="cpce-strength-val" id="cpce-min-kelvin-val">${Number(cfg.min_kelvin)||2000}K</span></div>
          <div class="cpce-row"><label class="lbl">Max Kelvin (Cool)</label><input type="range" id="cpce-max-kelvin" min="1000" max="10000" step="100" value="${Number(cfg.max_kelvin)||6500}"><span class="cpce-strength-val" id="cpce-max-kelvin-val">${Number(cfg.max_kelvin)||6500}K</span></div>

          <div class="cpce-sub-title">Brightness Slider Gradient</div>
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

          <div class="cpce-sub-title">Orientation</div>
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

          <div class="cpce-sub-title">Slider Handle</div>
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
          <div class="cpce-row"><label class="lbl">Movement Smoothing</label><input type="range" id="cpce-slider-debounce" min="0" max="1000" step="10" value="${Number(cfg.slider_debounce_ms)??100}"><span class="cpce-strength-val" id="cpce-slider-debounce-val">${Number(cfg.slider_debounce_ms)??100}ms</span></div>
          <div class="cpce-hint">How long to wait during a drag before sending a position to the light. Higher values smooth out rapid movement at the cost of a slight delay.</div>

          <div class="cpce-sub-title">Sizing</div>
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

          <div class="cpce-sub-title">Text Placement</div>
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

          <div class="cpce-sub-title">Text Visibility</div>
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

        <div class="cpce-group-divider"><ha-icon icon="mdi:cog-outline"></ha-icon>Entity &amp; Profile Management</div>

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
          <div class="cpce-collapse-head${this._addedEntitiesCollapsed ? ' collapsed' : ''}" id="cpce-added-toggle"><ha-icon icon="mdi:chevron-down"></ha-icon>Default Entities (${(cfg.entities||[]).length})</div>
          ${this._addedEntitiesCollapsed ? '' : `<div id="cpce-selected-list">${this._renderSelectedList()}</div>`}
        `)}

        ${this._section('mdi:tune-variant', 'Advanced Send Methods', 'options', `
          <div class="cpce-hint">Send methods compensate for a specific <strong>controller's firmware</strong> — how it wants white color temperature delivered, and whether it needs a color and an effect sent separately. Because these depend on the physical light (and one button can drive several different fixtures), set a <strong>card default</strong> below, then override <strong>per light</strong> for any fixture that behaves differently.</div>

          <div class="cpce-sub-title">Card Default — White Temperature Send Method</div>
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

          <div class="cpce-sub-title">Card Default — Effect Send Method</div>
          <div class="cpce-hint">For a button that sets <strong>both</strong> a color and an effect, choose how they're sent. Effects run on the bulb's own firmware (e.g. Zigbee identify / color-loop) — the card only sends the effect name; its speed isn't adjustable and most effects override the button's color.</div>
          <div class="cpce-check"><input type="checkbox" id="cpce-effect-separate" ${cfg.effect_separate_call?'checked':''}><label for="cpce-effect-separate">Send effect in a separate command (color first, then effect)</label></div>
          <div class="cpce-hint">Some controllers (e.g. Gledopto RGBWW via Zigbee2MQTT) re-trigger the effect from the color change when both are sent together, adding an extra flash. Turn this on to send them as two commands. Leave off (one command) for most lights.</div>

          <div class="cpce-sub-title">Per-Light Overrides</div>
          ${this._renderEntitySendMethods()}
        `)}

        ${this._section('mdi:movie-open-cog-outline', 'Scene Builder', 'scene-builder', `
          <div class="cpce-hint">Build multi-light scenes here — capture per-light states into a Home Assistant scene. (Coming soon.)</div>
        `)}

        ${this._section('mdi:card-multiple-outline', 'Fixture Profile Library', 'profile-library', this._renderProfileLibrarySection())}

        ${this._section('mdi:link-variant', 'Color Entities', 'color-entities', `
          <div class="cpce-hint">
            <code>color.*</code> (Color helper) entities store a reusable color/brightness. A button set to
            <strong>Custom Color/Temperature</strong> can link to one — the button then applies that entity's
            value <strong>live</strong> (edit it here, every linked button updates). Legacy <code>input_color.*</code> helpers still work.
          </div>

          <div class="cpce-collapse-head${this._ceCollapsed.manage ? ' collapsed' : ''}" data-ce-toggle="manage"><ha-icon icon="mdi:chevron-down"></ha-icon>Manage Entities (${this._allInputColorEntities.length})</div>
          ${this._ceCollapsed.manage ? '' : this._renderColorEntitiesManageList()}

          <div class="cpce-collapse-head${this._ceCollapsed.create ? ' collapsed' : ''}" data-ce-toggle="create"><ha-icon icon="mdi:chevron-down"></ha-icon>Create New Entity</div>
          ${this._ceCollapsed.create ? '' : `
            <div class="cpce-row">
              <input type="text" id="cpce-new-input-color-name" placeholder="Entity name (e.g. Theater Golden)">
              <button class="cpce-create-preset-btn" id="cpce-create-input-color-entity"><ha-icon icon="mdi:plus"></ha-icon> Create Entity</button>
            </div>
            <div class="cpce-hint">Creates a new <code>color</code> helper entity and, once confirmed, a new preset automatically linked to it. If the entity can't be created, no preset is created.</div>`}

          <div class="cpce-collapse-head${this._ceCollapsed.orphans ? ' collapsed' : ''}" data-ce-toggle="orphans"><ha-icon icon="mdi:chevron-down"></ha-icon>Clean Up Orphans</div>
          ${this._ceCollapsed.orphans ? '' : `
            <div class="cpce-hint">
              Older integration versions could leave behind orphaned color entities (ones "no longer
              provided by the integration") that Home Assistant won't let you delete normally. Scan for
              and remove any such orphaned <code>color.*</code> / <code>input_color.*</code> entities here.
            </div>
            <button class="cpce-add-btn" id="cpce-cleanup-orphans"><ha-icon icon="mdi:broom"></ha-icon> Scan &amp; Remove Orphans</button>`}
        `)}

      </div>
    `;
    this._wireEvents();
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
    bind('#cpce-icon', 'icon');
    bind('#cpce-icon-size', 'icon_size', v => clamp(parseInt(v,10)||22, 12, 48));
    bind('#cpce-icon-color', 'icon_color');
    const iconColorEnabledEl = this.querySelector('#cpce-icon-color-enabled');
    if (iconColorEnabledEl) iconColorEnabledEl.addEventListener('change', () => { this._updateConfig({ icon_color_enabled: iconColorEnabledEl.checked }); this._render(); });
    const iconColorModeEl = this.querySelector('#cpce-icon-color-mode');
    if (iconColorModeEl) iconColorModeEl.addEventListener('change', () => { this._updateConfig({ icon_color_mode: iconColorModeEl.value }); this._render(); });
    const iconOffModeEl = this.querySelector('#cpce-icon-off-mode');
    if (iconOffModeEl) iconOffModeEl.addEventListener('change', () => { this._updateConfig({ icon_off_color_mode: iconOffModeEl.value }); this._render(); });
    bind('#cpce-icon-off-color', 'icon_off_color');
    bind('#cpce-layout', 'layout');
    bind('#cpce-columns', 'columns', v => clamp(parseInt(v,10)||3,1,6));
    bind('#cpce-gap', 'gap', v => clamp(parseInt(v,10)||0,0,48));
    bind('#cpce-button-icon-gap', 'button_icon_gap', v => clamp(parseInt(v,10)||0,0,24));
    bind('#cpce-wrap', 'wrap');
    // Section ordering: move a section up/down in the order (by id) and re-render.
    const moveSection = (id, dir) => {
      const order = this._orderedSections().map(s => s.id);
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      // Persist sections too so the migrated set is written (order alone isn't enough on first run).
      this._updateConfig({ sections: this._orderedSectionsRaw(), section_order: order });
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
    // Per-section name heading + text style panel.
    const patchSection = (id, patch) => this._updateSections(this._orderedSectionsRaw().map(s => s.id === id ? { ...s, ...patch } : s));
    this.querySelectorAll('.cpce-order-style').forEach(btn => {
      btn.onclick = () => { this._openSectionStyle = this._openSectionStyle === btn.dataset.key ? null : btn.dataset.key; this._render(); };
    });
    this.querySelectorAll('.cpce-order-style-panel').forEach(panel => {
      const id = panel.dataset.sectionId;
      const showCb = panel.querySelector('.cpce-sn-show');
      if (showCb) showCb.addEventListener('change', () => { patchSection(id, { name_show: showCb.checked }); this._render(); });
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
    ['buttons', 'sliders', 'values'].forEach(key => {
      bind(`#cpce-div-${key}-top`, `divider_${key}_top`);
      bind(`#cpce-div-${key}-bottom`, `divider_${key}_bottom`);
    });
    const dividerColorModeEl = this.querySelector('#cpce-divider-color-mode');
    if (dividerColorModeEl) dividerColorModeEl.addEventListener('change', () => {
      // theme = clear the custom color (falls back to --divider-color); fixed = seed a default.
      this._updateConfig({ divider_color: dividerColorModeEl.value === 'fixed' ? (this._config.divider_color || '#444444') : '' });
      this._render();
    });
    bind('#cpce-divider-color', 'divider_color');
    bind('#cpce-divider-thickness', 'divider_thickness', v => clamp(parseInt(v,10)||1, 1, 10));
    bind('#cpce-divider-length', 'divider_length', v => clamp(parseInt(v,10)||100, 5, 100));
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
    bind('#cpce-card-border-color', 'card_border_color');
    bind('#cpce-card-border-width', 'card_border_width', v => clamp(parseInt(v,10)||1, 1, 10));
    bind('#cpce-card-border-radius', 'card_border_radius', v => clamp(parseInt(v,10)||12, 0, 40));
    bind('#cpce-card-border-top', 'card_border_top');
    bind('#cpce-card-border-bottom', 'card_border_bottom');
    bind('#cpce-card-border-left', 'card_border_left');
    bind('#cpce-card-border-right', 'card_border_right');
    bind('#cpce-card-glow-color', 'card_glow_color');
    bind('#cpce-card-glow-intensity', 'card_glow_intensity', v => clamp(parseFloat(v)||1.0, 0.2, 3));
    bind('#cpce-card-glow-borders-only', 'card_glow_borders_only');
    bind('#cpce-card-shadow-color', 'card_shadow_color');
    bind('#cpce-card-shadow-x', 'card_shadow_x', v => clamp(parseInt(v,10)||0, -20, 20));
    bind('#cpce-card-shadow-y', 'card_shadow_y', v => clamp(parseInt(v,10)||4, -20, 20));
    bind('#cpce-card-shadow-blur', 'card_shadow_blur', v => clamp(parseInt(v,10)||16, 0, 40));
    bind('#cpce-card-shadow-spread', 'card_shadow_spread', v => clamp(parseInt(v,10)||0, -20, 20));
    bind('#cpce-card-shadow-opacity', 'card_shadow_opacity', v => clamp(parseInt(v,10)||35, 0, 100) / 100);
    bind('#cpce-slider-border-radius', 'slider_border_radius', v => clamp(parseInt(v,10)||10, 0, 40));
    bind('#cpce-vertical-slider-alignment', 'vertical_slider_alignment');
    bind('#cpce-scale', 'scale', v => clamp(parseFloat(v)||1.0, 0.6, 1.8));
    bind('#cpce-button-style', 'button_style');
    bind('#cpce-button-font-size', 'button_font_size', v => clamp(parseInt(v,10)||14, 8, 32));
    bind('#cpce-button-name-weight', 'button_name_weight');
    bind('#cpce-button-name-wrap', 'button_name_wrap');
    bind('#cpce-button-max-width', 'button_max_width', v => clamp(parseInt(v,10)||0, 0, 300));
    bind('#cpce-button-height', 'button_height', v => clamp(parseInt(v,10)||44, 24, 100));
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
    bind('#cpce-button-border-color', 'button_border_color');
    bind('#cpce-button-border-width', 'button_border_width', v => clamp(parseInt(v,10)||1, 1, 10));
    bind('#cpce-button-border-radius', 'button_border_radius', v => clamp(parseInt(v,10)||10, 0, 40));
    bind('#cpce-button-glow-color', 'button_glow_color');
    bind('#cpce-button-glow-intensity', 'button_glow_intensity', v => clamp(parseFloat(v)||1.0, 0.2, 3));
    bind('#cpce-button-glow-condition', 'button_glow_condition');
    bind('#cpce-card-glow-condition', 'card_glow_condition');
    ['brightness', 'temperature', 'rgb'].forEach(type => {
      bind(`#cpce-${type}-label-position`, `${type}_label_position`);
      bind(`#cpce-${type}-value-position`, `${type}_value_position`);
    });
    // Switching fixed-vs-current mode changes which field is shown, so it needs a full re-render.
    const endModeEl = this.querySelector('#cpce-brightness-end-mode');
    if (endModeEl) endModeEl.addEventListener('change', () => { this._updateConfig({ brightness_end_color_mode: endModeEl.value }); this._render(); });
    const glowColorModeEl = this.querySelector('#cpce-card-glow-color-mode');
    if (glowColorModeEl) glowColorModeEl.addEventListener('change', () => { this._updateConfig({ card_glow_color_mode: glowColorModeEl.value }); this._render(); });
    // Switching between fixed and match border color shows/hides the fixed-color picker.
    const btnBorderModeEl = this.querySelector('#cpce-button-border-color-mode');
    if (btnBorderModeEl) btnBorderModeEl.addEventListener('change', () => { this._updateConfig({ button_border_color_mode: btnBorderModeEl.value }); this._render(); });
    const btnGlowModeEl = this.querySelector('#cpce-button-glow-color-mode');
    if (btnGlowModeEl) btnGlowModeEl.addEventListener('change', () => { this._updateConfig({ button_glow_color_mode: btnGlowModeEl.value }); this._render(); });
    // Enabling/disabling a slider's label/value text also enables/disables its position dropdown.
    ['brightness', 'temperature', 'rgb'].forEach(type => {
      const labelCb = this.querySelector(`#cpce-${type}-show-label`);
      if (labelCb) labelCb.addEventListener('change', () => this._render());
      const valueCb = this.querySelector(`#cpce-${type}-show-value`);
      if (valueCb) valueCb.addEventListener('change', () => this._render());
    });
    // Per-corner radius toggles for the card border (TL, TR, BR, BL).
    [0, 1, 2, 3].forEach(i => {
      const el = this.querySelector(`#cpce-card-corner-${i}`);
      if (el) el.addEventListener('change', () => {
        const corners = [...(this._config.card_border_corners || [true, true, true, true])];
        corners[i] = el.checked;
        this._updateConfig({ card_border_corners: corners });
      });
    });
    // These toggles reveal/hide dependent fields, so they need a full re-render.
    ['#cpce-card-border-enabled', '#cpce-card-glow-enabled', '#cpce-card-shadow-enabled', '#cpce-button-border-enabled', '#cpce-button-glow-enabled'].forEach(sel => {
      const el = this.querySelector(sel);
      const keyMap = {
        '#cpce-card-border-enabled': 'card_border_enabled',
        '#cpce-card-glow-enabled': 'card_glow_enabled',
        '#cpce-card-shadow-enabled': 'card_shadow_enabled',
        '#cpce-button-border-enabled': 'button_border_enabled',
        '#cpce-button-glow-enabled': 'button_glow_enabled',
      };
      if (el) el.addEventListener('change', () => { this._updateConfig({ [keyMap[sel]]: el.checked }); this._render(); });
    });
    // "All"/"None" convenience buttons for the card border side toggles.
    const setAllBorderSides = (value) => {
      this._updateConfig({ card_border_top: value, card_border_bottom: value, card_border_left: value, card_border_right: value });
      this._render();
    };
    const sidesAllBtn = this.querySelector('#cpce-card-border-sides-all');
    if (sidesAllBtn) sidesAllBtn.onclick = () => setAllBorderSides(true);
    const sidesNoneBtn = this.querySelector('#cpce-card-border-sides-none');
    if (sidesNoneBtn) sidesNoneBtn.onclick = () => setAllBorderSides(false);
    // "All"/"None" convenience buttons for the card corner-radius toggles.
    const setAllCorners = (value) => { this._updateConfig({ card_border_corners: [value, value, value, value] }); this._render(); };
    const cornersAllBtn = this.querySelector('#cpce-card-corners-all');
    if (cornersAllBtn) cornersAllBtn.onclick = () => setAllCorners(true);
    const cornersNoneBtn = this.querySelector('#cpce-card-corners-none');
    if (cornersNoneBtn) cornersNoneBtn.onclick = () => setAllCorners(false);
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
    wireRangeReadout('#cpce-card-glow-intensity', '#cpce-card-glow-intensity-val', 'x');
    wireRangeReadout('#cpce-scale', '#cpce-scale-val', 'x');
    wireRangeReadout('#cpce-button-glow-intensity', '#cpce-button-glow-intensity-val', 'x');
    wireRangeReadout('#cpce-card-border-width', '#cpce-card-border-width-val', 'px');
    wireRangeReadout('#cpce-card-border-radius', '#cpce-card-border-radius-val', 'px');
    wireRangeReadout('#cpce-button-border-width', '#cpce-button-border-width-val', 'px');
    wireRangeReadout('#cpce-card-shadow-x', '#cpce-card-shadow-x-val', 'px');
    wireRangeReadout('#cpce-card-shadow-y', '#cpce-card-shadow-y-val', 'px');
    wireRangeReadout('#cpce-card-shadow-blur', '#cpce-card-shadow-blur-val', 'px');
    wireRangeReadout('#cpce-card-shadow-spread', '#cpce-card-shadow-spread-val', 'px');
    wireRangeReadout('#cpce-card-shadow-opacity', '#cpce-card-shadow-opacity-val', '%');
    wireRangeReadout('#cpce-slider-border-radius', '#cpce-slider-border-radius-val', 'px');
    wireRangeReadout('#cpce-icon-size', '#cpce-icon-size-val', 'px');
    wireRangeReadout('#cpce-divider-thickness', '#cpce-divider-thickness-val', 'px');
    wireRangeReadout('#cpce-divider-length', '#cpce-divider-length-val', '%');
    wireRangeReadout('#cpce-columns', '#cpce-columns-val', '');
    wireRangeReadout('#cpce-gap', '#cpce-gap-val', 'px');
    wireRangeReadout('#cpce-button-icon-gap', '#cpce-button-icon-gap-val', 'px');
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
    this.querySelectorAll('.cpce-delete-entity-btn').forEach(btn => {
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

    // Color Entities — per-entity edit-panel toggle (pencil).
    this.querySelectorAll('.cpce-ce-edit').forEach(btn => {
      btn.onclick = () => { this._openColorEntity = this._openColorEntity === btn.dataset.entity ? null : btn.dataset.entity; this._render(); };
    });

    // Color Entities — per-entity edit panels: color wheel + hex + temp + brightness, each
    // writing straight to the entity via set_color (linked buttons follow it live).
    this.querySelectorAll('.cpce-ce-edit-panel').forEach(panel => {
      const id = panel.dataset.entity;
      const modeEl = panel.querySelector('.cpce-ce-mode');
      if (modeEl) modeEl.addEventListener('change', () => {
        if (modeEl.value === 'temp') {
          const midK = Math.round(((Number(this._config.min_kelvin)||2000) + (Number(this._config.max_kelvin)||6500)) / 2);
          this._writeEntityColorData(id, { color_temp_kelvin: midK });
        } else {
          this._writeEntityColorData(id, { rgb_color: inputColorStateToPresetValue(this._hass && this._hass.states[id]).rgb_color || [255, 0, 0] });
        }
        this._render();
      });
      // Color wheel + hex.
      const canvas = panel.querySelector('.cpce-ce-wheel');
      if (canvas) {
        const cur = inputColorStateToPresetValue(this._hass && this._hass.states[id]);
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
          this._writeEntityColorData(id, { rgb_color: rgb }, true);
          const prev = panel.querySelector('.cpce-hex-preview'); const hexIn = panel.querySelector('.cpce-ce-hex');
          const hex = ColorUtils.rgbToHex(rgb[0], rgb[1], rgb[2]);
          if (prev) prev.style.background = hex; if (hexIn && document.activeElement !== hexIn) hexIn.value = hex;
          const sw = this.querySelector(`.cpce-manage-item[data-entity="${id}"] .cpce-fav-swatch`); if (sw) sw.style.background = hex;
          this._drawColorWheel(canvas, ColorUtils.rgbToHs(rgb[0],rgb[1],rgb[2])[0], ColorUtils.rgbToHs(rgb[0],rgb[1],rgb[2])[1]);
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
      if (hexEl) hexEl.addEventListener('change', () => { const rgb = ColorUtils.hexToRgb(hexEl.value); if (rgb) { this._writeEntityColorData(id, { rgb_color: rgb }); this._render(); } });
      const tempEl = panel.querySelector('.cpce-ce-temp'); const tempVal = panel.querySelector('.cpce-temp-val');
      if (tempEl) { tempEl.addEventListener('input', () => { if (tempVal) tempVal.textContent = `${tempEl.value}K`; }); tempEl.addEventListener('change', () => this._writeEntityColorData(id, { color_temp_kelvin: parseInt(tempEl.value,10) })); }
      const briEn = panel.querySelector('.cpce-ce-bri-enable');
      if (briEn) briEn.addEventListener('change', () => {
        const cur = inputColorStateToPresetValue(this._hass && this._hass.states[id]);
        this._writeEntityColorData(id, { brightness: briEn.checked ? (cur.brightness ?? 255) : null });
        this._render();
      });
      const briEl = panel.querySelector('.cpce-ce-bri'); const briVal = panel.querySelector('.cpce-bri-val');
      if (briEl) { briEl.addEventListener('input', () => { if (briVal) briVal.textContent = `${briEl.value}%`; }); briEl.addEventListener('change', () => this._writeEntityColorData(id, { brightness: Math.round(clamp(parseInt(briEl.value,10)||1,1,100)*2.55) })); }
    });

    // Fixture Profile Library (single shared 'system' store): rename, delete.
    this.querySelectorAll('.cpce-profile-rename').forEach(inp => {
      inp.addEventListener('change', () => {
        const slug = inp.dataset.slug;
        const map = { ...fixtureLibraryMap('system') };
        if (!map[slug]) return;
        map[slug] = { ...map[slug], name: inp.value || slug };
        saveFixtureLibrary(this._hass, 'system', map).catch(e => console.warn(`${LOG_PREFIX} rename profile failed`, e));
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
        saveFixtureLibrary(this._hass, 'system', map)
          .then(() => this._render())
          .catch(e => { console.warn(`${LOG_PREFIX} delete profile failed`, e); window.alert(`Could not delete: ${formatWsError(e)}`); });
      };
    });
    // Toggle a library profile's inline edit panel.
    this.querySelectorAll('.cpce-profile-edit').forEach(btn => {
      btn.onclick = () => { this._openProfile = this._openProfile === btn.dataset.slug ? null : btn.dataset.slug; this._render(); };
    });
    // Create a new profile (opens its editor).
    const addProfileBtn = this.querySelector('#cpce-add-profile');
    if (addProfileBtn) addProfileBtn.onclick = () => this._addFixtureProfile();
    // Library profile edit-panel field wiring (writes straight to the shared library).
    this.querySelectorAll('.cpce-profile-edit-panel').forEach(panel => {
      const slug = panel.dataset.slug;
      const q = (sel) => panel.querySelector(sel);
      const modeEl = q('.cpce-pe-mode');
      if (modeEl) modeEl.addEventListener('change', () => {
        const map = { ...fixtureLibraryMap('system') };
        const e = map[slug]; if (!e) return;
        const look = { ...(e.look || {}) };
        ALL_PRESET_COLOR_KEYS.forEach(k => delete look[k]); delete look.color_kelvin; delete look.action; delete look.look_none;
        const midK = Math.round(((Number(this._config.min_kelvin)||2000) + (Number(this._config.max_kelvin)||6500)) / 2);
        if (modeEl.value === 'temp') look.color_kelvin = midK;
        else { const rgb = presetColorToRgb(e.look || {}); look.rgb_color = rgb; }  // keep current color as rgb
        map[slug] = { ...e, look };
        saveFixtureLibrary(this._hass, 'system', map).then(() => this._render()).catch(() => this._render());
      });
      // Color wheel + hex + native fields (same UI as a Custom Color button).
      this._wireProfileColorWheel(panel, slug);
      const tempEl = q('.cpce-pe-temp'); const tempVal = q('.cpce-temp-val');
      if (tempEl) { tempEl.addEventListener('input', () => { if (tempVal) tempVal.textContent = `${tempEl.value}K`; }); tempEl.addEventListener('change', () => this._patchProfileLook(slug, { color_kelvin: parseInt(tempEl.value,10) })); }
      const briEn = q('.cpce-pe-bri-enable');
      if (briEn) briEn.addEventListener('change', () => { this._patchProfileLook(slug, { brightness: briEn.checked ? (((fixtureLibraryMap('system')[slug]||{}).look||{}).brightness ?? 255) : null }); this._render(); });
      const briEl = q('.cpce-pe-bri'); const briVal = q('.cpce-bri-val');
      if (briEl) { briEl.addEventListener('input', () => { if (briVal) briVal.textContent = `${briEl.value}%`; }); briEl.addEventListener('change', () => this._patchProfileLook(slug, { brightness: Math.round(clamp(parseInt(briEl.value,10)||1,1,100)*2.55) })); }
      const trEn = q('.cpce-pe-trans-enable');
      if (trEn) trEn.addEventListener('change', () => { this._patchProfileLook(slug, { transition: trEn.checked ? (((fixtureLibraryMap('system')[slug]||{}).look||{}).transition ?? 1) : null }); this._render(); });
      const trEl = q('.cpce-pe-trans'); const trVal = q('.cpce-transition-val');
      if (trEl) { trEl.addEventListener('input', () => { if (trVal) trVal.textContent = `${trEl.value}s`; }); trEl.addEventListener('change', () => this._patchProfileLook(slug, { transition: clamp(parseFloat(trEl.value)||0,0,10) })); }
      const efEl = q('.cpce-pe-effect');
      if (efEl) efEl.addEventListener('change', () => this._patchProfileLook(slug, { effect: efEl.value.trim() || null }));
    });

    // Presets
    this._attachPresetListeners();
    const addBtn = this.querySelector('#cpce-add-preset');
    if (addBtn) addBtn.onclick = () => this._addNewPreset();
  }

  // Adds a new preset, optionally creating and linking a new input_color entity
  // for it when the user opts in.
  _addNewPreset() {
    const newPreset = { id: newPresetId(), name: 'New Preset', icon: modeDefaultIcon('color'), mode: 'color', rgb_color: [255, 0, 0] };

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
window.customCards.push({ type: 'color-light-manager-card', name: 'Color Light Manager', description: 'Control colored lights (color temp / RGB / RGBWW) in real time, with preset and Color Entity management.', preview: true });

debugLog('Loaded', BUILD_NUMBER);
