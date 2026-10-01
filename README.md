# Color Light & Scene Manager

A Home Assistant Dashboard **custom card** for controlling colored lights (color / temperature / RGB / RGBWW) in real time, **authoring Home Assistant scenes**, and **tracking scene state across rooms** — with mode-driven preset buttons, reusable styles and fixture profiles, live-linked color entities, per-light send-method tuning, and a full visual editor.

> The Dashboard resource, card `type:` (`custom:color-light-manager-card`), and JS filename keep their original `color-light-manager-card` names for backward compatibility — only the display name changed.

Current build: **v2026.10.01.282** · full history in [CHANGELOG.md](CHANGELOG.md)

---

## Key features at a glance

- **Preset buttons, single-purpose** — each button does one thing by Mode: turn lights **Off**, apply a **Fixture Profile**, activate a **Scene**, set a **Custom Temperature**, set a **Custom Color**, or show a **Scene Tracker** status tile.
- **Scene Groups (input_select)** — bind a button to one or more `input_select` "scene" helpers. Pressing it sets each helper; the button highlights **only when all its bound options currently match** — reliable, single-winner active state that survives reloads and doesn't guess from light state.
- **Scene Tracker buttons**: read-only tiles that show an area's current scene, with its color and icon. A tile takes its look from the scene button that set that scene. It sits among your other buttons and uses the section's Button Style.
- **Scene Manager** — create and edit **real HA `scene.*` entities** in the card (lights + switches, fans, covers, climate, media, locks, and more), usable anywhere in Home Assistant.
- **Scene Groups manager** — create, rename, edit options, and delete the `input_select` scene helpers right from the card (admin users).
- **Reusable, shared styles** — a **Button Styles** library (layered looks with conditional overlays) and a **Frame Styles** library, plus **Fixture Profiles** for reusable light looks. Edit once → every card using it updates live.
- **Flexible button sections**: Vertical Stack, Horizontal Stack, a Single Row, or a Grid, with alignment and gap. The **Off** button and **Scene Tracker** tiles can sit inline, or in their own row or column (shared, if you want them lined up), each with its own location, size and gap.
- **Local Favorites**: save any displayed color as a favorite straight from the card, edit it in the editor, then turn it into a button or a Color Entity.
- **Real-time sliders** — Brightness, Color Temperature, and RGB, in independent sections, each driving its own lights.
- **Live color linking** — a button can follow a `color.*` helper entity's value in real time (optional integration).
- **Per-controller send tuning** — send temperature as Kelvin/xy/hs/rgb/rgbw/rgbww and effects bundled or separate, per light, so mixed fixtures all behave.
- **Full visual editor** — every option is point-and-click; no YAML required.

---

## Requirements

The card works on its own for buttons, sliders, scenes, scene groups, and the scene tracker. Two features build on the **Color helper integration** (the `color` domain) by [@kkilchrist](https://github.com/kkilchrist/ha-color-ext): **Color Entities** (a button following a shared, live color) and **exact color round-trip**.

- Repo: **https://github.com/kkilchrist/ha-color-ext**
- Install via **HACS → ⋮ → Custom repositories** → add that repo with category **Dashboard** → install → hard-refresh the browser.
- **v0.3.0+ recommended** — it adds the `color_params` / `source` / `source_type` attributes the card reads for exact color (no lossy xy→rgb drift). Older versions and legacy `input_color.*` helpers still work via a fallback path.

Not using Color Entities? The integration is optional — buttons with an inline Custom Color/Temperature need nothing extra.

**Scene Groups** use standard Home Assistant `input_select` helpers. You can create them inside the card (admin), or in **Settings → Devices & Services → Helpers**.

---

## Concepts

- **Default Entities** — an optional shared pool of `light.*` entities. Each button/section can include this pool **live** and/or add its own lights. It's also the reference set the card glow / header icon can follow, and where per-light Send Methods are configured. It can be left empty.
- **Buttons** are **single-purpose**: each has a **Mode** that decides the one thing it does: Light Off, Fixture Profile, Scene, Custom Temperature, Custom Color, or Scene Tracker (a read-only status tile). To combine actions, build a Scene and use a Scene-mode button. Buttons show on the card in the order set with the arrows in the editor's Buttons panel.
- **Scene Selects** — an optional list of `input_select` bindings on any button. On press the card sets each helper to its option; the button is "active" only when **all** its bound helpers are on their options. Works for any button type and can span several helpers (e.g. one button that sets the same scene in three rooms).
- **Follow Lights for Color** — a scene button borrows the **live color** of the lights it controls for its own appearance (body + glow + accents). HA-native scenes auto-resolve their member lights; Z2M/script scenes need you to name the lights to follow. Falls back to a fixed color, then neutral grey, when nothing is on.
- **Scene Tracker**: a button Mode. Each tracker button is one area, made of an `input_select` (`tracker_entity`) and an optional representative light (`tracker_light`). The tile shows the current option and glows while the area is on a real scene, meaning anything other than Off or None. It never sets anything when pressed. Its color and icon come from the Scene button whose Scene Selects set the current option, or else from the light's live color. **Text** shows either the button's name with the current scene below it (default), or the current scene with your own text below it. **No Scene Text** replaces the raw option (e.g. `-none-` or `Off`) with your own words whenever no scene is on, or tick **Hide this tile when no scene is on** to remove the tile until a scene is set (it stays visible while editing the dashboard). Like the Off button, tracker tiles can be moved into a row or column above, below, before or after the other buttons (see **Scene Tracker Layout** below).
- **Fixture Profiles** — reusable "looks" (color/temperature + brightness/transition/effect) stored in a shared library; a *Fixture Profile* button references one.
- **Button Styles** — reusable button appearance (layout, border, glow, gradient, background, sizing) stored in a shared library; a section applies one to all its buttons.
- **Color Entities**: `color.*` helper entities that store a color/brightness. A linked button holds no color of its own and applies the entity's value live. Create one with a linked button via **Add Button & Entity** (Buttons panel) or **Create Entity** (Color Entities panel), or from a Local Favorite.
- **Scenes** — real Home Assistant `scene.*` entities, authored in the card's Scene Manager and usable anywhere in HA.

---

## Options at a glance

Every option below is fully point-and-click in the visual editor.

### Live card (control)
- **Mode-driven preset buttons**: Light Off · Fixture Profile · Scene · Custom Temperature · Custom Color · Scene Tracker. Each button does exactly one thing.
- **Scene Selects** — bind a button to one or more `input_select` helpers; deterministic multi-helper "active" (all must match).
- **Per-button targeting** — combine the live Default Entities pool with a button's own lights.
- **Sliders** (real-time) — Brightness, Color Temperature, RGB, in independent slider sections; debounced sends with a smooth handle.
- **Color Values** — a read-only readout of a light's current RGB / Kelvin / HS / XY (plus W / CW / WW where applicable).
- **Local Favorites**: a browser-local bar for stashing colors you're experimenting with. Each Color Values section has a **Save as Favorite** action, on by default and hideable per section. The editor's **Local Favorites** panel lists every saved favorite, so you can rename, recolor, set brightness and reorder them. Each one can also be turned into a **button** or a **Color Entity**; both keep the favorite.

### Buttons sections
- **Layout Type** — **Vertical Stack**, **Horizontal Stack**, **Single Row** (one line that scrolls sideways) or **Grid**, plus Grid Columns, **Alignment** (Left / Center / Right), Gap and Allow-wrap. A Button Style sets these; a section can override any of them and leave the rest on *Style default*.
- **Off Button Layout**: keep the Off button(s) **Inline**, or move them to a **Row above / below** or a **Column before / after**.
  - **Off Location** places them Left / Center / Right in a row, or Top / Middle / Bottom in a column.
  - **Button Gap** sets the space to the main buttons, exactly, in every Layout Type.
  - **Button Size** scales just the Off button(s).
  - A moved Off button keeps the same height as the main buttons, and the same width when they share one width.
  - For a column, the section's **Alignment** positions the whole [Off + buttons] cluster on the card. When a Horizontal Stack wraps to several rows, the rows stay centred on each other.
- **Scene Tracker Layout**: the same options for the section's Scene Tracker tiles: placement, **Tracker Location**, **Size** and **Gap**. Choose the **same** placement as the Off button to put both in one shared row or column. Each group keeps its own Location, Size and Gap there, and groups with the same Location sit together (two Center groups are centred side by side). Off and trackers can also use different placements, e.g. trackers in a column on the left and Off in a column on the right.
- **Only Control Lights Currently On** — a press affects only the section's target lights that are already on (Color, Temperature, Fixture Profile and Off buttons; Scene buttons fire the scene as-is). A fixed setting, plus an optional live checkbox on the card with its own placement, alignment and text style.
- Each section lists its buttons as removable chips.
- In the **Buttons** panel:
  - Buttons are grouped by section, in card order. The **up / down arrows** move a button within its section and change its order on the card.
  - **Add Button** adds a button; **Add Button & Entity** also creates a Color Entity and links the button to it.
  - New buttons start **unassigned**, so you choose their section.

### Scene Manager
- Author **real `scene.*` entities** without leaving the card (via HA's scene config API — the same one HA's own editor uses).
- **Create** by capturing the current state of chosen entities, with optional fade-in transition, name, and icon.
- **Multi-domain** — lights, switches, fans, covers, climate, media players, locks, humidifiers, and input/select helpers, each with its settable attributes.
- **Edit any scene** — expand to change every member's stored values, add/remove members, edit name/icon, then Save. Activate or re-capture from the list.

### Scene Groups (input_select helpers)
- **Create** a scene group (name + options + optional initial option and icon).
- **Edit options**, **rename**, and **delete** existing groups. YAML-defined helpers are shown read-only.
- Deleting a group warns how many buttons and Scene Tracker buttons reference it, and cleans those references up.
- *Admin only* — creating/editing helpers requires an admin Home Assistant user (a limitation of HA). Non-admins can still bind buttons to existing helpers.

### Send Methods (per controller)
- **White Temperature Send Method** — send a temperature as `color_temp_kelvin` (default) or as `xy` / `hs` / `rgb` / `rgbw` / `rgbww`.
- **Effect Send Method** — send a color+effect together (default) or as two separate calls, for controllers that re-trigger the effect on color change.
- **Per-light overrides** — set a card default, then override either method per light; the card groups service calls per resolved method so one button can drive mixed fixtures correctly.

### Card & button appearance
- Grouped editor: **Card** (layout, appearance, dividers, send methods), **Sections** (Buttons, Sliders, Color Values, Local Favorites, Dividers, order), and **Libraries** (Color Entities, Fixture Profiles, Frame Styles, Header Rules, Button Styles, Scenes, Scene Groups). Every panel's add / create / **Import** actions sit in one row at the top, under the panel's description.
- **Section Import / Export** — export any section (with its buttons bundled) as portable JSON and import it fully-configured on another card, via a copy/paste modal.
- **Button Styles** — layout, solid / tinted / theme / transparent background, per-side border, gradient border, glow (fixed / match / active-only), drop shadow, size, name/icon styling. Built-in **Basic Theme** and **Neon Lux**, or your own layered styles with conditional overlays.
- **Follow Lights for Color** (scene buttons) — the button's body, glow, and accents track the **live color** of the lights it turns on (auto for HA scenes; pick the lights for Z2M/script scenes). Live color applies only while the button is active.
- **Fixed Button & Glow colors** — two independent, separately-toggled fixed colors per button; set either, both, or neither. Unset = follow the live color; nothing to follow = neutral grey.
- **Save as Fixture Profile** — turn a button's inline Custom Color/Temperature look into a shared, reusable profile.
- **Icon fields assume `mdi:`** — type a bare name (`lightbulb`) and it resolves to `mdi:lightbulb`; prefixed icons (`si:`, custom sets) are left as-is. Tick **No icon (text only)** on a button to show just its text.
- Card title, icon, collapsible header (starts collapsed, or tick **Default state: expanded**), background, per-side border, glow, and drop shadow.
- **Glow & header icon color** can follow the light's live color, the last-pressed button's color, or a fixed color.
- **Header Rules** and **Frame Styles** — state-driven header styling and reusable border/glow/shadow bundles; see **Libraries** below.
- Compact chips on each button's editor row: link-icon chips for the bound **Color Entity** / **Fixture Profile** / **scene count**, **Unassigned** for a button not shown on the card, and per-light color-mode chips.

---

## Libraries

Both this card and the **Easy Entity Styler** card share style libraries stored in Home Assistant's built-in frontend key/value store — **no add-on or custom integration required**. A style you save in one place is available to every card of either type on the instance, and edits propagate live.

- **Scope is system-wide.** Libraries are shared across all users of the instance (Dashboard editing is admin-only, so there's a single shared author). There is no per-user scope.
- **Built-In entries are read-only.** Each library ships with Built-In examples you can't overwrite; **duplicate** one (or use it as a **starter**) to create an editable copy.
- **Edit once, updates everywhere.** A card references a library entry by name; editing that entry updates every card using it, live — no reload.
- **Portable.** Any entry can be **exported** as text and **imported** on another system to share a style with someone else.
- **Inline preview.** Button Styles and Frame Styles rows have an eye toggle that shows a live sample of the entry in place.

### Button Styles
Named, reusable button appearance — layout/columns, background style, border, gradient border, glow, drop shadow, sizing, and name/icon styling. A style is a **layered stack**: a base look plus optional conditional overlays (e.g. an "active" overlay that adds a glow only when a button is active). Two built-ins ship: **Basic Theme** (a clean, neutral look) and **Neon Lux** (transparent tiles with a blue gradient edge and active glow). Create a new style from any **starter** (a built-in or an existing style); the card records what it was based on. A section picks one style for all its buttons, including its Scene Tracker tiles. Per-button layer conditions — **Button Active**, **Off button only** and **Scene Tracker button only** — let one style give those buttons their own look.

### Frame Styles
Named, reusable frame bundles — borders, glow, shadow, background, and per-side edge lines. Each style is **sparse** (it stores only the properties you set), so you can layer an ordered list on a section or the whole card and the last one wins per property. Styles can be **conditional** — applied only when an entity is in a given state.

### Header Rules
Named, reusable, state-driven header styling. A rule set is an ordered list of rules (a condition → the outputs it sets) plus optional defaults. Outputs can set the header's **icon color, icon glyph, text color, icon size, text size,** and a **secondary text line** driven by an entity value. Outputs are sparse — anything left "Not set" defers to the card's own header look — and revert automatically when a rule stops matching. Apply a set to the card title and/or to any section.

### Fixture Profiles (this card only)
Reusable light "looks" — color or temperature plus brightness, transition, and effect — created and edited in **Fixture Profiles**, or by **Save as Fixture Profile** on a Custom Color/Temperature button. A *Fixture Profile* button references one by its internal slug (which stays fixed across renames, so links never break); editing the profile updates every referencing button live. Shared across all Color Light & Scene Manager cards on the instance via the same frontend store.

---

## How "active" (highlight/glow) is decided

Each button independently reports whether it's "active"; more than one can be active at once.

- **Button with Scene Selects** → active when **every** bound `input_select` is on its bound option. (Deterministic; ignores light state.)
- **Scene button, no Scene Selects** → active when it was the last button pressed this session.
- **Off button, no Scene Selects** → active when its target light is off.
- **Custom Color / Temperature button** → active when its target light is on and its current color/temperature matches the button's.

For reliable, mutually-exclusive scene highlighting (including the Off button), bind every button in the group — including Off — to the scene `input_select` with its matching option.

A scene button that **Follows Lights for Color** shows the live room color only while it's active; when inactive it uses its fixed color (or neutral grey), so its color doesn't change as the room's lights drift in the background.

---

## Notes & limitations

- **Effects run on the bulb's firmware.** The card only sends the effect *name* from a light's `effect_list`; it can't set effect speed/intensity, and many effects override the button's color.
- **A linked button stores no color** — deleting its Color Entity leaves it applying no color until relinked or given an inline color.
- **Scene Groups management is admin-only**, and YAML-defined `input_select` helpers can't be edited from the card (bind/display only).
- **Scene Tracker buttons are read-only**: they show scene state but don't set it.
- **Local Favorites** are browser-local and not synced across devices.
- **Fixture Profile slugs are internal** — a profile isn't an entity and can't be used from automations/scripts.

---

## Installation - HACS

[![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Ltek&repository=color-light-manager-card&category=dashboard)

1. Click the button above (or in HACS: **⋮ → Custom repositories**, add `https://github.com/Ltek/color-light-manager-card` as category **Dashboard**).
2. Open the repository in HACS and click **Download**.
3. Hard-refresh the browser (Ctrl/Cmd+Shift+R). HACS adds the Dashboard resource automatically.
4. Add the card to a dashboard: **Add Card → Custom: Color Light & Scene Manager** (or `type: custom:color-light-manager-card`).

---

## Credits

- Card: **LTek** — [github.com/Ltek/color-light-manager-card](https://github.com/Ltek/color-light-manager-card)
- Color helper integration: **[@kkilchrist](https://github.com/kkilchrist/ha-color-ext)** — [ha-color-ext](https://github.com/kkilchrist/ha-color-ext)

---

## Screenshots
<!-- SCREENSHOTS:START -->
<table>
  <tr>
    <td align="center" valign="top">
      <img src="screenshots/editor.JPG" width="100%" alt="editor">
    </td>
    <td align="center" valign="top">
      <img src="screenshots/example-live.JPG" width="100%" alt="example live">
    </td>
    <td align="center" valign="top">
      <img src="screenshots/example2.JPG" width="100%" alt="example2">
    </td>
    <td></td>
  </tr>
</table>
<!-- SCREENSHOTS:END -->

