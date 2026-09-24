#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { analyze } from './analyze.ts'
import { renderHtml } from './render.ts'
import { EDITORS, LAYOUTS, type EditorName, type LayoutName } from './types.ts'

const HELP = `onion-galaxy [paths...] [options]

Maps a JS/TS codebase's imports as an interactive 3D galaxy.

  paths                  Files/dirs to cruise, relative to --root (default: src, or .)
  -r, --root <dir>       Project root (default: .)
  -o, --out <file>       Output HTML (default: galaxy.html)
      --json <file>      Also write the graph data as JSON
      --ts-config <file> tsconfig to resolve paths with (default: <root>/tsconfig.json)
  -x, --exclude <regex>  Paths to skip (default: dist, build, coverage, tmp, *.d.ts)
      --cluster-depth <n> Directory depth that defines a star system (default: auto)
      --type-cycles      Count \`import type\` edges when detecting cycles
      --layout <name>    Initial layout: ${LAYOUTS.join(', ')} (default: spiral; switchable in the map)
      --editor <name>    Editor that "Open file" links use: ${EDITORS.join(', ')} (default: vscode)
      --no-git           Skip git churn stats
      --open             Open the result in your browser
  -h, --help             Show this help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', short: 'r', default: '.' },
    out: { type: 'string', short: 'o', default: 'galaxy.html' },
    json: { type: 'string' },
    'ts-config': { type: 'string' },
    exclude: { type: 'string', short: 'x' },
    'cluster-depth': { type: 'string' },
    'type-cycles': { type: 'boolean', default: false },
    layout: { type: 'string', default: 'spiral' },
    editor: { type: 'string', default: 'vscode' },
    'no-git': { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const clusterDepth = values['cluster-depth'] === undefined ? undefined : Number(values['cluster-depth'])
if (clusterDepth !== undefined && !(Number.isInteger(clusterDepth) && clusterDepth > 0)) {
  console.error('--cluster-depth must be a positive integer')
  process.exit(1)
}

const oneOf = <T extends string>(flag: string, value: string, allowed: readonly T[]): T => {
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.error(`--${flag} must be one of: ${allowed.join(', ')}`)
  process.exit(1)
}
const layout = oneOf<LayoutName>('layout', values.layout, LAYOUTS)
const editor = oneOf<EditorName>('editor', values.editor, EDITORS)

const root = path.resolve(values.root)
const paths = positionals.length ? positionals : [existsSync(path.join(root, 'src')) ? 'src' : '.']
const log = (msg: string) => console.error(`\x1b[36m✦\x1b[0m ${msg}`)

const galaxy = await analyze({
  root,
  paths,
  tsConfig: values['ts-config'],
  exclude: values.exclude,
  typeCycles: values['type-cycles'],
  git: !values['no-git'],
  clusterDepth,
  view: { layout, editor },
  log,
})

const { meta } = galaxy
log(`${meta.files} files · ${meta.imports} imports · ${galaxy.clusters.length} star systems`)
if (meta.cycles) {
  log(`\x1b[31m${meta.cycles} circular clusters spanning ${meta.filesInCycles} files\x1b[0m`)
  log(`Removing ${meta.cuts} imports would break them all (click a cycle in the map for the list)`)
}

if (values.json) {
  writeFileSync(values.json, JSON.stringify(galaxy, null, 2))
  log(`Wrote ${values.json}`)
}
const out = path.resolve(values.out)
writeFileSync(out, renderHtml(galaxy))
log(`Wrote ${out}`)

if (values.open) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  execFile(opener, [out])
}
