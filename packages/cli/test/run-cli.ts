import { Writable } from "node:stream"
import { type ExitCode, runCli } from "../src"
import type { LogWrite } from "../src/logger"

export class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

export interface CliRun {
  code: ExitCode
  stdout: string
  stderr: string
}

/** `aburi <argv>` in `cwd`, its stderr written to `stderr` (a pipe, unless a `TerminalStream`). */
export async function runCliIn(
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
  stderr: MemStream = new MemStream(),
): Promise<CliRun> {
  const stdout = new MemStream()
  const code = await runCli({ argv, cwd, stdout, stderr, env })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

/** A stream that says it is a terminal `columns` wide, as stderr on an interactive shell does. */
export class TerminalStream extends MemStream {
  readonly isTTY = true
  constructor(readonly columns = 200) {
    super()
  }
}

/** The carriage return and erase-line sequence that wipes the progress line. */
export const ERASE = "\r\u001b[2K"

/** `text` in each colour the CLI writes, opened and closed on the one line. */
export const YELLOW = (text: string): string => `\u001b[33m${text}\u001b[39m`
export const RED = (text: string): string => `\u001b[31m${text}\u001b[39m`
export const DIM = (text: string): string => `\u001b[2m${text}\u001b[22m`

const SGR = ["33", "31", "2", "39", "22"].map((code) => `\u001b[${code}m`)

export function withoutColor(text: string): string {
  return SGR.reduce((stripped, sequence) => stripped.replaceAll(sequence, ""), text)
}

/** What `text`, written to a terminal, leaves on it: a carriage return and erase-line wipe the line. */
export function screenOf(text: string): string {
  const lines = text.split("\n").map((line) => {
    const erased = line.lastIndexOf(ERASE)
    return erased === -1 ? line : line.slice(erased + ERASE.length)
  })
  const last = lines.pop() ?? ""
  return [...lines, ...(last.length === 0 ? [] : [last])].map((kept) => `${kept}\n`).join("")
}

/** Where a command run in process logs, so its lines stay with the test instead of on stderr. */
export interface CapturedLog {
  readonly lines: string[]
  readonly write: LogWrite
}

export function capturedLog(): CapturedLog {
  const lines: string[] = []
  return {
    lines,
    write: (line) => {
      lines.push(line)
    },
  }
}
