import { Command, InvalidArgumentError } from "commander"
import { formatFailOnMessage, runDiff } from "./commands/diff"
import { runExplain } from "./commands/explain"
import { runInit } from "./commands/init"
import { runScan } from "./commands/scan"
import { readEnv } from "./env"
import { CliError } from "./errors"
import { EXIT, type ExitCode } from "./exit-codes"

const VERSION = "0.0.0"

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

  const program = new Command()
  program
    .name("aburi")
    .description("Render meaningful code structure as IR for review")
    .version(VERSION, "-v, --version")
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
  const wrap = (fn: () => Promise<ExitCode | void>): (() => Promise<void>) => {
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
    .option("--concurrency <n>", "parser concurrency", parsePositiveInt)
    .option("--config <path>", "config file path")
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
        concurrency?: number
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
            ...(cmdOptions.config === undefined ? {} : { configPath: cmdOptions.config }),
            ...(env.configPath === null ? {} : { configPath: env.configPath }),
            ...(cmdOptions.concurrency === undefined
              ? {}
              : { concurrency: cmdOptions.concurrency }),
          })
          stdout.write(
            `${report.keptSymbols} kept · ${report.droppedSymbols} dropped · ${report.totalFiles} files\n`,
          )
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
            ...(cmdOptions.config === undefined ? {} : { configPath: cmdOptions.config }),
          })
          stdout.write(`${report.summaryLine}\n`)
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
    .option("--config <path>", "config file path")
    .action(
      (
        argument: string,
        cmdOptions: { ir?: string; output?: string; rescan?: boolean; config?: string },
      ) =>
        wrap(async () => {
          const outcome = await runExplain({
            cwd,
            argument,
            ...(cmdOptions.ir === undefined ? {} : { irPath: cmdOptions.ir }),
            ...(cmdOptions.output === undefined ? {} : { outputPath: cmdOptions.output }),
            ...(cmdOptions.rescan === undefined ? {} : { noRescan: !cmdOptions.rescan }),
            ...(cmdOptions.config === undefined ? {} : { configPath: cmdOptions.config }),
          })
          switch (outcome.kind) {
            case "single":
            case "file":
              stdout.write(outcome.markdown)
              if (!outcome.markdown.endsWith("\n")) stdout.write("\n")
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

function handleError(error: unknown, stderr: NodeJS.WritableStream): ExitCode {
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

function parseFormat(value: string): "json" | "md" | "both" {
  if (value === "json" || value === "md" || value === "both") return value
  throw new InvalidArgumentError(`--format must be one of: json | md | both`)
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new InvalidArgumentError(`must be a positive integer`)
  }
  return parsed
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
