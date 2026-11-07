import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { useScratchWorkspace } from "@aburi/test-support"
import { afterEach, describe, expect, it } from "vitest"
import {
  createPluginProcess,
  type PluginProcess,
  PluginProcessError,
  type PluginProcessErrorCode,
  type PluginProcessOptions,
} from "../src"
import { isRunning } from "./processes"

const PEER = fileURLToPath(new URL("./fixtures/peer.mjs", import.meta.url))
const NAME = `${process.execPath} ${PEER}`

const scratch = useScratchWorkspace("plugin-process")
let opened: PluginProcess[] = []

afterEach(async () => {
  await Promise.all(opened.map((plugin) => plugin.close()))
  opened = []
})

function peer(options: Partial<PluginProcessOptions> = {}, flags: string[] = []): PluginProcess {
  const plugin = createPluginProcess({
    command: process.execPath,
    args: [PEER, ...flags],
    ...options,
  })
  opened.push(plugin)
  return plugin
}

describe("a plugin process", () => {
  it("sends each request as one JSON-RPC line, leaving out params it was not given", async () => {
    const plugin = peer()

    expect(await plugin.request("request", { file: "a.py" })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"request","params":{"file":"a.py"}}',
    )
    expect(await plugin.request("request")).toBe('{"jsonrpc":"2.0","id":2,"method":"request"}')
  })

  it("matches answers that come back out of order to their requests, on one process", async () => {
    const plugin = peer()
    const pid = await plugin.request("pid")

    const answers = await Promise.all([
      plugin.request("delay", { ms: 200, value: "slow" }),
      plugin.request("delay", { ms: 0, value: "fast" }),
      plugin.request("crlf"),
    ])

    expect(answers).toEqual(["slow", "fast", "ok"])
    expect(await plugin.request("pid")).toBe(pid)
  })

  it("rejects a request answered with an error and keeps the process", async () => {
    const plugin = peer()
    const pid = await plugin.request("pid")

    await expect(plugin.request("fail", { message: "no tree for a.py" })).rejects.toMatchObject({
      code: "error-response",
      message: `${NAME} answered fail with an error: no tree for a.py`,
    })
    expect(await plugin.request("pid")).toBe(pid)
  })

  it.each<[string, Partial<PluginProcessOptions>, string, unknown, PluginProcessErrorCode, RegExp]>(
    [
      [
        "exits",
        {},
        "crash",
        { code: 3, stderr: "boom\n" },
        "exited",
        /exited with code 3\. It wrote on stderr:\nboom$/,
      ],
      [
        "answers nothing in time",
        {},
        "hang",
        undefined,
        "timeout",
        /did not answer hang within 300ms$/,
      ],
      [
        "writes a line over maxResponseBytes",
        { maxResponseBytes: 1_024 },
        "big",
        { bytes: 2_048 },
        "oversize",
        /wrote a line longer than maxResponseBytes \(1024 bytes\)$/,
      ],
      [
        "writes a line that is no answer",
        {},
        "garbage",
        undefined,
        "protocol",
        /answers no request it was sent: Traceback \(most recent call last\):$/,
      ],
    ],
  )(
    "rejects a request when the process %s, and starts another for the next",
    async (_, options, method, params, code, says) => {
      const plugin = peer(options)
      const pid = await plugin.request("pid")

      const failed = plugin.request(method, params, method === "hang" ? { timeoutMs: 300 } : {})

      await expect(failed).rejects.toBeInstanceOf(PluginProcessError)
      await expect(failed).rejects.toMatchObject({ code, message: expect.stringMatching(says) })
      const next = await plugin.request("pid")
      expect(next).not.toBe(pid)
      await expect.poll(() => isRunning(pid as number)).toBe(false)
    },
  )

  it("rejects every request still waiting when the process ends", async () => {
    const plugin = peer()
    const outcomes = await Promise.allSettled([
      plugin.request("delay", { ms: 10_000, value: "never" }),
      plugin.request("crash", { code: 1, stderr: "" }),
    ])

    expect(outcomes.map((outcome) => outcome.status === "rejected" && outcome.reason)).toEqual([
      expect.objectContaining({ code: "exited", message: `${NAME} exited with code 1` }),
      expect.objectContaining({ code: "exited", message: `${NAME} exited with code 1` }),
    ])
  })

  it("stops starting a process that ends three times without answering, until it is closed", async () => {
    const starts = join(scratch.root, "starts")
    const plugin = peer({ env: { ...process.env, PEER_STARTS: starts } }, ["--exit-at-start"])

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(plugin.request("pid")).rejects.toMatchObject({ code: "exited" })
    }
    await expect(plugin.request("pid")).rejects.toMatchObject({
      code: "abandoned",
      message: `${NAME} --exit-at-start ended 3 times without answering a request, so no more are sent to it. The last time: ${NAME} --exit-at-start exited with code 4`,
    })
    expect(await readFile(starts, "utf8")).toBe("xxx")

    await plugin.close()
    await expect(plugin.request("pid")).rejects.toMatchObject({ code: "exited" })
    expect(await readFile(starts, "utf8")).toBe("xxxx")
  })

  it("fails a request when the command cannot be started", async () => {
    const plugin = peer({ command: "aburi-no-such-command", args: [] })

    await expect(plugin.request("pid")).rejects.toMatchObject({
      code: "start-failed",
      message: expect.stringMatching(/^Could not start aburi-no-such-command: .*ENOENT/),
    })
  })

  it("ends the process on close, rejecting what it has not answered, and starts another after", async () => {
    const plugin = peer()
    const pid = (await plugin.request("pid")) as number
    const hanging = expect(plugin.request("hang")).rejects.toMatchObject({
      code: "closed",
      message: `${NAME} was closed before it answered`,
    })

    await plugin.close()

    await hanging
    expect(isRunning(pid)).toBe(false)
    expect(await plugin.request("pid")).not.toBe(pid)
  })

  it("kills on close a process that holds SIGTERM and outlives its stdin", async () => {
    const plugin = peer({}, ["--hold"])
    const pid = (await plugin.request("pid")) as number

    await plugin.close()

    expect(isRunning(pid)).toBe(false)
  })

  it.each<[Partial<PluginProcessOptions>, string]>([
    [{ timeoutMs: 0 }, "timeoutMs must be a positive integer (got 0)"],
    [{ timeoutMs: 1.5 }, "timeoutMs must be a positive integer (got 1.5)"],
    [{ maxResponseBytes: -1 }, "maxResponseBytes must be a positive integer (got -1)"],
  ])("refuses the options %o", (options, says) => {
    expect(() => createPluginProcess({ command: process.execPath, ...options })).toThrow(
      new RangeError(says),
    )
  })
})
