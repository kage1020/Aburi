import { CLASSIFY_TIMEOUT_MAX_MS, type ScanInput, type ScanResult, scan } from "@aburi/core"
import { buildDiff } from "@aburi/diff"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { ScratchWorkspace } from "@aburi/test-support"
import type {
  CallCandidate,
  ClassifyContext,
  Config,
  EffectPlugin,
  FrameworkClassifyContext,
  FrameworkPlugin,
  IR,
  LanguagePlugin,
  SymbolCandidate,
} from "@aburi/types"

export const IR_SCHEMA_URL = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"

export interface PluginLineup {
  languages?: readonly LanguagePlugin[]
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
}

/** The parts of `ScanInput` a suite occasionally sets beyond plugins and config. */
export type ScanExtras = Pick<ScanInput, "components" | "logger" | "lspServerFactory">

/**
 * `scan` over `workspaceRoot` with `lineup`, every plugin's manifest registered first. Classification
 * gets the ceiling budget unless `config` sets one: the 50 ms default is overrun by the first
 * classification in a process on a slow CI runner, which drops a correct effect.
 */
export async function scanWith(
  workspaceRoot: string,
  lineup: PluginLineup,
  config: Config = {},
  extras: ScanExtras = {},
): Promise<ScanResult> {
  const languages = lineup.languages ?? []
  const frameworks = lineup.frameworks ?? []
  const effects = lineup.effects ?? []

  const registry = new VocabRegistry()
  for (const plugin of [...languages, ...frameworks, ...effects]) registry.register(plugin.manifest)

  return scan({
    workspaceRoot,
    config: { classifyTimeoutMs: CLASSIFY_TIMEOUT_MAX_MS, ...config },
    languages,
    frameworks,
    effects,
    registry,
    ...extras,
  })
}

/** `buildDiff` between two IRs under the refs `base` and `head`. */
export function diffIRs(baseIR: IR, headIR: IR): ReturnType<typeof buildDiff> {
  return buildDiff({
    baseIR,
    headIR,
    base: { ref: "base", irSchema: IR_SCHEMA_URL },
    head: { ref: "head", irSchema: IR_SCHEMA_URL },
  })
}

export interface EditDiff {
  readonly base: ScanResult
  readonly head: ScanResult
  readonly diff: ReturnType<typeof buildDiff>
}

/** Scan with `before` at `file`, rewrite it to `after`, scan again, and diff the two scans. */
export async function diffOfEditWith(
  workspace: ScratchWorkspace,
  lineup: PluginLineup,
  file: string,
  before: string,
  after: string,
  extras: ScanExtras = {},
): Promise<EditDiff> {
  await workspace.writeSource(file, before)
  const base = await scanWith(workspace.root, lineup, {}, extras)
  await workspace.writeSource(file, after)
  const head = await scanWith(workspace.root, lineup, {}, extras)
  return { base, head, diff: diffIRs(base.ir, head.ir) }
}

export interface ExtractedFile<TNode> {
  /** The context a framework plugin classifies these candidates in. */
  readonly ctx: FrameworkClassifyContext
  readonly candidates: SymbolCandidate<TNode>[]
}

/** One in-memory file through `language`'s parse and extraction, as the scan runs them. */
export async function extractFile<TTree, TNode>(
  language: LanguagePlugin<TTree, TNode>,
  path: string,
  content: string,
): Promise<ExtractedFile<TNode>> {
  const file = { path, content }
  const { tree, imports } = await language.parseFile(file)
  if (tree === null) throw new Error(`${language.manifest.name} could not parse ${path}`)
  const registry = new VocabRegistry()
  registry.register(language.manifest)
  const ctx: FrameworkClassifyContext = { file, registry, config: {}, imports }
  return { ctx, candidates: language.extractSymbols(tree, ctx) }
}

/** The parts of an effect classifier's inputs that are plain data. */
export interface ClassifyInputs {
  readonly call: CallCandidate
  readonly file: ClassifyContext["file"]
  readonly owner: ClassifyContext["owner"]
}

/** `classify` run once on `call` and `ctx`, with a copy of its inputs taken before and the inputs after. */
export function classifyInputsAround(
  classify: EffectPlugin["classify"],
  call: CallCandidate,
  ctx: ClassifyContext,
): { before: ClassifyInputs; after: ClassifyInputs } {
  const before = structuredClone({ call, file: ctx.file, owner: ctx.owner })
  classify(call, ctx)
  return { before, after: { call, file: ctx.file, owner: ctx.owner } }
}
