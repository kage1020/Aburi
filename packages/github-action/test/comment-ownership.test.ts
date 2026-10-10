import { describe, expect, it } from "vitest"
import { ABURI_COMMENT_MARKER } from "../src/comment"
import {
  comment,
  created,
  listing,
  marked,
  updated,
  upsertAgainst,
  withApi,
  writesOf,
} from "./fixtures/github-api"

const alice = { login: "alice", type: "User" }
const quoted = comment(101, `Why does the bot search for \`${ABURI_COMMENT_MARKER}\`?`, alice)
const planted = comment(102, marked("# a report alice wrote"), alice)
const ours = comment(202, marked("# old report"))

describe("upsertPullRequestComment, on whose comment it rewrites", () => {
  it("passes over a person's comments that quote or open with the marker", async () => {
    await withApi(
      { replies: listing([[quoted, planted, ours]], updated(202)) },
      async (base, requests) => {
        expect(await upsertAgainst(base, "new")).toMatchObject({
          action: "updated",
          commentId: 202,
        })
        expect(writesOf(requests)).toEqual(["PATCH /repos/kage1020/Aburi/issues/comments/202"])
      },
    )
  })

  it("creates its own comment when only a person's carries the marker", async () => {
    await withApi(
      { replies: listing([[quoted, planted]], created(303)) },
      async (base, requests) => {
        expect(await upsertAgainst(base, "new")).toMatchObject({
          action: "created",
          commentId: 303,
        })
        expect(writesOf(requests)).toEqual(["POST /repos/kage1020/Aburi/issues/42/comments"])
      },
    )
  })

  it("asks who the token is only once a comment opens with the marker", async () => {
    await withApi({ replies: listing([[quoted]]) }, async (base, requests) => {
      await upsertAgainst(base, "new")
      expect(requests.some((r) => r.path.endsWith("/user"))).toBe(false)
    })
  })

  it("matches a personal token's own login, and no bot's", async () => {
    const mine = comment(103, marked("# mine"), { login: "kage1020", type: "User" })
    const api = {
      user: { json: { login: "kage1020" } },
      replies: listing([[ours, planted, mine]], updated(103)),
    }
    await withApi(api, async (base, requests) => {
      expect(await upsertAgainst(base, "new")).toMatchObject({ action: "updated", commentId: 103 })
      expect(writesOf(requests)).toEqual(["PATCH /repos/kage1020/Aburi/issues/comments/103"])
    })
  })

  it("matches a GitHub App's bot under an installation token", async () => {
    const app = comment(204, marked("# old"), { login: "aburi-reports[bot]", type: "Bot" })
    await withApi({ replies: listing([[planted, app]], updated(204)) }, async (base) => {
      expect(await upsertAgainst(base, "new")).toMatchObject({ action: "updated", commentId: 204 })
    })
  })

  it.each([
    [{ status: 502, json: { message: "bad gateway" } }, /identify the token's user: 502/],
    [{ status: 401, json: { message: "Bad credentials" } }, /user: 401/],
    [{ status: 404, json: { message: "Not Found" } }, /user: 404/],
    [{ status: 403, json: { message: "You have exceeded a secondary rate limit." } }, /user: 403/],
    [{ json: { id: 1 } }, /a user without a login/],
  ])("throws on GET /user answering %j, writing nothing", async (user, expected) => {
    await withApi({ user, replies: listing([[ours]]) }, async (base, requests) => {
      await expect(upsertAgainst(base, "new")).rejects.toThrow(expected)
      expect(writesOf(requests)).toEqual([])
    })
  })

  it("does not take a marker comment whose author it cannot read for its own", async () => {
    const { user: _user, ...authorless } = ours
    await withApi({ replies: listing([[authorless]], created(305)) }, async (base) => {
      expect(await upsertAgainst(base, "new")).toMatchObject({ action: "created", commentId: 305 })
    })
  })

  it("asks who the token is once, across pages", async () => {
    const chatter = Array.from({ length: 99 }, (_, i) => comment(2000 + i, "chatter"))
    await withApi(
      { replies: listing([[planted, ...chatter], [ours]], updated(202)) },
      async (base, requests) => {
        expect(await upsertAgainst(base, "new")).toMatchObject({
          action: "updated",
          commentId: 202,
        })
        expect(requests.filter((r) => r.path.endsWith("/user"))).toHaveLength(1)
      },
    )
  })
})
