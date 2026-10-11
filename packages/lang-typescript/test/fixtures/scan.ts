import type { ScanResult } from "@aburi/core"
import {
  diffOfEditWith,
  type EditDiff,
  type PluginLineup,
  type ScanExtras,
  scanWith,
} from "@aburi/test-harness"
import { recordingLogger, type ScratchWorkspace } from "@aburi/test-support"
import type { Config, DiffResult, IR, LanguagePlugin, SymbolDelta } from "@aburi/types"
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
