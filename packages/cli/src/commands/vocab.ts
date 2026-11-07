import { CORE_EFFECTS } from "@aburi/core"
import { isUnderPrefix, type VocabRegistry } from "@aburi/plugin-registry"
import type { PluginManifest, SymbolKind } from "@aburi/types"
import { loadPinnedConfig, pinConfig } from "../config-load"
import { internalFault } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { loadPlugins, type PluginListing } from "../plugin-loader"
import { resolveWorkspaceRoot } from "../workspace-root"

export type VocabQuery =
  | { readonly kind: "list" | "effects" | "extkinds" | "plugins" }
  | { readonly kind: "who-owns"; readonly value: string }

export interface VocabOptions {
  query: VocabQuery
  json?: boolean
  cwd?: string
  configPath?: string
}

export interface VocabOutcome {
  stdout: string
  /** Lines for stderr, in the order they are to be written, ahead of stdout. */
  stderr: readonly string[]
  exitCode: ExitCode
}

export interface VocabPlugin {
  name: string
  version: string
  type: PluginManifest["type"]
  listedIn: PluginListing
}

export interface VocabEffect {
  id: string
  description: string
  /** Null for a core effect id, which no plugin owns. */
  owner: string | null
}

export interface VocabExtKind {
  id: string
  baseKind: SymbolKind
  description: string
  owner: string
}

export interface VocabPrefix {
  prefix: string
  owner: string
}

export interface VocabFramework {
  name: string
  owner: string
}

export interface Vocabulary {
  plugins: VocabPlugin[]
  effects: VocabEffect[]
  effectPrefixes: VocabPrefix[]
  extKinds: VocabExtKind[]
  extKindPrefixes: VocabPrefix[]
  frameworks: VocabFramework[]
  derivedByPrefixes: VocabPrefix[]
}

export type VocabularyKind = "effect" | "extKind" | "framework" | "derivedBy"

export interface VocabOwner {
  vocabulary: VocabularyKind
  declaration: "core" | "explicit" | "prefix"
  prefix: string | null
  description: string | null
  /** extKind entries only: null when a prefix covers the value. */
  baseKind?: SymbolKind | null
  plugin: VocabPlugin | null
}

const VOCAB_PHASE = " while listing the vocabulary"

const NO_CONFIG =
  "⚠ No aburi.json was found, so no plugin is loaded: only the core effect vocabulary is known."

export async function runVocab(options: VocabOptions): Promise<VocabOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  const loaded = await loadPinnedConfig(await pinConfig(cwd, options.configPath))
  const plugins = await loadPlugins({
    config: loaded.config,
    workspaceRoot,
    syntheticPlugins: loaded.syntheticPlugins,
  })
  const notes = loaded.found ? [] : [NO_CONFIG]
  const json = options.json === true
  const { query } = options
  if (query.kind === "who-owns") {
    const owners = whoOwns(query.value, plugins.registry, plugins.listedIn)
    const exitCode = owners.length === 0 ? EXIT.RUNTIME : EXIT.SUCCESS
    if (json) {
      return { stdout: renderJson({ value: query.value, owners }), stderr: notes, exitCode }
    }
    if (owners.length === 0) {
      return { stdout: "", stderr: [...notes, noOwnerLine(query.value)], exitCode }
    }
    return { stdout: renderOwners(owners), stderr: notes, exitCode }
  }
  const vocabulary = readVocabulary(plugins.registry, plugins.listedIn)
  const stdout = json
    ? renderJson(pickLists(query.kind, vocabulary))
    : renderVocabTable(query.kind, vocabulary)
  return { stdout, stderr: notes, exitCode: EXIT.SUCCESS }
}

/** Everything `registry` holds, plus the core effect ids, in the order of loading. */
function readVocabulary(
  registry: VocabRegistry,
  listedIn: ReadonlyMap<string, PluginListing>,
): Vocabulary {
  const vocabulary: Vocabulary = {
    plugins: [],
    effects: CORE_EFFECTS.map(({ id, description }) => ({ id, description, owner: null })),
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    frameworks: [],
    derivedByPrefixes: [],
  }
  const prefixes = (list: readonly string[], owner: string) =>
    list.map((prefix) => ({ prefix, owner }))
  for (const manifest of registry.listPlugins()) {
    const { name: owner, provides } = manifest
    vocabulary.plugins.push(pluginEntry(manifest, listedIn))
    vocabulary.effects.push(
      ...provides.effects.map(({ id, description }) => ({ id, description, owner })),
    )
    vocabulary.effectPrefixes.push(...prefixes(provides.effectPrefixes, owner))
    vocabulary.extKinds.push(
      ...provides.extKinds.map(({ id, baseKind, description }) => ({
        id,
        baseKind,
        description,
        owner,
      })),
    )
    vocabulary.extKindPrefixes.push(...prefixes(provides.extKindPrefixes, owner))
    vocabulary.frameworks.push(...provides.frameworks.map((name) => ({ name, owner })))
    vocabulary.derivedByPrefixes.push(...prefixes(provides.derivedByPrefixes, owner))
  }
  return vocabulary
}

function pluginEntry(
  manifest: PluginManifest,
  listedIn: ReadonlyMap<string, PluginListing>,
): VocabPlugin {
  const listing = listedIn.get(manifest.name)
  if (listing === undefined) {
    throw internalFault(
      VOCAB_PHASE,
      `plugin "${manifest.name}" is registered, but no config entry loaded it`,
      undefined,
    )
  }
  return {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    listedIn: listing,
  }
}

/** Every vocabulary `value` is in, resolved as the registry resolves it during a scan. */
function whoOwns(
  value: string,
  registry: VocabRegistry,
  listedIn: ReadonlyMap<string, PluginListing>,
): VocabOwner[] {
  const plugin = (manifest: PluginManifest) => pluginEntry(manifest, listedIn)
  // The registry answers an enumerated id with its description and a covered one with null.
  const declared = (
    description: string | null,
    prefixes: readonly string[],
    owner: PluginManifest,
  ): Pick<VocabOwner, "declaration" | "prefix" | "description"> =>
    description === null
      ? { declaration: "prefix", prefix: coveringPrefix(value, prefixes, owner), description }
      : { declaration: "explicit", prefix: null, description }
  const owners: VocabOwner[] = []

  const core = CORE_EFFECTS.find((effect) => effect.id === value)
  const effect = core === undefined ? registry.findEffect(value) : null
  if (core !== undefined) {
    owners.push({
      vocabulary: "effect",
      declaration: "core",
      prefix: null,
      description: core.description,
      plugin: null,
    })
  } else if (effect !== null) {
    owners.push({
      vocabulary: "effect",
      ...declared(effect.description, effect.owner.provides.effectPrefixes, effect.owner),
      plugin: plugin(effect.owner),
    })
  }

  const extKind = registry.findExtKind(value)
  if (extKind !== null) {
    owners.push({
      vocabulary: "extKind",
      ...declared(extKind.description, extKind.owner.provides.extKindPrefixes, extKind.owner),
      baseKind: extKind.baseKind,
      plugin: plugin(extKind.owner),
    })
  }

  const framework = registry.findFramework(value)
  if (framework !== null) {
    owners.push({
      vocabulary: "framework",
      declaration: "explicit",
      prefix: null,
      description: null,
      plugin: plugin(framework.owner),
    })
  }

  const derivedByOwner = registry.findDerivedByOwner(value)
  if (derivedByOwner !== null) {
    owners.push({
      vocabulary: "derivedBy",
      ...declared(null, derivedByOwner.provides.derivedByPrefixes, derivedByOwner),
      plugin: plugin(derivedByOwner),
    })
  }
  return owners
}

function coveringPrefix(value: string, prefixes: readonly string[], owner: PluginManifest): string {
  const prefix = prefixes.find((candidate) => isUnderPrefix(value, candidate))
  if (prefix !== undefined) return prefix
  throw internalFault(
    VOCAB_PHASE,
    `the registry gave "${value}" to plugin "${owner.name}", whose manifest declares no prefix over it`,
    undefined,
  )
}

function noOwnerLine(value: string): string {
  return `No owner for "${value}": it is no core effect id, and no loaded plugin declares it or a prefix over it.`
}

type ListView = Exclude<VocabQuery["kind"], "who-owns">

function pickLists(view: ListView, vocabulary: Vocabulary): Partial<Vocabulary> {
  switch (view) {
    case "list":
      return vocabulary
    case "effects":
      return { effects: vocabulary.effects, effectPrefixes: vocabulary.effectPrefixes }
    case "extkinds":
      return { extKinds: vocabulary.extKinds, extKindPrefixes: vocabulary.extKindPrefixes }
    case "plugins":
      return { plugins: vocabulary.plugins }
  }
}

function renderJson(document: object): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

type Row = readonly string[]

const CORE_OWNER = "core"

function renderVocabTable(view: ListView, vocabulary: Vocabulary): string {
  switch (view) {
    case "list":
      return `${[
        section("Plugins", pluginRows(vocabulary)),
        section("Effects", effectRows(vocabulary)),
        section("extKinds", extKindRows(vocabulary)),
        section(
          "Frameworks",
          vocabulary.frameworks.map(({ name, owner }) => [owner, name]),
        ),
        section(
          "derivedBy prefixes",
          vocabulary.derivedByPrefixes.map(({ prefix, owner }) => [owner, prefix]),
        ),
      ].join("\n\n")}\n`
    case "effects":
      return lines(alignRows(effectRows(vocabulary)))
    case "extkinds":
      return lines(alignRows(extKindRows(vocabulary)))
    case "plugins":
      return lines(alignRows(pluginRows(vocabulary)))
  }
}

function pluginRows(vocabulary: Vocabulary): Row[] {
  return vocabulary.plugins.map(({ name, version, type, listedIn }) => [
    name,
    version,
    type,
    listingCell(listedIn),
  ])
}

function listingCell({ field, ref }: PluginListing): string {
  return `${field} "${ref}"`
}

/** One plugin's enumerated entries, then its prefixes, so that the owner column reads in runs. */
function byOwner<E extends { owner: string | null }>(
  vocabulary: Vocabulary,
  entries: readonly E[],
  prefixes: readonly VocabPrefix[],
  entryRow: (entry: E) => Row,
): Row[] {
  const rows = entries.filter((entry) => entry.owner === null).map(entryRow)
  for (const { name } of vocabulary.plugins) {
    rows.push(...entries.filter((entry) => entry.owner === name).map(entryRow))
    rows.push(...prefixes.filter((entry) => entry.owner === name).map((entry) => prefixRow(entry)))
  }
  return rows
}

function effectRows(vocabulary: Vocabulary): Row[] {
  return byOwner(vocabulary, vocabulary.effects, vocabulary.effectPrefixes, (effect) => [
    effect.owner ?? CORE_OWNER,
    effect.id,
    effect.description,
  ])
}

function extKindRows(vocabulary: Vocabulary): Row[] {
  return byOwner(vocabulary, vocabulary.extKinds, vocabulary.extKindPrefixes, (extKind) => [
    extKind.owner,
    extKind.id,
    extKind.baseKind,
    extKind.description,
  ])
}

function prefixRow({ prefix, owner }: VocabPrefix): Row {
  return [owner, `(prefix ${prefix})`]
}

function section(title: string, rows: readonly Row[]): string {
  const body = rows.length === 0 ? ["(none)"] : alignRows(rows)
  return [title, ...body.map((line) => `  ${line}`)].join("\n")
}

function lines(rendered: readonly string[]): string {
  return rendered.map((line) => `${line}\n`).join("")
}

/**
 * Pads each cell but a row's last to the widest cell another cell follows in its column, after
 * dropping empty trailing cells: a row that ends early does not push the next column out.
 */
function alignRows(rows: readonly Row[]): string[] {
  const trimmed = rows.map((row) => {
    let end = row.length
    while (end > 0 && row[end - 1] === "") end--
    return row.slice(0, end)
  })
  const widths: number[] = []
  for (const row of trimmed) {
    row.slice(0, -1).forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length)
    })
  }
  return trimmed.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  "),
  )
}

function renderOwners(owners: readonly VocabOwner[]): string {
  return `${owners.map((owner) => ownerBlock(owner).join("\n")).join("\n\n")}\n`
}

function ownerBlock(owner: VocabOwner): string[] {
  const field = (label: string, value: string) => `${`${label}:`.padEnd(13)}${value}`
  const block = [field("Vocabulary", owner.vocabulary)]
  if (owner.plugin !== null) {
    block.push(
      field("Plugin", `${owner.plugin.name} (v${owner.plugin.version})`),
      field("Type", owner.plugin.type),
      field("Listed in", listingCell(owner.plugin.listedIn)),
    )
  }
  // The manifest list is named after the vocabulary: `effects`, `effectPrefixes`, and so on.
  switch (owner.declaration) {
    case "core":
      block.push(field("Declaration", "core vocabulary, owned by no plugin"))
      break
    case "explicit":
      block.push(field("Declaration", `explicit (provides.${owner.vocabulary}s[])`))
      break
    case "prefix":
      block.push(
        field("Declaration", `prefix ${owner.prefix} (provides.${owner.vocabulary}Prefixes[])`),
      )
      break
  }
  if (owner.baseKind !== undefined && owner.baseKind !== null) {
    block.push(field("Base kind", owner.baseKind))
  }
  if (owner.description !== null) block.push(field("Description", owner.description))
  return block
}
