import { chmod, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  CliError,
  COMPONENTS_DIRNAME,
  DIFF_FULL_MD_FILENAME,
  DIFF_JSON_FILENAME,
  DIFF_MD_FILENAME,
  EXIT,
  IR_JSON_FILENAME,
  runScan,
  WORKSPACE_MD_FILENAME,
} from "../src"
import { pathExists } from "../src/fs-probe"
import { documentWith } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writeIRs, writeTypeScriptWorkspace } from "./workspace"

const workspace = useScratchWorkspace("write-faults")

const under = (...segments: string[]) => resolve(workspace.root, ...segments)
const run = (...argv: string[]) => runCliIn(workspace.root, argv)

async function documents(): Promise<string[]> {
  const empty = documentWith({ symbols: [] })
  const { base, head } = await writeIRs(workspace.root, empty, empty)
  return ["--base", base, "--head", head]
}

const onPosixAsAUser = it.skipIf(process.platform === "win32" || process.getuid?.() === 0)

describe("aburi scan with an --output-dir that cannot hold the outputs", () => {
  it("names the command, the directory and the flag when a file stands where it would go", async () => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    await workspace.writeSource("notadir", "not a directory\n")

    const { code, stderr } = await run("scan", "--output-dir", "notadir")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi scan could not write the output directory to ${under("notadir")}`,
    )
    expect(stderr).toContain("--output-dir")
    expect(stderr).toContain("EEXIST")
  })

  it("refuses the directory before it reads the workspace", async () => {
    await writeConfig(workspace.root, TYPESCRIPT)
    await workspace.writeSource("notadir", "not a directory\n")

    const { code, stderr } = await run("scan", "--output-dir", "notadir")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("could not write the output directory")
  })

  it("carries the failure it wraps as its cause", async () => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    await workspace.writeSource("notadir", "not a directory\n")

    const error = await errorFrom(CliError, () =>
      runScan({ cwd: workspace.root, format: "json", outputDir: "notadir" }),
    )

    expect(error.cause).toMatchObject({ code: "EEXIST" })
  })

  it("names the workspace Markdown when a directory stands where it would go", async () => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    await mkdir(under("out", WORKSPACE_MD_FILENAME), { recursive: true })

    const { code, stderr } = await run("scan", "--format", "md")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi scan could not write the workspace Markdown to ${under("out", WORKSPACE_MD_FILENAME)}`,
    )
    expect(stderr).toContain("--output-dir")
  })

  it.each([
    ["the IR", "md", IR_JSON_FILENAME],
    ["the workspace Markdown", "json", WORKSPACE_MD_FILENAME],
  ])("names %s, which --format %s does not write, when a directory stands in its place", async (artefact, format, filename) => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    await mkdir(under("out", filename), { recursive: true })

    const { code, stderr } = await run("scan", "--format", format)

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`aburi scan could not remove ${artefact} at ${under("out", filename)}`)
    expect(stderr).toContain("a directory stands where an earlier run's file would be")
    expect(stderr).toContain("--output-dir")
  })

  it("keeps the IR an earlier run wrote when --format md stops at a page it cannot write", async () => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    expect((await run("scan", "--format", "json")).code).toBe(EXIT.SUCCESS)
    const earlier = await readFile(under("out", IR_JSON_FILENAME), "utf8")
    await mkdir(under("out", WORKSPACE_MD_FILENAME))

    const { code } = await run("scan", "--format", "md")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(await readFile(under("out", IR_JSON_FILENAME), "utf8")).toBe(earlier)
  })

  it("names the component whose Markdown could not be written", async () => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    const componentMd = under("out", COMPONENTS_DIRNAME, "write-fixture.md")
    await mkdir(componentMd, { recursive: true })

    const { code, stderr } = await run("scan", "--format", "md")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi scan could not write the Markdown for component "write-fixture" to ${componentMd}`,
    )
  })
})

describe("aburi scan into a place the machine refuses", () => {
  onPosixAsAUser("names the IR when the directory may not be written to", async () => {
    await writeTypeScriptWorkspace(workspace.root, "write-fixture")
    const locked = under("locked")
    await mkdir(locked)
    await chmod(locked, 0o500)

    const { code, stderr } = await run(
      "scan",
      "--format",
      "json",
      "--output-dir",
      "locked",
    ).finally(() => chmod(locked, 0o700))

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain(
      `aburi scan could not write the IR to ${resolve(locked, IR_JSON_FILENAME)}`,
    )
    expect(stderr).toContain("EACCES")
    expect(stderr).not.toContain("--output-dir")
  })

  onPosixAsAUser.each([
    [
      "a page it may not remove",
      0o500,
      ["--format", "json"],
      'remove the Markdown for component "write-fixture"',
      "write-fixture.md",
    ],
    ["a components directory it may not list", 0o300, [], "list the components directory", "."],
  ])(
    "reports %s as a runtime failure naming the step and the path",
    async (_, mode, flags, failed, name) => {
      await writeTypeScriptWorkspace(workspace.root, "write-fixture")
      expect((await run("scan")).code).toBe(EXIT.SUCCESS)
      const components = under("out", COMPONENTS_DIRNAME)
      await chmod(components, mode)

      const { code, stderr } = await run("scan", ...flags).finally(() => chmod(components, 0o700))

      expect(code).toBe(EXIT.RUNTIME)
      expect(stderr).toContain(`aburi scan could not ${failed} at ${resolve(components, name)}`)
      expect(stderr).toContain("EACCES")
    },
  )

  onPosixAsAUser(
    "reports a page it may not read as a runtime failure naming the step and the path",
    async () => {
      await writeTypeScriptWorkspace(workspace.root, "write-fixture")
      const stale = under("out", COMPONENTS_DIRNAME, "stale.md")
      await workspace.writeSource(`out/${COMPONENTS_DIRNAME}/stale.md`, "# Component: stale\n")
      await chmod(stale, 0o200)

      const { code, stderr } = await run("scan")

      expect(code).toBe(EXIT.RUNTIME)
      expect(stderr).toContain(
        `aburi scan could not read the Markdown for component "stale" at ${stale}`,
      )
      expect(stderr).toContain("EACCES")
    },
  )

  it.skipIf(process.platform === "win32")(
    "reports any other refusal as the command's runtime failure, with the errno",
    async () => {
      await writeTypeScriptWorkspace(workspace.root, "write-fixture")
      const tooLong = "x".repeat(300)

      const { code, stderr } = await run("scan", "--output-dir", tooLong)

      expect(code).toBe(EXIT.RUNTIME)
      expect(stderr).toContain(
        `aburi scan could not write the output directory to ${under(tooLong)}`,
      )
      expect(stderr).toContain("ENAMETOOLONG")
      expect(stderr).not.toContain("Remove that file")
    },
  )
})

describe("aburi diff with an --output-dir that cannot hold the outputs", () => {
  it("names the command, the directory and the flag when a file stands where it would go", async () => {
    await workspace.writeSource("notadir", "not a directory\n")

    const { code, stderr } = await run("diff", ...(await documents()), "--output-dir", "notadir")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(
      `aburi diff could not write the output directory to ${under("notadir")}`,
    )
    expect(stderr).toContain("--output-dir")
  })

  it("refuses the directory before it reads either IR", async () => {
    await workspace.writeSource("notadir", "not a directory\n")
    const absent = under("absent.json")

    const { code, stderr } = await run(
      "diff",
      "--base",
      absent,
      "--head",
      absent,
      "--output-dir",
      "notadir",
    )

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("could not write the output directory")
  })

  it.each([
    ["the diff JSON", DIFF_JSON_FILENAME, []],
    ["the diff Markdown", DIFF_MD_FILENAME, ["--format", "json"]],
    ["the uncapped diff Markdown", DIFF_FULL_MD_FILENAME, []],
  ])("names %s an earlier run left when a directory stands in its place", async (artefact, filename, flags) => {
    await mkdir(under("out", filename), { recursive: true })

    const { code, stderr } = await run("diff", ...(await documents()), ...flags)

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(`aburi diff could not remove ${artefact} at ${under("out", filename)}`)
    expect(stderr).toContain("a directory stands where an earlier run's file would be")
    expect(stderr).toContain("--output-dir")
  })

  it("refuses a malformed invocation with nothing created for it", async () => {
    const { code } = await run("diff", "--base", under("base.json"))

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(await pathExists(under("out"))).toBe(false)
  })
})
