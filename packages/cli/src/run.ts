import { Command } from "commander"
import {
  collect,
  definedOnly,
  deriveFormat,
  deriveStrict,
  type OutputFormat,
  parseFailOnScope,
  parseFormat,
  parseLogLevel,
  parseMaxBytes,
  parsePath,
  refuseRepeatedValues,
} from "./cli-options"
import { runDiff } from "./commands/diff"
import { type CoverageDoubt, runExplain } from "./commands/explain"
import { runInit } from "./commands/init"
import { runScan } from "./commands/scan"
import { resolveConfigPath } from "./config-path"
import { type LogLevel, readEnv } from "./env"
import { assertNever, CliError, errorCode } from "./errors"
import { EXIT, type ExitCode } from "./exit-codes"
import { FailOnParseError, type FailOnScope, formatTriggered } from "./fail-on"
import { readGeneratorInfo } from "./generator-info"
import type { LogWrite } from "./logger"
import { showDiffProgress, showScanProgress } from "./progress"
import {
  createTerminal,
  type Terminal,
  type TerminalMode,
  terminalMode,
  toneOfLevel,
} from "./terminal"
import { describeWorkspaceDetection, UNNAMEABLE_BECAUSE } from "./unresolved-report"
import { VOCAB_DISCOVERED_FILENAME } from "./vocab-discovered"

export interface RunCliOptions {
  argv: readonly string[]
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export async function runCli(options: RunCliOptions): Promise<ExitCode> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const env = readEnv(options.env ?? process.env)
  const cwd = options.cwd ?? process.cwd()

  const { version } = await readGeneratorInfo()
  const program = new Command()
  const globals = () => program.opts<{ logLevel?: LogLevel; color?: boolean; ci?: boolean }>()
  const ciMode = (): boolean => env.ci || globals().ci === true
  const mode = (): TerminalMode =>
    terminalMode({
      env,
      ci: ciMode(),
      colourFlag: globals().color !== false,
      isTerminal: (stderr as { isTTY?: unknown }).isTTY === true,
    })
  const terminal = createTerminal(stderr, { mode })
  program
    .name("aburi")
    .description("Render meaningful code structure as IR for review")
    .version(version, "-v, --version")
    .option(
      "--log-level <level>",
      "the run's log on stderr: debug | info | warn | error (default: ABURI_LOG_LEVEL, or warn); info adds the files scan removes, debug each file extracted and why diff left a Symbol unpaired, and error shows none of it",
      parseLogLevel,
    )
    .option("--no-color", "no colour on stderr, whatever FORCE_COLOR says")
    .option(
      "--ci",
      "CI mode where CI is not set: no progress line, no colour unless FORCE_COLOR, and scan as under --no-timestamp",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        stdout.write(str)
      },
      writeErr: (str) => {
        terminal.say(withoutFinalNewline(str))
      },
      outputError: (str) => {
        terminal.say(withoutFinalNewline(str), "error")
      },
    })
    // Commander copies help settings into a subcommand when `.command()` creates it.
    .configureHelp({ showGlobalOptions: true })

  const warn = (message: string): void => {
    terminal.say(message, "warning")
  }
  const log: LogWrite = (line, level) => {
    terminal.say(withoutFinalNewline(line), toneOfLevel(level))
  }
  /** A result on stdout, below a progress line erased for good. */
  const out = (text: string): void => {
    terminal.endProgress()
    stdout.write(text)
  }
  /** `show`, when the progress line is shown at all, so that no scan reports to nothing. */
  const progressTo = <T>(show: (terminal: Terminal) => (progress: T) => void) =>
    mode().progress ? { progress: show(terminal) } : {}
  const logLevel = (): LogLevel | undefined => globals().logLevel ?? env.logLevel ?? undefined
  const failed = (error: unknown): ExitCode => handleError(error, terminal, logLevel() === "debug")
  let capturedExitCode: ExitCode = EXIT.SUCCESS
  const runCommand = (command: () => Promise<ExitCode | undefined>): (() => Promise<void>) => {
    return async () => {
      try {
        capturedExitCode = (await command()) ?? EXIT.SUCCESS
      } catch (error) {
        capturedExitCode = failed(error)
      } finally {
        terminal.endProgress()
      }
    }
  }

  program
    .command("init")
    .description("Generate aburi.json from autodetect")
    .option("--output <path>", "output path (default: ./aburi.json)", parsePath)
    .option("--force", "overwrite existing config")
    .option(
      "--with-suggestions",
      "name the detected plugins the workspace has not installed, as comments",
    )
    .option(
      "--respect-gitignore",
      "honour .gitignore in the language census and the nx project search",
    )
    .option(
      "--no-respect-gitignore",
      "ignore .gitignore in the language census and the nx project search",
    )
    .action(
      (cmdOptions: {
        output?: string
        force?: boolean
        withSuggestions?: boolean
        respectGitignore?: boolean
      }) =>
        runCommand(async () => {
          const report = await runInit({
            cwd,
            ...definedOnly({
              output: cmdOptions.output,
              force: cmdOptions.force,
              withSuggestions: cmdOptions.withSuggestions,
              respectGitignore: cmdOptions.respectGitignore,
            }),
          })
          out(`✓ Wrote ${report.outputPath}\n`)
          if (report.overwrote) {
            warn(`⚠ Overwrote ${report.outputPath}; the config that was there is gone.`)
          }
          out(
            `  managers: ${report.detectedManagers.join(", ") || "—"}\n` +
              `  languages: ${report.detectedLanguages.join(", ") || "—"}\n` +
              `  frameworks: ${report.detectedFrameworks.join(", ") || "—"}\n` +
              `  components: ${report.componentCount}\n`,
          )
          if (report.suggestedPlugins.length > 0) {
            out(`  suggested: ${report.suggestedPlugins.join(", ")}\n`)
          }
          for (const line of describeWorkspaceDetection(report)) warn(`⚠ ${line}`)
          if (report.unmappedLanguages.length > 0) {
            warn(
              `⚠ No language plugin ships for: ${report.unmappedLanguages.join(", ")}. ` +
                `"languages" is empty, so \`aburi scan\` has nothing to parse with — add a plugin ref to aburi.json.`,
            )
          }
          if (report.unmappedFrameworks.length > 0) {
            warn(
              `⚠ No framework plugin ships for: ${report.unmappedFrameworks.join(", ")}. ` +
                `Those components will be scanned without framework classification.`,
            )
          }
          return report.exitCode
        })(),
    )

  program
    .command("scan")
    .description("Generate IR from the current workspace")
    .option(
      "--output-dir <path>",
      "output directory (default: config.output.dir, or out)",
      parsePath,
    )
    .option("--format <format>", "json | md | both (default: both)", parseFormat)
    .option("--no-md", "drop the Markdown output (conflicts with --format both/md)")
    .option("--no-json", "drop the IR JSON output (conflicts with --format both/json)")
    .option("--ignore <glob>", "additional ignore glob (repeatable)", collect, [])
    .option("--respect-gitignore", "honour .gitignore patterns (overrides config)")
    .option("--no-respect-gitignore", "ignore .gitignore patterns (overrides config)")
    .option("--compact", "compact JSON output")
    .option(
      "--no-timestamp",
      "omit discoveredAt from aburi-vocab-discovered.json (default under CI)",
    )
    .option("--config <path>", "config file path", parsePath)
    .option("--lsp", "enable optional LSP enrichment (overrides config lsp.enabled=true)")
    .option("--no-lsp", "disable LSP enrichment (overrides config lsp.enabled=false)")
    .option("--strict", "stop at a value no plugin manifest declares (overrides config strict)")
    .option("--no-strict", "keep and record such values instead (overrides config strict)")
    .option(
      "--discover",
      `same as --no-strict: record undeclared values in ${VOCAB_DISCOVERED_FILENAME}`,
    )
    .action(
      (cmdOptions: {
        outputDir?: string
        format?: OutputFormat
        md?: boolean
        json?: boolean
        ignore?: string[]
        respectGitignore?: boolean
        compact?: boolean
        timestamp?: boolean
        config?: string
        lsp?: boolean
        strict?: boolean
        discover?: boolean
      }) =>
        runCommand(async () => {
          const report = await runScan({
            cwd,
            format: deriveFormat(cmdOptions),
            ...definedOnly({
              outputDir: cmdOptions.outputDir,
              ignore:
                cmdOptions.ignore !== undefined && cmdOptions.ignore.length > 0
                  ? cmdOptions.ignore
                  : undefined,
              respectGitignore: cmdOptions.respectGitignore,
              compact: cmdOptions.compact,
              suppressTimestamp: cmdOptions.timestamp === false || ciMode() ? true : undefined,
              lsp: cmdOptions.lsp,
              strict: deriveStrict(cmdOptions),
              logLevel: logLevel(),
              configPath: resolveConfigPath(cmdOptions.config, env),
            }),
            log,
            ...progressTo(showScanProgress),
            incidents: { warn },
          })
          const unnameable = report.unrepresentableFiles.length
          out(
            `${report.keptSymbols} kept · ${report.droppedSymbols} dropped · ${report.totalFiles} files` +
              `${unnameable === 0 ? "" : ` · ${unnameable} unnameable`}\n`,
          )
          out(`${report.callResolutionLine}\n`)
          if (report.irPath !== null) out(`→ ${report.irPath}\n`)
          if (report.workspaceMdPath !== null) out(`→ ${report.workspaceMdPath}\n`)
          return report.exitCode
        })(),
    )

  program
    .command("diff")
    .description("Compute the semantic diff between two IRs")
    .argument("[refspec]", "<base>..<head> ref spec")
    .option("--base <path>", "base IR file", parsePath)
    .option("--head <path>", "head IR file", parsePath)
    .option(
      "--output-dir <path>",
      "output directory (default: config.output.dir, or out)",
      parsePath,
    )
    .option("--format <format>", "json | md | both", parseFormat, "both")
    .option(
      "--fail-on <spec>",
      "comma-separated CI gate spec (e.g. changed,removed:>10), repeatable",
      collect,
      [],
    )
    .option(
      "--fail-on-scope <scope>",
      "all | non-test: whether --fail-on counts the Symbols of the files config testFiles names (default: all)",
      parseFailOnScope,
    )
    .option("--compact", "compact JSON output")
    .option(
      "--max-bytes <n>",
      "cap diff.md at n UTF-8 bytes, shortening sections to names and then dropping them least-important-first (GitHub rejects a comment body over 65536)",
      parseMaxBytes,
    )
    .option("--parallel-scans", "scan the base and the head at once, even on a single CPU")
    .option(
      "--no-parallel-scans",
      "scan the base and then the head, which uses less memory (default: at once, unless on a single CPU)",
    )
    .option("--config <path>", "config file path", parsePath)
    .action(
      (
        refspec: string | undefined,
        cmdOptions: {
          base?: string
          head?: string
          outputDir?: string
          format?: OutputFormat
          failOn?: string[]
          failOnScope?: FailOnScope
          compact?: boolean
          maxBytes?: number
          parallelScans?: boolean
          config?: string
        },
      ) =>
        runCommand(async () => {
          const report = await runDiff({
            cwd,
            refSpec: refspec ?? null,
            ...definedOnly({
              base: cmdOptions.base,
              head: cmdOptions.head,
              outputDir: cmdOptions.outputDir,
              format: cmdOptions.format,
              failOn:
                cmdOptions.failOn !== undefined && cmdOptions.failOn.length > 0
                  ? cmdOptions.failOn
                  : undefined,
              failOnScope: cmdOptions.failOnScope,
              compact: cmdOptions.compact,
              maxBytes: cmdOptions.maxBytes,
              parallelScans: cmdOptions.parallelScans,
              logLevel: logLevel(),
              configPath: resolveConfigPath(cmdOptions.config, env),
            }),
            warn,
            log,
            ...progressTo(showDiffProgress),
          })
          out(`${report.summaryLine}\n`)
          if (report.callResolutionLine !== null) {
            out(`${report.callResolutionLine}\n`)
          }
          if (report.diffMdPath !== null) out(`→ ${report.diffMdPath}\n`)
          if (report.triggered !== null) {
            terminal.say(formatTriggered(report.triggered), "error")
          }
          return report.exitCode
        })(),
    )

  program
    .command("explain")
    .description("Show a single Symbol's details")
    .argument("<id-or-pattern>", "Symbol id, file path, or substring pattern")
    .option("--ir <path>", "existing IR file (skip auto-scan)", parsePath)
    .option("--output <path>", "write markdown to file instead of stdout", parsePath)
    .option("--no-rescan", "fail if IR is missing rather than scanning")
    .option(
      "--debug-resolution",
      "append the per-call resolution table (forces a rescan; incompatible with --ir / --no-rescan)",
    )
    .option("--config <path>", "config file path", parsePath)
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
        runCommand(async () => {
          const outcome = await runExplain({
            cwd,
            argument,
            ...definedOnly({
              irPath: cmdOptions.ir,
              outputPath: cmdOptions.output,
              noRescan: cmdOptions.rescan === undefined ? undefined : !cmdOptions.rescan,
              debugResolution: cmdOptions.debugResolution,
              logLevel: logLevel(),
              configPath: resolveConfigPath(cmdOptions.config, env),
            }),
            warn,
            log,
            ...progressTo(showScanProgress),
          })
          terminal.endProgress()
          switch (outcome.kind) {
            case "single":
            case "file":
              if (outcome.writtenTo === null) {
                out(outcome.markdown)
                if (!outcome.markdown.endsWith("\n")) out("\n")
              } else {
                out(`→ ${outcome.writtenTo}\n`)
              }
              break
            case "ambiguous":
              out(`Multiple matches for "${argument}":\n`)
              for (const candidate of outcome.candidates) out(`  ${candidate.id}\n`)
              out("\nSpecify the full id to disambiguate.\n")
              break
            case "not-found":
              terminal.say(`No matches for "${argument}".`, "error")
              if (outcome.coverage !== null) warn(coverageLine(outcome.coverage))
              break
            case "unnameable":
              terminal.say(
                `Cannot answer "${argument}": no IR can name this file. "${outcome.unnameablePrefix}" ${UNNAMEABLE_BECAUSE[outcome.reason]}, so nothing Aburi writes can refer to it. Rename it.`,
                "error",
              )
              break
            case "unknown": {
              const trailer =
                outcome.namedBy === "id"
                  ? ", the file that id names, so it cannot say whether that Symbol exists."
                  : ", so it cannot say what that file declares."
              terminal.say(
                `Cannot answer "${argument}": this IR never analysed ${outcome.skipped.path} (${outcome.skipped.reason})${trailer}`,
                "error",
              )
              break
            }
            default:
              return assertNever(outcome, "explain outcome")
          }
          return outcome.exitCode
        })(),
    )

  for (const command of [program, ...program.commands]) refuseRepeatedValues(command)

  try {
    await program.parseAsync(options.argv, { from: "user" })
  } catch (error) {
    if (isCommanderError(error)) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return EXIT.SUCCESS
      }
      return EXIT.INPUT_ERROR
    }
    return failed(error)
  }
  return capturedExitCode
}

function withoutFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

function coverageLine(doubt: CoverageDoubt): string {
  if (doubt.kind === "named-losses") {
    return `⚠ This IR names ${doubt.files.length} file(s) the scan never analysed in stats.skippedFiles, so a match may be in one of them.`
  }
  return `⚠ This IR reports ${doubt.fileCount} file(s) it did not parse but predates stats.skippedFiles, so it cannot name them; a match may be in one of them. Re-run \`aburi scan\` to record the list.`
}

function isCommanderError(value: unknown): value is { code: string; message: string } {
  return errorCode(value)?.startsWith("commander.") === true
}

function handleError(error: unknown, terminal: Terminal, debug: boolean): ExitCode {
  terminal.endProgress()
  const exitCode = exitCodeOf(error)
  terminal.say(error instanceof Error ? error.message : String(error), "error")
  // An exit-2 error is the invocation's: its message is the whole story.
  if (debug && exitCode !== EXIT.INPUT_ERROR) {
    const trace = stackTrace(error)
    if (trace !== null) terminal.say(trace, "muted")
  }
  return exitCode
}

function exitCodeOf(error: unknown): ExitCode {
  if (error instanceof FailOnParseError) return EXIT.INPUT_ERROR
  if (!(error instanceof CliError)) return EXIT.RUNTIME
  switch (error.code) {
    case "input-error":
    case "config-error":
      return EXIT.INPUT_ERROR
    case "runtime-error":
      return EXIT.RUNTIME
    case "plugin-error":
      return EXIT.GATE
    default:
      return assertNever(error.code, "CliError code")
  }
}

/** The frames of `error`'s stack, then each cause's under a `caused by:` line. */
function stackTrace(error: unknown): string | null {
  const lines: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (current !== error) {
      lines.push(
        `caused by: ${current instanceof Error ? `${current.name}: ${current.message}` : String(current)}`,
      )
    }
    if (!(current instanceof Error)) break
    lines.push(...(current.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)))
    current = current.cause
  }
  return lines.length === 0 ? null : lines.join("\n")
}
