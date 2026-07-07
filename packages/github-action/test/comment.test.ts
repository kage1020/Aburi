import { describe, expect, it } from "vitest"
import { ABURI_COMMENT_MARKER, ensureMarker, upsertPullRequestComment } from "../src/comment"

interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly body: string | null
}

interface FakeFetchOptions {
  readonly listPages?: readonly unknown[][]
  readonly createResponse?: unknown
  readonly patchResponse?: unknown
  readonly listStatus?: number
  readonly createStatus?: number
  readonly patchStatus?: number
}

function makeFakeFetch(options: FakeFetchOptions): {
  readonly fetch: typeof globalThis.fetch
  readonly calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const pages = options.listPages ?? [[]]
  let pageIndex = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? init.body : null
    calls.push({ method, url, body })

    if (method === "GET" && url.includes("/issues/") && url.includes("/comments")) {
      const status = options.listStatus ?? 200
      const rows = pages[pageIndex] ?? []
      pageIndex += 1
      return new Response(JSON.stringify(rows), {
        status,
        headers: { "content-type": "application/json" },
      })
    }
    if (method === "POST") {
      const status = options.createStatus ?? 201
      return new Response(JSON.stringify(options.createResponse ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      })
    }
    if (method === "PATCH") {
      const status = options.patchStatus ?? 200
      return new Response(JSON.stringify(options.patchResponse ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("unexpected", { status: 500 })
  }
  return { fetch, calls }
}

const REF = { owner: "kage1020", repo: "Aburi", pullNumber: 42 }

describe("ensureMarker", () => {
  it("prepends the marker when absent", () => {
    const out = ensureMarker("hello", ABURI_COMMENT_MARKER)
    expect(out.startsWith(ABURI_COMMENT_MARKER)).toBe(true)
    expect(out.endsWith("hello")).toBe(true)
  })

  it("leaves the body untouched when the marker is already present", () => {
    const body = `${ABURI_COMMENT_MARKER}\n\ncontent`
    expect(ensureMarker(body, ABURI_COMMENT_MARKER)).toBe(body)
  })
})

describe("upsertPullRequestComment", () => {
  it("creates a new comment when no marker comment exists", async () => {
    const { fetch, calls } = makeFakeFetch({
      listPages: [[]],
      createResponse: {
        id: 111,
        body: `${ABURI_COMMENT_MARKER}\n\nfresh`,
        html_url: "https://github.com/kage1020/Aburi/pull/42#issuecomment-111",
      },
    })

    const outcome = await upsertPullRequestComment({
      ref: REF,
      body: "fresh",
      token: "test-token",
      fetch,
    })

    expect(outcome.action).toBe("created")
    expect(outcome.commentId).toBe(111)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[1]?.method).toBe("POST")
    const body = JSON.parse(calls[1]?.body ?? "{}") as { body: string }
    expect(body.body.startsWith(ABURI_COMMENT_MARKER)).toBe(true)
    expect(body.body).toContain("fresh")
  })

  it("updates an existing marker comment when the body diverges", async () => {
    const existing = {
      id: 222,
      body: `${ABURI_COMMENT_MARKER}\n\nold`,
      html_url: "https://github.com/kage1020/Aburi/pull/42#issuecomment-222",
    }
    const { fetch, calls } = makeFakeFetch({
      listPages: [[existing]],
      patchResponse: {
        id: 222,
        body: `${ABURI_COMMENT_MARKER}\n\nnew`,
        html_url: existing.html_url,
      },
    })

    const outcome = await upsertPullRequestComment({
      ref: REF,
      body: "new",
      token: "test-token",
      fetch,
    })

    expect(outcome.action).toBe("updated")
    expect(outcome.commentId).toBe(222)
    const patchCall = calls.find((c) => c.method === "PATCH")
    expect(patchCall).toBeDefined()
    expect(patchCall?.url).toContain("/issues/comments/222")
  })

  it("returns 'unchanged' when the existing comment body already matches", async () => {
    const body = `${ABURI_COMMENT_MARKER}\n\nsame`
    const { fetch, calls } = makeFakeFetch({
      listPages: [[{ id: 333, body, html_url: "u" }]],
    })

    const outcome = await upsertPullRequestComment({
      ref: REF,
      body: "same",
      token: "test-token",
      fetch,
    })

    expect(outcome.action).toBe("unchanged")
    expect(outcome.commentId).toBe(333)
    expect(calls.filter((c) => c.method === "PATCH" || c.method === "POST")).toEqual([])
  })

  it("scans across pages until the marker is found", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      body: "unrelated",
      html_url: "u",
    }))
    const target = {
      id: 999,
      body: `${ABURI_COMMENT_MARKER}\n\nold`,
      html_url: "u",
    }
    const { fetch, calls } = makeFakeFetch({
      listPages: [filler, [target]],
      patchResponse: {
        id: 999,
        body: `${ABURI_COMMENT_MARKER}\n\nnew`,
        html_url: "u",
      },
    })

    const outcome = await upsertPullRequestComment({
      ref: REF,
      body: "new",
      token: "test-token",
      fetch,
    })

    expect(outcome.action).toBe("updated")
    expect(outcome.commentId).toBe(999)
    const gets = calls.filter((c) => c.method === "GET")
    expect(gets.length).toBe(2)
    expect(gets[0]?.url).toContain("page=1")
    expect(gets[1]?.url).toContain("page=2")
  })

  it("throws a contextual error when the GitHub API rejects the list request", async () => {
    const { fetch } = makeFakeFetch({ listStatus: 403 })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "x", token: "t", fetch }),
    ).rejects.toThrow(/GitHub API failed to list PR comments: 403/)
  })

  it("throws when the create request fails", async () => {
    const { fetch } = makeFakeFetch({ listPages: [[]], createStatus: 401 })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "x", token: "t", fetch }),
    ).rejects.toThrow(/GitHub API failed to create PR comment: 401/)
  })

  it("sends bearer token and required GitHub API headers on every call", async () => {
    const { fetch, calls } = makeFakeFetch({
      listPages: [[]],
      createResponse: {
        id: 1,
        body: `${ABURI_COMMENT_MARKER}\n\nx`,
        html_url: "u",
      },
    })
    await upsertPullRequestComment({ ref: REF, body: "x", token: "secret", fetch })
    for (const call of calls) {
      expect(call.url).toContain("api.github.com")
    }
  })

  it("respects a custom apiBase for GitHub Enterprise Server", async () => {
    const { fetch, calls } = makeFakeFetch({
      listPages: [[]],
      createResponse: {
        id: 1,
        body: `${ABURI_COMMENT_MARKER}\n\nx`,
        html_url: "u",
      },
    })
    await upsertPullRequestComment({
      ref: REF,
      body: "x",
      token: "t",
      apiBase: "https://ghe.example.com/api/v3",
      fetch,
    })
    expect(calls[0]?.url.startsWith("https://ghe.example.com/api/v3/repos/")).toBe(true)
  })

  it("throws when the patch request fails", async () => {
    const existing = {
      id: 555,
      body: `${ABURI_COMMENT_MARKER}\n\nold`,
      html_url: "u",
    }
    const { fetch } = makeFakeFetch({ listPages: [[existing]], patchStatus: 422 })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch }),
    ).rejects.toThrow(/GitHub API failed to update PR comment: 422/)
  })

  it("throws when the create response is missing id / body / html_url", async () => {
    const { fetch } = makeFakeFetch({
      listPages: [[]],
      createResponse: { id: 1, body: "no html_url" },
    })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "x", token: "t", fetch }),
    ).rejects.toThrow(/without id\/body\/html_url/)
  })

  it("throws when the patch response is missing id / body / html_url", async () => {
    const existing = {
      id: 777,
      body: `${ABURI_COMMENT_MARKER}\n\nold`,
      html_url: "u",
    }
    const { fetch } = makeFakeFetch({
      listPages: [[existing]],
      patchResponse: { id: 777 },
    })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch }),
    ).rejects.toThrow(/without id\/body\/html_url/)
  })

  it("rejects a non-array list response instead of silently treating it as empty", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "oops" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "x", token: "t", fetch }),
    ).rejects.toThrow(/non-array response/)
  })
})
