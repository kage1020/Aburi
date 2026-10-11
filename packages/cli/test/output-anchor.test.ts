import { cp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, EXIT, IR_JSON_FILENAME, runExplain, runScan } from "../src"
import { TYPESCRIPT, writeConfig, writeFileAt, writeMonorepo } from "./workspace"

const workspace = useScratchWorkspace("output-anchor")

/** `writeMonorepo` one level down, so the directory above the workspace root is the scratch root. */
async function monorepo(): Promise<{ mono: string; app: string }> {
  const mono = resolve(workspace.root, "repo")
  const app = await writeMonorepo(mono)
  await writeConfig(mono, TYPESCRIPT)
  return { mono, app }
}

const irUnder = (directory: string) => resolve(directory, "out", IR_JSON_FILENAME)

function explainAlpha(cwd: string) {
  const log = recordingLogger()
  return runExplain({ cwd, argument: "alpha", noRescan: true, warn: log.warn }).then((outcome) => ({
    outcome,
    said: log.warnings,
  }))
}

describe("aburi explain — finding the IR aburi scan wrote", () => {
  it("finds the IR a scan in the same package directory wrote, and says nothing about it", async () => {
    const { app } = await monorepo()
    const report = await runScan({ cwd: app, format: "json" })
    expect(report.irPath).toBe(irUnder(app))

    const { outcome, said } = await explainAlpha(app)

    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
    expect(said).toEqual([])
  })

  it("finds an IR a scan at the workspace root wrote, and says which document answered", async () => {
    const { mono, app } = await monorepo()
    await runScan({ cwd: mono, format: "json" })

    const { outcome, said } = await explainAlpha(app)

    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
    expect(said).toEqual([`Answering from ${irUnder(mono)}; there is no IR under ${resolve(app)}.`])
  })

  it("searches the directories between the working directory and the root", async () => {
    const { mono } = await monorepo()
    const group = resolve(mono, "pkgs")
    const deep = resolve(group, "app/nested")
    await writeFileAt(deep, "src/b.ts", "export function gamma() { return 3 }\n")
    expect((await runScan({ cwd: group, format: "json" })).irPath).toBe(irUnder(group))

    expect((await explainAlpha(deep)).outcome.exitCode).toBe(EXIT.SUCCESS)
  })

  it("prefers the nearest IR when both directories hold one", async () => {
    const { mono, app } = await monorepo()
    await runScan({ cwd: mono, format: "json" })
    await runScan({ cwd: app, format: "json" })
    const rootIR = JSON.parse(await readFile(irUnder(mono), "utf8")) as Record<string, unknown>
    await writeFile(irUnder(mono), JSON.stringify({ ...rootIR, symbols: [] }), "utf8")

    expect((await explainAlpha(app)).outcome.exitCode).toBe(EXIT.SUCCESS)
  })

  it("stops at the workspace root rather than reading an IR from outside it", async () => {
    const { mono, app } = await monorepo()
    await runScan({ cwd: mono, format: "json" })
    await cp(resolve(mono, "out"), resolve(workspace.root, "out"), { recursive: true })
    await rm(resolve(mono, "out"), { recursive: true })

    const error = await errorFrom(CliError, () => explainAlpha(app))

    expect(error.message).toContain("No IR file at")
  })

  it("still resolves --ir against the working directory", async () => {
    const { app } = await monorepo()
    await runScan({ cwd: app, format: "json" })

    const outcome = await runExplain({
      cwd: app,
      argument: "alpha",
      irPath: `out/${IR_JSON_FILENAME}`,
      noRescan: true,
    })

    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
  })

  it("reads the written IR rather than rescanning, so an edit since the scan is not seen", async () => {
    const { app } = await monorepo()
    await runScan({ cwd: app, format: "json" })
    await writeFileAt(app, "src/a.ts", "export function beta() { return 2 }\n")

    expect((await runExplain({ cwd: app, argument: "alpha" })).exitCode).toBe(EXIT.SUCCESS)
    expect((await runExplain({ cwd: app, argument: "beta" })).exitCode).not.toBe(EXIT.SUCCESS)
  })
})

describe("aburi explain — no IR to find", () => {
  it("names the nearest path, and the root it searched up to", async () => {
    const { mono, app } = await monorepo()

    const error = await errorFrom(CliError, () => explainAlpha(app))

    expect(error.message).toContain(irUnder(app))
    expect(error.message).not.toContain(irUnder(mono))
    expect(error.message).toContain(`nor in any directory up to ${mono}`)
  })

  it("does not claim to have searched upward when there was nowhere to search", async () => {
    const { mono } = await monorepo()

    const error = await errorFrom(CliError, () => explainAlpha(mono))

    expect(error.message).toContain(irUnder(mono))
    expect(error.message).not.toContain("nor in any directory up to")
  })
})
