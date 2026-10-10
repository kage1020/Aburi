import { describe, expect, it } from "vitest"
import {
  ABURI_COMMENT_BODY_MAX_BYTES,
  ABURI_COMMENT_MARKER,
  ensureMarker,
  GITHUB_COMMENT_MAX_BYTES,
} from "../src/comment"
import { listing, postedBody, upsertAgainst, withApi } from "./fixtures/github-api"

describe("ensureMarker", () => {
  it("prepends the marker and a blank line when the body lacks it", () => {
    expect(ensureMarker("hello", ABURI_COMMENT_MARKER)).toBe(`${ABURI_COMMENT_MARKER}\n\nhello`)
  })

  it("leaves the body untouched when it already opens with the marker", () => {
    const body = `${ABURI_COMMENT_MARKER}\n\ncontent`
    expect(ensureMarker(body, ABURI_COMMENT_MARKER)).toBe(body)
  })

  it("still puts the marker first when the body only quotes it further down", () => {
    // Only a comment that opens with the marker is found again on the next run.
    const body = `Report\n\n\`${ABURI_COMMENT_MARKER}\` marks this comment`
    expect(ensureMarker(body, ABURI_COMMENT_MARKER)).toBe(`${ABURI_COMMENT_MARKER}\n\n${body}`)
  })
})

describe("the comment-body size limit", () => {
  it("leaves the report exactly the room the marker does not take", () => {
    const withMarker = ensureMarker("x".repeat(ABURI_COMMENT_BODY_MAX_BYTES), ABURI_COMMENT_MARKER)
    expect(Buffer.byteLength(withMarker, "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
  })

  it("posts a body that lands exactly on the limit", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      const outcome = await upsertAgainst(base, "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES))
      expect(outcome.action).toBe("created")
      expect(Buffer.byteLength(postedBody(requests), "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
    })
  })

  it("refuses a body one byte over before touching the API", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      await expect(
        upsertAgainst(base, "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES + 1)),
      ).rejects.toThrow(/over GitHub's 65536-byte limit/)
      expect(requests).toHaveLength(0)
    })
  })

  it("advises a budget derived from the marker actually in use", async () => {
    const marker = "<!-- a much longer marker than the default one -->"
    const budget = GITHUB_COMMENT_MAX_BYTES - Buffer.byteLength(`${marker}\n\n`, "utf8")
    await withApi({ replies: listing([]) }, async (base) => {
      await expect(upsertAgainst(base, "x".repeat(budget + 1), { marker })).rejects.toThrow(
        `--max-bytes ${budget}`,
      )
    })
  })
})
