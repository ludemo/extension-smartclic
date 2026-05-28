# Changelog

All notable changes to **Smartclic DevTools** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [0.2.4] — 2026-05-27

### Changed

- Restored waifu settings in `package.json` after merge drift: `robertgozu.waifu.message`, `robertgozu.waifu.write`, `robertgozu.waifu.tabSound`, and `robertgozu.waifu.startupSound`.
- Re-enabled `onStartupFinished` activation so startup sound setting works again.
- Kept Import Map icon pinned in Activity Bar using `media/importmap.svg`.

## [0.2.3] — 2026-05-26

### Added

- **SCSS variable completions (non-color)**: typing a number after `:` in a CSS property now suggests matching non-color variables from `_variables.scss` by raw value prefix (e.g. `32` → `$pix-32: 32px`, `$dvh-32: 32dvh`). Typing `$` anywhere in a value filters by variable name. Color variables are excluded — they use the existing color completion with swatch.
- **Storybook button in Import Map**: the library row now shows Start/Stop/Logs buttons for Storybook (`npm run storybook`). The extension probes port 6006 via TCP on each refresh to detect an already-running external instance and shows ✔ with a Stop button. States: offline, compiling, running, error, external (started outside VS Code).

### Fixed

- **Class completions — component classes were missing**: when `_clases.scss` global classes were present, component-specific class values (from `smartclic-data.json`) were silently discarded. Both lists are now combined — component classes appear first (sortText `0_`), global utility classes second (`1_`).
- **Library row — spurious MFE buttons**: the `hasprocess` pattern in `view/item/context` matched the library row, causing MFE-specific Stop and Logs buttons to appear on the library item. Fixed by anchoring the MFE condition to `^mfe`.

---

## [0.2.2] — 2026-05-26

### Changed

- **File Icon Theme** ya no se activa automáticamente al instalar la extensión. Elige **Smartclic Icons** manualmente en *Settings → File Icon Theme* si lo quieres.

## [0.2.1] — 2026-05-26

### Added

- **Waifu behavior toggles in settings**:
  - `robertgozu.waifu.tabSound` (default: `false`): plays `media/sounds/tab-open.wav` when opening a new editor tab.
  - `robertgozu.waifu.startupSound` (default: `false`): plays `media/sounds/startup.wav` when VS Code/Cursor session initializes.
  - `robertgozu.waifu.message` (default: `false`): enables kawaii-style welcome and SCSS diagnostic messages. When disabled, messages are plain/normal.
  - `robertgozu.waifu.write` (default: `false`): enables waifu typing effect decorations while editing.

## [0.2.0] — 2026-05-25

### Added

- **Color variable completions**: typing `$` inside a CSS property value now shows only the color variables registered in `_variables.scss`, each with its hex value as description and `var(--name, vars.$name)` as insert text.
- **Inline color swatches**: the VS Code color picker square now appears next to bare `$varName` references in addition to `vars.$name` / `resol.$name` references.
- **Color swatch support for `rgb()` / `rgba()`**: variables whose value is a functional color (not only hex) now render the swatch correctly.
- **Slot IntelliSense**: typing `<template #` or `<template v-slot:` inside a Vue component now completes named slots with description. Hover on a component name now lists available slots.
- **Attribute hover documentation**: hovering over an attribute name shows its description, default value, and list of allowed values.
- **Attribute value hover**: hovering over a value inside `attr="..."` shows its description and preview image.
- **Utility class completions**: autocomplete for `_clases.scss` classes inside `class=""`, `:class=""`, and `v-bind:class=""` attributes.

### Fixed

- **SCSS linter — negative values** (`-32px`): was incorrectly generating `-vars.$pix-32`. Now correctly generates `calc(-1 * vars.$pix-32)` or reports the raw value as F1/F2 without mangling the sign.
- **SCSS linter — decimal values** (`0.1px`): was incorrectly generating `0.vars.$pix-1`. Fixed by using a dedicated non-global test regex to avoid `lastIndex` side-effects.
- **SCSS linter — functional colors**: `rgb()` and `rgba()` hardcoded colors were not detected as F4/F5. Now handled alongside hex colors.
- **SCSS linter — F6b (bare color var, no alias)**: a bare `$colorVar` in a file without `@use vars` had no autofix at all. Now auto-fixes to `var(--name, $name)`.
- **SCSS linter — one-step color fix**: when `@use vars` is present and a bare `$colorVar` is used, the fix now goes directly to `var(--name, vars.$name)` in one step instead of two.
- **Breakpoint snippets — wrong variable name**: `vars.-res-lg` was generated instead of `vars.$bp-res-lg`. Root cause: `$bp` inside `SnippetString` was interpreted as a snippet variable. Fixed by escaping to `\$bp`.
- **Breakpoint snippets — completions not appearing**: completions only fired on the exact full prefix (`bklg`, `bkxl`). Now fire on any `bk` prefix (`bk`, `bkl`, `bklg`, `bkx`…) and VS Code filters the list.
- **Yalc remove — stale cache in `node_modules`**: removing a yalc package left stale files. Now runs a full `node_modules` clean + `npm install` after removal.
- **Scaffold — missing underscore**: was looking for `mixin.scss` and `variables.scss` instead of `_mixin.scss` and `_variables.scss`.
- **Class completions — `:class` not working**: the `:class` and `v-bind:class` dynamic binding attributes were not recognized. Fixed.
- **Import map — unhandled write errors**: `setEntry`, `setAll`, and `applyIpMode` now show a VS Code error message on read/write failure instead of silently swallowing the error.
- **Build detection — Vite and Rsbuild**: the MFE build progress detection only handled webpack. Now also covers Vite (`ready in`, `Local: http`) and Rsbuild (`build success`, `server running at`).
- **Class loader — nested SCSS blocks**: the regex for parsing `_clases.scss` broke on nested blocks (`&:hover`, pseudo-selectors). Replaced with a brace-depth parser that extracts only top-level declarations.
- **Data loader — unresolved boolean valueSets**: component `valueSet` references were not resolved, leaving boolean props without their `true`/`false` values in completions.

---

## [0.1.0] — 2025

### Added

- Initial release.
- SCSS linter rules F1–F7 with autofix on save (`Ctrl+Alt+S`), code actions (lightbulb), and debounced lint on edit.
- IntelliSense for Vue/HTML: component name completions with preview images, attribute completions, attribute value completions.
- Hover documentation for component names.
- Import Map panel in the Explorer sidebar: MFE status, toggle local/dev, start/stop dev servers, yalc integration, build + publish library.
- Breakpoint SCSS snippets (`bk`, `bklg`, `bkxl`, `bkxxl`).
- Component scaffold command (right-click on folder).
