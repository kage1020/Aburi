import { resolve } from "node:path"
import { errorFrom, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  CliError,
  DEFAULT_OUTPUT_DIRNAME,
  DIFF_JSON_FILENAME,
  EXIT,
  IR_JSON_FILENAME,
  resolveOutputDir,
  runDiff,
  runExplain,
  runScan,
} from "../src"
import { pathExists } from "../src/fs-probe"
import { commitAll, fakeGit, initRepository } from "./git"
import { documentWith } from "./ir-documents"
import { TYPESCRIPT, writeConfig, writeFileAt, writeIRs, writeMonorepo } from "./workspace"

const workspace = useScratchWorkspace("output-dir")

async function configuredWith(dir: string | undefined, directory = workspace.root): Promise<void> {
  await writeConfig(directory, dir === undefined ? TYPESCRIPT : { ...TYPESCRIPT, output: { dir } })
}

async function writeAlpha(directory = workspace.root): Promise<void> {
  await writeFileAt(directory, "src/a.ts", "export function alpha() { return 1 }\n")
}

async function writeBrokenConfig(): Promise<void> {
  await workspace.writeSource(
    "aburi.json",
    '{ "languages": ["lang-typescript"], "output": { "dir": "artifacts"',
  )
}

const under = (...segments: string[]) => resolve(workspace.root, ...segments)

describe("resolveOutputDir", () => {
  const absolute = resolve("/elsewhere/artifacts")

  it.each<[string, string | undefined, string | undefined, string]>([
    ["/work", undefined, undefined, resolve("/work", DEFAULT_OUTPUT_DIRNAME)],
    ["/work", undefined, "artifacts", resolve("/work", "artifacts")],
    ["/work", "flagged", "artifacts", resolve("/work", "flagged")],
    ["/work", "dist", undefined, resolve("/work", "dist")],
    ["/work/pkgs/app", undefined, "artifacts", resolve("/work/pkgs/app", "artifacts")],
    ["/work/pkgs/app", undefined, absolute, absolute],
  ])("resolves cwd %s, flag %s, config %s to %s", (cwd, flag, configured, expected) => {
    expect(resolveOutputDir(cwd, flag, configured)).toBe(expected)
  })
})

describe("aburi scan — where it writes", () => {
  it.each<[string, string | undefined, string]>([
    ["where the config says, and nothing where it does not", undefined, "artifacts"],
    ["where the flag says, over the config", "dist", "dist"],
  ])("writes %s", async (_, outputDir, expected) => {
    await configuredWith("artifacts")
    await writeAlpha()

    const report = await runScan({
      cwd: workspace.root,
      format: "json",
      ...(outputDir === undefined ? {} : { outputDir }),
    })

    expect(report.irPath).toBe(under(expected, IR_JSON_FILENAME))
    for (const other of ["artifacts", "dist", DEFAULT_OUTPUT_DIRNAME].filter(
      (d) => d !== expected,
    )) {
      expect(await pathExists(under(other))).toBe(false)
    }
  })

  it("anchors the configured name to the working directory, not the workspace root", async () => {
    const app = await writeMonorepo(workspace.root)
    await configuredWith("artifacts")

    const report = await runScan({ cwd: app, format: "json" })

    expect(report.irPath).toBe(resolve(app, "artifacts", IR_JSON_FILENAME))
    expect(await pathExists(under("artifacts"))).toBe(false)
  })
})

describe("aburi diff — where it writes", () => {
  const EMPTY = documentWith({ symbols: [] })

  it("writes diff.json where the config says", async () => {
    await configuredWith("artifacts")
    const { base, head } = await writeIRs(workspace.root, EMPTY, EMPTY)

    const report = await runDiff({ cwd: workspace.root, base, head, warn: () => {} })

    expect(report.diffJsonPath).toBe(under("artifacts", DIFF_JSON_FILENAME))
    expect(await pathExists(under(DEFAULT_OUTPUT_DIRNAME))).toBe(false)
  })

  it("keeps a ref diff's per-side scans out of the configured directory", async () => {
    await initRepository(workspace.root)
    await configuredWith("artifacts")
    await writeAlpha()
    await workspace.writeSource(".gitignore", "artifacts/\n")
    await commitAll(workspace.root)

    const report = await runDiff({ cwd: workspace.root, refSpec: "main..HEAD", warn: () => {} })

    expect(report.diffJsonPath).toBe(under("artifacts", DIFF_JSON_FILENAME))
    expect(await pathExists(under("artifacts", IR_JSON_FILENAME))).toBe(false)
  })

  it("refuses an unusable config before it asks git anything", async () => {
    await writeBrokenConfig()
    const { runner, asked } = fakeGit()

    const error = await errorFrom(CliError, () =>
      runDiff({ cwd: workspace.root, refSpec: "main..HEAD", git: runner }),
    )

    expect(error.code).toBe("config-error")
    expect(asked).toEqual([])
  })

  it("refuses a config it cannot read rather than writing to the default", async () => {
    await writeBrokenConfig()
    const { base, head } = await writeIRs(workspace.root, EMPTY, EMPTY)

    const error = await errorFrom(CliError, () => runDiff({ cwd: workspace.root, base, head }))

    expect(error.code).toBe("config-error")
    expect(await pathExists(under(DEFAULT_OUTPUT_DIRNAME))).toBe(false)
  })

  it("does not read the config when the flag already answered", async () => {
    await writeBrokenConfig()
    const { base, head } = await writeIRs(workspace.root, EMPTY, EMPTY)

    const report = await runDiff({
      cwd: workspace.root,
      base,
      head,
      outputDir: "dist",
      warn: () => {},
    })

    expect(report.diffJsonPath).toBe(under("dist", DIFF_JSON_FILENAME))
  })

  it("places diff.json by the config --config names, not the discovered one", async () => {
    await configuredWith("discovered")
    await writeConfig(
      workspace.root,
      { ...TYPESCRIPT, output: { dir: "artifacts" } },
      "custom.json",
    )
    const { base, head } = await writeIRs(workspace.root, EMPTY, EMPTY)

    const report = await runDiff({
      cwd: workspace.root,
      base,
      head,
      configPath: "./custom.json",
      warn: () => {},
    })

    expect(report.diffJsonPath).toBe(under("artifacts", DIFF_JSON_FILENAME))
    expect(await pathExists(under("discovered"))).toBe(false)
  })
})

describe("aburi explain — where it reads", () => {
  it("reads the IR back out of the configured directory", async () => {
    await configuredWith("artifacts")
    await writeAlpha()
    await runScan({ cwd: workspace.root, format: "json" })

    const outcome = await runExplain({ cwd: workspace.root, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
  })

  it("rescans into the configured directory, and finds it there next time", async () => {
    await configuredWith("artifacts")
    await writeAlpha()

    const rescanned = await runExplain({ cwd: workspace.root, argument: "alpha" })

    expect(rescanned.exitCode).toBe(EXIT.SUCCESS)
    expect(await pathExists(under("artifacts", IR_JSON_FILENAME))).toBe(true)
    expect(await pathExists(under(DEFAULT_OUTPUT_DIRNAME))).toBe(false)
    const again = await runExplain({ cwd: workspace.root, argument: "alpha", noRescan: true })
    expect(again.exitCode).toBe(EXIT.SUCCESS)
  })

  it("uses the configured name at every rung of the walk, and says which document answered", async () => {
    const app = await writeMonorepo(workspace.root)
    await configuredWith("artifacts")
    await runScan({ cwd: workspace.root, format: "json" })
    const log = recordingLogger()

    const outcome = await runExplain({
      cwd: app,
      argument: "alpha",
      noRescan: true,
      warn: log.warn,
    })

    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
    expect(log.warnings).toEqual([
      `Answering from ${under("artifacts", IR_JSON_FILENAME)}; there is no IR under ${app}.`,
    ])
  })

  it("names the configured candidate when there is no IR", async () => {
    await configuredWith("artifacts")
    await writeAlpha()

    const error = await errorFrom(CliError, () =>
      runExplain({ cwd: workspace.root, argument: "alpha", noRescan: true }),
    )

    expect(error.message).toContain(under("artifacts", IR_JSON_FILENAME))
    expect(error.message).not.toContain(under(DEFAULT_OUTPUT_DIRNAME, IR_JSON_FILENAME))
  })

  it("searches an absolute configured directory once, and says so", async () => {
    const elsewhere = under("shared-artifacts")
    const app = await writeMonorepo(workspace.root)
    await configuredWith(elsewhere)

    const error = await errorFrom(CliError, () =>
      runExplain({ cwd: app, argument: "alpha", noRescan: true }),
    )

    expect(error.message).not.toContain("nor in any directory up to")
    expect(error.message.split(resolve(elsewhere, IR_JSON_FILENAME))).toHaveLength(2)
  })

  it("searches the directory the config --config names gives", async () => {
    await configuredWith("discovered")
    await writeConfig(
      workspace.root,
      { ...TYPESCRIPT, output: { dir: "artifacts" } },
      "custom.json",
    )
    await writeAlpha()

    const error = await errorFrom(CliError, () =>
      runExplain({
        cwd: workspace.root,
        argument: "alpha",
        noRescan: true,
        configPath: "./custom.json",
      }),
    )

    expect(error.message).toContain(under("artifacts", IR_JSON_FILENAME))
    expect(error.message).not.toContain(under("discovered"))
  })

  it("refuses a config it cannot read rather than answering from the wrong directory", async () => {
    await configuredWith(undefined)
    await writeAlpha()
    await runScan({ cwd: workspace.root, format: "json" })
    await writeBrokenConfig()

    const error = await errorFrom(CliError, () =>
      runExplain({ cwd: workspace.root, argument: "alpha", noRescan: true }),
    )

    expect(error.code).toBe("config-error")
  })

  it("does not read the config when --ir named the document", async () => {
    await configuredWith(undefined)
    await writeAlpha()
    await runScan({ cwd: workspace.root, format: "json" })
    await writeBrokenConfig()

    const outcome = await runExplain({
      cwd: workspace.root,
      argument: "alpha",
      irPath: `${DEFAULT_OUTPUT_DIRNAME}/${IR_JSON_FILENAME}`,
      noRescan: true,
    })

    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
  })
})
