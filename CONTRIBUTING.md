# Contributing

Thanks for helping out! Bug reports and pull requests are welcome.

## Setup

Requires Node 22.18+ and [pnpm](https://pnpm.io) (the version is pinned in `package.json`; `corepack enable` picks it
up automatically).

```bash
pnpm install
pnpm build:viewer                          # bundle src/viewer → dist/viewer (rerun after viewer changes)
pnpm galaxy --root ../my-project --open    # run the CLI from source
```

Node runs the `.ts` sources directly, so there's no compile step while working on the analyzer; only the browser
viewer needs bundling.

## Checks

These all run in CI on Node 22 and 24:

```bash
pnpm lint          # oxlint (CI fails on warnings: pnpm lint:ci)
pnpm format        # oxfmt; pnpm format:ci only checks
pnpm typecheck     # Node, browser and test tsconfigs
pnpm build         # tsc → dist/, plus the viewer bundle
pnpm test          # node:test; the render tests need the viewer bundle, so build first
pnpm test:fixture  # map the fixture project → out/fixture.html, to look at by hand
```

`fixture/` is a tiny project with known cycles, type-only and lazy imports, an orphan and unresolvable imports. The
tests assert against it, so update them together.

## Layout

| Path             | What                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `src/cli.ts`     | CLI entry point (`onion-galaxy`)                                        |
| `src/analyze.ts` | Runs dependency-cruiser, builds nodes, links, star systems and cycles    |
| `src/scc.ts`     | Iterative Tarjan strongly-connected-components, for cycle detection     |
| `src/render.ts`  | Inlines the viewer bundle and the data into one HTML file               |
| `src/types.ts`   | Data contract shared by the analyzer and the viewer                     |
| `src/viewer/`    | three.js / 3d-force-graph galaxy: layout, bloom, starfield, UI          |
| `test/`          | Unit tests                                                              |
| `fixture/`       | Test project                                                            |

## Dependencies

The published package contains only `dist/`. three.js and 3d-force-graph are bundled into the viewer, so the only
runtime dependencies are dependency-cruiser and TypeScript, which dependency-cruiser uses to parse `.ts` files.
**TypeScript must stay on 5.x**: dependency-cruiser doesn't support 7.x yet and silently finds no files with it.
Dependabot is configured to hold it back.

`pnpm-workspace.yaml` allows exactly one dependency install script, esbuild's, which fetches its native binary.

## Commit messages and releases

Releases are automatic. Every push to `main` that passes CI runs [semantic-release](https://semantic-release.gitbook.io/),
which reads the new commit messages ([Conventional Commits](https://www.conventionalcommits.org/)) and decides whether
to release:

| Commit message                                             | Release                                                |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `fix: handle empty tsconfig paths`                         | patch (0.3.0 → 0.3.1)                                  |
| `feat: add a timeline slider`                              | minor (0.3.0 → 0.4.0)                                  |
| `feat!: drop Node 22` or a `BREAKING CHANGE:` footer       | major (0.3.0 → 1.0.0)                                  |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:`, `perf:` …  | no release (`perf:` counts as a patch)                 |

It then tags the commit (`v0.4.0`), publishes to npm with provenance via trusted publishing (no token needed), and
creates a GitHub release with notes generated from the commits. `package.json` keeps the placeholder version
`0.0.0-development` on purpose: the real version lives in the git tags and is set at publish time.

If you squash-merge pull requests, the PR title becomes the commit message, so give it the prefix.
