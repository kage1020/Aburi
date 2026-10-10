import { describe, expect, it } from "vitest"
import {
  comment,
  created,
  listing,
  marked,
  refusingBase,
  updated,
  withApi,
  writesOf,
} from "./fixtures/github-api"
import { useUpsertScript } from "./fixtures/upsert-script"

const upsert = useUpsertScript()

describe("upsert-comment.mjs", () => {
  it("creates the comment when no marker comment is there, and says so in the outputs", async () => {
    await withApi({ replies: listing([], created(11)) }, async (base, requests) => {
      const run = await upsert(base, "something changed\n")
      expect(run.status).toBe(0)
      expect(run.outputs).toEqual({ action: "created", "comment-id": "11" })
      expect(run.stdout).toBe("Aburi comment 11 created: https://github.example/c/11\n")
      expect(writesOf(requests)).toEqual(["POST /repos/kage1020/Aburi/issues/42/comments"])
      expect(requests.every((r) => r.headers.authorization === "Bearer secret-token")).toBe(true)
    })
  })

  it("rewrites the existing marker comment in place", async () => {
    const list = [comment(7, "unrelated"), comment(9, marked("old report\n"))]
    await withApi({ replies: listing([list], updated(9)) }, async (base, requests) => {
      const run = await upsert(base, "new report\n")
      expect(run.outputs).toEqual({ action: "updated", "comment-id": "9" })
      expect(writesOf(requests)).toEqual(["PATCH /repos/kage1020/Aburi/issues/comments/9"])
    })
  })

  it("writes nothing when the comment already holds the same bytes", async () => {
    await withApi(
      { replies: listing([[comment(4, marked("same report\n"))]]) },
      async (base, requests) => {
        const run = await upsert(base, "same report\n")
        expect(run.outputs).toEqual({ action: "unchanged", "comment-id": "4" })
        expect(writesOf(requests)).toEqual([])
      },
    )
  })

  it("keeps paging until a short page, so a busy pull request still finds its comment", async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(i + 1, "chatter"))
    const pages = [full, [comment(500, marked("old\n"))]]
    await withApi({ replies: listing(pages, updated(500)) }, async (base, requests) => {
      const run = await upsert(base, "report\n")
      expect(run.outputs).toEqual({ action: "updated", "comment-id": "500" })
      expect(requests.filter((r) => r.path.includes("/comments?"))).toHaveLength(2)
    })
  })

  it("preserves an API base that is mounted under a path (GitHub Enterprise Server)", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      expect((await upsert(base, "report\n", { GITHUB_API_URL: `${base}/api/v3` })).status).toBe(0)
      expect(requests.every((r) => r.path.startsWith("/api/v3/repos/kage1020/Aburi/"))).toBe(true)
    })
  })

  it("says how many comments it could not read, rather than skipping them in silence", async () => {
    const unreadable = [
      { id: 5, body: "no html_url here" },
      { id: "not a number", body: "x" },
    ]
    await withApi({ replies: listing([unreadable], created(6)) }, async (base) => {
      const run = await upsert(base, "report\n")
      expect(run.status).toBe(0)
      expect(run.stderr).toContain("::warning::2 comment(s)")
      expect(run.outputs.action).toBe("created")
    })
  })

  it("is exit 1 with one line when GitHub refuses the write", async () => {
    const refusal = { status: 403, text: '{"message":"Resource not accessible by integration"}' }
    await withApi({ replies: listing([], refusal) }, async (base) => {
      const run = await upsert(base, "report\n")
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(
        /^::error::GitHub API failed to create PR comment: 403 .*Resource not accessible by integration/,
      )
      expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
      expect(run.outputs).toEqual({})
    })
  })

  it("names the network failure behind fetch's own `fetch failed`", async () => {
    const run = await upsert(await refusingBase(), "report\n")
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/^::error::fetch failed \(caused by .*ECONNREFUSED/)
  })
})
