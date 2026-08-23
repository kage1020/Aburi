import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runExplain, runScan } from "../src"
import { IR_JSON_FILENAME, resolveOutputDir } from "../src/artifact-paths"

/**
 * `aburi scan` writes its artefacts under the working directory; `aburi explain` looked for
 * them under the workspace root. Those are the same directory in a single-package repository
 * and in every flat fixture, which is why the split went unnoticed — a monorepo package is the
 * only place the two anchors come apart.
 *
 * `--no-rescan` is what these assert through. Without it a miss is silent: explain rescans and
 * answers correctly, so the only symptom is the time it took.
 */

/** `outer/` holds no marker; `outer/repo` is the workspace and `outer/repo/pkgs/app` a package. */
let outer = ""
let mono = ""
let app = ""

/** `mono/` is the workspace root (pnpm marker); `mono/pkgs/app` is a package inside it. */
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
  // At the root, so a scan started from either directory finds it: config discovery walks up
  // from `cwd`, and one of these tests scans from `mono` itself.
  await writeFile(
    resolve(mono, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
    }),
    "utf8",
  )

  // The two anchors have to actually differ, or these tests pass under the defect. An ancestor
  // marker outside the temp directory would make the detected root something else again.
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
    // The other direction, and the one anchoring to `cwd` alone would have broken: scanning at
    // the root and asking from inside a package is the ordinary way to use this. Both
    // documents describe the whole workspace, because a scan does — wherever it was started.
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
    // Distinguishable only by content: the two files are otherwise the same document.
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

    // The nearest candidate is where a scan run here would have put it, which is the one the
    // reader acts on. The old message named the workspace root's path and nothing else.
    expect((thrown as Error).message).toContain(resolve(app, "out", IR_JSON_FILENAME))
    expect((thrown as Error).message).not.toContain(resolve(mono, "out", IR_JSON_FILENAME))
    // Not `toContain(mono)`, which every candidate path already satisfies as a prefix.
    expect((thrown as Error).message).toContain(`nor in any directory up to ${mono}`)
  })

  it("does not claim to have searched upward when there was nowhere to search", async () => {
    // From the workspace root the walk has one candidate, and a message offering a range it
    // never covered would be a confident overstatement about where it looked.
    await makeMonorepo()

    const thrown = await runExplain({ cwd: mono, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toContain(resolve(mono, "out", IR_JSON_FILENAME))
    expect((thrown as Error).message).not.toContain("nor in any directory up to")
  })

  it("stops at the workspace root rather than reading an IR from outside it", async () => {
    // An `out/` above the workspace holds a document about a different tree. Config discovery
    // deliberately walks past the root — a config may be shared across repositories — and this
    // deliberately does not.
    await makeMonorepo()
    await runScan({ cwd: mono, format: "json" })
    // Move the only IR in the ancestry to a directory above the workspace root.
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
    // The middle of the walk. With only the two endpoints exercised, an implementation that
    // checked `cwd` and the root and nothing between would pass every other test here.
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
    // The lookup can now reach any ancestor, and the answer carries no trace of where it came
    // from: `ir.workspace.root` is `"."` in every document by schema, so the file's location is
    // the only signal there is.
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
    // The visible half of the fix. An on-disk IR is the answer everywhere else in the CLI and
    // `aburi scan` is how it is refreshed; before this, explain in a package directory missed
    // the file and rescanned, so it happened to see edits no document had recorded.
    await makeMonorepo()
    await runScan({ cwd: app, format: "json" })
    await writeFile(resolve(app, "src/a.ts"), "export function beta() { return 2 }\n", "utf8")

    const stale = await runExplain({ cwd: app, argument: "alpha" })
    const absent = await runExplain({ cwd: app, argument: "beta" })

    expect(stale.exitCode).toBe(0)
    expect(absent.exitCode).not.toBe(0)
  })
})

describe("resolveOutputDir", () => {
  it("anchors the default and an explicit relative path to the working directory", () => {
    expect(resolveOutputDir("/work/pkgs/app", undefined)).toBe(resolve("/work/pkgs/app", "out"))
    expect(resolveOutputDir("/work/pkgs/app", "artifacts")).toBe(
      resolve("/work/pkgs/app", "artifacts"),
    )
  })

  it("leaves an absolute path alone", () => {
    const absolute = resolve("/elsewhere/artifacts")
    expect(resolveOutputDir("/work/pkgs/app", absolute)).toBe(absolute)
  })
})
