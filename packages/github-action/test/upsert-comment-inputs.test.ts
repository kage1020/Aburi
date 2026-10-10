import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { created, listing, withApi } from "./fixtures/github-api"
import { useUpsertScript } from "./fixtures/upsert-script"

const upsert = useUpsertScript()
/** A directory, standing where `$GITHUB_OUTPUT` names a file. */
const unwritable = useScratchWorkspace("github-output-dir")

describe("upsert-comment.mjs, on what the step hands it", () => {
  it.each([
    ["an empty token", { GITHUB_TOKEN: "" }, "GITHUB_TOKEN"],
    ["a repository that is not owner/repo", { GITHUB_REPOSITORY: "Aburi" }, "GITHUB_REPOSITORY"],
    ["a pull request number that is not one", { PR_NUMBER: "12abc" }, "PR_NUMBER"],
    ["no pull request number at all", { PR_NUMBER: "" }, "PR_NUMBER"],
  ])("is exit 2 and touches no API for %s", async (_, env, named) => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      const run = await upsert(base, "report\n", env)
      expect(run.status).toBe(2)
      expect(run.stderr).toMatch(/^::error::/)
      expect(run.stderr).toContain(named)
      expect(run.outputs).toEqual({})
      expect(requests).toHaveLength(0)
    })
  })

  it("is exit 2 when the Markdown is not there, naming the path it looked at", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      const run = await upsert(base, "report\n", { MARKDOWN_PATH: "/nowhere/diff.md" })
      expect(run.status).toBe(2)
      expect(run.stderr).toContain("/nowhere/diff.md")
      expect(requests).toHaveLength(0)
    })
  })

  it("runs without `$GITHUB_OUTPUT`, for a caller that is not a step", async () => {
    await withApi({ replies: listing([], created(3)) }, async (base) => {
      const run = await upsert(base, "report\n", { GITHUB_OUTPUT: undefined })
      expect(run.status).toBe(0)
      expect(run.stdout).toBe("Aburi comment 3 created: https://github.example/c/3\n")
    })
  })

  it("warns rather than fails when `$GITHUB_OUTPUT` cannot be written, the comment being posted", async () => {
    await withApi({ replies: listing([], created(3)) }, async (base) => {
      const run = await upsert(base, "report\n", { GITHUB_OUTPUT: unwritable.root })
      expect(run.status).toBe(0)
      expect(run.stderr).toMatch(
        /^::warning::Comment 3 was created, but \$GITHUB_OUTPUT could not be written \(EISDIR/,
      )
    })
  })
})
