import type { ScanResult } from "@aburi/core"
import { diffIRs, type ScanExtras, scanWith } from "@aburi/test-harness"
import { recordingLogger, type ScratchWorkspace } from "@aburi/test-support"
import type { Config, IR, LanguagePlugin, SymbolDelta } from "@aburi/types"
import { expect } from "vitest"
import { langTypescriptPlugin } from "../../src/index"

/** A real scan of `workspaceRoot` with this plugin as the only one. */
export function scanTypeScript(
  workspaceRoot: string,
  config: Config = {},
  extras: ScanExtras = {},
): Promise<ScanResult> {
  return scanWith(workspaceRoot, { languages: [langTypescriptPlugin] }, config, extras)
}

/** The IR of a scan that warned about nothing, so a case cannot pass on a file it half read. */
export async function scanWithoutWarnings(workspaceRoot: string): Promise<IR> {
  const logger = recordingLogger()
  const { ir } = await scanTypeScript(workspaceRoot, {}, { logger })
  expect(logger.warnings).toEqual([])
  return ir
}

/** Scan with `before` at `file`, rewrite it to `after`, scan again, and diff the two. */
export async function diffOfEdit(
  workspace: ScratchWorkspace,
  file: string,
  before: string,
  after: string,
): Promise<ReturnType<typeof diffIRs>> {
  await workspace.writeSource(file, before)
  const baseIR = await scanWithoutWarnings(workspace.root)
  await workspace.writeSource(file, after)
  const headIR = await scanWithoutWarnings(workspace.root)
  return diffIRs(baseIR, headIR)
}

/** Each Symbol the diff reports `changed`, by name, with its delta. */
export function changedSymbols(
  diff: ReturnType<typeof diffIRs>,
): ({ name: string } & SymbolDelta)[] {
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
