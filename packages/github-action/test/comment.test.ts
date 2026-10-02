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
  /** `GET /user`. Default: the 403 an installation token gets, as the default `github.token` does. */
  readonly userStatus?: number
  readonly userResponse?: unknown
}

/** The account the default `github.token` posts as. */
const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" }

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
    if (method === "GET" && url.endsWith("/user")) {
      const refusal = { message: "Resource not accessible by integration" }
      return new Response(JSON.stringify(options.userResponse ?? refusal), {
        status: options.userStatus ?? 403,
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
      user: ACTIONS_BOT,
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
      listPages: [[{ id: 333, body, html_url: "u", user: ACTIONS_BOT }]],
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
      user: ACTIONS_BOT,
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
    const gets = calls.filter((c) => c.method === "GET" && c.url.includes("/comments"))
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
    const existing = {
      id: 5,
      body: `${ABURI_COMMENT_MARKER}\n\nold`,
      html_url: "u",
      user: ACTIONS_BOT,
    }
    const { fetch, calls } = makeFakeFetch({
      listPages: [[existing]],
      patchResponse: { ...existing, body: `${ABURI_COMMENT_MARKER}\n\nx` },
    })
    await upsertPullRequestComment({ ref: REF, body: "x", token: "secret", fetch })
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"])
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
  const existing = {
    id: 555,
    body: `${ABURI_COMMENT_MARKER}\n\nold`,
    html_url: "u",
    user: ACTIONS_BOT,
  }
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

  describe("whose comment it is", () => {
    const quoted = {
      id: 101,
      body: `Why does the bot search for \`${ABURI_COMMENT_MARKER}\`?`,
      html_url: "u101",
      user: { login: "alice", type: "User" },
    }
    const planted = {
      id: 102,
      body: `${ABURI_COMMENT_MARKER}\n\n# a report alice wrote`,
      html_url: "u102",
      user: { login: "alice", type: "User" },
    }
    const ours = {
      id: 202,
      body: `${ABURI_COMMENT_MARKER}\n\n# old report`,
      html_url: "u202",
      user: ACTIONS_BOT,
    }

    it("passes over a person's comments that quote or open with the marker", async () => {
      const { fetch, calls } = makeFakeFetch({
        listPages: [[quoted, planted, ours]],
        patchResponse: { ...ours, body: `${ABURI_COMMENT_MARKER}\n\nnew` },
      })
      const outcome = await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(outcome).toMatchObject({ action: "updated", commentId: 202 })
      expect(calls.find((c) => c.method === "PATCH")?.url).toContain("/issues/comments/202")
    })

    it("creates its own comment when only a person's carries the marker", async () => {
      const { fetch, calls } = makeFakeFetch({
        listPages: [[quoted, planted]],
        createResponse: { id: 303, body: "x", html_url: "u303" },
      })
      const outcome = await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(outcome).toMatchObject({ action: "created", commentId: 303 })
      expect(calls.some((c) => c.method === "PATCH")).toBe(false)
    })

    it("asks who the token is only once a comment opens with the marker", async () => {
      const { fetch, calls } = makeFakeFetch({
        listPages: [[quoted]],
        createResponse: { id: 304, body: "x", html_url: "u304" },
      })
      await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(calls.some((c) => c.url.endsWith("/user"))).toBe(false)
    })

    it("matches a personal token's own login, and no bot's", async () => {
      const mine = { ...planted, id: 103, user: { login: "kage1020", type: "User" } }
      const { fetch, calls } = makeFakeFetch({
        listPages: [[ours, planted, mine]],
        userStatus: 200,
        userResponse: { login: "kage1020" },
        patchResponse: { ...mine, body: `${ABURI_COMMENT_MARKER}\n\nnew` },
      })
      const outcome = await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(outcome).toMatchObject({ action: "updated", commentId: 103 })
      expect(calls.find((c) => c.method === "PATCH")?.url).toContain("/issues/comments/103")
    })

    it("matches a GitHub App's bot under an installation token", async () => {
      const app = { ...ours, id: 204, user: { login: "aburi-reports[bot]", type: "Bot" } }
      const { fetch, calls } = makeFakeFetch({
        listPages: [[planted, app]],
        patchResponse: { ...app, body: `${ABURI_COMMENT_MARKER}\n\nnew` },
      })
      const outcome = await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(outcome).toMatchObject({ action: "updated", commentId: 204 })
      expect(calls.find((c) => c.method === "PATCH")?.url).toContain("/issues/comments/204")
    })

    it.each([
      { userStatus: 502, userResponse: { message: "bad gateway" }, expected: /user: 502/ },
      { userStatus: 401, userResponse: { message: "Bad credentials" }, expected: /user: 401/ },
      { userStatus: 404, userResponse: { message: "Not Found" }, expected: /user: 404/ },
      {
        userStatus: 403,
        userResponse: { message: "You have exceeded a secondary rate limit." },
        expected: /user: 403/,
      },
      { userStatus: 200, userResponse: { id: 1 }, expected: /a user without a login/ },
    ])("throws on a $userStatus from GET /user that is not the installation-token refusal", async ({
      userStatus,
      userResponse,
      expected,
    }) => {
      // Read as "an installation token", any of these would give up the login match for a
      // personal token: a duplicate report, or another bot's comment rewritten.
      const { fetch, calls } = makeFakeFetch({ listPages: [[ours]], userStatus, userResponse })
      await expect(
        upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch }),
      ).rejects.toThrow(expected)
      expect(calls.some((c) => c.method === "PATCH" || c.method === "POST")).toBe(false)
    })

    it("does not take a marker comment whose author it cannot read for its own", async () => {
      const { user: _user, ...authorless } = ours
      const { fetch, calls } = makeFakeFetch({
        listPages: [[authorless]],
        createResponse: { id: 305, body: "x", html_url: "u305" },
      })
      const outcome = await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(outcome).toMatchObject({ action: "created", commentId: 305 })
      expect(calls.some((c) => c.method === "PATCH")).toBe(false)
    })

    it("asks who the token is once, across pages", async () => {
      const filler = Array.from({ length: 99 }, (_, i) => ({
        id: 2000 + i,
        body: "chatter",
        html_url: "u",
        user: ACTIONS_BOT,
      }))
      const { fetch, calls } = makeFakeFetch({
        listPages: [[planted, ...filler], [ours]],
        patchResponse: { ...ours, body: `${ABURI_COMMENT_MARKER}\n\nnew` },
      })
      const outcome = await upsertPullRequestComment({ ref: REF, body: "new", token: "t", fetch })
      expect(outcome).toMatchObject({ action: "updated", commentId: 202 })
      expect(calls.filter((c) => c.url.endsWith("/user"))).toHaveLength(1)
    })
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
