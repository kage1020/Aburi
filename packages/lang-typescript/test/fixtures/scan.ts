import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { ScanResult } from "@aburi/core"
import {
  diffIRs,
  diffOfEditWith,
  type EditDiff,
  type PluginLineup,
  type ScanExtras,
  scanWith,
} from "@aburi/test-harness"
import { recordingLogger, type ScratchWorkspace } from "@aburi/test-support"
import type {
  Config,
  DiffResult,
  IR,
  LanguagePlugin,
  SymbolChange,
  SymbolDelta,
} from "@aburi/types"
import { expect } from "vitest"
import { langTypescriptPlugin } from "../../src/index"

const TYPESCRIPT_ONLY: PluginLineup = { languages: [langTypescriptPlugin] }

/** A real scan of `workspaceRoot` with this plugin as the only one. */
export function scanTypeScript(
  workspaceRoot: string,
  config: Config = {},
  extras: ScanExtras = {},
): Promise<ScanResult> {
  return scanWith(workspaceRoot, TYPESCRIPT_ONLY, config, extras)
}

/** The IR of a scan that warned about nothing, so a case cannot pass on a file it half read. */
export async function scanWithoutWarnings(workspaceRoot: string): Promise<IR> {
  const logger = recordingLogger()
  const { ir } = await scanTypeScript(workspaceRoot, {}, { logger })
  expect(logger.warnings).toEqual([])
  return ir
}

/** `diffOfEditWith` this plugin alone, where neither scan may warn. */
export async function editOf(
  workspace: ScratchWorkspace,
  file: string,
  before: string,
  after: string,
): Promise<EditDiff> {
  const logger = recordingLogger()
  const edit = await diffOfEditWith(workspace, TYPESCRIPT_ONLY, file, before, after, { logger })
  expect(logger.warnings).toEqual([])
  return edit
}

/** The diff of `editOf`. */
export async function diffOfEdit(
  workspace: ScratchWorkspace,
  file: string,
  before: string,
  after: string,
): Promise<EditDiff["diff"]> {
  return (await editOf(workspace, file, before, after)).diff
}

/** Scan `before`, delete its files, write `after` in others, scan again, and diff the two. */
export async function diffOfMove(
  workspace: ScratchWorkspace,
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<DiffResult> {
  for (const [file, text] of Object.entries(before)) await workspace.writeSource(file, text)
  const baseIR = await scanWithoutWarnings(workspace.root)
  for (const file of Object.keys(before)) await rm(join(workspace.root, file))
  for (const [file, text] of Object.entries(after)) await workspace.writeSource(file, text)
  const headIR = await scanWithoutWarnings(workspace.root)
  return diffIRs(baseIR, headIR)
}

/** Every change as status and names, with the stage that paired it where there is one, sorted. */
export function pairingOutcome(diff: DiffResult): string[] {
  return diff.symbols.map(describePairing).sort()
}

function describePairing(change: SymbolChange): string {
  if ("symbol" in change) return `${change.status} ${change.symbol.name}`
  const pairing = `${change.status} ${change.before.name} -> ${change.after.name}`
  return "rationale" in change ? `${pairing} (${change.rationale})` : pairing
}

/** Each Symbol the diff reports `changed`, by name, with its delta. */
export function changedSymbols(diff: DiffResult): ({ name: string } & SymbolDelta)[] {
  return diff.symbols.flatMap((c) =>
    c.status === "changed" ? [{ name: c.after.name, ...c.delta }] : [],
  )
}

/** The real plugin with some of its methods replaced, as a scan can be handed it. */
export function pluginOverriding(
  overrides: (real: LanguagePlugin) => Partial<LanguagePlugin>,
): LanguagePlugin {
  const real = langTypescriptPlugin as unknown as LanguagePlugin
  return Object.assign(Object.create(real), overrides(real))
}
