import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import type { Summary } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff, runScan } from "../src"
import { DIFF_JSON_FILENAME } from "../src/artifact-paths"

/**
 * `cli-spec.md` §6.4 step 3: the base scan reads the **head**'s `aburi.json`.
 *
 * The base is interpreted through the head's view on purpose. Under the base's own config a
 * commit that edits nothing but `ignore` moves every Symbol the setting covers, so `aburi
 * diff HEAD~1..HEAD --fail-on added` fails a pull request that changed no source at all — and
 * the counts it reports are about the config, not about the change under review.
 *
 * Both routes to a config had to be pinned to make that true. Discovery walks up from the
 * scan's cwd, which for the base scan is the temporary worktree; a relative `--config`
 * resolves against the same directory. Each returned the base revision's copy of the file.
 */

let scratch = ""
let head = ""
let baseTree = ""

/**
 * A workspace that is one package, in two revisions that differ only in their config.
 *
 * `src/b.ts` is what the two configs disagree about, and it carries a non-empty body: an
 * empty one is dropped as boilerplate, which would make "no added Symbol" true for the wrong
 * reason.
 */
async function makeRevisions(configName: string, baseConfigName = configName): Promise<void> {
  for (const dir of [head, baseTree]) {
    await mkdir(resolve(dir, "src"), { recursive: true })
    await writeFile(resolve(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8")
    // `detectWorkspaceRoot` takes the *outermost* marker, so without one of our own a `.git`
    // or workspace-aware `package.json` anywhere above `tmpdir()` would silently become the
    // root and every assertion below would be measuring the wrong tree. A bare
    // `package.json` is not a marker, which is what makes this file necessary rather than
    // merely reassuring.
    await writeFile(resolve(dir, ".aburi-workspace"), "", "utf8")
    await writeFile(resolve(dir, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
    await writeFile(resolve(dir, "src/b.ts"), "export function beta() { return 2 }\n", "utf8")
  }
  await writeConfig(resolve(head, configName), undefined)
  // The base revision hides `src/b.ts`. Read, it removes beta from the base IR and the head's
  // beta becomes an addition somebody made.
  await writeConfig(resolve(baseTree, baseConfigName), ["src/b.ts"])
  expect(await detectWorkspaceRoot({ cwd: head })).toBe(head)
}

async function writeConfig(
  path: string,
  ignore: readonly string[] | undefined,
  effects: readonly string[] = [],
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...(effects.length === 0 ? {} : { effects }),
      ...(ignore === undefined ? {} : { ignore }),
    }),
    "utf8",
  )
}

/** An effects plugin that classifies nothing — enough to be loaded, and no more. */
const NOOP_EFFECTS_PLUGIN = `
export const plugin = {
  manifest: {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "effects-noop",
    version: "0.0.0",
    type: "effects",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [],
      frameworks: [],
    },
  },
  async init() {},
  classify() {
    return null
  },
}
`

/**
 * A `git` that materializes the base revision the way `worktree add` does, so the base scan
 * meets a real directory with a real config in it. Nothing here is stubbed at the config
 * layer — the defect lives in which file the scan opens, so the test has to let it open one.
 */
function makeGit(): GitRunner {
  return {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      if (key === "rev-parse --verify") return { stdout: "abc123\n", stderr: "" }
      if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
      if (key === "worktree add") {
        const destination = args[3]
        if (destination === undefined) throw new Error("worktree add without a destination")
        await cp(baseTree, destination, { recursive: true })
      }
      return { stdout: "", stderr: "" }
    },
  }
}

async function readSummary(outputDir: string): Promise<Summary> {
  const raw = await readFile(resolve(outputDir, DIFF_JSON_FILENAME), "utf8")
  return (JSON.parse(raw) as { summary: Summary }).summary
}

/**
 * What both revisions look like when the two scans agreed on the head's config: two Symbols,
 * neither of them touched.
 *
 * `unchanged` is what makes the assertion non-degenerate. `added: 0` alone is also true of a
 * half-fixed pinning that gives *both* sides a config ignoring `src/b.ts` — that run reports
 * `unchanged: 1`. Pre-fix the counts are `added: 1, unchanged: 1`.
 */
const NO_CHANGE = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 2 }

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-cfg-"))
  head = resolve(scratch, "head")
  baseTree = resolve(scratch, "base")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff — the base scan reads the head's config", () => {
  it("reports no change when the only difference between the revisions is `ignore`", async () => {
    await makeRevisions("aburi.json")
    const outputDir = resolve(scratch, "out")
    const warnings: string[] = []

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      failOn: "added",
      warn: (m) => warnings.push(m),
    })

    // Under the base's own config `src/b.ts` is absent from the base IR, so `beta` reads as
    // `added` and the gate trips on a commit that touched no source.
    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    // A pinned base scan reads a config outside its own workspace root by construction, so
    // the "sits below the workspace root" line would fire on every ref-mode diff in a
    // configured repo — new noise, and about a monorepo package nobody ran anything from.
    expect(warnings).toEqual([])
  })

  it("resolves a relative `--config` against the caller's directory, not the worktree", async () => {
    await makeRevisions("custom.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      configPath: "./custom.json",
      outputDir,
      failOn: "added",
      warn: () => {},
    })

    // `resolve(worktreeDir, "./custom.json")` is the base copy of the file, and it exists —
    // so the override was read twice, once per revision, rather than pinned once.
    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("reads the `--config` file the head names even when the base has none at that path", async () => {
    // `custom.json` at the head, `aburi.json` at the base. The pinned path does not exist in
    // the worktree at all, which is the point: the head's file is read from the head's tree
    // rather than re-resolved against wherever the scan happens to be standing.
    await makeRevisions("custom.json", "aburi.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      configPath: "./custom.json",
      outputDir,
      warn: () => {},
    })

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("ignores a base-revision config discovery would have preferred over the head's", async () => {
    // No `--config` here, so this is the discovery path rather than the override one. The
    // head is configured by `aburi.jsonc`, the base by `aburi.json`; discovery prefers
    // `.jsonc`, so re-running it from inside the worktree finds neither the head's file nor
    // the file the head's own discovery chose — it finds the base's stale `aburi.json`.
    await makeRevisions("aburi.jsonc", "aburi.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      failOn: "added",
      warn: () => {},
    })

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})

describe("a relative plugin ref in the head's config resolves in the head's tree", () => {
  it("loads a plugin the head added and the base revision does not have", async () => {
    await makeRevisions("aburi.json")
    // The head registers a plugin that lives beside its own config. The base revision predates
    // it, so the file is absent from the worktree — which is the ordinary shape of a commit
    // that adds a plugin. `cli-spec.md` §6.4.1.5 pins the plugin set to the head environment
    // for exactly this reason; resolved against the worktree instead, the base scan dies with
    // `plugin-error` on a config the head reads fine.
    await mkdir(resolve(head, "plugins"), { recursive: true })
    await writeFile(resolve(head, "plugins/noop.mjs"), NOOP_EFFECTS_PLUGIN, "utf8")
    // `ignore` keeps the plugin module out of the *scan*, which is a separate question from
    // whether the loader can find it: `lang-typescript` claims `.mjs`, so without this the
    // head grows a Symbol the base has no file for and the diff reports it as added.
    await writeConfig(resolve(head, "aburi.json"), ["plugins/**"], ["./plugins/noop.mjs"])
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      warn: () => {},
    })

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})

describe("a pinned config replaces discovery rather than seeding it", () => {
  it("autodetects when told to, even standing in a directory that has a config", async () => {
    await makeRevisions("aburi.json")

    // The arm `aburi diff` takes when the head deleted its config while the base still has
    // one. Reading `head/aburi.json` here would be discovery running anyway, which is the
    // whole defect — and the diff-level tests cannot see it, because a `pinnedConfigPath?:
    // string` refactor where `undefined` means "discover" passes every one of them.
    await expect(
      runScan({
        cwd: head,
        pinnedConfig: { kind: "autodetect" },
        outputDir: resolve(scratch, "out"),
        format: "json",
      }),
      // Autodetect currently has no way to reach a language plugin, so it stops here rather
      // than producing an empty IR. That is what makes both sides of a diff fail identically
      // instead of one of them reporting the workspace as deleted.
    ).rejects.toThrow(/no aburi.json was found/)
  })
})
