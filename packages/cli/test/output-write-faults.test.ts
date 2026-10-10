import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli, runScan } from "../src"
import {
  COMPONENTS_DIRNAME,
  DIFF_FULL_MD_FILENAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  IR_JSON_FILENAME,
  WORKSPACE_MD_FILENAME,
} from "../src/artifact-paths"
import { CliError } from "../src/errors"
import { emptyIR, MemStream, writeTypeScriptWorkspace } from "./fixtures"

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-write-faults-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

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

const onPosixAsAUser = it.skipIf(process.platform === "win32" || process.getuid?.() === 0)

describe("aburi scan with an --output-dir that cannot hold the outputs", () => {
  it("names the command, the directory and the flag when a file stands where it would go", async () => {
    await writeTypeScriptWorkspace(scratch, "write-fixture")
    await writeFile(resolve(scratch, "notadir"), "not a directory\n", "utf8")

    const { exitCode, stderr } = await run(["scan", "--output-dir", "notadir"])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi scan could not write the output directory to ${resolve(scratch, "notadir")}`,
    )
    expect(stderr).toContain("--output-dir")
    expect(stderr).toContain("EEXIST")
  })

  it("refuses the directory before it scans anything", async () => {
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({ languages: ["lang-typescript"] }),
      "utf8",
    )
    await writeFile(resolve(scratch, "notadir"), "not a directory\n", "utf8")

    const { exitCode, stderr } = await run(["scan", "--output-dir", "notadir"])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("could not write the output directory")
  })

  it("names the workspace Markdown when a directory stands where it would go", async () => {
    await writeTypeScriptWorkspace(scratch, "write-fixture")
    await mkdir(resolve(scratch, "out", WORKSPACE_MD_FILENAME), { recursive: true })

    const { exitCode, stderr } = await run(["scan", "--format", "md"])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi scan could not write the workspace Markdown to ${resolve(scratch, "out", WORKSPACE_MD_FILENAME)}`,
    )
    expect(stderr).toContain("--output-dir")
  })

  it("names the component whose Markdown could not be written", async () => {
    await writeTypeScriptWorkspace(scratch, "write-fixture")
    const clean = await runScan({ cwd: scratch, format: "md" })
    const [componentMd] = clean.componentMdPaths
    if (componentMd === undefined) throw new Error("the clean scan wrote no component Markdown")
    expect(componentMd).toContain(resolve(scratch, "out", COMPONENTS_DIRNAME))
    await rm(componentMd)
    await mkdir(componentMd)

    const { exitCode, stderr } = await run(["scan", "--format", "md"])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`aburi scan could not write the Markdown for component "`)
    expect(stderr).toContain(`" to ${componentMd}`)
  })
})

describe("aburi scan into a place the machine refuses", () => {
  onPosixAsAUser("names the IR when the directory may not be written to", async () => {
    await writeTypeScriptWorkspace(scratch, "write-fixture")
    const locked = resolve(scratch, "locked")
    await mkdir(locked)
    await chmod(locked, 0o500)

    const { exitCode, stderr } = await run(["scan", "--format", "json", "--output-dir", "locked"])

    await chmod(locked, 0o700)

    expect(exitCode).toBe(EXIT.RUNTIME)
    expect(stderr).toContain(
      `aburi scan could not write the IR to ${resolve(locked, IR_JSON_FILENAME)}`,
    )
    expect(stderr).toContain("EACCES")
    expect(stderr).not.toContain("--output-dir")
  })

  it.skipIf(process.platform === "win32")(
    "reports any other refusal as the command's runtime failure, with the errno",
    async () => {
      await writeTypeScriptWorkspace(scratch, "write-fixture")
      const tooLong = "x".repeat(300)

      const { exitCode, stderr } = await run(["scan", "--output-dir", tooLong])

      expect(exitCode).toBe(EXIT.RUNTIME)
      expect(stderr).toContain(
        `aburi scan could not write the output directory to ${resolve(scratch, tooLong)}`,
      )
      expect(stderr).toContain("ENAMETOOLONG")
      expect(stderr).not.toContain("Remove that file")
    },
  )
})

describe("aburi diff with an --output-dir that cannot hold the outputs", () => {
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
    expect(stderr).toContain(
      `aburi diff could not write the output directory to ${resolve(scratch, "notadir")}`,
    )
    expect(stderr).toContain("--output-dir")
  })

  it("names the diff JSON when a directory stands where it would go", async () => {
    // The removal, not the write, is what meets the directory: it runs before either IR is read.
    const { base, head } = await writeIRPair()
    await mkdir(resolve(scratch, "out", DIFF_JSON_FILENAME), { recursive: true })

    const { exitCode, stderr } = await run(["diff", "--base", base, "--head", head])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi diff could not remove the diff JSON at ${resolve(scratch, "out", DIFF_JSON_FILENAME)}`,
    )
    expect(stderr).toContain("--output-dir")
  })

  it("names the diff Markdown when that is the artefact in the way", async () => {
    const { base, head } = await writeIRPair()
    await mkdir(resolve(scratch, "out", DIFF_MD_FILENAME), { recursive: true })

    const { exitCode, stderr } = await run([
      "diff",
      "--base",
      base,
      "--head",
      head,
      "--format",
      "json",
    ])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi diff could not remove the diff Markdown at ${resolve(scratch, "out", DIFF_MD_FILENAME)}`,
    )
  })

  it("names the uncapped report an earlier run left when it cannot be removed", async () => {
    const { base, head } = await writeIRPair()
    await mkdir(resolve(scratch, "out", DIFF_FULL_MD_FILENAME), { recursive: true })

    const { exitCode, stderr } = await run(["diff", "--base", base, "--head", head])

    expect(exitCode).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi diff could not remove the uncapped diff Markdown at ${resolve(scratch, "out", DIFF_FULL_MD_FILENAME)}`,
    )
    expect(stderr).toContain("--output-dir")
  })

  it("is refused before either IR is read", async () => {
    await writeFile(resolve(scratch, "notadir"), "not a directory\n", "utf8")

    const thrown = await run([
      "diff",
      "--base",
      resolve(scratch, "absent.json"),
      "--head",
      resolve(scratch, "absent.json"),
      "--output-dir",
      "notadir",
    ])

    expect(thrown.exitCode).toBe(EXIT.INPUT_ERROR)
    expect(thrown.stderr).toContain("could not write the output directory")
  })

  it("still refuses a malformed invocation with nothing created for it", async () => {
    const thrown = await runCli({
      argv: ["diff", "--base", resolve(scratch, "base.json")],
      cwd: scratch,
      stdout: new MemStream(),
      stderr: new MemStream(),
    })
    expect(thrown).toBe(EXIT.INPUT_ERROR)
    await expect(mkdir(resolve(scratch, "out"))).resolves.toBeUndefined()
  })
})

describe("the error a write failure throws", () => {
  it("carries the failure it wraps as its cause", async () => {
    await writeTypeScriptWorkspace(scratch, "write-fixture")
    await writeFile(resolve(scratch, "notadir"), "not a directory\n", "utf8")

    const thrown = await runScan({ cwd: scratch, format: "json", outputDir: "notadir" }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).cause).toMatchObject({ code: "EEXIST" })
  })
})
