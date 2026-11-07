import { noopRegistry, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type {
  ExtKind,
  FrameworkPlugin,
  LanguagePlugin,
  ParseResult,
  VocabRegistry,
} from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import {
  createFileExtractor,
  type ExtractionJob,
  type FileExtraction,
  type ParsePoolFactory,
  serializeCanonical,
} from "../../src"
import {
  extractorPool,
  oneSymbolPerFile,
  scanStubs,
  stubFrameworkPlugin,
} from "../fixtures/plugins"

const FILES = ["a", "b", "c", "d", "e"].map((name) => `${name}.stub`)
const workspace = useScratchWorkspace("parse-pool")
beforeEach(async () => {
  for (const path of FILES) await workspace.writeSource(path, path)
})

/** `b.stub` and `d.stub` parse to no tree. */
const language = (): LanguagePlugin =>
  oneSymbolPerFile({
    parseFile: async (file): Promise<ParseResult> =>
      file.path === "b.stub" || file.path === "d.stub"
        ? { tree: null, errors: [], imports: [] }
        : { tree: {}, errors: [], imports: [] },
  })

/** Gives the Symbol of `c.stub` an extKind no manifest declares. */
const rogue = (): FrameworkPlugin =>
  stubFrameworkPlugin("framework-stub", {
    classifySymbol: (symbol) =>
      symbol.id.includes(":c.stub#")
        ? { extKind: "framework:stub:rogue" as ExtKind, derivedBy: "framework-stub:x" }
        : null,
  })

const refusing: VocabRegistry = {
  ...noopRegistry,
  assertExtKindDeclared: (id) => {
    throw Object.assign(new Error(`"${id}" is not declared`), { code: "vocab-undeclared" })
  },
}

function poolOf(
  extract: (fileId: number) => Promise<FileExtraction>,
  closed: string[],
): ParsePoolFactory {
  return () => ({
    extract,
    close: async () => {
      closed.push("closed")
    },
  })
}

describe("scan — a parse pool", () => {
  it("is handed the files the scan discovered, numbered in the order it found them", async () => {
    const jobs: ExtractionJob[] = []
    const result = await scanStubs(workspace.root, {
      languages: [language()],
      parsePool: (job) => {
        jobs.push(job)
        return null
      },
    })

    expect(jobs.map((job) => job.files.map((file) => file.path))).toEqual([FILES])
    expect(result.ir.symbols.map((symbol) => symbol.id)).toHaveLength(3)
  })

  it("stops at the first file in order whose fault ends the run, saying only what came before it", async () => {
    const run = async (parsePool?: ParsePoolFactory) => {
      const logger = recordingLogger()
      const outcome = await scanStubs(workspace.root, {
        languages: [language()],
        frameworks: [rogue()],
        registry: refusing,
        logger,
        ...(parsePool === undefined ? {} : { parsePool }),
      }).then(
        () => null,
        (error: unknown) => error,
      )
      return { outcome, warnings: logger.warnings }
    }
    const alone = await run()
    const pooled = await run(
      extractorPool(
        2,
        () => ({ languages: [language()], frameworks: [rogue()], effects: [], registry: refusing }),
        // The file after the fault finishes first, on the other extractor.
        (fileId) => (fileId === 3 ? 1 : 0),
      ),
    )

    expect(alone.warnings).toEqual([expect.stringMatching(/^Skipped b\.stub: /)])
    expect(alone.outcome).toMatchObject({ code: "vocab-undeclared" })
    expect(pooled.warnings).toEqual(alone.warnings)
    expect(pooled.outcome).toMatchObject({
      code: "vocab-undeclared",
      message: (alone.outcome as Error).message,
    })
  })

  it("withdraws a file whose extraction ended the thread it ran on, and names it", async () => {
    const logger = recordingLogger()
    const closed: string[] = []
    const result = await scanStubs(workspace.root, {
      languages: [language()],
      logger,
      parsePool: (job) => {
        const extractor = createFileExtractor(job, {
          languages: [language()],
          frameworks: [],
          effects: [],
          registry: noopRegistry,
        })
        return poolOf(
          async (fileId) =>
            fileId === 2
              ? {
                  fileId,
                  outcome: { kind: "crashed", detail: "its parser worker ran out of heap" },
                  events: [],
                }
              : extractor.extract(fileId),
          closed,
        )(job)
      },
    })

    expect(result.skipped.find((file) => file.path === "c.stub")).toEqual({
      path: "c.stub",
      reason: "extraction-failed",
      detail: "its parser worker ran out of heap",
    })
    expect(result.extractionFailures).toEqual([
      {
        file: "c.stub",
        message: "its parser worker ran out of heap",
        code: "extraction-thread-ended",
      },
    ])
    expect(logger.warnings).toContain("Skipped c.stub: its parser worker ran out of heap")
    expect(closed).toEqual(["closed"])
  })

  it("ends the scan with the error a pool rejects with, once it has closed the pool", async () => {
    const closed: string[] = []
    const failure = new Error("the pool gave up")
    const outcome = scanStubs(workspace.root, {
      languages: [language()],
      parsePool: poolOf(() => Promise.reject(failure), closed),
    })

    await expect(outcome).rejects.toBe(failure)
    expect(closed).toEqual(["closed"])
  })

  it("writes the IR one extractor writes, whichever extractor each file went to", async () => {
    const alone = await scanStubs(workspace.root, { languages: [language()] })
    const pooled = await scanStubs(workspace.root, {
      languages: [language()],
      parsePool: extractorPool(
        3,
        () => ({ languages: [language()], frameworks: [], effects: [], registry: noopRegistry }),
        (fileId) => FILES.length - fileId,
      ),
    })

    expect(serializeCanonical(pooled.ir)).toBe(serializeCanonical(alone.ir))
  })
})
