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

/**
 * The script is exercised as a process against a real HTTP server, not as an imported function
 * with an injected `fetch`: what `action.yml` and `aburi-comment.yml` depend on is the contract
 * between them and a child process — env in, exit code and `$GITHUB_OUTPUT` out — and a unit test
 * of the flow already exists next door in `comment.test.ts`, over the library form.
 */
async function withApi(
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
    const reply = replies(request)
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

/**
 * Run the script with the environment fully spelled out — never inherited. A CI runner has
 * `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and `GITHUB_OUTPUT` of its own, and inheriting them would
 * make the negative cases pass for the wrong reason, and append this test's outputs to the real
 * step's.
 */
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

/** `?page=` as the script asked for it. Read off the parsed query, because the literal `page=1`
 * is also a substring of `per_page=100` — a page-1 test that matches on the raw path matches
 * every page and loops until the suite times out. */
function pageOf(request: RecordedRequest): number {
  return Number(new URL(request.path, "http://localhost").searchParams.get("page") ?? "0")
}

function comment(id: number, body: string) {
  return { id, body, html_url: `https://github.example/c/${id}` }
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
    // Two implementations of one comment: this script (what the action and the `workflow_run`
    // companion run) and `src/comment.ts` (what an importer calls). A marker that drifts between
    // them orphans every comment already on a pull request — the update silently becomes a second
    // comment instead.
    const source = await readFile(SCRIPT, "utf8")
    expect(source).toContain(`const MARKER = "${ABURI_COMMENT_MARKER}"`)
  })

  it("measures against the same limit the library holds", async () => {
    const source = await readFile(SCRIPT, "utf8")
    expect(source).toContain(`const MAX_BYTES = ${GITHUB_COMMENT_MAX_BYTES}`)
  })

  it("is exit 2 on a report GitHub would reject, without posting it", async () => {
    // The 422 this replaces says nothing about size and arrives after the list call has paged
    // through the whole pull request. Nothing here can re-render the document — that is what
    // `aburi diff --max-bytes` is for — so it says which file, how big, and what to do.
    //
    // One byte over, measured with the marker: `"x".repeat(GITHUB_COMMENT_MAX_BYTES)` would be
    // the limit plus the marker's 29, and would pass just as well against a `>=` comparison.
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
    // The other side of the boundary, so `>` cannot drift to `>=` unnoticed: one byte less than
    // the case above is the largest report the default budget is calculated to allow.
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
    // The other branch of `raw.includes(MARKER)`: nothing is prepended, so the whole 65536 is
    // the report's to use. Prepending a second marker would also be an in-place update that
    // never finds its own comment again.
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
    // A re-run that PATCHes an identical body notifies everyone subscribed to the pull request to
    // tell them nothing changed.
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
        expect(requests.filter((r) => r.method === "GET")).toHaveLength(2)
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
    // Exit 2 rather than 1: `diff.md` missing is a statement about the caller's setup — the wrong
    // `output-dir`, an artifact that did not carry the report — not about this pull request's code.
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
    // A read-only token reaching the create is exactly the fork case this script exists for, and
    // the annotation is where the reader learns it: the Checks UI shows the first line of one, so
    // there is only ever one.
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
    // A row the parser rejects is skipped, and if that row was Aburi's own comment the upsert
    // creates a second one instead of rewriting the first — the in-place update the whole design
    // rests on, failing with nothing in the log to explain the duplicate.
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
