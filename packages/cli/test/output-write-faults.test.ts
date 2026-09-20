import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { makeLanguageId } from "@aburi/core"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli } from "../src"
import { DIFF_JSON_FILENAME, WORKSPACE_MD_FILENAME } from "../src/artifact-paths"
import { MemStream } from "./fixtures"

/**
 * A write that fails used to surface as the errno alone — `EEXIST: file already exists,
 * mkdir '…/notadir'` — with nothing saying which command was running or which of its outputs
 * did not land. Every artefact `aburi scan` and `aburi diff` write now goes through one path
 * that names both, and the exit code follows who has to act (`cli-spec.md` §9): a path that
 * cannot hold the output is the caller's (2), a disk that refuses the bytes is the machine's (1).
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-write-faults-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function writeScanWorkspace(): Promise<void> {
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "write-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
    }),
    "utf8",
  )
  await mkdir(resolve(scratch, "src"), { recursive: true })
  await writeFile(resolve(scratch, "src/quiet.ts"), "// declares nothing\n", "utf8")
}

function emptyIR(): IR {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
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

/** Two IR files for a file-mode diff, so the only thing left to fail is the write. */
async function writeIRPair(): Promise<{ base: string; head: string }> {
  const base = resolve(scratch, "base.json")
  const head = resolve(scratch, "head.json")
  await writeFile(base, JSON.stringify(emptyIR()), "utf8")
  await writeFile(head, JSON.stringify(emptyIR()), "utf8")
  return { base, head }
}

async function run(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
  const stderr = new MemStream()
  const exitCode = await runCli({ argv, cwd: scratch, stdout: new MemStream(), stderr })
  return { exitCode, stderr: stderr.text() }
}

describe("aburi scan — an --output-dir that cannot hold the outputs", () => {
  it("names the command, the directory and the flag when a file stands where it would go", async () => {
    // The issue's own example: `--output-dir notadir` where `notadir` is a file, answered with
    // a bare `EEXIST … mkdir` and exit 1 before.
    await writeScanWorkspace()
    await writeFile(resolve(scratch, "notadir"), "not a directory\n", "utf8")

    const { exitCode, stderr } = await run(["scan", "--output-dir", "notadir"])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("aburi scan could not write the output directory")
    expect(stderr).toContain(resolve(scratch, "notadir"))
    expect(stderr).toContain("--output-dir")
    // The errno is kept, after the sentence that explains it, for whoever has to reproduce it.
    expect(stderr).toContain("EEXIST")
  })

  it("names the artefact when a directory already stands where one of them would go", async () => {
    await writeScanWorkspace()
    await mkdir(resolve(scratch, "out", WORKSPACE_MD_FILENAME), { recursive: true })

    const { exitCode, stderr } = await run(["scan"])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`aburi scan could not write ${WORKSPACE_MD_FILENAME} to `)
    expect(stderr).toContain(resolve(scratch, "out", WORKSPACE_MD_FILENAME))
    expect(stderr).toContain("--output-dir")
  })

  // A name longer than the filesystem allows fails the write for a reason that is not the
  // path's shape, on every POSIX filesystem and for root too — which a permission bit is not,
  // since root writes through it. Windows has its own limits and answers with other codes.
  it.skipIf(process.platform === "win32")(
    "reports any other refusal as the command's runtime failure, with the errno",
    async () => {
      await writeScanWorkspace()
      const tooLong = "x".repeat(300)

      const { exitCode, stderr } = await run(["scan", "--output-dir", tooLong])

      expect(exitCode).toBe(EXIT.RUNTIME)
      expect(stderr).toContain("aburi scan could not write the output directory to ")
      expect(stderr).toContain(resolve(scratch, tooLong))
      expect(stderr).toContain("ENAMETOOLONG")
      // Not the caller's: no flag to point elsewhere is offered for a fault in the machine.
      expect(stderr).not.toContain("Remove that file")
    },
  )
})

describe("aburi diff — an --output-dir that cannot hold the outputs", () => {
  it("names the command and the directory when a file stands where it would go", async () => {
    const { base, head } = await writeIRPair()
    await writeFile(resolve(scratch, "notadir"), "not a directory\n", "utf8")

    const { exitCode, stderr } = await run([
      "diff",
      "--base",
      base,
      "--head",
      head,
      "--output-dir",
      "notadir",
    ])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("aburi diff could not write the output directory to ")
    expect(stderr).toContain(resolve(scratch, "notadir"))
    expect(stderr).toContain("--output-dir")
  })

  it("names the artefact when a directory already stands where one of them would go", async () => {
    const { base, head } = await writeIRPair()
    await mkdir(resolve(scratch, "out", DIFF_JSON_FILENAME), { recursive: true })

    const { exitCode, stderr } = await run(["diff", "--base", base, "--head", head])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`aburi diff could not write ${DIFF_JSON_FILENAME} to `)
    expect(stderr).toContain(resolve(scratch, "out", DIFF_JSON_FILENAME))
  })
})
