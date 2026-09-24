# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Cycle-breaking hints: each cycle lists a minimal set of imports to remove to break it, shown as `✂ cut` in the
  panel and as yellow edges in the map. The CLI prints the total.
- Blast radius and "pulls in": everything that depends on a file (or that it depends on), rippling out hop by hop,
  with a per-hop histogram.
- Path finder: the shortest import chain between two files.
- Zoom-dependent detail: distant systems collapse into one star, joined by trade routes sized by import count.
  "Always show planets" turns it off.
- Layouts: `--layout spiral|stability|ring|sphere`, also switchable in the map. In `stability`, distance from the
  centre is a file's instability.
- Open in editor: `--editor vscode|cursor|zed|webstorm|idea|none`, a button in the file panel and the `o` key.

### Changed

- Node 22.18 or newer is now required (Node 20 reached end of life in April 2026).

### Security

- All `<` characters in the data inlined into the generated page are escaped, so file or project names can never
  break out of the page's script element.

## [0.2.0] - 2026-09-24

### Removed

- npm packages and Node built-ins are no longer part of the map, and the `--externals` option is gone.

### Changed

- Instability is computed from project files only, so it always matches the dependents and imports shown.
- Softer glow, so dense star systems no longer merge into white blobs.

### Fixed

- The default excludes (`dist/`, `*.d.ts`) no longer also matched files inside npm packages.

## [0.1.0] - 2026-09-23

- Initial release.

[Unreleased]: https://github.com/ryangibbs/onion-galaxy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ryangibbs/onion-galaxy/releases/tag/v0.2.0
[0.1.0]: https://github.com/ryangibbs/onion-galaxy/releases/tag/v0.1.0
