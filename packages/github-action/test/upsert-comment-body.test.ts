import { describe, expect, it } from "vitest"
import {
  ABURI_COMMENT_BODY_MAX_BYTES,
  ABURI_COMMENT_MARKER,
  GITHUB_COMMENT_MAX_BYTES,
} from "../src/comment"
import { listing, marked, postedBody, withApi } from "./fixtures/github-api"
import { useUpsertScript } from "./fixtures/upsert-script"

const upsert = useUpsertScript()

describe("upsert-comment.mjs, on the body it posts", () => {
  it("prefixes the same marker the library does", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      expect((await upsert(base, "## Aburi\n")).status).toBe(0)
      expect(postedBody(requests)).toBe(marked("## Aburi\n"))
    })
  })

  it("puts the marker first even when the report quotes it further down", async () => {
    const report = `report quoting \`${ABURI_COMMENT_MARKER}\`\n`
    await withApi({ replies: listing([]) }, async (base, requests) => {
      await upsert(base, report)
      expect(postedBody(requests)).toBe(marked(report))
    })
  })

  it("posts a report that lands exactly on the library's limit", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      const run = await upsert(base, "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES))
      expect(run.status).toBe(0)
      expect(Buffer.byteLength(postedBody(requests), "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
    })
  })

  it("measures a report that already carries the marker as it stands", async () => {
    const report = marked("x".repeat(GITHUB_COMMENT_MAX_BYTES - 29))
    expect(Buffer.byteLength(report, "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
    await withApi({ replies: listing([]) }, async (base, requests) => {
      expect((await upsert(base, report)).status).toBe(0)
      expect(postedBody(requests)).toBe(report)
    })
  })

  it("is exit 2 on one byte over, in one line, without posting", async () => {
    await withApi({ replies: listing([]) }, async (base, requests) => {
      const run = await upsert(base, "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES + 1))
      expect(run.status).toBe(2)
      expect(run.stderr).toMatch(/^::error::.*65536-byte comment limit.*--max-bytes/)
      expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
      expect(requests).toHaveLength(0)
    })
  })
})
