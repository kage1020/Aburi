import { glob, readFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..", "..", "..")
const RELEASE_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/release.yml")

/**
 * Every `uses:` a reader can copy. CHANGELOGs are left out on purpose: they are a record of
 * what past releases said, changesets rewrites them, and nobody pastes a workflow out of one.
 *
 * `turbo.json` declares these same paths as inputs of `@aburi/github-action#test`, so a local
 * run after editing one of them is a cache miss rather than a cached pass.
 */
const SOURCES = [
  "README.md",
  "docs/**/*.md",
  "packages/*/README.md",
  ".github/workflows/*.yml",
] as const

/** The files whose examples this package's pinning story lives in. */
const PINNED_EXAMPLE_FILES = [
  "README.md",
  "docs/guide/ci-integration.md",
  "packages/github-action/README.md",
] as const

/**
 * What a documented ref to this action may be: the immutable tag a release creates (a
 * prerelease suffix included — `release.yml` tags `v0.4.0-beta.1` before it decides not to
 * move the alias), the major alias, or a full SHA.
 *
 * The tags are unprefixed because the path in front of them already says which action they
 * belong to, and `changeset publish` only ever writes scoped `@aburi/<pkg>@<ver>` tags, so
 * the `v*` namespace is this action's alone.
 *
 * `main` is deliberately absent. It resolves, so it is a legitimate thing for a consumer to
 * write, but leaving it legal here would let every example drift back onto a branch without
 * a test noticing — and moving them off it is the whole point of this package's Pinning
 * section. Someone documenting `@main` on purpose is expected to change this line and say why.
 */
const ALLOWED_ABURI_REF = /^(?:v\d+(?:\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)?|[0-9a-f]{40})$/
/** The major-only alias, captured so it can be checked against the package's real major. */
const ALIAS_REF = /^v(\d+)$/

/**
 * Both quoting styles and a trailing comment, because a value this misses is a value that
 * silently escapes every assertion below. `action.yml` in this package already writes
 * `uses: "actions/github-script@v7"`, so the quoted form is a copy away from a README.
 */
const USES_LINE = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#]+))[ \t]*(?:#.*)?$/gm

interface UsesRef {
  readonly file: string
  readonly line: number
  readonly value: string
}

interface Scan {
  readonly refs: readonly UsesRef[]
  /** Files matched per entry of `SOURCES`, so a glob that stops matching is visible. */
  readonly filesPerPattern: Readonly<Record<string, number>>
}

function extractUses(raw: string): { readonly value: string; readonly line: number }[] {
  const out: { value: string; line: number }[] = []
  for (const match of raw.matchAll(USES_LINE)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value === undefined) continue
    // A local action (`./packages/github-action`) and a reusable-workflow call
    // (`./.github/workflows/docs.yml`) carry no ref, and a container step is not a ref at all.
    if (value.startsWith("./") || value.startsWith("docker://")) continue
    out.push({ value, line: raw.slice(0, match.index).split("\n").length })
  }
  return out
}

/**
 * `relative` answers `docs\guide\ci-integration.md` on Windows, which matches nothing in
 * `SOURCES` or `PINNED_EXAMPLE_FILES` and turned every path comparison here into a silent
 * miss on that runner alone. Paths are recorded in one spelling, the one the globs use.
 */
function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/")
}

async function scanSources(): Promise<Scan> {
  const refs: UsesRef[] = []
  const filesPerPattern: Record<string, number> = {}
  for (const pattern of SOURCES) {
    filesPerPattern[pattern] = 0
    for await (const entry of glob(pattern, { cwd: REPO_ROOT })) {
      filesPerPattern[pattern] = (filesPerPattern[pattern] ?? 0) + 1
      const absolute = resolve(REPO_ROOT, entry)
      const raw = await readFile(absolute, "utf8")
      for (const { value, line } of extractUses(raw)) {
        refs.push({ file: repoPath(absolute), line, value })
      }
    }
  }
  return { refs, filesPerPattern }
}

/**
 * The runner's own parse, from `PipelineTemplateConverter.ConvertToStep`: split the value on
 * `@`, require exactly two segments, then require at least `{owner}/{repo}` before the `@` and
 * a non-empty ref after it. Anything else is `Expected format {org}/{repo}[/path]@ref` — a
 * manifest load failure raised before the job starts, so no step of the workflow runs.
 */
function parseUses(
  value: string,
): { readonly path: readonly string[]; readonly ref: string } | null {
  const segments = value.split("@")
  const path = segments[0]?.split(/[/\\]/).filter((s) => s.length > 0) ?? []
  const ref = segments.length === 2 ? (segments[1] ?? "") : ""
  if (segments.length !== 2 || path.length < 2 || ref.length === 0) return null
  return { path, ref }
}

async function actionMajor(): Promise<string> {
  const raw = await readFile(resolve(HERE, "..", "package.json"), "utf8")
  const version = (JSON.parse(raw) as { version: string }).version
  return version.split(".")[0] ?? ""
}

interface WorkflowShape {
  readonly on: Record<string, unknown>
  readonly jobs: Record<
    string,
    {
      readonly needs?: string | readonly string[]
      readonly if?: string
      readonly permissions?: Record<string, string>
      readonly outputs?: Record<string, string>
      readonly steps?: readonly {
        readonly name?: string
        readonly id?: string
        readonly if?: string
        readonly env?: Record<string, string>
        readonly run?: string
        readonly with?: Record<string, unknown>
      }[]
    }
  >
}

async function loadReleaseWorkflow(): Promise<WorkflowShape> {
  return parse(await readFile(RELEASE_WORKFLOW, "utf8")) as WorkflowShape
}

async function tagStepRun(name: string): Promise<string> {
  const workflow = await loadReleaseWorkflow()
  const step = workflow.jobs["tag-action"]?.steps?.find((s) => s.name === name)
  expect(step, `no step named "${name}" in the tag-action job`).toBeDefined()
  return step?.run ?? ""
}

describe("parseUses", () => {
  // The load-bearing piece: the whole suite's value is this returning null on the one form
  // that reads like a ref and is not. Without these cases a body that answered a fixed
  // `{path: ["kage1020", "Aburi"], ref: "main"}` would keep every other test in the file green.
  it.each([
    // The tag `changeset publish` writes for this package, pasted where a ref goes.
    ["kage1020/Aburi/packages/github-action@@aburi/github-action@0.2.0", "three @ segments"],
    ["foo/bar", "no @ at all"],
    ["foo/bar@", "empty ref"],
    ["foo@v1", "only one path segment"],
    ["@v1", "no path at all"],
    ["foo/bar@v1@v2", "two refs"],
  ])("rejects %s (%s)", (value) => {
    expect(parseUses(value)).toBeNull()
  })

  it.each([
    ["actions/checkout@v4", ["actions", "checkout"], "v4"],
    [
      "kage1020/Aburi/packages/github-action@v0",
      ["kage1020", "Aburi", "packages", "github-action"],
      "v0",
    ],
    // `RemoveEmptyEntries` in the runner's split, which `.filter(…)` reproduces.
    ["foo//bar@v1", ["foo", "bar"], "v1"],
  ])("accepts %s", (value, path, ref) => {
    expect(parseUses(value)).toEqual({ path, ref })
  })
})

describe("ALLOWED_ABURI_REF", () => {
  it.each([
    "v0",
    "v1",
    "v0.3.0",
    // `release.yml` creates this before the prerelease guard decides not to move the alias,
    // so it is a real ref and documenting it is legal.
    "v0.4.0-beta.1",
    "d7af4711659564b6a95d074130b24481bdff81ca",
  ])("accepts %s", (ref) => {
    expect(ALLOWED_ABURI_REF.test(ref)).toBe(true)
  })

  it.each([
    ["main", "moving a branch back into the examples is the regression this locks"],
    ["@aburi/github-action@0.2.0", "the tag a `uses:` cannot hold"],
    ["action-v0", "the prefixed spelling this scheme dropped; no release creates it"],
    ["0.3.0", "no `v`"],
    ["v0.2", "not a version"],
    ["v", "no number"],
    ["d7af471", "an abbreviated SHA, which is not what a pin means"],
  ])("rejects %s (%s)", (ref) => {
    expect(ALLOWED_ABURI_REF.test(ref)).toBe(false)
  })
})

describe("USES_LINE", () => {
  // Each of these used to slip past the pattern with no signal at all, which is worse than a
  // wrong answer: the canary counts refs, so a value it never sees is a value nothing checks.
  it.each([
    ['- uses: "kage1020/Aburi/packages/github-action@v0.2.0"', "v0.2.0"],
    ["- uses: 'kage1020/Aburi/packages/github-action@v0.2.0'", "v0.2.0"],
    ["- uses: kage1020/Aburi/packages/github-action@v0.2.0 # pinned", "v0.2.0"],
    ["      - uses: kage1020/Aburi/packages/github-action@v0.2.0", "v0.2.0"],
  ])("reads the ref out of %s", (line, ref) => {
    const found = extractUses(line)
    expect(found).toHaveLength(1)
    expect(parseUses(found[0]?.value ?? "")?.ref).toBe(ref)
  })

  it("skips local actions and reusable-workflow calls", () => {
    expect(extractUses("- uses: ./packages/github-action")).toEqual([])
    expect(extractUses("    uses: ./.github/workflows/docs.yml")).toEqual([])
  })
})

describe("documented `uses:` references", () => {
  it("has a glob for every source it claims to cover, and each one matches", async () => {
    // A bare count over everything would not protect what matters: `.github/workflows/*.yml`
    // alone carries about twenty third-party refs, so `docs/**` and `packages/*/README.md`
    // could both stop matching and a total-count canary would still be satisfied.
    const { filesPerPattern } = await scanSources()
    for (const pattern of SOURCES) {
      expect(filesPerPattern[pattern], `no file matched ${pattern}`).toBeGreaterThan(0)
    }
  })

  it("keeps a pinned example in each file the pinning story is told in", async () => {
    const { refs } = await scanSources()
    // The comparison below is `===` against a `/`-spelled literal, and only Windows ever
    // disagreed about that — so the invariant is asserted rather than assumed.
    for (const ref of refs) {
      expect(ref.file, `${ref.file} is not spelled the way SOURCES is`).not.toContain("\\")
    }
    for (const file of PINNED_EXAMPLE_FILES) {
      const ours = refs.filter((r) => r.file === file && r.value.startsWith("kage1020/Aburi"))
      expect(ours.length, `${file} documents no kage1020/Aburi ref`).toBeGreaterThan(0)
    }
  })

  it("are all parseable by the runner", async () => {
    const { refs } = await scanSources()
    const unparseable = refs.filter((r) => parseUses(r.value) === null)
    expect(
      unparseable.map((r) => `${r.file}:${r.line} → ${r.value}`),
      "these would fail the manifest to load",
    ).toEqual([])
  })

  it("pin this action to a ref the release actually creates", async () => {
    const { refs } = await scanSources()
    const ours = refs.filter((r) => r.value.startsWith("kage1020/Aburi"))
    const major = await actionMajor()
    for (const ref of ours) {
      const parsed = parseUses(ref.value)
      const where = `${ref.file}:${ref.line} → ${ref.value}`
      expect(parsed, where).not.toBeNull()
      expect(parsed?.path.slice(0, 2).join("/"), where).toBe("kage1020/Aburi")
      expect(parsed?.ref ?? "", where).toMatch(ALLOWED_ABURI_REF)
      // A `major` changeset would take the package to 1.0.0 and leave every documented
      // `@v0` naming a tag no release will ever create. The alias is only correct
      // for the major this package is actually on.
      const alias = ALIAS_REF.exec(parsed?.ref ?? "")
      if (alias) {
        expect(alias[1], `${where}: package.json is on major ${major}`).toBe(major)
      }
    }
  })
})

describe("release workflow: tag-action job", () => {
  it("is a separate job so a tag failure cannot take the docs deploy with it", async () => {
    // As a step on `release` this ran after npm already had the packages, so a tag ruleset or
    // a rejected push reddened the publish run and skipped `docs` (which is `needs: release`
    // with no `always()`) over a failure that had nothing to do with the docs.
    const workflow = await loadReleaseWorkflow()
    const job = workflow.jobs["tag-action"]
    expect(job, "no tag-action job").toBeDefined()
    expect(job?.needs).toBe("release")
    expect(job?.permissions).toEqual({ contents: "write" })
    // The decoupling itself: docs must not wait on tagging.
    expect(workflow.jobs.docs?.needs).toBe("release")
    // And nothing may push tags from the publish job any more.
    const releaseRuns = (workflow.jobs.release?.steps ?? []).map((s) => s.run ?? "").join("\n")
    expect(releaseRuns).not.toContain("refs/tags/")
  })

  it("runs on a publish, and on a dispatch that skips the publish job", async () => {
    // `changeset publish` skips packages already on npm, so a re-run reports published=false
    // and this job would never fire again — the dispatch is the only way back.
    const workflow = await loadReleaseWorkflow()
    const gate = workflow.jobs["tag-action"]?.if ?? ""
    expect(gate).toContain("needs.release.outputs.published == 'true'")
    expect(gate).toContain("github.event_name == 'workflow_dispatch'")
    // Without `always()` a dispatch, which skips `release`, would skip this too.
    expect(gate).toContain("always()")
    expect(Object.keys(workflow.on)).toContain("workflow_dispatch")
    // And the dispatch must not be able to start a publish.
    expect(workflow.jobs.release?.if ?? "").toContain("github.event_name == 'push'")
  })

  it("reads the published versions from the release job's own output", async () => {
    const workflow = await loadReleaseWorkflow()
    const step = workflow.jobs["tag-action"]?.steps?.find((s) => s.id === "target")
    expect(step, "no step with id `target`").toBeDefined()
    expect(step?.env?.PUBLISHED).toContain("needs.release.outputs.publishedPackages")
    expect(workflow.jobs.release?.outputs?.publishedPackages).toContain(
      "steps.changesets.outputs.publishedPackages",
    )
    // A dispatch resolves the commit from the tag `changeset publish` left for that version,
    // so it does not silently tag wherever `main` happens to be.
    expect(step?.run).toContain("refs/tags/@aburi/github-action@$version")
  })

  it("compares the existing tag's commit rather than trusting the push to reject it", async () => {
    // git rejects an existing tag only when it points somewhere else; on the same commit — the
    // shape of every retry — it answers `Everything up-to-date` and exits 0. The comparison is
    // the only thing that distinguishes a retry from a collision.
    const run = await tagStepRun("Create the immutable tag and move the major alias")
    expect(run).toContain('if [ "$remote_sha" = "$TARGET" ]')
    // `--exit-code` answers 2 for no-match and 128 for a failed query, and an `if` reads both
    // as "absent"; this reads the output instead and treats a non-zero exit as unknown. (The
    // flag is named in the step's own comment, so the query itself is what gets asserted.)
    expect(run).toContain('git ls-remote --tags origin "refs/tags/$immutable"')
    expect(run).not.toContain("ls-remote --exit-code")
    expect(run).toContain("Could not read refs/tags/$immutable from origin")
  })

  it("keeps the major alias off a prerelease, by the pattern that decides it", async () => {
    // Asserting the pattern, not just the shape around it: mistyping `*-*)` as `*_*)` is the
    // one typo that force-pushes `v0` onto a prerelease for every consumer tracking
    // the major, and an order-of-substrings check waves it through.
    const run = await tagStepRun("Create the immutable tag and move the major alias")
    const guard = run.indexOf('case "$VERSION" in')
    const aliasMove = run.indexOf('git tag -f "$alias"')
    expect(guard).toBeGreaterThan(-1)
    expect(aliasMove).toBeGreaterThan(guard)
    const between = run.slice(guard, aliasMove)
    expect(between).toMatch(/\*-\*\)/)
    expect(between).toContain("exit 0")
    // The alias is the only forced push; the immutable tag must never be one.
    expect(run).toContain('git push origin --force "refs/tags/$alias"')
    expect(run).toContain('git push origin "refs/tags/$immutable"')
  })
})
