import { Command, InvalidArgumentError } from "commander"
import { formatFailOnMessage, runDiff } from "./commands/diff"
import { type CoverageDoubt, runExplain } from "./commands/explain"
import { runInit } from "./commands/init"
import { runScan } from "./commands/scan"
import { resolveConfigPath } from "./config-path"
import { readEnv } from "./env"
import { assertNever, CliError, errorCode } from "./errors"
import { EXIT, type ExitCode } from "./exit-codes"
import { FailOnParseError } from "./fail-on"
import { readGeneratorInfo } from "./generator-info"
import { describeUnresolvedDeclarations } from "./unresolved-report"
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

  const warn = (message: string): void => {
    stderr.write(`${message}\n`)
  }
  let capturedExitCode: ExitCode = EXIT.SUCCESS
  const runCommand = (command: () => Promise<ExitCode | undefined>): (() => Promise<void>) => {
    return async () => {
      try {
        capturedExitCode = (await command()) ?? EXIT.SUCCESS
      } catch (error) {
        capturedExitCode = handleError(error, stderr)
      }
    }
  }

  program
    .command("init")
    .description("Generate aburi.json from autodetect")
    .option("--output <path>", "output path (default: ./aburi.json)")
    .option("--force", "overwrite existing config")
    .option("--with-suggestions", "include plugin install suggestions as comments")
    .option("--respect-gitignore", "honour .gitignore while counting a component's languages")
    .option("--no-respect-gitignore", "ignore .gitignore while counting a component's languages")
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
          for (const line of describeUnresolvedDeclarations(
            report.unresolvedDeclarations,
            report.fellBackToSingleComponent,
          )) {
            stderr.write(`⚠ ${line}\n`)
          }
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
    .option("--output-dir <path>", "output directory (default: config.output.dir, or out)")
    .option("--format <format>", "json | md | both (default: both)", parseFormat)
    .option("--no-md", "drop the Markdown output (conflicts with --format both/md)")
    .option("--no-json", "drop the IR JSON output (conflicts with --format both/json)")
    .option("--ignore <glob>", "additional ignore glob (repeatable)", collect, [])
    .option("--respect-gitignore", "honour .gitignore patterns (overrides config)")
    .option("--no-respect-gitignore", "ignore .gitignore patterns (overrides config)")
    .option("--compact", "compact JSON output")
    .option("--no-timestamp", "omit generatedAt from IR (default when running under CI env)")
    .option("--config <path>", "config file path")
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
        format?: "json" | "md" | "both"
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
              suppressTimestamp: cmdOptions.timestamp === false || env.ci ? true : undefined,
              lsp: cmdOptions.lsp,
              strict: deriveStrict(cmdOptions),
              logLevel: env.logLevel ?? undefined,
              configPath: resolveConfigPath(cmdOptions.config, env),
            }),
            incidents: { warn },
          })
          const unnameable = report.unrepresentableFiles.length
          stdout.write(
            `${report.keptSymbols} kept · ${report.droppedSymbols} dropped · ${report.totalFiles} files` +
              `${unnameable === 0 ? "" : ` · ${unnameable} unnameable`}\n`,
          )
          stdout.write(`${report.callResolutionLine}\n`)
          if (report.irPath !== null) stdout.write(`→ ${report.irPath}\n`)
          if (report.workspaceMdPath !== null) stdout.write(`→ ${report.workspaceMdPath}\n`)
          return report.exitCode
        })(),
    )

  program
    .command("diff")
    .description("Compute the semantic diff between two IRs")
    .argument("[refspec]", "<base>..<head> ref spec")
    .option("--base <path>", "base IR file")
    .option("--head <path>", "head IR file")
    .option("--output-dir <path>", "output directory (default: config.output.dir, or out)")
    .option("--format <format>", "json | md | both", parseFormat, "both")
    .option("--fail-on <spec>", "comma-separated CI gate spec (e.g. changed,removed:>10)")
    .option("--compact", "compact JSON output")
    .option(
      "--max-bytes <n>",
      "cap diff.md at n UTF-8 bytes, shortening sections to names and then dropping them least-important-first (GitHub rejects a comment body over 65536)",
      parseMaxBytes,
    )
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
          maxBytes?: number
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
              failOn: cmdOptions.failOn,
              compact: cmdOptions.compact,
              maxBytes: cmdOptions.maxBytes,
              configPath: resolveConfigPath(cmdOptions.config, env),
            }),
            warn,
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
        runCommand(async () => {
          const outcome = await runExplain({
            cwd,
            argument,
            ...definedOnly({
              irPath: cmdOptions.ir,
              outputPath: cmdOptions.output,
              noRescan: cmdOptions.rescan === undefined ? undefined : !cmdOptions.rescan,
              debugResolution: cmdOptions.debugResolution,
              configPath: resolveConfigPath(cmdOptions.config, env),
            }),
            warn,
          })
          switch (outcome.kind) {
            case "single":
            case "file":
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
              if (outcome.coverage !== null) {
                stderr.write(`${coverageLine(outcome.coverage)}\n`)
              }
              break
            case "unnameable":
              stderr.write(
                `Cannot answer "${argument}": no IR can name this file. "${outcome.unnameablePrefix}" holds a backslash, and "/" is the only separator a Document path has, so nothing Aburi writes can refer to it. Rename it.\n`,
              )
              break
            case "unknown": {
              const trailer =
                outcome.namedBy === "id"
                  ? ", the file that id names, so it cannot say whether that Symbol exists."
                  : ", so it cannot say what that file declares."
              stderr.write(
                `Cannot answer "${argument}": this IR never analysed ${outcome.skipped.path} (${outcome.skipped.reason})${trailer}\n`,
              )
              break
            }
            default:
              return assertNever(outcome, "explain outcome")
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
  return capturedExitCode
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

function definedOnly<T extends object>(fields: T): { [K in keyof T]-?: Exclude<T[K], undefined> } {
  const present: Partial<Record<keyof T, unknown>> = {}
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key] !== undefined) present[key] = fields[key]
  }
  return present as { [K in keyof T]-?: Exclude<T[K], undefined> }
}

function parseFormat(value: string): "json" | "md" | "both" {
  if (value === "json" || value === "md" || value === "both") return value
  throw new InvalidArgumentError(`--format must be one of: json | md | both`)
}

function parseMaxBytes(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`--max-bytes must be a positive integer (got "${value}")`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`--max-bytes is too large to be a byte count (got "${value}")`)
  }
  return parsed
}

function collect(value: string, accumulator: string[]): string[] {
  return [...accumulator, value]
}

/** `--strict` / `--no-strict` / `--discover` to `ScanOptions.strict`; absent when none was typed. */
function deriveStrict(cmdOptions: { strict?: boolean; discover?: boolean }): boolean | undefined {
  if (cmdOptions.discover !== true) return cmdOptions.strict
  if (cmdOptions.strict === true) {
    throw new CliError("--strict and --discover contradict each other: drop one", "input-error")
  }
  return false
}

function deriveFormat(cmdOptions: {
  format?: "json" | "md" | "both"
  md?: boolean
  json?: boolean
}): "json" | "md" | "both" {
  const dropped = [
    ...(cmdOptions.md === false ? ["--no-md"] : []),
    ...(cmdOptions.json === false ? ["--no-json"] : []),
  ]
  if (cmdOptions.format !== undefined) {
    const format = `--format ${cmdOptions.format}`
    // The output `--format` already leaves out: dropping it again changes nothing.
    const redundant =
      cmdOptions.format === "json" ? "--no-md" : cmdOptions.format === "md" ? "--no-json" : null
    const conflicting = dropped.filter((flag) => flag !== redundant)
    if (conflicting.length === 1) {
      throw new CliError(
        `${format} and ${conflicting[0]} contradict each other: drop one`,
        "input-error",
      )
    }
    if (conflicting.length === 2) {
      throw new CliError(
        `${format} contradicts both --no-md and --no-json: drop ${format}, or both of them`,
        "input-error",
      )
    }
    return cmdOptions.format
  }
  if (dropped.length === 2) {
    throw new CliError("--no-md and --no-json leave scan nothing to write", "input-error")
  }
  return cmdOptions.md === false ? "json" : cmdOptions.json === false ? "md" : "both"
}
