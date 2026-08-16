import { dirname } from "node:path"
import { Command, InvalidArgumentError } from "commander"
import { formatFailOnMessage, runDiff } from "./commands/diff"
import { runExplain } from "./commands/explain"
import { runInit } from "./commands/init"
import { runScan, type ScanReport } from "./commands/scan"
import { resolveConfigPath } from "./config-path"
import { readEnv } from "./env"
import { CliError } from "./errors"
import { EXIT, type ExitCode } from "./exit-codes"
import { FailOnParseError } from "./fail-on"
import { readGeneratorInfo } from "./generator-info"

export interface RunCliOptions {
  argv: readonly string[]
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/**
 * Entry-point that the `bin/aburi.ts` shim invokes and that the test suite calls with a
 * synthetic argv + captured streams. Never calls `process.exit` directly — returns the
 * exit code so the caller (or the tests) decide.
 */
export async function runCli(options: RunCliOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const env = readEnv(options.env ?? process.env)
  const cwd = options.cwd ?? process.cwd()

  const { version } = await readGeneratorInfo()
  const program = new Command()
  program
    .name("aburi")
    .description("Render meaningful code structure as IR for review")
    .version(version, "-v, --version")
    .exitOverride() // don't call process.exit — surface as CommanderError
    .configureOutput({
      writeOut: (str) => {
        stdout.write(str)
      },
      writeErr: (str) => {
        stderr.write(str)
      },
    })

  let outcome: ExitCode = EXIT.SUCCESS
  const wrap = (fn: () => Promise<ExitCode | undefined>): (() => Promise<void>) => {
    return async () => {
      try {
        const result = await fn()
        outcome = result ?? EXIT.SUCCESS
      } catch (error) {
        outcome = handleError(error, stderr)
      }
    }
  }

  program
    .command("init")
    .description("Generate aburi.json from autodetect")
    .option("--output <path>", "output path (default: ./aburi.json)")
    .option("--force", "overwrite existing config")
    .option("--with-suggestions", "include plugin install suggestions as comments")
    .action((cmdOptions: { output?: string; force?: boolean; withSuggestions?: boolean }) =>
      wrap(async () => {
        const report = await runInit({
          cwd,
          ...(cmdOptions.output === undefined ? {} : { output: cmdOptions.output }),
          ...(cmdOptions.force === undefined ? {} : { force: cmdOptions.force }),
          ...(cmdOptions.withSuggestions === undefined
            ? {}
            : { withSuggestions: cmdOptions.withSuggestions }),
        })
        stdout.write(`✓ Wrote ${report.outputPath}\n`)
        stdout.write(
          `  managers: ${report.detectedManagers.join(", ") || "—"}\n` +
            `  languages: ${report.detectedLanguages.join(", ") || "—"}\n` +
            `  frameworks: ${report.detectedFrameworks.join(", ") || "—"}\n` +
            `  components: ${report.componentCount}\n`,
        )
        if (report.suggestedPlugins.length > 0) {
          stdout.write(`  suggested: ${report.suggestedPlugins.join(", ")}\n`)
        }
        // An unmapped language leaves `languages` empty, and `aburi scan` refuses to run
        // without a language plugin — so this is the difference between the next command
        // working and it stopping, not a nicety.
        if (report.unmappedLanguages.length > 0) {
          stderr.write(
            `⚠ No language plugin ships for: ${report.unmappedLanguages.join(", ")}. ` +
              `"languages" is empty, so \`aburi scan\` has nothing to parse with — add a plugin ref to aburi.json.\n`,
          )
        }
        if (report.unmappedFrameworks.length > 0) {
          stderr.write(
            `⚠ No framework plugin ships for: ${report.unmappedFrameworks.join(", ")}. ` +
              `Those components will be scanned without framework classification.\n`,
          )
        }
        return report.exitCode
      })(),
    )

  program
    .command("scan")
    .description("Generate IR from the current workspace")
    .option("--output-dir <path>", "output directory (default: out)")
    .option("--format <format>", "json | md | both", parseFormat, "both")
    .option("--no-md", "shortcut for --format json")
    .option("--no-json", "shortcut for --format md")
    .option("--ignore <glob>", "additional ignore glob (repeatable)", collect, [])
    .option("--no-respect-gitignore", "ignore .gitignore patterns")
    .option("--compact", "compact JSON output")
    .option("--no-timestamp", "omit generatedAt from IR (default when running under CI env)")
    .option("--config <path>", "config file path")
    .option("--lsp", "enable optional LSP enrichment (overrides config lsp.enabled=true)")
    .option("--no-lsp", "disable LSP enrichment (overrides config lsp.enabled=false)")
    .action(
      (cmdOptions: {
        outputDir?: string
        format?: "json" | "md" | "both"
        md?: boolean
        json?: boolean
        ignore?: string[]
        respectGitignore?: boolean
        compact?: boolean
        timestamp?: boolean
        config?: string
        lsp?: boolean
      }) =>
        wrap(async () => {
          const format = deriveFormat(cmdOptions)
          const report = await runScan({
            cwd,
            ...(cmdOptions.outputDir === undefined ? {} : { outputDir: cmdOptions.outputDir }),
            format,
            ...(cmdOptions.ignore !== undefined && cmdOptions.ignore.length > 0
              ? { ignore: cmdOptions.ignore }
              : {}),
            ...(cmdOptions.respectGitignore === undefined
              ? {}
              : { respectGitignore: cmdOptions.respectGitignore }),
            ...(cmdOptions.compact === undefined ? {} : { compact: cmdOptions.compact }),
            ...(cmdOptions.timestamp === false || env.ci ? { suppressTimestamp: true } : {}),
            ...(cmdOptions.lsp === undefined ? {} : { lsp: cmdOptions.lsp }),
            ...(env.logLevel === null ? {} : { logLevel: env.logLevel }),
            ...withConfigPath(cmdOptions.config, env),
          })
          stdout.write(
            `${report.keptSymbols} kept · ${report.droppedSymbols} dropped · ${report.totalFiles} files\n`,
          )
          stdout.write(`${report.callResolutionLine}\n`)
          if (report.irPath !== null) stdout.write(`→ ${report.irPath}\n`)
          if (report.workspaceMdPath !== null) stdout.write(`→ ${report.workspaceMdPath}\n`)
          warnOnScanIncidents(report, stderr)
          return report.exitCode
        })(),
    )

  program
    .command("diff")
    .description("Compute the semantic diff between two IRs")
    .argument("[refspec]", "<base>..<head> ref spec")
    .option("--base <path>", "base IR file")
    .option("--head <path>", "head IR file")
    .option("--output-dir <path>", "output directory (default: out)")
    .option("--format <format>", "json | md | both", parseFormat, "both")
    .option("--fail-on <spec>", "comma-separated CI gate spec (e.g. changed,removed:>10)")
    .option("--compact", "compact JSON output")
    .option("--config <path>", "config file path")
    .action(
      (
        refspec: string | undefined,
        cmdOptions: {
          base?: string
          head?: string
          outputDir?: string
          format?: "json" | "md" | "both"
          failOn?: string
          compact?: boolean
          config?: string
        },
      ) =>
        wrap(async () => {
          const report = await runDiff({
            cwd,
            refSpec: refspec ?? null,
            ...(cmdOptions.base === undefined ? {} : { base: cmdOptions.base }),
            ...(cmdOptions.head === undefined ? {} : { head: cmdOptions.head }),
            ...(cmdOptions.outputDir === undefined ? {} : { outputDir: cmdOptions.outputDir }),
            ...(cmdOptions.format === undefined ? {} : { format: cmdOptions.format }),
            ...(cmdOptions.failOn === undefined ? {} : { failOn: cmdOptions.failOn }),
            ...(cmdOptions.compact === undefined ? {} : { compact: cmdOptions.compact }),
            ...withConfigPath(cmdOptions.config, env),
            warn: (message: string) => {
              stderr.write(`${message}\n`)
            },
          })
          stdout.write(`${report.summaryLine}\n`)
          if (report.callResolutionLine !== null) {
            stdout.write(`${report.callResolutionLine}\n`)
          }
          if (report.diffMdPath !== null) stdout.write(`→ ${report.diffMdPath}\n`)
          if (report.triggered !== null) {
            stderr.write(`${formatFailOnMessage(report.triggered)}\n`)
          }
          return report.exitCode
        })(),
    )

  program
    .command("explain")
    .description("Show a single Symbol's details")
    .argument("<id-or-pattern>", "Symbol id, file path, or substring pattern")
    .option("--ir <path>", "existing IR file (skip auto-scan)")
    .option("--output <path>", "write markdown to file instead of stdout")
    .option("--no-rescan", "fail if IR is missing rather than scanning")
    .option(
      "--debug-resolution",
      "append the per-call resolution table (forces a rescan; incompatible with --ir / --no-rescan)",
    )
    .option("--config <path>", "config file path")
    .action(
      (
        argument: string,
        cmdOptions: {
          ir?: string
          output?: string
          rescan?: boolean
          debugResolution?: boolean
          config?: string
        },
      ) =>
        wrap(async () => {
          const outcome = await runExplain({
            cwd,
            argument,
            ...(cmdOptions.ir === undefined ? {} : { irPath: cmdOptions.ir }),
            ...(cmdOptions.output === undefined ? {} : { outputPath: cmdOptions.output }),
            ...(cmdOptions.rescan === undefined ? {} : { noRescan: !cmdOptions.rescan }),
            ...(cmdOptions.debugResolution === undefined
              ? {}
              : { debugResolution: cmdOptions.debugResolution }),
            ...withConfigPath(cmdOptions.config, env),
          })
          switch (outcome.kind) {
            case "single":
            case "file":
              // §7 — when --output is set the markdown lives in the file only.
              // Otherwise mirror to stdout so the user can `aburi explain foo | less`.
              if (outcome.writtenTo === null) {
                stdout.write(outcome.markdown)
                if (!outcome.markdown.endsWith("\n")) stdout.write("\n")
              } else {
                stdout.write(`→ ${outcome.writtenTo}\n`)
              }
              break
            case "ambiguous":
              stdout.write(`Multiple matches for "${argument}":\n`)
              for (const candidate of outcome.candidates) stdout.write(`  ${candidate.id}\n`)
              stdout.write("\nSpecify the full id to disambiguate.\n")
              break
            case "not-found":
              stderr.write(`No matches for "${argument}".\n`)
              break
          }
          return outcome.exitCode
        })(),
    )

  try {
    await program.parseAsync(options.argv, { from: "user" })
  } catch (error) {
    if (isCommanderError(error)) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return EXIT.SUCCESS
      }
      return EXIT.INPUT_ERROR
    }
    return handleError(error, stderr)
  }
  return outcome
}

function isCommanderError(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    (value as { code: string }).code.startsWith("commander.")
  )
}

/**
 * Error mapping (see docs/design/cli-spec.md §9 for the exit-code contract):
 *   - `input-error` / `config-error` → EXIT.INPUT_ERROR
 *   - `runtime-error`                → EXIT.RUNTIME
 *   - `plugin-error`                 → EXIT.GATE
 *   - FailOnParseError               → EXIT.INPUT_ERROR (grammar mistake, not a runtime bug)
 *   - Any other Error                → EXIT.RUNTIME
 */
function handleError(error: unknown, stderr: NodeJS.WritableStream): ExitCode {
  if (error instanceof FailOnParseError) {
    stderr.write(`${error.message}\n`)
    return EXIT.INPUT_ERROR
  }
  if (error instanceof CliError) {
    stderr.write(`${error.message}\n`)
    switch (error.code) {
      case "input-error":
      case "config-error":
        return EXIT.INPUT_ERROR
      case "runtime-error":
        return EXIT.RUNTIME
      case "plugin-error":
        return EXIT.GATE
    }
  }
  if (error instanceof Error) {
    stderr.write(`${error.message}\n`)
    return EXIT.RUNTIME
  }
  stderr.write(`${String(error)}\n`)
  return EXIT.RUNTIME
}

/**
 * §11 — `--config` takes precedence over `ABURI_CONFIG`. When neither is present the
 * object contribution is empty so the downstream command falls through to on-disk
 * config discovery.
 */
function withConfigPath(
  cliFlag: string | undefined,
  env: ReturnType<typeof readEnv>,
): { configPath?: string } {
  const resolved = resolveConfigPath(cliFlag, env)
  return resolved === undefined ? {} : { configPath: resolved }
}

/**
 * Config discovery is anchored to `cwd`, everything inside the config to the workspace
 * root. When the two directories differ — running inside a monorepo package that has its
 * own `aburi.json` — a relative path in that file points somewhere other than where its
 * author was looking, and the scan still covers the whole workspace. Both are deliberate
 * (see `resolveConfig`), and neither is visible from the command line, so say it.
 */
function warnOnConfigOutsideWorkspaceRoot(report: ScanReport, stderr: NodeJS.WritableStream): void {
  if (report.configSource === null) return
  if (dirname(report.configSource) === report.workspaceRoot) return
  stderr.write(
    `⚠ Config ${report.configSource} sits below the workspace root ${report.workspaceRoot}. ` +
      `Paths inside it (ignore, components[].roots, relative plugin refs) resolve against the root, ` +
      `and the scan covers the whole workspace.\n`,
  )
}

/**
 * How many withdrawn files are named individually before the list is summarised.
 *
 * A plugin broken enough to reject one file usually rejects them all, so the untruncated
 * list is the whole workspace — which on CI scrolls every other warning out of the log it
 * was meant to appear in. Ten is enough to see the shape (one path, or many) and read the
 * message, which is identical across them when the fault is the plugin's.
 */
const MAX_LISTED_EXTRACTION_FAILURES = 10

/**
 * §5.6 — surface parse failures / soft timeouts / discovery-time skips on stderr so a
 * scan that ate 50 broken files still produces a visible signal. The main summary line
 * on stdout stays clean; this only fires when a non-empty incident list exists.
 */
function warnOnScanIncidents(report: ScanReport, stderr: NodeJS.WritableStream): void {
  warnOnConfigOutsideWorkspaceRoot(report, stderr)
  if (report.parseErrorCount > 0) {
    stderr.write(`⚠ ${report.parseErrorCount} file(s) had recoverable parse errors.\n`)
  }
  if (report.parseFailureCount > 0) {
    // Apart from the line above rather than folded into it: those files are in the IR with
    // warnings against them, these are not in it at all, and the difference is the whole
    // reason a reader is reading the count. The skip summary below names them too, among
    // every other reason a file went missing; this says which of them are unparseable.
    stderr.write(
      `⚠ ${report.parseFailureCount} file(s) could not be parsed and were left out of the IR.\n`,
    )
  }
  if (report.timeoutCount > 0) {
    stderr.write(
      `⚠ ${report.timeoutCount} effect classification(s) hit the per-call timeout budget.\n`,
    )
  }
  if (report.skipped.length > 0) {
    stderr.write(
      `⚠ ${report.skipped.length} file(s) contributed no Symbols: ${summariseSkipped(report.skipped)}\n`,
    )
  }
  if (report.extractionFailures.length > 0) {
    // Named on its own line rather than left inside the skip summary: this is the reason
    // that decides the exit code, and a reader given a non-zero status needs to know which
    // of the counts above earned it — and, unlike the other reasons, which files and why.
    // `@aburi/core` logs the same per file, but through its own sink, which disappears at
    // `ABURI_LOG_LEVEL=error` and never reaches a caller that injected its own streams.
    stderr.write(
      `⚠ ${report.extractionFailures.length} file(s) were dropped because a plugin threw while extracting them.\n`,
    )
    for (const failure of report.extractionFailures.slice(0, MAX_LISTED_EXTRACTION_FAILURES)) {
      stderr.write(`    ${failure.file}: ${failure.message}\n`)
    }
    const hidden = report.extractionFailures.length - MAX_LISTED_EXTRACTION_FAILURES
    if (hidden > 0) stderr.write(`    …and ${hidden} more\n`)
  }
  const lsp = report.lspEnrichment
  if (lsp !== undefined) {
    if (lsp.filesFellBack > 0) {
      stderr.write(
        `⚠ LSP enrichment fell back for ${lsp.filesFellBack} file(s); IR field values in those files remain at the untyped tier.\n`,
      )
    }
    if (lsp.languagesDisabled.length > 0) {
      stderr.write(`⚠ LSP disabled mid-run for language(s): ${lsp.languagesDisabled.join(", ")}.\n`)
    }
    if (lsp.requestsTimedOut > 0 || lsp.requestsFailed > 0) {
      stderr.write(
        `  LSP requests: ${lsp.requestsIssued} issued · ${lsp.requestsTimedOut} timed out · ${lsp.requestsFailed} failed.\n`,
      )
    }
  }
}

function summariseSkipped(skipped: readonly { reason: string }[]): string {
  const counts = new Map<string, number>()
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
  return [...counts.entries()].map(([reason, n]) => `${reason}=${n}`).join(", ")
}

function parseFormat(value: string): "json" | "md" | "both" {
  if (value === "json" || value === "md" || value === "both") return value
  throw new InvalidArgumentError(`--format must be one of: json | md | both`)
}

function collect(value: string, accumulator: string[]): string[] {
  return [...accumulator, value]
}

function deriveFormat(cmdOptions: {
  format?: "json" | "md" | "both"
  md?: boolean
  json?: boolean
}): "json" | "md" | "both" {
  if (cmdOptions.md === false) return "json"
  if (cmdOptions.json === false) return "md"
  return cmdOptions.format ?? "both"
}
