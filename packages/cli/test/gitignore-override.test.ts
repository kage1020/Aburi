import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli, runScan } from "../src"

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

/**
 * `--no-respect-gitignore` is an override, and an override that was not typed has to leave the
 * config alone.
 *
 * The flag is declared negatable, so commander materialised `true` for it on every run that
 * did not pass it — indistinguishable, at the option object, from a run that asked for `true`.
 * The CLI then forwarded that `true` into `mergeCliOverrides`, which wrote it over
 * `config.respectGitignore`. A workspace whose config turned `.gitignore` off got it back on,
 * and only through the CLI: `runScan` called directly, and the rescan `aburi diff` performs,
 * both read the config and saw the opposite file set.
 *
 * The fixture is the smallest workspace where the two answers differ: one file `.gitignore`
 * excludes, one it does not, and a Symbol in each so presence is readable from the IR rather
 * than from a count.
 */

let scratch = ""

const IGNORED_SYMBOL = "ts:src/gen.ts#generated"
const KEPT_SYMBOL = "ts:src/a.ts#alpha"

async function writeConfig(respectGitignore?: boolean): Promise<void> {
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...(respectGitignore === undefined ? {} : { respectGitignore }),
    }),
    "utf8",
  )
}

/** The Symbol ids in the IR the CLI wrote, sorted. */
async function symbolsFromCli(argv: readonly string[]): Promise<string[]> {
  const outputDir = resolve(scratch, "out")
  await rm(outputDir, { recursive: true, force: true })
  const stdout = new MemStream()
  const stderr = new MemStream()
  const code = await runCli({
    argv: ["scan", "--output-dir", outputDir, "--format", "json", ...argv],
    stdout,
    stderr,
    env: {},
    cwd: scratch,
  })
  expect(code, stderr.text()).toBe(0)
  const ir = JSON.parse(await readFile(resolve(outputDir, "aburi.ir.json"), "utf8")) as {
    symbols: { id: string }[]
  }
  return ir.symbols.map((s) => s.id).sort()
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-gitignore-override-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "gitignore-fixture", private: true }),
    "utf8",
  )
  await writeFile(resolve(scratch, ".gitignore"), "src/gen.ts\n", "utf8")
  await mkdir(resolve(scratch, "src"), { recursive: true })
  await writeFile(resolve(scratch, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
  await writeFile(
    resolve(scratch, "src/gen.ts"),
    "export function generated() { return 2 }\n",
    "utf8",
  )
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi scan — respectGitignore", () => {
  it("leaves a config that turned .gitignore off turned off", async () => {
    // The defect. Nothing on the command line mentioned `.gitignore`, and the file the config
    // asked for came back missing.
    await writeConfig(false)

    expect(await symbolsFromCli([])).toEqual([KEPT_SYMBOL, IGNORED_SYMBOL].sort())
  })

  it("honours .gitignore when the config does not say otherwise", async () => {
    // The schema default, and the behaviour every run without a config has. A fix that made
    // the flag an override must not have made the absence of one mean `false`.
    await writeConfig()

    expect(await symbolsFromCli([])).toEqual([KEPT_SYMBOL])
  })

  it("--no-respect-gitignore overrides a config that says true", async () => {
    await writeConfig(true)

    expect(await symbolsFromCli(["--no-respect-gitignore"])).toEqual(
      [KEPT_SYMBOL, IGNORED_SYMBOL].sort(),
    )
  })

  it("--respect-gitignore overrides a config that says false", async () => {
    // The direction that had no spelling at all: with `respectGitignore: false` in the config
    // there was no way to ask for one run that honoured `.gitignore`.
    await writeConfig(false)

    expect(await symbolsFromCli(["--respect-gitignore"])).toEqual([KEPT_SYMBOL])
  })
})

describe("the CLI and a direct call see the same workspace", () => {
  it("agrees with runScan about which files the config excluded", async () => {
    // The shape the issue reported: one workspace, one config, two answers depending on
    // whether the caller went through argv. `runDiff` reads the config the same way `runScan`
    // does, so this is the comparison that was failing.
    await writeConfig(false)

    const direct = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out-direct"),
      format: "json",
    })
    const directIr = JSON.parse(
      await readFile(resolve(scratch, "out-direct/aburi.ir.json"), "utf8"),
    ) as { symbols: { id: string }[] }

    expect(direct.exitCode).toBe(0)
    expect(await symbolsFromCli([])).toEqual(directIr.symbols.map((s) => s.id).sort())
  })
})
