import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import type { LanguagePlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { runDiff, runExplain, runScan } from "../src"
import {
  BYTES_PER_WORKER,
  DEFAULT_HEAP_PER_WORKER_MB,
  heapPerWorkerMb,
  type ParserSizing,
  parserWorkers,
} from "../src/parser-concurrency"
import { FAKE_LANGUAGE_PLUGIN, LANG_MANIFEST } from "./plugin-fakes"

/** A four-processor machine with memory to spare, scanning a workspace of plenty of source. */
const MACHINE: ParserSizing = {
  requested: undefined,
  fileCount: 1200,
  sourceBytes: 64 * BYTES_PER_WORKER,
  heapPerWorkerMb: 256,
  availableMemoryMb: 16_384,
  parallelism: 4,
  scansAtOnce: 1,
}

describe("parserWorkers", () => {
  it.each<[string, Partial<ParserSizing>, number]>([
    ["one fewer than the processors by default", {}, 3],
    ["one on a single processor", { parallelism: 1 }, 1],
    ["what --concurrency asks for", { requested: 8 }, 8],
    [
      "--concurrency, where memory allows it",
      { requested: 8, availableMemoryMb: 4096, heapPerWorkerMb: 512 },
      8,
    ],
    [
      "as many as memory allows, below --concurrency",
      { requested: 8, availableMemoryMb: 2048, heapPerWorkerMb: 512 },
      4,
    ],
    ["one where memory allows none", { availableMemoryMb: 100 }, 1],
    ["no more than there are files", { requested: 8, fileCount: 3 }, 3],
    [
      "none by default for less source than one worker pays for",
      { sourceBytes: BYTES_PER_WORKER - 1 },
      1,
    ],
    ["one for each worker's worth of source by default", { sourceBytes: 2 * BYTES_PER_WORKER }, 2],
    ["--concurrency however little the source", { requested: 2, sourceBytes: 10 }, 2],
    [
      "half the spare processors each when two scans run at once",
      { parallelism: 8, scansAtOnce: 2 },
      4,
    ],
    [
      "half the memory each when two scans run at once",
      { requested: 8, availableMemoryMb: 2048, scansAtOnce: 2 },
      4,
    ],
  ])("is %s", (_case, overrides, workers) => {
    expect(parserWorkers({ ...MACHINE, ...overrides })).toBe(workers)
  })
})

function language(wasmHeapPerWorkerMB?: number): LanguagePlugin {
  return {
    ...FAKE_LANGUAGE_PLUGIN,
    manifest: {
      ...LANG_MANIFEST,
      ...(wasmHeapPerWorkerMB === undefined ? {} : { capabilities: { wasmHeapPerWorkerMB } }),
    },
  }
}

describe("heapPerWorkerMb", () => {
  it.each<[string, (number | undefined)[], number]>([
    ["the largest any language declares", [256, 512], 512],
    ["what one language declares, below the default", [64], 64],
    ["the default for a language that declares none", [undefined], DEFAULT_HEAP_PER_WORKER_MB],
    ["the default when it is the largest", [64, undefined], DEFAULT_HEAP_PER_WORKER_MB],
  ])("is %s", (_case, declared, budget) => {
    expect(heapPerWorkerMb(declared.map(language))).toBe(budget)
  })
})

const workspace = useScratchWorkspace("parser-concurrency")

describe("a concurrency that is not a positive integer", () => {
  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])(
    "is refused by every command before it reads anything: %s",
    async (concurrency) => {
      const nowhere = join(workspace.root, "absent")
      const refused = {
        code: "input-error",
        message: `--concurrency must be a positive integer (got ${concurrency}).`,
      }

      await expect(runScan({ cwd: nowhere, concurrency })).rejects.toMatchObject(refused)
      await expect(
        runDiff({ cwd: nowhere, base: nowhere, head: nowhere, concurrency }),
      ).rejects.toMatchObject(refused)
      await expect(
        runExplain({ cwd: nowhere, argument: "alpha", irPath: nowhere, concurrency }),
      ).rejects.toMatchObject(refused)
    },
  )
})
