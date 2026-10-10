import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runExplain, runScan } from "../src"
import { IR_JSON_FILENAME } from "../src/artifact-paths"

let outer = ""
let mono = ""
let app = ""

async function makeMonorepo(): Promise<void> {
  await writeFile(resolve(mono, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
  await writeFile(
    resolve(mono, "package.json"),
    JSON.stringify({ name: "root", private: true }),
    "utf8",
  )
  app = resolve(mono, "pkgs/app")
  await mkdir(resolve(app, "src"), { recursive: true })
  await writeFile(resolve(app, "package.json"), JSON.stringify({ name: "app" }), "utf8")
  await writeFile(resolve(app, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
  await writeFile(
    resolve(mono, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
    }),
    "utf8",
  )

  expect(await detectWorkspaceRoot({ cwd: app })).toBe(mono)
  expect(resolve(app)).not.toBe(mono)
}

async function readIrAt(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

beforeEach(async () => {
  outer = await mkdtemp(resolve(tmpdir(), "aburi-output-anchor-"))
  mono = resolve(outer, "repo")
  await mkdir(mono, { recursive: true })
})

afterEach(async () => {
  await rm(outer, { recursive: true, force: true })
})

describe("the directory scan writes to is the directory explain reads from", () => {
  it("finds the IR a scan in the same package directory wrote", async () => {
    await makeMonorepo()
    const report = await runScan({ cwd: app, format: "json" })
    expect(report.irPath).toBe(resolve(app, "out", IR_JSON_FILENAME))

    const outcome = await runExplain({ cwd: app, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(0)
  })

  it("still finds an IR a scan at the workspace root wrote", async () => {
    await makeMonorepo()
    const report = await runScan({ cwd: mono, format: "json" })
    expect(report.irPath).toBe(resolve(mono, "out", IR_JSON_FILENAME))

    const outcome = await runExplain({ cwd: app, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(0)
  })

  it("prefers the nearest IR when both directories hold one", async () => {
    await makeMonorepo()
    await runScan({ cwd: mono, format: "json" })
    await runScan({ cwd: app, format: "json" })
    await writeFile(
      resolve(mono, "out", IR_JSON_FILENAME),
      JSON.stringify({ ...(await readIrAt(resolve(mono, "out", IR_JSON_FILENAME))), symbols: [] }),
      "utf8",
    )

    const outcome = await runExplain({ cwd: app, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(0)
  })

  it("names the nearest path, and the root it searched up to, when there is no IR", async () => {
    await makeMonorepo()

    const thrown = await runExplain({ cwd: app, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toContain(resolve(app, "out", IR_JSON_FILENAME))
    expect((thrown as Error).message).not.toContain(resolve(mono, "out", IR_JSON_FILENAME))
    expect((thrown as Error).message).toContain(`nor in any directory up to ${mono}`)
  })

  it("does not claim to have searched upward when there was nowhere to search", async () => {
    await makeMonorepo()

    const thrown = await runExplain({ cwd: mono, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toContain(resolve(mono, "out", IR_JSON_FILENAME))
    expect((thrown as Error).message).not.toContain("nor in any directory up to")
  })

  it("stops at the workspace root rather than reading an IR from outside it", async () => {
    await makeMonorepo()
    await runScan({ cwd: mono, format: "json" })
    await mkdir(resolve(outer, "out"), { recursive: true })
    await writeFile(
      resolve(outer, "out", IR_JSON_FILENAME),
      await readFile(resolve(mono, "out", IR_JSON_FILENAME), "utf8"),
      "utf8",
    )
    await rm(resolve(mono, "out"), { recursive: true, force: true })

    const thrown = await runExplain({ cwd: app, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toContain("No IR file at")
  })

  it("searches the directories between the working directory and the root", async () => {
    await makeMonorepo()
    const group = resolve(mono, "pkgs")
    const deep = resolve(group, "app/nested")
    await mkdir(resolve(deep, "src"), { recursive: true })
    await writeFile(resolve(deep, "src/b.ts"), "export function gamma() { return 3 }\n", "utf8")

    const report = await runScan({ cwd: group, format: "json" })
    expect(report.irPath).toBe(resolve(group, "out", IR_JSON_FILENAME))

    const outcome = await runExplain({ cwd: deep, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(0)
  })

  it("says which document answered when it was not the one under the caller", async () => {
    await makeMonorepo()
    await runScan({ cwd: mono, format: "json" })
    const said: string[] = []

    await runExplain({
      cwd: app,
      argument: "alpha",
      noRescan: true,
      warn: (message) => said.push(message),
    })

    expect(said).toEqual([
      `Answering from ${resolve(mono, "out", IR_JSON_FILENAME)}; there is no IR under ${resolve(app)}.`,
    ])
  })

  it("says nothing when the document under the caller answered", async () => {
    await makeMonorepo()
    await runScan({ cwd: app, format: "json" })
    const said: string[] = []

    await runExplain({
      cwd: app,
      argument: "alpha",
      noRescan: true,
      warn: (message) => said.push(message),
    })

    expect(said).toEqual([])
  })

  it("still resolves --ir against the working directory", async () => {
    await makeMonorepo()
    await runScan({ cwd: app, format: "json" })

    const outcome = await runExplain({
      cwd: app,
      argument: "alpha",
      irPath: `out/${IR_JSON_FILENAME}`,
      noRescan: true,
    })

    expect(outcome.exitCode).toBe(0)
  })

  it("reads the written IR rather than rescanning, so an edit since the scan is not seen", async () => {
    await makeMonorepo()
    await runScan({ cwd: app, format: "json" })
    await writeFile(resolve(app, "src/a.ts"), "export function beta() { return 2 }\n", "utf8")

    const stale = await runExplain({ cwd: app, argument: "alpha" })
    const absent = await runExplain({ cwd: app, argument: "beta" })

    expect(stale.exitCode).toBe(0)
    expect(absent.exitCode).not.toBe(0)
  })
})
