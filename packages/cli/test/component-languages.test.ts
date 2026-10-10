import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runScan } from "../src"
import { CliError } from "../src/errors"
import { STUB_PLUGIN } from "./stub-language"

let workRoot = ""

async function writeFileAt(rel: string, content = "x"): Promise<void> {
  const abs = resolve(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

async function writeLanguage(directory: string, extension: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await writeFileAt(join(directory, `f${index}${extension}`), "export const x = 1\n")
  }
}

async function scannedLanguages(config: Record<string, unknown>): Promise<readonly string[]> {
  await writeFile(
    resolve(workRoot, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...config,
    }),
    "utf8",
  )
  const report = await runScan({ cwd: workRoot, format: "json" })
  if (report.irPath === null) throw new Error("expected an IR")
  const ir = JSON.parse(await readFile(report.irPath, "utf8")) as IR
  expect(ir.components).toHaveLength(1)
  return ir.components[0]?.languages ?? []
}

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), "aburi-component-languages-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe("aburi scan hands the census its own drop decision", () => {
  it("does not label a component with a language only its git-ignored files are written in", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await scannedLanguages({})).toEqual(["ts"])
  })

  it("counts the git-ignored files again when the config turns the rule off", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await scannedLanguages({ respectGitignore: false })).toEqual(["py", "ts"])
  })

  it("does not label a component with a language only config.ignore's files are written in", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("fixtures", ".py")

    expect(await scannedLanguages({ ignore: ["fixtures/**"] })).toEqual(["ts"])
  })
})

const DROPPING_PLUGIN = STUB_PLUGIN.replace(
  '  fileExtensions: [".stub"],',
  '  fileExtensions: [".stub"],\n  fileDropPatterns: ["**/legacy/**"],',
)

describe("a language plugin's own drop globs reach the census", () => {
  it("does not count a directory only the plugin excludes", async () => {
    await writeFile(resolve(workRoot, "lang-stub.mjs"), DROPPING_PLUGIN, "utf8")
    await writeFileAt("package.json", JSON.stringify({ name: "fixture", private: true }))
    await writeFileAt(join("src", "a.stub"), "x")
    await writeLanguage("src", ".py")
    await writeLanguage("legacy", ".rs")

    expect(await scannedLanguages({ languages: ["./lang-stub.mjs"] })).toEqual(["py"])
  })
})

describe("what a failed component resolution exits with", () => {
  it("exits with a runtime failure when a rule file cannot be used", async () => {
    await writeLanguage("src", ".ts")
    await writeFileAt(".gitignore", `${"a".repeat(5_000)}\n`)

    const thrown = await scannedLanguages({}).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("runtime-error")
  })

  it("keeps the input error for a manifest that cannot be parsed", async () => {
    await writeLanguage("src", ".ts")
    await writeFileAt("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n')
    await writeFileAt("apps/billing/package.json", "{ broken")

    const thrown = await scannedLanguages({}).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
    expect((thrown as Error).message).toContain("package.json")
  })

  it("keeps the input error for a component root the Document cannot hold", async () => {
    await writeLanguage("src", ".ts")

    const thrown = await scannedLanguages({
      components: [{ id: "app", roots: ["../outside"] }],
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
  })
})
