import { call, makeIR, makeSymbol, recordingLogger } from "@aburi/test-support"
import type {
  CallResolutionStats,
  DeclinedCall,
  Dependency,
  IR,
  Symbol as IRSymbol,
  SkippedFile,
} from "@aburi/types"
import {
  DEFAULT_OUTPUT_DIRNAME,
  type DiffOptions,
  type DiffReport,
  IR_JSON_FILENAME,
  runDiff,
} from "../src"
import { writeFileAt, writeIRs, writePackageJson } from "./workspace"

/** A Symbol named after its id's last segment, declared in `file` (by default the id's file). */
export function symbolFor(id: string, file?: string): IRSymbol {
  const name = id.slice(id.indexOf("#") + 1)
  if (file === undefined) return makeSymbol({ id, name })
  return makeSymbol({
    id,
    name,
    source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
  })
}

export interface DocumentShape {
  symbols: readonly IRSymbol[]
  dependencies?: readonly Dependency[]
  skipped?: readonly SkippedFile[]
  /** Files a document predating `stats.skippedFiles` lost without naming them. */
  unnamedLosses?: number
  declinedCalls?: readonly DeclinedCall[]
}

export function documentWith(shape: DocumentShape): IR {
  const lost = shape.skipped?.length ?? shape.unnamedLosses ?? 0
  const document = makeIR({
    symbols: [...shape.symbols].sort(byKey((s) => s.id)),
    dependencies: [...(shape.dependencies ?? [])],
  })
  return {
    ...document,
    stats: {
      ...document.stats,
      totalFiles: shape.symbols.length + lost,
      parsedFiles: shape.symbols.length,
      ...(shape.skipped === undefined
        ? {}
        : { skippedFiles: [...shape.skipped].sort(byKey((f) => f.path)) }),
      ...(shape.declinedCalls === undefined ? {} : { declinedCalls: [...shape.declinedCalls] }),
    },
  }
}

/** `documentWith(shape)` carrying `callResolution`, its first Symbol making the calls left unresolved. */
export function documentWithCensus(shape: DocumentShape, callResolution: CallResolutionStats): IR {
  const [first, ...rest] = shape.symbols
  if (first === undefined) throw new Error("documentWithCensus: a census needs a Symbol to call")
  const unresolved = Array.from(
    { length: callResolution.totalCalls - callResolution.resolvedCalls },
    (_, i) => call({ target: `mystery${i}`, line: i + 2 }),
  )
  const document = documentWith({
    ...shape,
    symbols: [{ ...first, calls: [...first.calls, ...unresolved] }, ...rest],
  })
  return { ...document, stats: { ...document.stats, callResolution } }
}

/** A workspace root holding `document` where `aburi scan` would have written it. */
export async function writeScannedWorkspace(root: string, shape: DocumentShape): Promise<void> {
  await writePackageJson(root)
  await writeFileAt(root, ".aburi-workspace", "")
  await writeFileAt(
    root,
    `${DEFAULT_OUTPUT_DIRNAME}/${IR_JSON_FILENAME}`,
    JSON.stringify(documentWith(shape)),
  )
}

/** `runDiff` over `base` and `head` written into `root`, with every warning it gave. */
export async function diffDocuments(
  root: string,
  base: IR,
  head: IR,
  options: Omit<DiffOptions, "cwd" | "base" | "head" | "warn"> = {},
): Promise<{
  report: DiffReport
  paths: { base: string; head: string }
  warnings: string[]
  said: string
}> {
  const paths = await writeIRs(root, base, head)
  const log = recordingLogger()
  const report = await runDiff({ cwd: root, ...paths, warn: log.warn, ...options })
  return { report, paths, warnings: log.warnings, said: log.warnings.join("\n") }
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}
