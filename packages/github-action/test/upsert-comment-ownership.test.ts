import { describe, expect, it } from "vitest"
import { ABURI_COMMENT_MARKER } from "../src/comment"
import {
  comment,
  created,
  listing,
  marked,
  updated,
  withApi,
  writesOf,
} from "./fixtures/github-api"
import { useUpsertScript } from "./fixtures/upsert-script"

const upsert = useUpsertScript()

const alice = { login: "alice", type: "User" }
const planted = comment(102, marked("# planted"), alice)

describe("upsert-comment.mjs, on whose comment it rewrites", () => {
  it("never rewrites a person's comment that quotes the marker, and updates its own", async () => {
    const quoted = comment(101, `Why does the bot search for \`${ABURI_COMMENT_MARKER}\`?`, alice)
    const list = [quoted, planted, comment(202, marked("# old report"))]
    await withApi({ replies: listing([list], updated(202)) }, async (base, requests) => {
      const run = await upsert(base, "# Aburi diff\n")
      expect(run.outputs).toEqual({ action: "updated", "comment-id": "202" })
      expect(writesOf(requests)).toEqual(["PATCH /repos/kage1020/Aburi/issues/comments/202"])
    })
  })

  it("creates its own comment when only a person's carries the marker", async () => {
    await withApi({ replies: listing([[planted]], created(303)) }, async (base, requests) => {
      const run = await upsert(base, "report\n")
      expect(run.outputs).toEqual({ action: "created", "comment-id": "303" })
      expect(writesOf(requests)).toEqual(["POST /repos/kage1020/Aburi/issues/42/comments"])
    })
  })

  it("matches a personal token's own login rather than any bot", async () => {
    const me = { login: "kage1020", type: "User" }
    const api = {
      user: { json: { login: "kage1020" } },
      replies: listing(
        [[comment(201, marked("# a bot's")), comment(301, marked("# mine"), me)]],
        updated(301),
      ),
    }
    await withApi(api, async (base, requests) => {
      const run = await upsert(base, "report\n")
      expect(run.outputs).toEqual({ action: "updated", "comment-id": "301" })
      expect(writesOf(requests)).toEqual(["PATCH /repos/kage1020/Aburi/issues/comments/301"])
    })
  })

  it.each([
    ["a 502", { status: 502, json: { message: "bad gateway" } }, "identify the token's user: 502"],
    ["a bad token's 401", { status: 401, json: { message: "Bad credentials" } }, "user: 401"],
    [
      "a secondary rate limit's 403",
      { status: 403, json: { message: "You have exceeded a secondary rate limit." } },
      "user: 403",
    ],
    ["a user with no login", { json: { id: 1 } }, "a user without a login"],
  ])("is exit 1 on %s from GET /user, writing nothing", async (_, user, named) => {
    const api = { user, replies: listing([[comment(9, marked("old\n"))]]) }
    await withApi(api, async (base, requests) => {
      const run = await upsert(base, "report\n")
      expect(run.status).toBe(1)
      expect(run.stderr).toContain(named)
      expect(writesOf(requests)).toEqual([])
    })
  })

  it("counts a marker comment whose author it cannot read as unreadable, and says so", async () => {
    const { user: _user, ...authorless } = comment(9, marked("old\n"))
    await withApi({ replies: listing([[authorless]], created(10)) }, async (base) => {
      const run = await upsert(base, "report\n")
      expect(run.status).toBe(0)
      expect(run.stderr).toMatch(/^::warning::1 comment\(s\) .*author login/)
      expect(run.outputs.action).toBe("created")
    })
  })

  it("asks who the token is once, across pages", async () => {
    const chatter = Array.from({ length: 99 }, (_, i) => comment(i + 2, "chatter"))
    const pages = [
      [comment(1, marked("# planted"), alice), ...chatter],
      [comment(500, marked("old\n"))],
    ]
    await withApi({ replies: listing(pages, updated(500)) }, async (base, requests) => {
      const run = await upsert(base, "report\n")
      expect(run.outputs).toEqual({ action: "updated", "comment-id": "500" })
      expect(requests.filter((r) => r.path.endsWith("/user"))).toHaveLength(1)
    })
  })
})
