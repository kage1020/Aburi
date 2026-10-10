import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import {
  ABURI_COMMENT_BODY_MAX_BYTES,
  ABURI_COMMENT_MARKER,
  GITHUB_COMMENT_MAX_BYTES,
} from "../src/comment"

const execFileAsync = promisify(execFile)

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "upsert-comment.mjs",
)

interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string
  readonly body: string
}

interface Reply {
  readonly status?: number
  readonly json?: unknown
  readonly text?: string
}

function withApi(
  replies: (request: RecordedRequest) => Reply,
  run: (base: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  // `GET /user` as the default `github.token` gets it: the refusal an installation token gets.
  return withApiAs(
    { status: 403, json: { message: "Resource not accessible by integration" } },
    replies,
    run,
  )
}

/** {@link withApi}, with `GET /user` answered by `user`: who the token says it is. */
async function withApiAs(
  user: Reply,
  replies: (request: RecordedRequest) => Reply,
  run: (base: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  const server = await listen(async (req, res) => {
    const body = await readBody(req)
    const request: RecordedRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: String(req.headers.authorization ?? ""),
      body,
    }
    requests.push(request)
    const reply = request.path.endsWith("/user") ? user : replies(request)
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" })
    res.end(reply.text ?? JSON.stringify(reply.json ?? {}))
  })
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`, requests)
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler)
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += String(chunk)
    })
    req.on("end", () => done(raw))
  })
}

interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  /** Everything the script wrote to `$GITHUB_OUTPUT`, as the runner would read it back. */
  readonly outputs: Record<string, string>
}

const workspaces: string[] = []

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runScript(overrides: Record<string, string | undefined>): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "aburi-upsert-"))
  workspaces.push(dir)
  const outputPath = join(dir, "github-output")
  await writeFile(outputPath, "")

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    PATH: process.env.PATH ?? "",
    GITHUB_OUTPUT: outputPath,
    ...overrides,
  })) {
    if (value !== undefined) env[key] = value
  }

  let status = 0
  let stdout = ""
  let stderr = ""
  try {
    const done = await execFileAsync(process.execPath, [SCRIPT], { env })
    stdout = done.stdout
    stderr = done.stderr
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    status = failure.code ?? -1
    stdout = failure.stdout ?? ""
    stderr = failure.stderr ?? ""
  }

  const outputs: Record<string, string> = {}
  for (const line of (await readFile(outputPath, "utf8")).split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return { status, stdout, stderr, outputs }
}

async function markdownFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aburi-report-"))
  workspaces.push(dir)
  const path = join(dir, "diff.md")
  await writeFile(path, contents)
  return path
}

function pageOf(request: RecordedRequest): number {
  return Number(new URL(request.path, "http://localhost").searchParams.get("page") ?? "0")
}

/** The account the default `github.token` posts as. */
const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" }

function comment(id: number, body: string, user: { login: string; type: string } = ACTIONS_BOT) {
  return { id, body, html_url: `https://github.example/c/${id}`, user }
}

function baseEnv(base: string, markdownPath: string): Record<string, string> {
  return {
    GITHUB_API_URL: base,
    GITHUB_TOKEN: "secret-token",
    GITHUB_REPOSITORY: "kage1020/Aburi",
    PR_NUMBER: "42",
    MARKDOWN_PATH: markdownPath,
  }
}

describe("upsert-comment.mjs", () => {
  it("posts the same marker the library prepends", async () => {
    const source = await readFile(SCRIPT, "utf8")
    expect(source).toContain(`const MARKER = "${ABURI_COMMENT_MARKER}"`)
  })

  it("measures against the same limit the library holds", async () => {
    const source = await readFile(SCRIPT, "utf8")
    expect(source).toContain(`const MAX_BYTES = ${GITHUB_COMMENT_MAX_BYTES}`)
  })

  it("is exit 2 on a report GitHub would reject, without posting it", async () => {
    const path = await markdownFile("x".repeat(ABURI_COMMENT_BODY_MAX_BYTES + 1))
    await withApi(
      () => ({ json: [] }),
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(2)
        expect(run.stderr).toContain("::error::")
        expect(run.stderr).toContain("65536-byte comment limit")
        expect(run.stderr).toContain("--max-bytes")
        expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
        expect(requests).toHaveLength(0)
      },
    )
  })

  it("posts a report that lands exactly on the limit", async () => {
    const body = "x".repeat(ABURI_COMMENT_BODY_MAX_BYTES)
    const path = await markdownFile(body)
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [] } : { status: 201, json: comment(44, "x") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        const created = requests.find((r) => r.method === "POST")
        const posted = JSON.parse(created?.body ?? "{}").body as string
        expect(Buffer.byteLength(posted, "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
      },
    )
  })

  it("measures a report that already carries the marker as it stands", async () => {
    const body = `${ABURI_COMMENT_MARKER}\n\n${"x".repeat(GITHUB_COMMENT_MAX_BYTES - 29)}`
    expect(Buffer.byteLength(body, "utf8")).toBe(GITHUB_COMMENT_MAX_BYTES)
    const path = await markdownFile(body)
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [] } : { status: 201, json: comment(45, "x") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        const created = requests.find((r) => r.method === "POST")
        const posted = JSON.parse(created?.body ?? "{}").body as string
        expect(posted).toBe(body)
        expect(posted.split(ABURI_COMMENT_MARKER)).toHaveLength(2)
      },
    )
  })

  it("creates the comment when no marker comment is there, prefixing the marker", async () => {
    const path = await markdownFile("## Aburi\n\nsomething changed\n")
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [] } : { status: 201, json: comment(11, "x") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs).toEqual({ action: "created", "comment-id": "11" })

        const created = requests.find((r) => r.method === "POST")
        expect(created?.path).toBe("/repos/kage1020/Aburi/issues/42/comments")
        expect(created?.authorization).toBe("Bearer secret-token")
        const body = JSON.parse(created?.body ?? "{}").body as string
        expect(body.startsWith(ABURI_COMMENT_MARKER)).toBe(true)
        expect(body).toContain("something changed")
      },
    )
  })

  it("rewrites the existing marker comment in place", async () => {
    const path = await markdownFile("new report\n")
    await withApi(
      (request) =>
        request.method === "GET"
          ? {
              json: [
                comment(7, "unrelated"),
                comment(9, `${ABURI_COMMENT_MARKER}\n\nold report\n`),
              ],
            }
          : { json: comment(9, "patched") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs).toEqual({ action: "updated", "comment-id": "9" })

        const patched = requests.find((r) => r.method === "PATCH")
        expect(patched?.path).toBe("/repos/kage1020/Aburi/issues/comments/9")
        expect(requests.some((r) => r.method === "POST")).toBe(false)
      },
    )
  })

  it("writes nothing when the comment already holds the same bytes", async () => {
    const body = `${ABURI_COMMENT_MARKER}\n\nsame report\n`
    const path = await markdownFile("same report\n")
    await withApi(
      () => ({ json: [comment(4, body)] }),
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs).toEqual({ action: "unchanged", "comment-id": "4" })
        expect(requests.every((r) => r.method === "GET")).toBe(true)
      },
    )
  })

  it("never rewrites a person's comment that quotes the marker, and updates its own", async () => {
    const path = await markdownFile("# Aburi diff\n\n1 changed\n")
    const alice = { login: "alice", type: "User" }
    await withApi(
      (request) =>
        request.method === "GET"
          ? {
              json: [
                comment(101, `Why does the bot search for \`${ABURI_COMMENT_MARKER}\`?`, alice),
                comment(102, `${ABURI_COMMENT_MARKER}\n\n# planted`, alice),
                comment(202, `${ABURI_COMMENT_MARKER}\n\n# old report`),
              ],
            }
          : { json: comment(202, "patched") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs).toEqual({ action: "updated", "comment-id": "202" })
        const writes = requests.filter((r) => r.method !== "GET")
        expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
          "PATCH /repos/kage1020/Aburi/issues/comments/202",
        ])
      },
    )
  })

  it("creates its own comment when only a person's carries the marker", async () => {
    const path = await markdownFile("report\n")
    await withApi(
      (request) =>
        request.method === "GET"
          ? {
              json: [
                comment(102, `${ABURI_COMMENT_MARKER}\n\n# planted`, {
                  login: "alice",
                  type: "User",
                }),
              ],
            }
          : { status: 201, json: comment(303, "x") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs).toEqual({ action: "created", "comment-id": "303" })
        expect(requests.some((r) => r.method === "PATCH")).toBe(false)
      },
    )
  })

  it("matches a personal token's own login rather than any bot", async () => {
    const path = await markdownFile("report\n")
    const me = { login: "kage1020", type: "User" }
    await withApiAs(
      { json: { login: "kage1020" } },
      (request) =>
        request.method === "GET"
          ? {
              json: [
                comment(201, `${ABURI_COMMENT_MARKER}\n\n# a bot's`),
                comment(301, `${ABURI_COMMENT_MARKER}\n\n# mine`, me),
              ],
            }
          : { json: comment(301, "patched", me) },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs).toEqual({ action: "updated", "comment-id": "301" })
        expect(requests.find((r) => r.method === "PATCH")?.path).toBe(
          "/repos/kage1020/Aburi/issues/comments/301",
        )
      },
    )
  })

  it("puts the marker first even when the report quotes it further down", async () => {
    const path = await markdownFile(`report quoting \`${ABURI_COMMENT_MARKER}\`\n`)
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [] } : { status: 201, json: comment(12, "x") },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        const posted = JSON.parse(requests.find((r) => r.method === "POST")?.body ?? "{}")
          .body as string
        expect(posted.startsWith(`${ABURI_COMMENT_MARKER}\n\nreport quoting`)).toBe(true)
      },
    )
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
  ])("is exit 1 on %s from GET /user, writing nothing", async (_case, user, named) => {
    const path = await markdownFile("report\n")
    await withApiAs(
      user,
      () => ({ json: [comment(9, `${ABURI_COMMENT_MARKER}\n\nold\n`)] }),
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(1)
        expect(run.stderr).toContain(named)
        expect(requests.every((r) => r.method === "GET")).toBe(true)
      },
    )
  })

  it("counts a marker comment whose author it cannot read as unreadable, and says so", async () => {
    const path = await markdownFile("report\n")
    const { user: _user, ...authorless } = comment(9, `${ABURI_COMMENT_MARKER}\n\nold\n`)
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [authorless] } : { status: 201, json: comment(10, "x") },
      async (base) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.stderr).toContain("::warning::1 comment(s)")
        expect(run.stderr).toContain("author login")
        expect(run.outputs.action).toBe("created")
      },
    )
  })

  it("asks who the token is once, across pages", async () => {
    // A person's marker comment on page 1 asks; Aburi's on page 2 reuses the answer.
    const path = await markdownFile("report\n")
    const alice = { login: "alice", type: "User" }
    const first = [
      comment(1, `${ABURI_COMMENT_MARKER}\n\n# planted`, alice),
      ...Array.from({ length: 99 }, (_, i) => comment(i + 2, "chatter")),
    ]
    await withApi(
      (request) => {
        if (request.method !== "GET") return { json: comment(500, "patched") }
        return pageOf(request) === 1
          ? { json: first }
          : { json: [comment(500, `${ABURI_COMMENT_MARKER}\n\nold\n`)] }
      },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.outputs).toEqual({ action: "updated", "comment-id": "500" })
        expect(requests.filter((r) => r.path.endsWith("/user"))).toHaveLength(1)
      },
    )
  })

  it("keeps paging until a short page, so a busy pull request still finds its comment", async () => {
    const path = await markdownFile("report\n")
    const full = Array.from({ length: 100 }, (_, i) => comment(i + 1, "chatter"))
    await withApi(
      (request) => {
        if (request.method !== "GET") return { json: comment(500, "patched") }
        return pageOf(request) === 1
          ? { json: full }
          : { json: [comment(500, `${ABURI_COMMENT_MARKER}\n\nold\n`)] }
      },
      async (base, requests) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.outputs.action).toBe("updated")
        expect(requests.filter((r) => r.path.includes("/comments?"))).toHaveLength(2)
      },
    )
  })

  it("preserves an API base that is mounted under a path (GitHub Enterprise Server)", async () => {
    const path = await markdownFile("report\n")
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [] } : { status: 201, json: comment(1, "x") },
      async (base, requests) => {
        const run = await runScript({ ...baseEnv(base, path), GITHUB_API_URL: `${base}/api/v3` })
        expect(run.status).toBe(0)
        expect(requests[0]?.path.startsWith("/api/v3/repos/kage1020/Aburi/")).toBe(true)
      },
    )
  })

  it.each([
    ["an empty token", { GITHUB_TOKEN: "" }, "GITHUB_TOKEN"],
    ["a repository that is not owner/repo", { GITHUB_REPOSITORY: "Aburi" }, "GITHUB_REPOSITORY"],
    ["a pull request number that is not one", { PR_NUMBER: "12abc" }, "PR_NUMBER"],
    ["no pull request number at all", { PR_NUMBER: "" }, "PR_NUMBER"],
  ])("is exit 2 and touches no API for %s", async (_case, override, named) => {
    const path = await markdownFile("report\n")
    await withApi(
      () => ({ json: [] }),
      async (base, requests) => {
        const run = await runScript({ ...baseEnv(base, path), ...override })
        expect(run.status).toBe(2)
        expect(run.stderr).toContain("::error::")
        expect(run.stderr).toContain(named)
        expect(run.outputs).toEqual({})
        expect(requests).toHaveLength(0)
      },
    )
  })

  it("is exit 2 when the Markdown is not there, naming the path it looked at", async () => {
    await withApi(
      () => ({ json: [] }),
      async (base, requests) => {
        const run = await runScript(baseEnv(base, "/nowhere/diff.md"))
        expect(run.status).toBe(2)
        expect(run.stderr).toContain("/nowhere/diff.md")
        expect(requests).toHaveLength(0)
      },
    )
  })

  it("is exit 1 with one line when GitHub refuses the write", async () => {
    const path = await markdownFile("report\n")
    await withApi(
      (request) =>
        request.method === "GET"
          ? { json: [] }
          : { status: 403, text: '{"message":"Resource not accessible by integration"}' },
      async (base) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(1)
        expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
        expect(run.stderr).toContain("403")
        expect(run.stderr).toContain("Resource not accessible by integration")
        expect(run.outputs).toEqual({})
      },
    )
  })

  it("says how many comments it could not read, rather than skipping them in silence", async () => {
    const path = await markdownFile("report\n")
    await withApi(
      (request) =>
        request.method === "GET"
          ? {
              json: [
                { id: 5, body: "no html_url here" },
                { id: "not a number", body: "x" },
              ],
            }
          : { status: 201, json: comment(6, "x") },
      async (base) => {
        const run = await runScript(baseEnv(base, path))
        expect(run.status).toBe(0)
        expect(run.stderr).toContain("::warning::2 comment(s)")
        expect(run.outputs.action).toBe("created")
      },
    )
  })

  it("runs without `$GITHUB_OUTPUT`, for a caller that is not a step", async () => {
    const path = await markdownFile("report\n")
    await withApi(
      (request) =>
        request.method === "GET" ? { json: [] } : { status: 201, json: comment(3, "x") },
      async (base) => {
        const run = await runScript({ ...baseEnv(base, path), GITHUB_OUTPUT: undefined })
        expect(run.status).toBe(0)
        expect(run.stdout).toContain("Aburi comment 3 created")
      },
    )
  })
})
