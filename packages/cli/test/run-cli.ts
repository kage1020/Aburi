import { Writable } from "node:stream"
import { type ExitCode, runCli } from "../src"

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

const ERASE_LINE = "\r\u001b[2K"

/** The colour sequences the CLI writes: yellow, red and dim, and the resets that close them. */
const SGR = ["33", "31", "2", "39", "22"].map((code) => `\u001b[${code}m`)

export function withoutColour(text: string): string {
  return SGR.reduce((stripped, sequence) => stripped.replaceAll(sequence, ""), text)
}

/** What `text`, written to a terminal, leaves on it: a carriage return and erase-line wipe the line. */
export function screenOf(text: string): string {
  const lines = text.split("\n").map((line) => {
    const erased = line.lastIndexOf(ERASE_LINE)
    return erased === -1 ? line : line.slice(erased + ERASE_LINE.length)
  })
  const last = lines.pop() ?? ""
  return [...lines, ...(last.length === 0 ? [] : [last])].map((kept) => `${kept}\n`).join("")
}
