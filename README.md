# Color Light Manager — Control & Management Features

A Home Assistant custom Lovelace card for controlling colored lights (color, temperature, brightness) in real time, with preset buttons, scene triggering, and management of the entities that back it. This document covers the functional/control features — not the visual styling options.

---

## Entities

**Manage Card Entities** defines the pool of `light.*` entities the card works with. Everything else (presets, sliders, color-value readouts) targets a subset of this pool.

- Search/filter available lights and add each with a `+`.
- Each entity shows its **supported color modes** (e.g. `color_temp`, `xy`, `rgb`) as chips, so you know what each light natively accepts.
- The "Added Entities" list is collapsible (for large setups).

## Scenes (Scene Manager)

**Scene Manager** defines a pool of `scene.*` entities available to presets — mirroring the entity manager.

- Search/add scenes; presets can then trigger one or more of them.
- Triggering calls `scene.turn_on`.

---

## Sliders (real-time control)

Sliders send live changes to their target light(s) as you drag.

- **Brightness**, **Color Temperature**, and **RGB** sliders.
- **Multiple independent Slider Sections** — each section picks which of the three sliders it shows and targets its own entity subset, so one card can control different lights separately.
- **Smoothing (debounce)** rate-limits service calls during a drag; the handle itself tracks the pointer smoothly (rAF-coalesced) and won't bounce back after release (settle guard ignores stale/in-transition HA states briefly).
- Shared styling across slider sections (orientation, size, handle, text placement/color).

## Color Value Readout

A read-only **Color Values** section shows a target light's current values — **RGB, Kelvin, HS, XY**, plus **W / CW / WW** when the light supports RGBW/RGBWW. Useful for reading a dialed-in color to save into a preset. Each Color Values section monitors its own chosen light(s). Optional mired display alongside Kelvin.

---

## Preset Buttons

Presets are the core control feature. Each preset button is an **additive bundle of actions**, all fired in parallel on press:

### 1. Color / Temperature / Off (the primary action)
- **Color** — stored and sent in one **native format**: RGB, XY, HS, RGBW, or RGBWW. The value is sent verbatim (no lossy conversion), so precise typed values stay exact. Formats a target light supports natively are tagged **(native)**; others still work (HA converts them).
- **Temperature** — a Kelvin value.
- **Off** — turns the color-control lights off.
- Optional **brightness** (independent toggle; when off, the light's current brightness is left unchanged).

### 2. Color Control Lights (target)
Which lights get the color/temp/off action:
- **All** card entities, **Specific** entities (chips), or **None** (send no color — for scene-only or turn-off-only buttons).

### 3. Trigger Scenes
Select one or more scenes (from Scene Manager) to activate on press.

### 4. Turn Off These
Select card entities to turn **off** on press — independent of the color-control lights (e.g. set an accent color on one light while turning others off).

> A single preset can, for example: set XY color on the accent lights, turn off the ceiling lights, and activate a "movie" scene — all at once.

### Presets ↔ Color Entities
Presets can **link to an `input_color.*` helper entity** as a persistent store of their color values:
- On link, the preset **reads** the entity's current values.
- Edits are held locally; **"Save to Entity"** writes them back on demand. Unsaved edits revert when the preset editor closes — the entity stays the source of truth, so a deleted/recreated button recovers its values from the entity.
- A link-status icon shows linked (and flags broken links to missing entities).

## White Color Temperature — Send Method

Because some controllers mishandle standard `color_temp_kelvin`, the card can send a white temperature as any of: **Kelvin** (default), **XY**, **HS**, **RGB**, **RGBW**, or **RGBWW**. Applies to both the temperature slider and Temperature presets. Use **XY** (or RGBWW for dedicated cold/warm channels) if your controller renders whites wrong on Kelvin.

---

## Manage HA's Color Entities

Direct management of `input_color.*` helper entities from the card:
- **Create** a new Color Entity (drives the integration's config flow) and auto-link a preset to it.
- **Delete** an entity (removes the config entry and its registry entry).
- **Create Preset** from an unmatched entity.
- **Scan & Remove Orphans** — cleans up orphaned color entities the integration can leave behind.

## Sections & Targeting Model

The card body is an ordered list of user-defined **sections** — Buttons, Sliders, and Color Values — each nameable, reorderable, and independently targetable:
- Multiple Buttons sections; each preset chooses which section it appears in.
- Multiple Slider sections and Color Values sections, each with its own target entities.
- Any action's target is always intersected with the card's managed entities.
