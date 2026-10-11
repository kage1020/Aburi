import { describe, expect, it } from "vitest"
import {
  comment,
  created,
  type FakeApi,
  listing,
  marked,
  postedBody,
  updated,
  upsertAgainst,
  withApi,
  writesOf,
} from "./fixtures/github-api"

describe("upsertPullRequestComment", () => {
  it("creates the comment when no marker comment is there, prefixing the marker", async () => {
    await withApi({ replies: listing([], created(111)) }, async (base, requests) => {
      expect(await upsertAgainst(base, "fresh")).toEqual({
        action: "created",
        commentId: 111,
        url: "https://github.example/c/111",
      })
      expect(writesOf(requests)).toEqual(["POST /repos/kage1020/Aburi/issues/42/comments"])
      expect(postedBody(requests)).toBe(marked("fresh"))
    })
  })

  it("rewrites the existing marker comment in place", async () => {
    const list = [comment(7, "unrelated"), comment(9, marked("old"))]
    await withApi({ replies: listing([list], updated(9)) }, async (base, requests) => {
      expect(await upsertAgainst(base, "new")).toMatchObject({ action: "updated", commentId: 9 })
      expect(writesOf(requests)).toEqual(["PATCH /repos/kage1020/Aburi/issues/comments/9"])
    })
  })

  it("writes nothing when the comment already holds the same bytes", async () => {
    await withApi({ replies: listing([[comment(4, marked("same"))]]) }, async (base, requests) => {
      expect(await upsertAgainst(base, "same")).toMatchObject({ action: "unchanged", commentId: 4 })
      expect(writesOf(requests)).toEqual([])
    })
  })

  it("keeps paging until a short page, so a busy pull request still finds its comment", async () => {
    const full = Array.from({ length: 100 }, (_, i) => comment(i + 1, "chatter"))
    const pages = [full, [comment(500, marked("old"))]]
    await withApi({ replies: listing(pages, updated(500)) }, async (base, requests) => {
      expect(await upsertAgainst(base, "new")).toMatchObject({ action: "updated", commentId: 500 })
      const listed = requests.filter((r) => r.path.includes("/comments?"))
      expect(listed.map((r) => new URL(r.path, base).searchParams.get("page"))).toEqual(["1", "2"])
    })
  })

  it("sends the bearer token and GitHub's API headers on every call", async () => {
    await withApi(
      { replies: listing([[comment(5, marked("old"))]], updated(5)) },
      async (base, requests) => {
        await upsertAgainst(base, "new")
        expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "PATCH"])
        for (const request of requests) {
          expect(request.headers).toMatchObject({
            authorization: "Bearer secret-token",
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "aburi-github-action",
          })
        }
      },
    )
  })

  it("preserves an API base that is mounted under a path (GitHub Enterprise Server)", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      await upsertAgainst(`${base}/api/v3`, "new")
      expect(requests.map((r) => r.path.startsWith("/api/v3/repos/kage1020/Aburi/"))).toEqual([
        true,
        true,
      ])
    })
  })

  it.each<[string, FakeApi["replies"], RegExp]>([
    [
      "the list request is refused",
      () => ({ status: 403, json: { message: "Forbidden" } }),
      /GitHub API failed to list PR comments: 403/,
    ],
    ["the list is not an array", () => ({ json: { message: "oops" } }), /non-array response/],
    [
      "the create is refused",
      listing([], { status: 401, json: { message: "Bad credentials" } }),
      /GitHub API failed to create PR comment: 401/,
    ],
    [
      "the update is refused",
      listing([[comment(555, marked("old"))]], { status: 422, json: { message: "Invalid" } }),
      /GitHub API failed to update PR comment: 422/,
    ],
    [
      "the create's reply lacks html_url",
      listing([], { status: 201, json: { id: 1, body: "no html_url" } }),
      /without id\/body\/html_url/,
    ],
    [
      "the update's reply lacks body",
      listing([[comment(555, marked("old"))]], { json: { id: 555 } }),
      /without id\/body\/html_url/,
    ],
  ])("throws when %s", async (_, replies, expected) => {
    await withApi({ replies }, async (base) => {
      await expect(upsertAgainst(base, "new")).rejects.toThrow(expected)
    })
  })
})
