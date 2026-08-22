# Color Light & Scene Manager

A Home Assistant Dashboard **custom card** for controlling colored lights (color / temperature / RGB / RGBWW) in real time **and authoring Home Assistant scenes** — with mode-driven preset buttons, reusable **Fixture Profiles**, live-linked **Color Entities**, per-light send-method tuning, and a full visual editor.

> The dashboard resource, card `type:` (`custom:color-light-manager-card`), and JS filename keep their original `color-light-manager-card` names for backward compatibility — only the display name changed.

---

## Requirements

The card works on its own for buttons, sliders, and scenes. Two features build on the **Color helper integration** (the `color` domain) by [@kkilchrist](https://github.com/kkilchrist/ha-color-ext): **Color Entities** (a button following a shared, live color) and **exact color round-trip**.

- Repo: **https://github.com/kkilchrist/ha-color-ext**
- Install via **HACS → Integrations → Custom repositories** → add that repo as an *Integration* → install → restart Home Assistant.
- **v0.3.0+ recommended** — it adds the `color_params` / `source` / `source_type` attributes the card reads for exact color (no lossy xy→rgb drift). Older versions and legacy `input_color.*` helpers still work via a fallback path.

Not using Color Entities? The integration is optional — buttons with an inline Custom Color/Temperature need nothing extra.

---

## Installation

1. Copy `color-light-manager-card.js` into your Home Assistant `config/www/` folder.
2. Add it as a dashboard resource:
   - **Settings → Dashboards → ⋮ → Resources → Add Resource**
   - URL: `/local/color-light-manager-card.js`  ·  Type: **JavaScript Module**
3. Hard-refresh the browser (Ctrl/Cmd+Shift+R). Confirm the console shows the loaded version, e.g. `[v2026.08.22.97]`.
4. Add the card to a dashboard: **Add Card → Custom: Color Light & Scene Manager** (or `type: custom:color-light-manager-card`).

---

## Concepts

- **Default Entities** — an optional shared pool of `light.*` entities. Each button/section can include this pool **live** (changes propagate instantly) and/or add its own lights. It's also the reference set the card glow / header icon follow, and where per-light Send Methods are configured. It can be left empty — every button can target its own lights instead.
- **Buttons** — **single-purpose**: each has a **Mode** that decides the one thing it does — **Light Off**, **Fixture Profile**, **Scene**, **Custom Temperature**, or **Custom Color**. Only the settings relevant to the mode are shown. To combine actions (dim some lights, turn others off, close blinds…), build a **Scene** and use a Scene-mode button.
- **Fixture Profiles** — reusable "looks" (color/temperature + brightness/transition/effect) stored in a shared library. A button set to *Fixture Profile* references one; editing the profile updates every button using it.
- **Color Entities** — `color.*` helper entities that store a color/brightness. A button linked to one holds **no color of its own** and applies the entity's value **live** — edit the entity once and every linked button follows.
- **Scenes** — real Home Assistant `scene.*` entities, authored in the card's Scene Manager (multi-domain: lights, switches, fans, covers, climate, media players…). Usable anywhere in HA (native cards, `select` helpers, automations, voice); a Scene-mode button activates one.

---

## Features

### Live card (control)
- **Mode-driven preset buttons** — Light Off · Fixture Profile · Scene · Custom Temperature · Custom Color. Each button does exactly one thing (its mode).
- **Per-button targeting** — for a look/off button, combine the live Default Entities pool with the button's own lights (any `light.*`).
- **Sliders** (real-time) — Brightness, Color Temperature, RGB. Multiple independent slider sections, each targeting its own lights; debounced sends with a smooth, non-bouncing handle.
- **Color Values** — a read-only readout of a light's current RGB / Kelvin / HS / XY (plus W / CW / WW for RGBW/RGBWW), handy for dialing in a color.
- **Scratchpad** — a temporary, browser-local strip for stashing colors you're experimenting with.

### Scene Manager
- Author **real `scene.*` entities** without leaving the card (written via Home Assistant's scene config API — the same one HA's own scene editor uses).
- **Create a Scene:** capture the current state of the entities you choose, with an optional fade-in **transition**, **name**, and **icon**.
- **Multi-domain:** lights (color/brightness/effect/transition), plus switches, fans, covers, climate, media players, locks, humidifiers, and input/select helpers — each with the settable attributes its domain supports.
- **Edit any scene:** expand to see and change every member's exact stored values (sliders for numeric values, search-to-add more entities, per-member remove), edit name/icon, then **Save** (a button that greys to "Settings Saved" and turns accent-blue when there are unsaved changes). Activate or re-capture from the list.

### Fixture Profile Library
- Create, name, edit, and delete reusable profiles in one place (**Entities, Scenes & Profiles → Fixture Profile Library**).
- Full inline editor per profile: color wheel + native format fields, or temperature, plus brightness, transition, and effect.
- Shared across **all** Color Light &amp; Scene Manager cards on the instance via Home Assistant's built-in frontend store — one edit updates every referencing button live. No custom component required.

### Color Entities (needs the Color integration)
- Manage `color.*` helpers from the card: **create**, **edit** (color wheel / temperature / brightness, written via `color.set_color`), **rename**, **delete**, and clean up orphans — each row collapsible.
- A button in Custom Color/Temperature mode can **link** to an entity; it then applies that entity's value in real time and its own inline editors are hidden (the entity is the single source of truth — no drift).
- **Exact color** — with Color integration v0.3.0+ the card reads the entity's authored value (`color_params`) and sends it in its **native format** (xy stays xy, etc.), eliminating the lossy xy→rgb round-trip.

### Send Methods (per controller)
- **White Temperature Send Method** — send a color temperature as `color_temp_kelvin` (default) or as `xy` / `hs` / `rgb` / `rgbw` / `rgbww`, for controllers whose native temperature handling is wrong.
- **Effect Send Method** — for a button carrying both a color and an effect, send them together (default) or as two separate `light.turn_on` calls (fixes controllers that re-trigger the effect off the color change, e.g. Gledopto via Zigbee2MQTT).
- **Per-light overrides** — set a card default, then override either method **per light**. At press time the card resolves the method per target entity and groups service calls accordingly, so one button can correctly drive mixed fixtures at once.

### Card & button appearance (visual editor)
- Grouped editor: **Card Builder** (layout, appearance, dividers, scratchpad), **Section Builder** (Buttons, Sliders, Color Values), and **Entities, Scenes & Profiles** (Default Entities, Advanced Send Methods, Scene Manager, Fixture Profile Library, Color Entities).
- Button styling — solid / tinted, border, glow, size, icon, per-mode default icons; optional per-button custom styling color with a "copy from another button" picker.
- **Icon fields assume `mdi:`** — type a bare name (`lightbulb`) and it resolves to `mdi:lightbulb`; prefixed icons (`si:`, custom sets) are left as-is.
- Card title, icon, collapsible header, background, border (per-side), glow, and drop shadow.
- **Glow & header icon color** can follow the light's live color, the **last-pressed button's** color, or a fixed color.
- Linkage badges on each button (Color Entity / Fixture Profile / Scene), and per-light color-mode chips in the entity list.

---

## Notes & limitations

- **Effects run on the bulb's firmware.** The card only sends the effect *name* from a light's `effect_list`; it can't set effect speed/intensity (Home Assistant's `light.turn_on` has no such parameter). Many effects also override the button's color. Some effects (e.g. Zigbee "identify" effects like `breathe`) are fixed-timing pulses — nothing card-side can smooth them.
- **A linked button stores no color** — deleting its Color Entity leaves it applying no color until relinked or given an inline color.
- **Scratchpad** colors are browser-local and not synced across devices.
- **Fixture Profile slugs are internal.** A profile's storage key stays fixed when you rename it (so references never break); it isn't an entity and can't be used from automations/scripts.

---

## Version

Build number format: `v<year>.<month>.<day>.<increment>` — the trailing increment is a monotonic version counter that never resets. It's defined once at the top of `color-light-manager-card.js` (`BUILD_NUMBER`) and shown in the editor header and browser console on load.

## Credits

- Card: **LTek** — [github.com/Ltek/color-light-manager-card](https://github.com/Ltek/color-light-manager-card)
- Color helper integration: **[@kkilchrist](https://github.com/kkilchrist/ha-color-ext)** — [ha-color-ext](https://github.com/kkilchrist/ha-color-ext)

<img width="450" alt="live" src="https://github.com/user-attachments/assets/8cc6de7c-5b1d-49f4-b345-d828add28fc0" />

<img width="450" alt="editor" src="https://github.com/user-attachments/assets/ad8300fb-9f54-4f96-a27d-c164d4d4d036" />
