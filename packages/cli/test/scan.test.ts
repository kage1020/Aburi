import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli, runScan } from "../src"

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

/**
 * runScan integration tests — use a minimal on-disk workspace so config resolution and
 * plugin loading follow the real code paths. The scans always exit successfully because
 * no plugin is configured; the point of these tests is to lock in the ScanReport shape
 * that `run.ts` reads to decide whether to emit stderr warnings.
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "scan-fixture", private: true }),
    "utf8",
  )
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — happy path with no plugins", () => {
  it("produces an IR and a workspace.md with zero symbols", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "both",
    })
    expect(report.exitCode).toBe(0)
    expect(report.keptSymbols).toBe(0)
    expect(report.droppedSymbols).toBe(0)
    expect(report.irPath).not.toBeNull()
    expect(report.workspaceMdPath).not.toBeNull()
  })

  it("reports the call-resolution census even with nothing to resolve (§8.1)", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.callResolutionLine).toBe("calls 0 · resolved 0 · unresolved 0")
    expect(report.unresolvedCalls).toEqual([])
  })

  it("prints the census on stdout right after the kept/dropped line", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    const lines = stdout.text().trimEnd().split("\n")
    expect(lines[0]).toMatch(/^0 kept · 0 dropped · \d+ files$/)
    expect(lines[1]).toBe("calls 0 · resolved 0 · unresolved 0")
  })

  it("--format json skips markdown", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.irPath).not.toBeNull()
    expect(report.workspaceMdPath).toBeNull()
  })

  it("--format md skips the IR JSON", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "md",
    })
    expect(report.irPath).toBeNull()
    expect(report.workspaceMdPath).not.toBeNull()
  })

  it("exposes a skipped array (may include unroutable files when no lang plugin is loaded)", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(Array.isArray(report.skipped)).toBe(true)
    expect(report.parseErrorCount).toBe(0)
    expect(report.timeoutCount).toBe(0)
    // Without a lang plugin, package.json is discovered but has no route, so it may
    // land on the skipped list. Assert the shape rather than the exact contents.
    for (const entry of report.skipped) {
      expect(typeof entry.path).toBe("string")
      expect(typeof entry.reason).toBe("string")
    }
  })
})

describe("runScan — respects --ignore glob", () => {
  it("accepts CLI ignore globs without crashing (regression: empty ignore array)", async () => {
    await mkdir(resolve(scratch, "vendor"), { recursive: true })
    await writeFile(resolve(scratch, "vendor/x.ts"), "export const x = 1", "utf8")
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      ignore: ["vendor/**"],
    })
    expect(report.exitCode).toBe(0)
    // With no language plugin loaded totalFiles reflects discovery-time survival, not
    // parse survival. We only assert the run completed and produced an IR file.
    expect(report.irPath).not.toBeNull()
  })
})
