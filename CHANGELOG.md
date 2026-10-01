# Changelog — Color Light & Scene Manager Card

Build numbers are `vYYYY.MM.DD.N`, where `N` is a monotonic counter that never
resets. Newest first.

> Entries before v2026.09.27.255 were not kept in a changelog; the archived builds in
> `archive/` are the only record of those versions.

---

## v2026.10.01.282

- **Scene Tracker: hide the tile when no scene is on.** There's a new checkbox on Scene Tracker
  buttons, *Hide this tile when no scene is on*. The tile disappears while its group is Off, None,
  `-none-` or unavailable, and comes back as soon as a scene is set. The other buttons close up around
  it, and if it's in a Scene Tracker Layout row or column, that row or column goes away too. It always
  stays visible while you're editing the dashboard, so it can't get lost. *No Scene Text* is hidden
  while this is ticked, since there is nothing to show it on. Stored as `tracker_hide_none: true`.
- **Card Appearance: Default state: expanded.** When *Make card collapsible* is on, this checkbox makes
  the card start open instead of collapsed. Clicking the title still collapses it. Stored as
  `card_start_expanded: true` only while ticked, so existing collapsible cards still start collapsed.

## v2026.10.01.281

- **Fixed: the dashboard could freeze for minutes, especially on mobile.**
  - **Cause:** every Home Assistant state update (any entity, anywhere) registered a new "library
    changed" listener for the shared Button Style, Fixture Profile, Frame Style and Header Rule
    libraries, and none were ever removed. After a few hours that was thousands of listeners per card.
    The next time a library sent an update, each listener ran a full card re-render, one after
    another. A library sends an update when a style is saved, and also when the HA connection resumes,
    for example when the mobile app comes back to the foreground. Measured: 2,000 updates' worth of
    listeners meant one library update caused 2,001 full re-renders and about 5 seconds of frozen page
    on a desktop browser. A phone is several times slower, and a card open for a day has far more.
  - **Why it got worse recently:** the leak is older than these builds, but the v270–v277 layout work
    (wrapped-row fitting, matching moved buttons' sizes) made each re-render measure the page. That
    made each of those thousands of renders about three times as expensive.
  - **Fix:** each card and editor now registers one listener, reused on every update. It is removed
    when the card is taken off the page, and repeated updates are coalesced into one render per frame.
    After the same 2,000 updates there is now 1 listener, and a library update costs 1 render of about
    7 ms.
- **Fixed: the editor's colour wheels added window listeners that were never removed.** The button,
  Fixture Profile and Color Entity wheels each added four mouse/touch listeners to the whole page on
  every editor redraw. Each one kept an old copy of the editor in memory and ran on every mouse or
  touch movement. They are now added when a drag starts and removed when it ends.
- Checked and not a problem: there are no `setInterval`s or periodic fetches. The only repeating
  `setTimeout` is the bounded wait after creating a Color Entity. The resize observer is idle when
  nothing changes. Ordinary state updates still only refresh the buttons' live state, not the whole
  card.

## v2026.10.01.280

- **Scene Tracker: No Scene Text.** It's a freeform field on Scene Tracker buttons, shown in place of
  the scene name when no scene is on: the helper is on Off, None or `-none-`, or is unavailable. So
  instead of `-none-`, a tile can read "No scene", "Idle", or anything you like. It works with both
  Text options: under the button name by default, or as the main text with *Current scene, custom
  text below*. Leave it blank to keep showing the option as-is. Stored as `tracker_none_text`.

## v2026.10.01.279

- **New per-button option: No icon (text only).** It's a checkbox under the button's Name / Icon
  fields. When ticked, the button shows only its text, with no icon or icon gap. This also overrides a
  Button Style that sets an icon for every button. Works for every Mode, including Scene Tracker tiles.
  Stored as `hide_icon: true` only while ticked.
- **Scene Tracker: choose the tile's text.** A new **Text** setting on Scene Tracker buttons:
  - *Button name, current scene below*: the existing look, and the default.
  - *Current scene, custom text below*: the current scene becomes the main text, with **Text Below**
    (anything you type, e.g. the room name) underneath. Leave Text Below blank for a single line.
  Stored as `tracker_text: scene` and `tracker_subtext`. Switching back to the default clears both.
- **Button Styles: new layer condition, "Scene Tracker button only".** It works like *Off button
  only*: a layer with this condition applies only to Scene Tracker tiles, so one Button Style can give
  trackers their own border, background or glow. The style's preview shows a third *Tracker* sample
  whenever a layer uses this condition.

## v2026.10.01.278

- **Documentation only. No change to how the card behaves.** The README is brought up to date with
  v271–v277:
  - Scene Tracker is described as a button Mode (with where its color and icon come from).
  - The Buttons panel's reorder arrows and *Add Button* / *Add Button & Entity* are documented, and
    the Sort dropdown, removed in v271, is no longer mentioned.
  - *Off Button Layout* and the new *Scene Tracker Layout* are described with their current labels
    (Location, Button Size / Size, Button Gap / Gap), including shared rows and columns.
  - The Local Favorites panel and its two convert actions are documented.
  - The editor overview now notes that add / create / Import actions sit at the top of each panel,
    and the button-row chips list no longer includes the removed section-name chip.
- The card file changes only in its version stamp.

## v2026.10.01.277

- **Scene Tracker Layout has its own Gap again, in every case.** It used to disappear when the trackers
  shared the Off button's row or column. Each group now keeps its own **Location**, **Size** and
  **Gap**. Gap is the space between that group and the main buttons, so give both the same Gap to line
  them up exactly.
- **Fixed: two groups set to Center in a shared row weren't in the centre.** Each group was centred in
  its own share of the leftover space, so two Center groups sat at about a quarter and three quarters
  across. Each shared row or column is now split into start / centre / end zones, where the end zones
  share the leftover space equally. Groups with the same Location sit together in that zone, so two
  Center groups are side by side, centred on the section. Top/Left and Bottom/Right go to their ends.
- **Fixed: the Off button looked smaller once moved out of the button row,** even at Button Size 100%.
  Inline, a button takes its width from the row (the style's max-width stretch) and stretches to the
  row's height like its neighbours. Moved into its own row or column it had neither, so it shrank to
  fit its own text. Placed Off buttons and Scene Tracker tiles now get the same height as the main
  buttons, and the same width when the main buttons share one width (as they do with a max width or a
  grid). It's re-measured when the card resizes.
- **Size now takes real space.** Size used to scale only the picture, leaving the full-size box in the
  layout, which threw off centring and gaps for any group below 100%. It now resizes the group itself.
  Off-only placements (no Scene Tracker Layout) keep the previous sizing method, so their looks don't
  change apart from the size fix above.

## v2026.10.01.276

- **Import buttons are labelled just "Import"**, with the same icon, in Frame Styles, Header Rules,
  Button Styles, each Button Style's layers, and Section Layout. What each one imports is now in its
  tooltip. They always sit on the same row as that panel's add buttons; the Section Layout row no
  longer wraps Import onto a line of its own.
- **Scene Tracker Location is back, and works the same way as Off Location.** It now stays visible
  when trackers share the Off button's row or column. In a shared row or column each group keeps its
  own Location. For example, trackers at Top and Off at Bottom sit at opposite ends of the column;
  both at Middle sit together in the centre. On its own, a group's Location works exactly as before.
  The shared row or column still has a single gap to the other buttons: the Off *Button Gap*.
- **Labels under the Off Button / Scene Tracker settings tidied:**
  - Subtitles *Off Button Placement* / *Scene Tracker Placement* are now **Off Button Layout** /
    **Scene Tracker Layout**.
  - The "Placement" label before each dropdown was removed, since the subtitle already says what it is.
  - *Alignment* is now **Location**: *Off Location*, *Tracker Location*.
  - *Off Button Size* is now **Button Size**, *Off Button Gap* is **Button Gap**, *Tracker Size* is
    **Size**, and *Tracker Gap* is **Gap**.
- No config keys changed (`off_button_align` / `tracker_align` etc.), so existing setups are
  unaffected. Sections without a tracker layout render exactly as before.

## v2026.09.30.275

- **Scene Tracker Placement now shares the Off button's rows and columns.** Trackers and Off use the
  same four slots: row above, row below, column before, column after. Give both the same Placement and
  they sit in **one** row or column, lined up with each other: trackers first, then Off. In v274 they
  became two separate, nested rows or columns that couldn't line up. Different placements still work
  independently, e.g. trackers in a column on the left and Off in a column on the right.
  - A shared row/column has one alignment and one gap, so it uses **Off Alignment** and **Off Button
    Gap**. The editor hides the tracker's own Alignment and Gap while shared and says so. **Tracker
    Size** stays separate, so the two can still be sized differently.
  - Sections without a tracker placement render exactly as before.
- **Buttons panel: Add buttons moved to the top, and split in two.** They are now under the panel
  description, above the button list, in the same style as Frame Styles' *New Frame*:
  - **Add Button** adds a Custom Color button straight away. The "Create a linked Color Entity for this
    new preset?" confirmation is gone.
  - **Add Button & Entity** asks for a name, creates a Color Entity, then adds a button linked to it.
    If the entity can't be created, no button is added. Previously a plain button was added anyway,
    which left a half-done result.
- **Every panel's add/create action is now at the top, under its description, in the same style:**
  - **Sliders**: *Add Slider Section*.
  - **Fixture Profiles**: *Add Profile*.
  - **Color Entities**: the name field and *Create Entity*. The collapsible "Create New Entity" section
    was removed.
  - **Scene Groups**: *New Scene Group* opens the create form, and the button becomes *Cancel*. It
    replaces the "Create a Scene Group" collapsible and now sits above the Scene Group filter.
  - **Scenes**: *New Scene* opens the capture form, and the button becomes *Cancel*. It replaces the
    "Create a Scene" collapsible.
  - **Section Layout**: the add-section buttons use the same button style, with *Import Section…* as a
    secondary button, like *Import JSON…* elsewhere.
  - Frame Styles, Header Rules and Button Styles already followed this layout and are unchanged.

## v2026.09.30.274

- **Scene Tracker Placement: the same placement and size options as the Off button.** A buttons
  section's settings now have a *Scene Tracker Placement* group below *Off Button Placement*:
  - **Placement**: Inline (default), Row above, Row below, Column before, Column after
  - **Tracker Alignment**: Left / Center / Right for a row, Top / Middle / Bottom for a column
  - **Tracker Size**: 30–200%, scales only the tracker tiles and is independent of the card scale
  - **Tracker Gap**: the space between the tracker tiles and the other buttons, 8px by default
  These are stored per section as `tracker_placement`, `tracker_align`, `tracker_scale` and
  `tracker_gap`. They are written only when changed from the default, so existing configs don't change.
- **Works together with Off placement.** The tracker tiles are placed around everything else, so you
  can have, for example, trackers in a column on the left, the Off button in a column on the right,
  and the colour buttons in between. The Off button keeps its position next to the other buttons.
- It uses the exact same layout code as Off placement, so the v270 wrapped-row behaviour carries
  over: with column placements on both sides, wrapped button rows stay centred on each other, and
  both gaps stay exact as the card narrows and widens again.
- A section with only tracker buttons ignores the placement, since there is nothing to place them
  beside.

## v2026.09.30.273

- **The Scratchpad panel is now "Local Favorites"**, and "scratchpad" no longer appears anywhere in the
  card or editor. It was always the same store the card's *Save Current* and *Save as Favorite* actions
  write to, so it now has one name everywhere: *Local* because it lives only in this browser.
- **Every Local Favorite is listed and editable in that panel.** Before, the panel only had the
  show-bar checkbox, and the list sat at the bottom of the Buttons panel with just convert and delete.
  Each favorite now has:
  - its name
  - its color: an RGB swatch, or a Kelvin value for temperature favorites
  - an optional brightness (blank means leave brightness unchanged)
  - move up / down, which reorders the card's bar too
  - delete, with the standard confirmation
  Edits save straight to the browser and show on the card's bar immediately. They are not stored in
  the card config, so editing favorites never changes your saved YAML.
- **Two separate convert actions per favorite:**
  - **Convert to Button** (`mdi:gesture-tap-button`) adds a Custom Color or Custom Temperature
    button, unassigned, like before. It now also carries the favorite's brightness; previously that
    was dropped.
  - **Convert to Color Entity** (`mdi:link-variant-plus`) is **new**. It creates a Color helper in
    Home Assistant with the favorite's color and brightness, through the same flow as the Color
    Entities panel's Create. The new entity is then listed under Color Entities. The helper's
    creation step takes RGB, so a temperature favorite is created as that temperature's RGB
    equivalent. Both actions keep the favorite.
- The editor refreshes the list when a favorite is saved on the card or in another tab, but only while
  the Local Favorites panel is open, so it never interrupts editing elsewhere.

## v2026.09.30.272

- **Scene Tracker is now a button Mode, not a section type.** Pick **Mode → Scene Tracker (read-only)**
  on any button, then choose its Scene Group (`input_select`) and, optionally, a Light. One tracker
  button is one area. The tile sits among your other buttons, in the same layout and Button Style, so
  it lines up with them and follows the section's Off-button placement. Order it with the new arrows.
- **Why:** a tracker tile already rendered through the button renderer, so it was a button in all but
  name. Keeping it as a separate section meant a second Areas editor, a second Tile Style picker, and a
  grid layout that didn't match the buttons next to it.
- **Breaking, no migration:** the `scene_tracker` section type is gone. The card now ignores such a
  section, and the "+ Scene Tracker" add-section button was removed. Re-create each Area as a button:

  ```yaml
  presets:
    - id: kitchen_tracker        # any unique id
      name: Kitchen
      mode: tracker
      section_id: <your buttons section id>
      tracker_entity: input_select.kitchen_scene
      tracker_light: light.kitchen   # optional
  ```

  The section's `style_preset` for tiles has no replacement key, because tiles now use the button
  section's style. The YAML-only per-Area `option_colors` / `icon_map` / `icon` keys were also dropped.
  A tracker button's own icon is used when no Scene button supplies one.
- **Tracker buttons are strictly read-only.** Pressing one does nothing. They are skipped by the
  live light-state matching that decides whether a color button is "active", so a tile can't light
  up or set a scene by accident. Tracker mode hides Target Lights, Scene Selects and the look editors,
  since none of them apply. Switching a button to tracker mode clears its press-only settings.
- **Tiles stay live.** A tile re-renders whenever its `input_select` or light changes. That wiring was
  repointed from the old section's Areas to tracker buttons, so tiles don't freeze after first load.
- **Scene Groups panel:** reference counts and the delete-cleanup now cover Scene Tracker buttons.
  Deleting a helper clears it from any tracker button rather than deleting the button.
- **Unassigned buttons** (In Button Section → None) are unchanged. The hint now explains their use
  with tracker buttons: an unassigned Scene button can supply the color and icon a tracker tile shows
  for an option, without a visible button.

## v2026.09.30.271

- **Buttons editor: reorder buttons with up/down arrows.** Each button row now has Move up / Move
  down arrows that change the button's position **on the card**, not just in the editor. The arrows
  move a button within its own section. Buttons in other sections, and Unassigned buttons, stay where
  they are, even when they sit between two buttons of this section in the saved config.
- **Removed the Sort dropdown (Grouped Local / Library, Alphabetical, By Section).** The list is now
  always grouped by button section, in card order. The old sorts only changed the editor's display, so
  there was no way to set the real order. An alphabetical view would also hide the order the arrows
  just set. Local vs Library grouping was redundant: a button that uses a Fixture Profile already shows
  a chip with the profile's name and a link icon.
- **Removed the section-name chip from every button row.** The group divider above the buttons already
  names the section. The **Unassigned** chip stays, since it tells you the button is not shown on the
  card.
- If a button's editor is open when you move it, it stays open.

## v2026.09.30.270

- **Fixed: with a column Off placement, a wrapping *Horizontal Stack* lined its wrapped rows up on the
  left instead of centring them.** When the buttons wrapped to an uneven number of rows, a short last
  row sat flush left rather than centred under the row above — a lone 3rd button appeared under the
  first button instead of between the first two. Wrapped rows are now centred on each other, while the
  nearest button still sits exactly *Off Button Gap* from the Off button. This was a side effect of the
  v269 gap fix, which packed every flex row toward the Off button; only a *non-wrapping* row (Single
  Row, or Horizontal Stack with **Allow buttons to wrap** off) is packed now, since it has no rows to
  centre.
- How, and why it needs JavaScript: no CSS width equals the width a wrapped row actually uses — a
  flex-wrap box's intrinsic (`max-content`) width is its fully *unwrapped* width, and `fit-content`
  resolves to the *available* width. Either leaves slack that `justify-content:center` centres inside,
  re-opening the phantom gap beside Off. (A CSS grid does report a true wrapped width, but forces
  uniform columns — that was v268's bug.) So the widest wrapped row is now measured after layout and
  the box pinned to exactly that width, which satisfies the gap and the row centring at once without
  changing any layout's identity. Narrowing the box to its widest row cannot change the wrapping, since
  no row was wider than it.
- The fit re-runs on width changes (window resize, sidebar toggle, masonry reflow) and after every
  re-render. Verified in a real browser: 13/14 wrap cases pass (the 14th, *Grid*, is unchanged
  pre-existing behaviour — grid tracks are uniform and fill left-to-right); the 25-case column suite
  matches v269 exactly except for the one intended centring change, with gaps exact in all 25; the 7
  *Inline* placement cases are byte-identical to v269; and rows re-wrap and stay centred with an exact
  gap across a 470–900px resize sweep, including after a full re-render.

## v2026.09.30.269

- **Fixed: with a column Off placement, only *Grid* laid out correctly — Vertical Stack, Horizontal
  Stack and Single Row were all rendered as a grid.** v268 fixed the Off-button gap by swapping the
  main button group for a CSS grid, but it did that for *every* layout, so all four Layout Types
  collapsed into the same 3-across grid. The main group now keeps its own layout (a Vertical Stack is a
  real vertical column, a Single Row a real single scrolling row, a Grid a grid) *and* the gap beside
  Off still equals *Off Button Gap*. How: shrink-wrapping turns out to be layout-dependent — stack and
  grid already report the width they use, while a flex row reports its fully-*unwrapped* width and
  can't be shrink-wrapped at all, so a row's buttons are instead packed toward the Off button, putting
  the nearest button flush against it. Section **Alignment** (Left/Center/Right) now positions the
  whole [Off + buttons] cluster, so it works for every layout too. Verified in a real browser across
  25 layout × placement × gap × width combinations (measured gap matched the setting in all of them),
  with the *Inline* placement confirmed byte-identical to v268.

## v2026.09.30.268

- **Fixed for good: column Off placement gap when the main buttons wrap to multiple rows.** The
  phantom gap between the Off button and the buttons (seen since v264, e.g. Dinner/Bright on row 1,
  Sports on row 2 floating far from Off) is gone — *and* the section's Center/Left/Right alignment
  still works. Root cause: a flex-wrap container's intrinsic width is its fully-**unwrapped** width, so
  the main-button box was sized to one long row; centring the cluster then opened the gap. The main
  buttons now render as a CSS **grid** (only grid reports its true wrapped width) sized to
  `max-content` columns, so the Off button sits exactly *Off Button Gap* px away, the cluster centres
  on the card, and wrapped rows align per the section's Alignment. Verified with real-browser pixel
  measurement and screenshots (not just syntax checks).

## v2026.09.30.267

- **Fixed: section Alignment (Left/Center/Right) ignored when the Off button is in a column.** v266's
  gap fix added a scoped rule that packed the main buttons toward the Off button with `!important`,
  which also overrode the section's own alignment — so *Center*/*Right* did nothing (buttons always
  went Left). Removed that override: the main group is content-sized (`flex:0 1 auto`), so its own
  `justify-content` positions the buttons *and* the gap stays exactly *Off Button Gap* — both work.
- **Layout labels shortened.** With a separate *Allow buttons to wrap* checkbox, the wrap qualifier
  was redundant: *Stack - Vertical* → **Vertical Stack**, *Stack - Horizontal wrap* → **Horizontal
  Stack** (Single Row and Grid unchanged). Labels only — configs untouched.

## v2026.09.30.266

- **Fixed (for real): column Off placement gap with a wrapping button layout.** With *Stack -
  Horizontal wrap* (or Grid) and a *Column before/after* Off button, the buttons floated far from the
  Off button — the gap ignored *Off Button Gap*. Two bugs stacked: (1) v265's `width:fit-content` wrap
  mis-sized around the nested wrapping button flex, and (2) the main group's own centre-alignment
  re-centred its wrapped rows inside the leftover width. Now the row is `[Off | gap | main]` with Off
  fixed-size and the main group packed *toward* Off (flush to the facing edge), so the nearest button
  always sits exactly *Off Button Gap* px from Off — in every layout, at any wrap.

## v2026.09.30.265

- **Layout Type labels now match Home Assistant terminology.** *Stack (vertical)* → **Stack -
  Vertical**, *Columns (row)* → **Stack - Horizontal wrap**, *Row (scroll)* → **Single Row** (Grid
  unchanged). Applies to both the Button Styles library's *Button Layout* group and a section's Layout
  override. Only the labels changed — saved configs are untouched (same underlying values).
- **Fixed (again): column Off placement gap now equals the slider in every layout.** The v264 fix
  sized the main-buttons box but the full-width wrap + `justify-content:center` still let a wrapping
  layout re-center the buttons and reintroduce phantom space. The wrap now shrink-wraps to
  `[Off + gap + buttons]` (`width:fit-content` + `margin:auto`), so the visible gap is exactly *Off
  Button Gap*; it still wraps on a genuinely narrow card.

## v2026.09.30.264

- **Fixed: huge gap before a column-placed Off button in Columns/Grid layouts.** With a wrapping
  layout (Columns or Grid), the main-buttons box absorbed leftover row width and *Alignment: Center*
  then centered the buttons inside that oversized box — pushing them far from the Off button and
  ignoring the *Off Button Gap* value. The main box now hugs its content (`width:max-content`), so the
  spacing equals the slider (Stack was already correct); it still wraps on a genuinely narrow card.

## v2026.09.30.263

- **README brought up to date for builds 256–262:** Favorites (Save as Favorite, and turning a
  Favorite into a button — the old "Scratchpad" wording is gone), a new *Buttons sections* part
  covering Layout Type (Stack / Columns / Row (scroll) / Grid) with alignment, Off Button Placement,
  Gap and Size, Only Control Lights Currently On, section button chips, unassigned new buttons and the
  view-only Sort, plus the inline preview in the Button Styles and Frame Styles libraries.
  No code changes.

## v2026.09.30.262

- **Rewrote column Off placement with flexbox — Top / Middle / Bottom now works.** The 3-track grid
  (`1fr auto 1fr`) from v260 didn't reliably honor the Off Alignment (Middle rendered at the bottom).
  Column-before/after now use a plain flex row: `align-items` gives the Off button's Top/Middle/Bottom
  position and `justify-content:center` keeps the whole [Off + buttons] cluster centered on the card.
- **Off Button Gap is now the wrap's flex `gap` for every placement.** One mechanism (rows and
  columns alike) sets the distance between the Off button and the main group, replacing the
  per-placement margins.

## v2026.09.30.261

- **Off Button Gap now applies to all placements.** The gap between the Off button and the main
  buttons was column-only; it now also spaces a *Row above* / *Row below* Off group (vertical margin),
  not just columns.

## v2026.09.30.260

- **Fixed: main buttons now stay centered with a column Off placement.** Column-before/after now use a
  3-track layout so the main buttons are centered on the **card**, not shifted by the Off button's
  width beside them.
- **New: Off Button Gap.** For column placements, a px control sets the space between the Off button
  and the main buttons (default 8px). The main buttons stay centered regardless of the gap.

## v2026.09.30.259

- **Fixed: Off-button column placement now honors Top / Middle / Bottom.** Column-before/after
  placements pinned the Off button to the top regardless of *Off Alignment*; it now aligns on the
  cross axis correctly.
- **Fixed: main buttons not centering with a column Off placement.** The main button group now fills
  the remaining width, so its own Left/Center/Right alignment is visible beside the Off column.
- **New: per-section Off Button Size.** A dedicated scale for just the Off button(s) in a section
  (independent of the card scale) — shown when an Off placement other than *Inline* is selected.

## v2026.09.30.258

- **Off-button placement per Buttons section.** A section's **Off** button(s) can be pulled out of the
  main button flow into their own group — a **Row above** / **Row below**, or a **Column before** /
  **Column after** — with its own alignment (Left/Center/Right for a row, Top/Middle/Bottom for a
  column). Defaults to *Inline* (unchanged). Set under a Buttons section's config → *Off Button
  Placement*.

## v2026.09.30.257

- **Fixed: card failed to load (blank card + `hui-grid-section` errors).** `_currentValuesBlock` read
  a `section` argument that wasn't in its signature, throwing on first render of any card with a Color
  Values section. Added the missing parameter.
- **Fixed: Buttons section config panel wouldn't expand.** The Section Layout editor called
  `_sectionLayout` / `_sectionButtonStyle`, which exist on the card class but not the editor class;
  added editor-side equivalents.

## v2026.09.29.256

- **Save a color as a Favorite from a Color Values section, then turn it into a button.** Each Color
  Values section shows a **Save as Favorite** action on the card (on by default; hide it per-section)
  that captures that section's displayed color into the Favorites scratchpad. In the editor's
  **Buttons** panel, a new **Favorites** list converts any saved favorite into a real button
  (unassigned, so you pick its section afterward).
- **New buttons start unassigned.** Creating a button (Add Button, or from a Color Entity) no longer
  drops it into the first Buttons section — it's added unassigned and opens for editing so you choose
  where it goes.
- **Fixed:** Left/Center/Right alignment now works for the Grid (Fixed Columns) layout — grid columns
  size to content and the grid block justifies, instead of filling the row so alignment did nothing.
- **Buttons sections now list their buttons as chips.** Each Buttons section (in *Section Layout &
  Config*) shows the buttons assigned to it as removable chips; the × unassigns a button from the
  section (it leaves the card but keeps its look for the Scene Tracker).
- **"Only Control Lights Currently On" for Buttons sections.** Buttons sections gain the same option
  the Sliders sections have — a static setting plus an optional live card checkbox — so a button
  press affects only the section's target lights that are already on. Includes the same placement
  (Top/Bottom), alignment (Left/Center/Right), and text-style controls.
- **Sort option in the Buttons panel.** A view-only sort — Grouped (Local/Library), Alphabetical, or
  By Section — reorders the button editors without touching the saved config.
- **Unified button-layout controls (style + per-section).** Button Styles and the per-Buttons-section
  override now share one set of controls: **Layout Type** — Stack / Columns / **Row (scroll)** / Grid —
  plus Grid Columns, Alignment (Left / Center / Right), Gap, and Allow-wrap. *Row (scroll)* is new to
  both (a single non-wrapping row that scrolls horizontally), and **Alignment** is new to both (fixes
  buttons always centering). A section leaves any control on *Style default* to inherit the style; set
  one to override just that section. All three render paths (card default, applied style, section
  override) share a single layout-CSS builder so they stay identical.
- **Clarified "Only Control Lights Currently On" scope.** The hint now notes it applies to Color,
  Temperature, Fixture Profile and Off buttons; Scene buttons fire the scene as-is and are unaffected.
- **Inline Preview in the Button Styles & Frame Styles libraries.** Each library row gains an eye
  toggle (matching the Easy Cover Styler card) that expands a live sample of the style/frame in
  place. Edit (pencil) was already present.

## v2026.09.27.255

- **Fixed: library changes now reach every consumer.** Each style library subscribed once and kept
  only the *first* caller's callback, so whichever of the card or the editor registered second was
  never told an entry had changed — the visible symptom was editing a style not refreshing the card
  beside it. Affected all four libraries (Fixture Profiles, Button Styles, Frame, Header).
- **Section exports now carry their dependencies.** Exporting a section bundles the Fixture Profiles,
  Button Styles, Frame and Header entries its buttons reference, so it works on another install
  instead of silently falling back to defaults. Import adds anything missing and never overwrites an
  existing entry of the same name, then reports what it added.
