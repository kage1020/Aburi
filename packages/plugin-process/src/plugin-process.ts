import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"

export interface PluginProcessOptions {
  /** Run as `spawn` runs it, with no shell between. */
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** How long one request may wait for its answer, the process's own start included. */
  readonly timeoutMs?: number
  /** The longest line the process may write on stdout, in bytes. */
  readonly maxResponseBytes?: number
}

export interface RequestOptions {
  /** In place of the process's `timeoutMs`, for a request known to take longer or shorter. */
  readonly timeoutMs?: number
}

export interface PluginProcess {
  /** Sends one JSON-RPC request and resolves with its `result`, starting the process if none runs. */
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>
  /** Ends the process, if one runs. A later request starts another. */
  close(): Promise<void>
}

export type PluginProcessErrorCode =
  | "start-failed"
  | "exited"
  | "timeout"
  | "oversize"
  | "protocol"
  | "error-response"
  | "abandoned"
  | "closed"

export class PluginProcessError extends Error {
  readonly code: PluginProcessErrorCode

  constructor(message: string, code: PluginProcessErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "PluginProcessError"
    this.code = code
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024
const KILL_AFTER_MS = 5_000
const STDERR_TAIL_CHARS = 8 * 1024
const NEWLINE = 0x0a
// A process that dies before answering anything three times running will not answer the next
// request either, and starting it once per file would cost a scan thousands of starts.
const MAX_SILENT_ENDS = 3

interface Pending {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: PluginProcessError) => void
  readonly timer: NodeJS.Timeout
}

export function createPluginProcess(options: PluginProcessOptions): PluginProcess {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs")
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  )
  const name = [options.command, ...(options.args ?? [])].join(" ")
  let running: Running | null = null
  const ending = new Set<Promise<void>>()
  let silentEnds = 0
  let lastEnd: PluginProcessError | null = null
  let nextId = 1

  const start = (): Running => {
    const started = new Running(name, options, maxResponseBytes, (answered, why) => {
      if (running === started) running = null
      if (answered) {
        silentEnds = 0
      } else {
        silentEnds += 1
        lastEnd = why
      }
    })
    ending.add(started.closed)
    void started.closed.then(() => ending.delete(started.closed))
    return started
  }

  return {
    async request(method, params, requestOptions = {}) {
      const waitMs =
        requestOptions.timeoutMs === undefined
          ? timeoutMs
          : positiveInteger(requestOptions.timeoutMs, "timeoutMs")
      if (silentEnds >= MAX_SILENT_ENDS) {
        throw new PluginProcessError(
          `${name} ended ${MAX_SILENT_ENDS} times without answering a request, so no more are sent to it. The last time: ${lastEnd?.message ?? "no reason was given"}`,
          "abandoned",
          { cause: lastEnd },
        )
      }
      const id = nextId++
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
      running ??= start()
      return running.send(id, method, `${message}\n`, waitMs)
    },
    async close() {
      const current = running
      running = null
      current?.end(new PluginProcessError(`${name} was closed before it answered`, "closed"))
      silentEnds = 0
      lastEnd = null
      await Promise.all(ending)
    },
  }
}

/** One start of the process, from spawn to exit. */
class Running {
  readonly closed: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private readonly line: Buffer[] = []
  private lineBytes = 0
  private stderrTail = ""
  private answered = false
  private exited = false
  private failure: PluginProcessError | null = null
  private escalation: NodeJS.Timeout | undefined

  constructor(
    private readonly name: string,
    options: PluginProcessOptions,
    private readonly maxResponseBytes: number,
    private readonly onEnd: (answered: boolean, why: PluginProcessError) => void,
  ) {
    this.child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    // Pending requests hold their timers, which keep the event loop alive while they wait; an
    // idle process must not, so a plugin that never closes it still lets its host exit.
    this.child.unref()
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      unref(stream)
    }
    // A write to a process that has gone fails here too; its end is reported once, by `close`.
    this.child.stdin.on("error", () => {})
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk))
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS)
    })
    this.closed = new Promise((done) => {
      this.child.on("error", (error) => {
        this.fail(
          new PluginProcessError(`Could not start ${name}: ${error.message}`, "start-failed", {
            cause: error,
          }),
        )
        if (this.child.pid === undefined) this.settle(done)
      })
      this.child.on("close", (code, signal) => {
        this.fail(
          new PluginProcessError(
            `${name} ${signal === null ? `exited with code ${code}` : `ended on ${signal}`}${this.quotedStderr()}`,
            "exited",
          ),
        )
        this.settle(done)
      })
    })
  }

  send(id: number, method: string, line: string, timeoutMs: number): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reject(
          id,
          new PluginProcessError(
            `${this.name} did not answer ${method} within ${timeoutMs}ms`,
            "timeout",
          ),
        )
        this.end(
          new PluginProcessError(
            `${this.name} was ended because it did not answer ${method} within ${timeoutMs}ms`,
            "exited",
          ),
        )
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.child.stdin.write(line)
    })
  }

  /** Rejects what is still waiting with `why` and stops the process. */
  end(why: PluginProcessError): void {
    this.fail(why)
    if (this.exited || this.escalation !== undefined) return
    this.child.stdin.end()
    this.child.kill("SIGTERM")
    // A process can hold SIGTERM; this timer also keeps the host alive until the process is gone.
    this.escalation = setTimeout(() => this.child.kill("SIGKILL"), KILL_AFTER_MS)
  }

  private read(chunk: Buffer): void {
    let start = 0
    for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
      if (!this.take(chunk.subarray(start, at))) return
      this.answer(Buffer.concat(this.line).toString("utf8"))
      this.line.length = 0
      this.lineBytes = 0
      start = at + 1
    }
    this.take(chunk.subarray(start))
  }

  private take(part: Buffer): boolean {
    this.lineBytes += part.length
    if (this.lineBytes > this.maxResponseBytes) {
      this.end(
        new PluginProcessError(
          `${this.name} wrote a line longer than maxResponseBytes (${this.maxResponseBytes} bytes)`,
          "oversize",
        ),
      )
      return false
    }
    this.line.push(part)
    return true
  }

  private answer(text: string): void {
    if (this.failure !== null || text.trim().length === 0) return
    const response = parseResponse(text)
    const waiting = response === null ? undefined : this.pending.get(response.id)
    if (response === null || waiting === undefined) {
      this.end(
        new PluginProcessError(
          `${this.name} wrote a line on stdout that answers no request it was sent: ${clip(text)}`,
          "protocol",
        ),
      )
      return
    }
    this.answered = true
    this.pending.delete(response.id)
    clearTimeout(waiting.timer)
    if ("error" in response) {
      waiting.reject(
        new PluginProcessError(
          `${this.name} answered ${waiting.method} with an error: ${response.error}`,
          "error-response",
        ),
      )
    } else {
      waiting.resolve(response.result)
    }
  }

  private reject(id: number, error: PluginProcessError): void {
    const waiting = this.pending.get(id)
    if (waiting === undefined) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.reject(error)
  }

  private fail(why: PluginProcessError): void {
    if (this.failure === null) {
      this.failure = why
      this.onEnd(this.answered, why)
    }
    for (const id of [...this.pending.keys()]) this.reject(id, this.failure)
  }

  private settle(done: () => void): void {
    this.exited = true
    clearTimeout(this.escalation)
    done()
  }

  private quotedStderr(): string {
    const tail = this.stderrTail.trimEnd()
    return tail.length === 0 ? "" : `. It wrote on stderr:\n${tail}`
  }
}

type Response = { id: number; result: unknown } | { id: number; error: string }

function parseResponse(text: string): Response | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const { id } = value as { id?: unknown }
  if (typeof id !== "number") return null
  if ("result" in value) return { id, result: value.result }
  if (!("error" in value)) return null
  const { error } = value
  const message =
    typeof error === "object" && error !== null && "message" in error ? error.message : error
  return { id, error: typeof message === "string" ? message : JSON.stringify(message) }
}

function clip(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function unref(stream: object): void {
  const handle = stream as { unref?: () => void }
  handle.unref?.()
}

function positiveInteger(value: number, option: string): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError(`${option} must be a positive integer (got ${String(value)})`)
}
