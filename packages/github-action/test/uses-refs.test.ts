import { glob, readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/**
 * Every `uses:` a reader can copy. CHANGELOGs are left out on purpose: they are a record of
 * what past releases said, changesets rewrites them, and nobody pastes a workflow out of one.
 */
const SOURCES = [
  "README.md",
  "docs/**/*.md",
  "packages/*/README.md",
  ".github/workflows/*.yml",
] as const

/** Anything this action's own repository-qualified refs are allowed to be. */
const ALLOWED_ABURI_REFS = /^(?:main|action-v\d+(?:\.\d+\.\d+)?|[0-9a-f]{40})$/

const USES_LINE = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)[ \t]*$/gm

interface UsesRef {
  readonly file: string
  readonly line: number
  readonly value: string
}

async function collectUsesRefs(): Promise<UsesRef[]> {
  const found: UsesRef[] = []
  for (const pattern of SOURCES) {
    for await (const entry of glob(pattern, { cwd: REPO_ROOT })) {
      const file = relative(REPO_ROOT, resolve(REPO_ROOT, entry))
      const raw = await readFile(resolve(REPO_ROOT, entry), "utf8")
      for (const match of raw.matchAll(USES_LINE)) {
        const value = match[1]
        if (value === undefined) continue
        // A local action (`./packages/github-action`) and a reusable-workflow call
        // (`./.github/workflows/docs.yml`) carry no ref, and a container step is not a ref at all.
        if (value.startsWith("./") || value.startsWith("docker://")) continue
        const line = raw.slice(0, match.index).split("\n").length
        found.push({ file, line, value })
      }
    }
  }
  return found
}

/**
 * The runner's own parse, from `PipelineTemplateConverter.ConvertToStep`: split the value on `@`,
 * require exactly two segments, then require at least `{owner}/{repo}` before the `@` and a
 * non-empty ref after it. Anything else is `Expected format {org}/{repo}[/path]@ref` — a manifest
 * load failure, raised before the job starts, so no step of the workflow runs.
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

describe("documented `uses:` references", () => {
  it("finds the workflow snippets it is supposed to be checking", async () => {
    // Without this, a glob that stops matching turns every assertion below into a silent pass.
    const refs = await collectUsesRefs()
    expect(refs.length).toBeGreaterThan(10)
    expect(refs.some((r) => r.value.startsWith("kage1020/Aburi/packages/github-action@"))).toBe(
      true,
    )
  })

  it("are all parseable by the runner", async () => {
    // The tag `changeset publish` writes for this package is `@aburi/github-action@0.2.0`, which
    // reads like a ref and is not one: pasted after the path it makes three `@` segments, and the
    // workflow fails to load. An earlier revision of this README recommended exactly that.
    const refs = await collectUsesRefs()
    const unparseable = refs.filter((r) => parseUses(r.value) === null)
    expect(
      unparseable.map((r) => `${r.file}:${r.line} → ${r.value}`),
      "these would fail the manifest to load",
    ).toEqual([])
  })

  it("pin this action to a ref the release actually creates", async () => {
    // `.github/workflows/release.yml` pushes `action-v<version>` and moves `action-v<major>`;
    // `main` and a full SHA always resolve. A `v0.2.0` or `@aburi/github-action@0.2.0` here would
    // be a ref no release produces, and the failure lands on the consumer, not on us.
    const refs = await collectUsesRefs()
    const ours = refs.filter((r) => r.value.startsWith("kage1020/Aburi"))
    for (const ref of ours) {
      const parsed = parseUses(ref.value)
      expect(parsed, `${ref.file}:${ref.line}`).not.toBeNull()
      expect(parsed?.path.slice(0, 2).join("/")).toBe("kage1020/Aburi")
      expect(parsed?.ref, `${ref.file}:${ref.line} → ${ref.value}`).toMatch(ALLOWED_ABURI_REFS)
    }
  })
})

describe("release workflow", () => {
  it("creates the immutable action tag and moves only the major alias", async () => {
    // The two halves of the scheme the READMEs document. `action-v<version>` is the immutable
    // one, so the step refuses to overwrite an existing one rather than re-pointing a ref a
    // consumer already reviewed; `action-v<major>` is the alias, and is the only forced push.
    const raw = await readFile(resolve(REPO_ROOT, ".github/workflows/release.yml"), "utf8")
    expect(raw).toContain('git tag "action-v$version"')
    expect(raw).toContain('git tag -f "action-v$major"')
    expect(raw).toContain('git push origin "refs/tags/action-v$version"')
    expect(raw).toContain('git push origin --force "refs/tags/action-v$major"')
    // Refuses rather than moves, so an immutable tag stays immutable.
    expect(raw).toContain('git ls-remote --exit-code --tags origin "refs/tags/action-v$version"')
    // A release that bumped only the CLI leaves the action tags alone.
    expect(raw).toContain('select(.name == "@aburi/github-action")')
  })

  it("keeps the major alias off a prerelease", async () => {
    // `action-v0` is what a consumer tracking the major runs. Moving it onto `0.3.0-beta.1`
    // would ship them a prerelease they never asked for, while the immutable
    // `action-v0.3.0-beta.1` is there for anyone who did.
    const raw = await readFile(resolve(REPO_ROOT, ".github/workflows/release.yml"), "utf8")
    const step = raw.slice(raw.indexOf("Tag the action release"))
    const guard = step.indexOf('case "$version" in')
    const aliasMove = step.indexOf('git tag -f "action-v$major"')
    expect(guard).toBeGreaterThan(-1)
    expect(aliasMove).toBeGreaterThan(guard)
    expect(step.slice(guard, aliasMove)).toContain("exit 0")
  })
})
