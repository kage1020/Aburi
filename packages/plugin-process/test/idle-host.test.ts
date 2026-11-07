import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { useScratchWorkspace } from "@aburi/test-support"
import { beforeAll, expect, it } from "vitest"

const DIST = fileURLToPath(new URL("../dist/index.mjs", import.meta.url))
const PEER = fileURLToPath(new URL("./fixtures/peer.mjs", import.meta.url))

const scratch = useScratchWorkspace("plugin-process-idle")

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error(`${DIST} is missing: build @aburi/plugin-process first.`)
})

it("lets its host exit with a process it never closed sitting idle, which then exits too", async () => {
  const script = [
    `import { createPluginProcess } from ${JSON.stringify(pathToFileURL(DIST).href)}`,
    `const plugin = createPluginProcess({ command: process.execPath, args: [${JSON.stringify(PEER)}] })`,
    `process.stdout.write(String(await plugin.request("pid")))`,
  ].join("\n")
  const exits = join(scratch.root, "exits")
  const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PEER_EXITS: exits },
    stdio: ["ignore", "pipe", "inherit"],
    // A host the process holds open would otherwise outlive the test.
    signal: AbortSignal.timeout(20_000),
  })
  host.on("error", () => {})
  let stdout = ""
  host.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  const code = await new Promise<number | null>((done) => host.on("close", done))

  expect(code).toBe(0)
  expect(Number(stdout)).toBeGreaterThan(0)
  // An orphan is not always reaped, so the process says it exited rather than leaving it to its pid.
  await expect.poll(() => readFile(exits, "utf8").catch(() => "")).toBe("x")
})
