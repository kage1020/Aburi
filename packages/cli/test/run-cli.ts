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

export async function runCliIn(cwd: string, argv: readonly string[]): Promise<CliRun> {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const code = await runCli({ argv, cwd, stdout, stderr, env: {} })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}
