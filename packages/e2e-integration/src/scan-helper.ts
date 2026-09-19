import { type ScanInput, type ScanResult, type ServerFactory, scan } from "@aburi/core"
import { buildDiff } from "@aburi/diff"
import { nestEffectsPlugin } from "@aburi/effects-nest"
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type {
  Component,
  Config,
  EffectPlugin,
  FrameworkPlugin,
  IR,
  Symbol as IRSymbol,
  LanguagePlugin,
  Logger,
} from "@aburi/types"

export const IR_SCHEMA = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"

export interface PluginLineup {
  languages?: readonly LanguagePlugin[]
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
}

/** The parts of `ScanInput` a scenario occasionally sets beyond plugins and config. */
export type ScanExtras = Pick<ScanInput, "components" | "logger" | "lspServerFactory">

/**
 * Drive `@aburi/core`'s `scan` with plugin objects wired straight from disk, registering
 * every manifest in a fresh `VocabRegistry`.
 *
 * The CLI's `runScan` resolves plugin names against `node_modules`, which a tmpdir workspace
 * does not have. Injecting the objects keeps the fixtures free of an install step while
 * exercising the same pipeline (discovery → parse → classify → drop → fingerprint →
 * integrity). Plugin-name resolution is covered by `packages/cli/test/plugin-loader.test.ts`.
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

  return scan({ workspaceRoot, config, languages, frameworks, effects, registry, ...extras })
}

/** Plugins layered on top of `scanFixture`'s default TypeScript + NestJS lineup. */
export type ScanFixturePluginOverlay = PluginLineup

/** `scanWith` for the NestJS fixtures: TypeScript, NestJS and Nest effects plus `overlay`. */
export async function scanFixture(
  workspaceRoot: string,
  config: Config = {},
  overlay: ScanFixturePluginOverlay = {},
  components: readonly Component[] = [],
  lspServerFactory?: ServerFactory,
): Promise<ScanResult> {
  const lineup: PluginLineup = {
    languages: [langTypescriptPlugin, ...(overlay.languages ?? [])],
    frameworks: [nestjsFrameworkPlugin, ...(overlay.frameworks ?? [])],
    effects: [nestEffectsPlugin, ...(overlay.effects ?? [])],
  }
  const extras: ScanExtras =
    lspServerFactory === undefined ? { components } : { components, lspServerFactory }
  return scanWith(workspaceRoot, lineup, config, extras)
}

/** The Symbol with exactly this id, or a failure that lists what the scan produced. */
export function symbolById(result: ScanResult, id: string): IRSymbol {
  const found = result.ir.symbols.find((symbol) => symbol.id === id)
  if (found === undefined) {
    throw new Error(`no Symbol ${id}; have ${result.ir.symbols.map((s) => s.id).join(", ")}`)
  }
  return found
}

/** The Symbol with exactly this qualified name, or a failure that lists what the scan produced. */
export function symbolNamed(result: ScanResult, name: string): IRSymbol {
  const found = result.ir.symbols.find((symbol) => symbol.name === name)
  if (found === undefined) {
    throw new Error(
      `no Symbol named "${name}"; have ${result.ir.symbols.map((s) => s.name).join(", ")}`,
    )
  }
  return found
}

/** `buildDiff` between two IRs under the refs `base` and `head`. */
export function diffIRs(baseIR: IR, headIR: IR): ReturnType<typeof buildDiff> {
  return buildDiff({
    baseIR,
    headIR,
    base: { ref: "base", irSchema: IR_SCHEMA },
    head: { ref: "head", irSchema: IR_SCHEMA },
  })
}

export interface WarningCollector {
  logger: Logger
  /** Every `warn` message the scan emitted, in order. */
  warnings: string[]
}

/** A silent `Logger` that keeps its `warn` messages, for assertions on what a scan reported. */
export function warningCollector(): WarningCollector {
  const warnings: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message)
    },
    error: () => {},
  }
  return { logger, warnings }
}
