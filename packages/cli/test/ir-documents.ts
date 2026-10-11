import { makeIR, makeSymbol, recordingLogger } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol, SkippedFile } from "@aburi/types"
import { type DiffOptions, IR_JSON_FILENAME, runDiff } from "../src"
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
  skipped?: readonly SkippedFile[]
  /** Files a document predating `stats.skippedFiles` lost without naming them. */
  unnamedLosses?: number
}

export function documentWith(shape: DocumentShape): IR {
  const lost = shape.skipped?.length ?? shape.unnamedLosses ?? 0
  const document = makeIR({ symbols: [...shape.symbols].sort(byKey((s) => s.id)) })
  return {
    ...document,
    stats: {
      ...document.stats,
      totalFiles: shape.symbols.length + lost,
      parsedFiles: shape.symbols.length,
      ...(shape.skipped === undefined
        ? {}
        : { skippedFiles: [...shape.skipped].sort(byKey((f) => f.path)) }),
    },
  }
}

/** A workspace root holding `document` where `aburi scan` would have written it. */
export async function writeScannedWorkspace(root: string, shape: DocumentShape): Promise<void> {
  await writePackageJson(root)
  await writeFileAt(root, ".aburi-workspace", "")
  await writeFileAt(root, `out/${IR_JSON_FILENAME}`, JSON.stringify(documentWith(shape)))
}

/** `runDiff` over `base` and `head` written into `root`, with every warning it gave. */
export async function diffDocuments(
  root: string,
  base: IR,
  head: IR,
  options: Omit<DiffOptions, "cwd" | "base" | "head" | "warn"> = {},
) {
  const paths = await writeIRs(root, base, head)
  const log = recordingLogger()
  const report = await runDiff({ cwd: root, ...paths, warn: log.warn, ...options })
  return { report, paths, warnings: log.warnings, said: log.warnings.join("\n") }
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}
