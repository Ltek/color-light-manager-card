# Changelog — Color Light & Scene Manager Card

Build numbers are `vYYYY.MM.DD.N`, where `N` is a monotonic counter that never
resets. Newest first.

> Entries before v2026.09.27.255 were not kept in a changelog; the archived builds in
> `archive/` are the only record of those versions.

---

## v2026.09.27.255

- **Fixed: library changes now reach every consumer.** Each style library subscribed once and kept
  only the *first* caller's callback, so whichever of the card or the editor registered second was
  never told an entry had changed — the visible symptom was editing a style not refreshing the card
  beside it. Affected all four libraries (Fixture Profiles, Button Styles, Frame, Header).
- **Section exports now carry their dependencies.** Exporting a section bundles the Fixture Profiles,
  Button Styles, Frame and Header entries its buttons reference, so it works on another install
  instead of silently falling back to defaults. Import adds anything missing and never overwrites an
  existing entry of the same name, then reports what it added.
