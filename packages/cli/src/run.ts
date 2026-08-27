import { Command, InvalidArgumentError } from "commander"
import { formatFailOnMessage, runDiff } from "./commands/diff"
import { type CoverageDoubt, runExplain } from "./commands/explain"
import { runInit } from "./commands/init"
import { runScan } from "./commands/scan"
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
    // The pair rather than the negative alone, for the reason `scan` states: a run that typed
    // neither has to be distinguishable from one that asked for the default. There is no config
    // to fall through to here — this command writes the first one — so the default is honouring
    // `.gitignore`, and the negative is the only way out of a `.gitignore` that cannot be read.
    .option("--respect-gitignore", "honour .gitignore while counting a component's languages")
    .option("--no-respect-gitignore", "ignore .gitignore while counting a component's languages")
    .action(
      (cmdOptions: {
        output?: string
        force?: boolean
        withSuggestions?: boolean
        respectGitignore?: boolean
      }) =>
        wrap(async () => {
          const report = await runInit({
            cwd,
            ...(cmdOptions.output === undefined ? {} : { output: cmdOptions.output }),
            ...(cmdOptions.force === undefined ? {} : { force: cmdOptions.force }),
            ...(cmdOptions.withSuggestions === undefined
              ? {}
              : { withSuggestions: cmdOptions.withSuggestions }),
            ...(cmdOptions.respectGitignore === undefined
              ? {}
              : { respectGitignore: cmdOptions.respectGitignore }),
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
          // The config this command writes describes the workspace it found, so a manifest
          // that named packages and produced none makes that description wrong before it is
          // ever read — and `components[]` is the one part of it a reader cannot check
          // against anything.
          for (const declaration of report.unresolvedDeclarations) {
            const patterns = declaration.patterns.map((p) => JSON.stringify(p)).join(", ")
            const count = declaration.patterns.length
            stderr.write(
              `⚠ ${declaration.tool} declared ${count} package pattern${count === 1 ? "" : "s"} ` +
                `that named no package: ${patterns}\n`,
            )
          }
          if (report.fellBackToSingleComponent && report.unresolvedDeclarations.length > 0) {
            stderr.write(
              "⚠ No workspace package was found, so the whole repository is one component.\n",
            )
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
    .option("--output-dir <path>", "output directory (default: config.output.dir, or out)")
    .option("--format <format>", "json | md | both", parseFormat, "both")
    .option("--no-md", "shortcut for --format json")
    .option("--no-json", "shortcut for --format md")
    .option("--ignore <glob>", "additional ignore glob (repeatable)", collect, [])
    // Declared as a pair, like `--lsp` / `--no-lsp` below. A lone `--no-x` makes commander
    // materialise `true` for every run that did not pass it, and the option object then cannot
    // say whether the caller asked for `true` or said nothing — so the override was applied
    // unconditionally and a config that turned `.gitignore` off got it back on. With both
    // spellings declared the value is absent until one of them is typed, which is what the
    // forwarding below already assumes.
    .option("--respect-gitignore", "honour .gitignore patterns (overrides config)")
    .option("--no-respect-gitignore", "ignore .gitignore patterns (overrides config)")
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
            incidents: {
              warn: (message: string) => {
                stderr.write(`${message}\n`)
              },
            },
          })
          // `totalFiles` excludes the files no Document path can name, by design (§5.8), so on
          // its own this line moves in the flattering direction: a workspace of 200 with 15
          // unnameable ones reads `185 files` and looks whole. The other two gate reasons leave
          // their mark in these numbers; this one has to be added back or the summary
          // contradicts the exit code beside it.
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
            warn: (message: string) => {
              stderr.write(`${message}\n`)
            },
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
              if (outcome.coverage !== null) {
                stderr.write(`${coverageLine(outcome.coverage)}\n`)
              }
              break
            case "unnameable":
              // Not `No matches`, for the reason `unknown` is not: the absence is the format's
              // and not the workspace's, and no rescan or re-ask changes it.
              stderr.write(
                `Cannot answer "${argument}": no IR can name this file. "${outcome.unnameablePrefix}" holds a backslash, and "/" is the only separator a Document path has, so nothing Aburi writes can refer to it. Rename it.\n`,
              )
              break
            case "unknown": {
              // Not a match failure, so it does not start with `No matches`: the document
              // holds no answer to give, and saying otherwise would assert an absence it
              // cannot support.
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
              return assertNeverOutcome(outcome)
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

/**
 * The second line under `No matches`, on every miss the document could not tie to the file the
 * question named — which includes the id and file arms when the path they name was analysed
 * after all.
 *
 * Counted, not listed, even though `named-losses` carries the entries. The question was about
 * one Symbol, and answering it with an inventory of the run buries it; the document is where
 * the list lives, and the line says so. No per-reason next step here: the reasons call for
 * different actions, and that mapping belongs in one place for the scan report and this line
 * alike rather than being invented twice.
 */
function coverageLine(doubt: CoverageDoubt): string {
  if (doubt.kind === "named-losses") {
    return `⚠ This IR names ${doubt.files.length} file(s) the scan never analysed in stats.skippedFiles, so a match may be in one of them.`
  }
  return `⚠ This IR reports ${doubt.fileCount} file(s) it did not parse but predates stats.skippedFiles, so it cannot name them; a match may be in one of them. Re-run \`aburi scan\` to record the list.`
}

/**
 * Compile-time guard on the `explain` outcome switch: a new `ExplainOutcome` member is a type
 * error here rather than a command that exits on a code with nothing written to explain it.
 */
function assertNeverOutcome(outcome: never): never {
  throw new Error(`Unhandled explain outcome: ${JSON.stringify(outcome)}`)
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
