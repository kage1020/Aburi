import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { detectWorkspaceRoot, makeLanguageId } from "@aburi/core"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runDiff, runExplain, runScan } from "../src"
import {
  DEFAULT_OUTPUT_DIRNAME,
  DIFF_JSON_FILENAME,
  IR_JSON_FILENAME,
  resolveOutputDir,
} from "../src/artifact-paths"
import { CliError } from "../src/errors"

/**
 * `config.output.dir` is the documented default for `--output-dir` in three places and had no
 * reader anywhere, so a workspace that set it got `out/` on every run — silently, because
 * writing to `out/` succeeds. These assert the precedence flag → config → `out`, and that every
 * command reading or writing the directory agrees on it: `aburi scan` writing there and
 * `aburi explain` looking somewhere else is the defect one directory name has already caused.
 */

let scratch = ""

/** Whether anything is at `path`. Used negatively: the setting is only observable as an absence. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  )
}

const CONFIG_SCHEMA = "https://aburi.dev/schema/aburi.config.v1.json"

async function writeConfig(directory: string, output: string | undefined): Promise<void> {
  await writeFile(
    resolve(directory, "aburi.json"),
    JSON.stringify({
      $schema: CONFIG_SCHEMA,
      languages: ["lang-typescript"],
      ...(output === undefined ? {} : { output: { dir: output } }),
    }),
    "utf8",
  )
}

async function writeSource(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await writeFile(resolve(directory, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
}

/**
 * A config the parser refuses. Truncated rather than merely odd: the config is JSONC, so a
 * trailing comma is legal and a comment is legal, and either would have let these tests pass
 * without anything having read the file.
 */
async function writeBrokenConfig(directory: string): Promise<void> {
  await writeFile(
    resolve(directory, "aburi.json"),
    '{ "languages": ["lang-typescript"], "output": { "dir": "artifacts"',
    "utf8",
  )
}

function emptyIR(): IR {
  return {
    $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: [makeLanguageId("ts")] },
    components: [],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

/** Two identical IR files, so `aburi diff` runs without git and writes its artefacts. */
async function writeIRPair(directory: string): Promise<{ base: string; head: string }> {
  const base = resolve(directory, "base.json")
  const head = resolve(directory, "head.json")
  await writeFile(base, JSON.stringify(emptyIR()), "utf8")
  await writeFile(head, JSON.stringify(emptyIR()), "utf8")
  return { base, head }
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-output-dir-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("resolveOutputDir", () => {
  it("falls through the flag to the configured name to the default", () => {
    expect(resolveOutputDir("/work", undefined, undefined)).toBe(resolve("/work", "out"))
    expect(resolveOutputDir("/work", undefined, "artifacts")).toBe(resolve("/work", "artifacts"))
    expect(resolveOutputDir("/work", "flagged", "artifacts")).toBe(resolve("/work", "flagged"))
  })

  it("resolves a configured name against the working directory, and leaves an absolute one", () => {
    const absolute = resolve("/elsewhere/artifacts")
    expect(resolveOutputDir("/work/pkgs/app", undefined, "artifacts")).toBe(
      resolve("/work/pkgs/app", "artifacts"),
    )
    expect(resolveOutputDir("/work/pkgs/app", undefined, absolute)).toBe(absolute)
  })

  it("still answers for the two-argument callers that predate the setting", () => {
    expect(resolveOutputDir("/work", undefined)).toBe(resolve("/work", DEFAULT_OUTPUT_DIRNAME))
    expect(resolveOutputDir("/work", "dist")).toBe(resolve("/work", "dist"))
  })
})

describe("aburi scan", () => {
  it("writes where the config says, and nothing where it does not", async () => {
    await writeConfig(scratch, "artifacts")
    await writeSource(scratch)

    const report = await runScan({ cwd: scratch, format: "json" })

    expect(report.irPath).toBe(resolve(scratch, "artifacts", IR_JSON_FILENAME))
    // The half that made the defect invisible: writing to `out/` succeeds, so the only way to
    // see the setting being honoured is that the default directory was not created.
    expect(await exists(resolve(scratch, DEFAULT_OUTPUT_DIRNAME))).toBe(false)
  })

  it("lets the flag win over the config", async () => {
    await writeConfig(scratch, "artifacts")
    await writeSource(scratch)

    const report = await runScan({ cwd: scratch, format: "json", outputDir: "dist" })

    expect(report.irPath).toBe(resolve(scratch, "dist", IR_JSON_FILENAME))
    expect(await exists(resolve(scratch, "artifacts"))).toBe(false)
  })

  it("anchors the configured name to the working directory, not the workspace root", async () => {
    // The root holds the config, the package is where the caller stands. A workspace-root
    // anchor would make the default (`out`, resolved against `cwd`) and a configured value
    // resolve against different directories — two rules for one slot.
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
    await writeFile(
      resolve(scratch, "package.json"),
      JSON.stringify({ name: "root", private: true }),
      "utf8",
    )
    await writeConfig(scratch, "artifacts")
    const app = resolve(scratch, "pkgs/app")
    await mkdir(app, { recursive: true })
    await writeFile(resolve(app, "package.json"), JSON.stringify({ name: "app" }), "utf8")
    await writeSource(app)
    expect(await detectWorkspaceRoot({ cwd: app })).toBe(scratch)

    const report = await runScan({ cwd: app, format: "json" })

    expect(report.irPath).toBe(resolve(app, "artifacts", IR_JSON_FILENAME))
    expect(await exists(resolve(scratch, "artifacts"))).toBe(false)
  })
})

describe("aburi diff", () => {
  it("writes diff.json where the config says", async () => {
    await writeConfig(scratch, "artifacts")
    const { base, head } = await writeIRPair(scratch)

    const report = await runDiff({ cwd: scratch, base, head, refSpec: null })

    expect(report.diffJsonPath).toBe(resolve(scratch, "artifacts", DIFF_JSON_FILENAME))
    expect(await exists(resolve(scratch, DEFAULT_OUTPUT_DIRNAME))).toBe(false)
  })

  it("does not read the config when the flag already answered", async () => {
    // A run that said where to write has no use for `output.dir`, so a config it never
    // consults must not be able to stop it.
    await writeBrokenConfig(scratch)
    const { base, head } = await writeIRPair(scratch)

    const report = await runDiff({ cwd: scratch, base, head, refSpec: null, outputDir: "dist" })

    expect(report.diffJsonPath).toBe(resolve(scratch, "dist", DIFF_JSON_FILENAME))
  })

  it("refuses a config it cannot read rather than writing to the default", async () => {
    await writeBrokenConfig(scratch)
    const { base, head } = await writeIRPair(scratch)

    const thrown = await runDiff({ cwd: scratch, base, head, refSpec: null }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
    expect(await exists(resolve(scratch, DEFAULT_OUTPUT_DIRNAME))).toBe(false)
  })
})

describe("aburi explain", () => {
  it("reads the IR back out of the configured directory", async () => {
    await writeConfig(scratch, "artifacts")
    await writeSource(scratch)
    await runScan({ cwd: scratch, format: "json" })

    const outcome = await runExplain({ cwd: scratch, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(0)
  })

  it("uses the configured name at every rung of the walk", async () => {
    // The scan happens at the root and the question is asked inside a package: the walk has to
    // spell `artifacts` at the ancestor too, not only under the caller.
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
    await writeFile(
      resolve(scratch, "package.json"),
      JSON.stringify({ name: "root", private: true }),
      "utf8",
    )
    await writeConfig(scratch, "artifacts")
    const app = resolve(scratch, "pkgs/app")
    await mkdir(app, { recursive: true })
    await writeFile(resolve(app, "package.json"), JSON.stringify({ name: "app" }), "utf8")
    await writeSource(app)
    await runScan({ cwd: scratch, format: "json" })

    const outcome = await runExplain({ cwd: app, argument: "alpha", noRescan: true })

    expect(outcome.exitCode).toBe(0)
  })

  it("names the configured candidate when there is no IR", async () => {
    await writeConfig(scratch, "artifacts")
    await writeSource(scratch)

    const thrown = await runExplain({ cwd: scratch, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    expect((thrown as Error).message).toContain(resolve(scratch, "artifacts", IR_JSON_FILENAME))
    expect((thrown as Error).message).not.toContain(
      resolve(scratch, DEFAULT_OUTPUT_DIRNAME, IR_JSON_FILENAME),
    )
  })

  it("searches an absolute configured directory once, and says so", async () => {
    // Every rung of the walk resolves an absolute value to the same place. Left undeduplicated
    // the list would hold that path once per ancestor, and the message would offer a range of
    // directories the lookup never visited.
    const elsewhere = resolve(scratch, "shared-artifacts")
    const app = resolve(scratch, "pkgs/app")
    await mkdir(app, { recursive: true })
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
    await writeFile(
      resolve(scratch, "package.json"),
      JSON.stringify({ name: "root", private: true }),
      "utf8",
    )
    await writeConfig(scratch, elsewhere)
    await writeSource(app)

    const thrown = await runExplain({ cwd: app, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    const message = (thrown as Error).message
    expect(message).toContain(resolve(elsewhere, IR_JSON_FILENAME))
    expect(message).not.toContain("nor in any directory up to")
    expect(message.split(resolve(elsewhere, IR_JSON_FILENAME)).length - 1).toBe(1)
  })

  it("refuses a config it cannot read rather than answering from the wrong directory", async () => {
    // The trap this replaces: a good IR sits in `out/`, the config that would have said
    // `artifacts` is unreadable, and falling back to the default would answer from a document
    // the workspace stopped writing.
    await writeConfig(scratch, undefined)
    await writeSource(scratch)
    await runScan({ cwd: scratch, format: "json" })
    await writeBrokenConfig(scratch)

    const thrown = await runExplain({ cwd: scratch, argument: "alpha", noRescan: true }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
  })

  it("does not read the config when --ir named the document", async () => {
    await writeConfig(scratch, undefined)
    await writeSource(scratch)
    await runScan({ cwd: scratch, format: "json" })
    await writeBrokenConfig(scratch)

    const outcome = await runExplain({
      cwd: scratch,
      argument: "alpha",
      irPath: `${DEFAULT_OUTPUT_DIRNAME}/${IR_JSON_FILENAME}`,
      noRescan: true,
    })

    expect(outcome.exitCode).toBe(0)
  })
})
