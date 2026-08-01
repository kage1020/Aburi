import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type LoadedConfig, loadConfig, readConfigFile } from "@aburi/config"
import {
  detectComponents,
  detectManagers,
  detectWorkspaceRoot,
  makeComponentId,
  scan,
  writeCanonicalIR,
} from "@aburi/core"
import {
  formatCallResolutionLine,
  projectComponent,
  projectWorkspace,
} from "@aburi/markdown-projection"
import type {
  CallResolutionStats,
  Component,
  Config,
  IR,
  LspEnrichmentStats,
  UnresolvedCallDiagnostic,
} from "@aburi/types"
import type { LogLevel } from "../env"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"
import { readGeneratorInfo } from "../generator-info"
import { createLogger } from "../logger"
import { loadPlugins } from "../plugin-loader"

export interface ScanOptions {
  cwd?: string
  configPath?: string
  outputDir?: string
  format?: "json" | "md" | "both"
  ignore?: readonly string[]
  respectGitignore?: boolean
  compact?: boolean
  suppressTimestamp?: boolean
  strict?: boolean
  /**
   * Override for `Config.lsp.enabled`. `true` from `--lsp`, `false` from
   * `--no-lsp`, `undefined` when neither flag was passed (falls through to the
   * on-disk config value). Follows the CLI override precedence rule in
   * `docs/design/config.md` §11.
   */
  lsp?: boolean
  /**
   * Lowest level the run's `Logger` emits, from `ABURI_LOG_LEVEL` (§11).
   * Defaults to `"warn"`, which is what the CLI has always printed.
   */
  logLevel?: LogLevel
}

export interface ScanReport {
  irPath: string | null
  workspaceMdPath: string | null
  componentMdPaths: string[]
  totalFiles: number
  keptSymbols: number
  droppedSymbols: number
  parseErrorCount: number
  timeoutCount: number
  /**
   * Files that never made it into the IR (over-size, unreadable, unroutable). Surfaced
   * separately from `parseErrorCount` because a discovery-time drop is silent by design
   * in `@aburi/core` — it belongs on the CLI report so `aburi scan` can warn on stderr.
   */
  skipped: readonly { path: string; reason: string; detail?: string }[]
  /**
   * Present when the LSP enrichment pass ran (config.lsp.enabled = true and at
   * least one server was configured). Absent when LSP was skipped entirely.
   */
  lspEnrichment: LspEnrichmentStats | undefined
  /**
   * Head-side call-resolution census rendered for stdout (call-resolution.md
   * §8.1). Always present — `scan` emits the counters unconditionally.
   */
  callResolutionLine: string
  /**
   * Per-call diagnostics behind that census. Kept out of the IR by design
   * (§8.1) and consumed by `aburi explain --debug-resolution`.
   */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  exitCode: ExitCode
}

/**
 * §5 — `aburi scan`. Resolves config, loads plugins, runs `@aburi/core` `scan`, then
 * writes IR JSON and per-Component Markdown into `--output-dir` (default `out/`). The
 * function is pure with respect to stdout/stderr — the CLI wrapper prints summaries. That
 * separation lets integration tests assert on the returned report without swallowing
 * stream output.
 */
export async function runScan(options: ScanOptions = {}): Promise<ScanReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)

  const loaded = await resolveConfig(workspaceRoot, options.configPath)
  const config = mergeCliOverrides(loaded.config, options)

  const plugins = await loadPlugins({
    config,
    workspaceRoot,
    syntheticPlugins: loaded.syntheticPlugins,
  })

  const managers = await detectManagers(workspaceRoot)
  const components = await resolveComponents(config, workspaceRoot)

  const scanInput: Parameters<typeof scan>[0] = {
    workspaceRoot,
    config,
    languages: plugins.languages,
    frameworks: plugins.frameworks,
    effects: plugins.effects,
    registry: plugins.registry,
    workspaceManagers: managers.managers.map((m) => ({
      tool: m.tool,
      roots: [...m.roots],
    })),
    components,
    generator: await readGeneratorInfo(),
    logger: createLogger(options.logLevel === undefined ? {} : { minimum: options.logLevel }),
  }
  const scanResult = await scan(scanInput)

  const format = options.format ?? "both"
  const outputDir = resolve(cwd, options.outputDir ?? "out")
  await mkdir(outputDir, { recursive: true })

  let irPath: string | null = null
  const workspaceMdPath = await maybeWriteWorkspaceMd(format, outputDir, scanResult.ir, options)
  const componentMdPaths = await maybeWriteComponentMd(format, outputDir, scanResult.ir)
  if (format !== "md") {
    irPath = resolve(outputDir, "aburi.ir.json")
    await writeCanonicalIR(scanResult.ir, irPath, {
      format: options.compact ? "compact" : "pretty",
    })
  }

  return {
    irPath,
    workspaceMdPath,
    componentMdPaths,
    totalFiles: scanResult.ir.stats.totalFiles,
    keptSymbols: scanResult.ir.stats.keptSymbols,
    droppedSymbols: scanResult.ir.stats.droppedSymbols,
    parseErrorCount: scanResult.parseErrors.length,
    timeoutCount: scanResult.timeoutEvents.length,
    skipped: scanResult.skipped.map((s) => {
      const entry: { path: string; reason: string; detail?: string } = {
        path: s.path,
        reason: s.reason,
      }
      if (s.detail !== undefined) entry.detail = s.detail
      return entry
    }),
    lspEnrichment: scanResult.ir.stats.lspEnrichment,
    callResolutionLine: formatCallResolutionLine(requireCallResolution(scanResult.ir)),
    unresolvedCalls: scanResult.unresolvedCalls,
    exitCode: EXIT.SUCCESS,
  }
}

/**
 * `Stats.callResolution` is optional in the schema so v1 documents written
 * before the field existed stay valid, but the IR we just produced came out of
 * `scan()`, which always fills it in. Substituting zeroes here would print
 * `calls 0 · resolved 0 · unresolved 0` — a clean bill of health for a run that
 * measured nothing — so a missing field is reported as the contract breach it
 * would be.
 */
function requireCallResolution(ir: IR): CallResolutionStats {
  const stats = ir.stats.callResolution
  if (stats === undefined) {
    throw new CliError(
      "scan() returned an IR without stats.callResolution; @aburi/core stopped emitting the call-resolution census (call-resolution.md §8.1).",
      "runtime-error",
    )
  }
  return stats
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return await detectWorkspaceRoot({ cwd })
  } catch {
    return resolve(cwd)
  }
}

async function resolveConfig(
  workspaceRoot: string,
  overridePath: string | undefined,
): Promise<LoadedConfig> {
  try {
    if (overridePath !== undefined) {
      const absolute = resolve(workspaceRoot, overridePath)
      const config = await readConfigFile(absolute)
      const { normalizeFrameworkHints } = await import("@aburi/config")
      return {
        found: true,
        source: absolute,
        config,
        syntheticPlugins: normalizeFrameworkHints(config),
      }
    }
    return await loadConfig({ cwd: workspaceRoot })
  } catch (error) {
    throw new CliError(`Failed to load Aburi config: ${errorMessage(error)}`, "config-error", {
      cause: error,
    })
  }
}

function mergeCliOverrides(config: Partial<Config>, options: ScanOptions): Config {
  const merged: Partial<Config> = { ...config }
  if (options.ignore !== undefined && options.ignore.length > 0) {
    merged.ignore = [...(merged.ignore ?? []), ...options.ignore]
  }
  if (options.respectGitignore !== undefined) merged.respectGitignore = options.respectGitignore
  if (options.strict !== undefined) merged.strict = options.strict
  if (options.lsp !== undefined) {
    merged.lsp = { ...(merged.lsp ?? {}), enabled: options.lsp }
  }
  return merged as Config
}

/**
 * Both branches can fail on a Component id the schema cannot hold: the config branch if a
 * config reached us without ajv validation, the detection branch if a package or directory
 * name kebab-cases to nothing. Either way it is a problem with the project being scanned,
 * not a bug in Aburi, so it is wrapped as `config-error` — the exit-code table in
 * `../exit-codes` maps that to 2, and an unwrapped `CoreError` would fall through to the
 * generic handler and report 1 with no command context.
 */
async function resolveComponents(
  config: Partial<Config>,
  workspaceRoot: string,
): Promise<Component[]> {
  try {
    if (config.components !== undefined && config.components.length > 0) {
      // The config schema already constrains `id` to the kebab shape, but the value arrives
      // here as a plain string. Re-asserting it through the constructor is what turns it into
      // a Component id, and keeps a config loaded by some other path from smuggling in a
      // shape `components[].id` cannot hold.
      return config.components.map((entry) => {
        // `publicApi` / `frameworks` are Class B and `description` is Class A
        // (`ir-schema.md` §1.1), so the empty cases are spelled differently on purpose:
        // the two array keys disappear, the scalar stays as an explicit `null`. Emitting
        // `[]` here would contradict `detectComponents`, which omits them — the same
        // Component would then have two shapes depending on whether it was configured or
        // detected.
        const component: Component = {
          id: makeComponentId(entry.id),
          name: entry.name ?? entry.id,
          roots: [...entry.roots],
          languages: [...(entry.languages ?? [])],
          description: entry.description ?? null,
        }
        if (entry.publicApi !== undefined && entry.publicApi.length > 0) {
          component.publicApi = [...entry.publicApi]
        }
        if (entry.frameworks !== undefined && entry.frameworks.length > 0) {
          component.frameworks = [...entry.frameworks]
        }
        return component
      })
    }
    return await detectComponents({ workspaceRoot })
  } catch (error) {
    throw new CliError(`Failed to resolve components: ${errorMessage(error)}`, "config-error", {
      cause: error,
    })
  }
}

async function maybeWriteWorkspaceMd(
  format: "json" | "md" | "both",
  outputDir: string,
  ir: IR,
  options: ScanOptions,
): Promise<string | null> {
  if (format === "json") return null
  const path = resolve(outputDir, "workspace.md")
  const md = projectWorkspace(ir, {
    suppressTimestamp: options.suppressTimestamp ?? false,
  })
  await writeFile(path, md, "utf8")
  return path
}

async function maybeWriteComponentMd(
  format: "json" | "md" | "both",
  outputDir: string,
  ir: IR,
): Promise<string[]> {
  if (format === "json") return []
  const paths: string[] = []
  await mkdir(resolve(outputDir, "components"), { recursive: true })
  for (const component of ir.components) {
    const symbolsInComponent = ir.symbols.filter((s) => s.component === component.id)
    const md = projectComponent({
      component,
      symbols: symbolsInComponent,
      dependencies: ir.dependencies,
    })
    const path = resolve(outputDir, "components", `${component.id}.md`)
    await writeFile(path, md, "utf8")
    paths.push(path)
  }
  return paths
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
