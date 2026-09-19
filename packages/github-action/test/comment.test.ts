import { describe, expect, it } from "vitest"
import {
  ABURI_COMMENT_BODY_MAX_BYTES,
  ABURI_COMMENT_MARKER,
  ensureMarker,
  GITHUB_COMMENT_MAX_BYTES,
  upsertPullRequestComment,
} from "../src/comment"

interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly body: string | null
  readonly headers: Record<string, string>
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
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ method, url, body, headers })

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

  it("sends bearer token and required GitHub API headers on every call", async () => {
    const existing = { id: 5, body: `${ABURI_COMMENT_MARKER}\n\nold`, html_url: "u" }
    const { fetch, calls } = makeFakeFetch({
      listPages: [[existing]],
      patchResponse: { ...existing, body: `${ABURI_COMMENT_MARKER}\n\nx` },
    })
    await upsertPullRequestComment({ ref: REF, body: "x", token: "secret", fetch })
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"])
    for (const call of calls) {
      expect(call.url).toContain("api.github.com")
      expect(call.headers).toMatchObject({
        authorization: "Bearer secret",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "aburi-github-action",
      })
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

  /** The list page that routes the upsert to a create (no marker comment) or an update. */
  const existing = { id: 555, body: `${ABURI_COMMENT_MARKER}\n\nold`, html_url: "u" }
  const routeTo = { create: { listPages: [[]] }, update: { listPages: [[existing]] } }

  it.each([
    {
      write: "create" as const,
      options: { createStatus: 401 },
      expected: /create PR comment: 401/,
    },
    { write: "update" as const, options: { patchStatus: 422 }, expected: /update PR comment: 422/ },
  ])("throws a contextual error when the $write request fails", async ({
    write,
    options,
    expected,
  }) => {
    const { fetch } = makeFakeFetch({ ...routeTo[write], ...options })
    await expect(
      upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch }),
    ).rejects.toThrow(expected)
  })

  it.each([
    { write: "create" as const, options: { createResponse: { id: 1, body: "no html_url" } } },
    { write: "update" as const, options: { patchResponse: { id: 555 } } },
  ])("throws when the $write response is missing id / body / html_url", async ({
    write,
    options,
  }) => {
    const { fetch } = makeFakeFetch({ ...routeTo[write], ...options })
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

describe("the comment-body size limit", () => {
  it("leaves the report exactly the room the marker does not take", () => {
    const withMarker = ensureMarker("x".repeat(ABURI_COMMENT_BODY_MAX_BYTES), ABURI_COMMENT_MARKER)
    expect(Buffer.byteLength(withMarker, "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
  })

  it("refuses an oversized body before touching the API", async () => {
    // GitHub answers this with a bare 422 that never says "too large", and only after the list
    // call has paged through every comment on the pull request. The message here names the size
    // and the flag that renders a smaller one.
    const { fetch, calls } = makeFakeFetch({ listPages: [[]] })
    await expect(
      upsertPullRequestComment({
        ref: REF,
        // One byte over once the marker is on it, so `>` cannot drift to `>=` unnoticed.
        body: "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES + 1),
        token: "test-token",
        fetch,
      }),
    ).rejects.toThrow(/over GitHub's 65536-byte limit/)
    expect(calls).toHaveLength(0)
  })

  it("advises a budget derived from the marker actually in use", async () => {
    // A caller with a longer marker that re-rendered at the default 65507 would overflow again,
    // on the advice of this very message.
    const marker = "<!-- a much longer marker than the default one -->"
    const budget = 65536 - Buffer.byteLength(`${marker}\n\n`, "utf8")
    const { fetch } = makeFakeFetch({ listPages: [[]] })
    await expect(
      upsertPullRequestComment({
        ref: REF,
        body: "x".repeat(budget + 1),
        token: "test-token",
        marker,
        fetch,
      }),
    ).rejects.toThrow(`--max-bytes ${budget}`)
  })

  it("posts a body that lands exactly on the limit", async () => {
    const { fetch, calls } = makeFakeFetch({
      listPages: [[]],
      createResponse: {
        id: 333,
        body: "at the limit",
        html_url: "https://github.com/kage1020/Aburi/pull/42#issuecomment-333",
      },
    })
    const outcome = await upsertPullRequestComment({
      ref: REF,
      body: "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES),
      token: "test-token",
      fetch,
    })
    expect(outcome.action).toBe("created")
    expect(calls.some((c) => c.method === "POST")).toBe(true)
  })
})
