import type { Logger } from "@aburi/types"
import { type ExtractedFiles, ExtractionCollator } from "./collate"
import {
  createFileExtractor,
  type ExtractionJob,
  type ExtractionPlugins,
  type FileExtraction,
} from "./extract-file"
import { initializePlugins } from "./lifecycle"

export type { ExtractedFiles, ExtractionFailure, ParseErrorRecord } from "./collate"

/** Extracts a scan's files on threads of its own, each bracketing its own plugins' lifecycle. */
export interface ParsePool {
  /** The answers may settle in any order; the scan folds them in file order. */
  extract(fileId: number): Promise<FileExtraction>
  /** Ends the pool once its threads have cleaned up their plugins; a pending extraction rejects. */
  close(): Promise<void>
}

/** A pool for the job, or `null` for the scan to extract every file on its own thread. */
export type ParsePoolFactory = (job: ExtractionJob) => ParsePool | null

export interface ExtractFilesInput extends ExtractionJob, ExtractionPlugins {
  logger: Logger
  parsePool?: ParsePoolFactory
  progress?: (done: number, total: number) => void
}

export async function extractFiles(input: ExtractFilesInput): Promise<ExtractedFiles> {
  const job: ExtractionJob = {
    workspaceRoot: input.workspaceRoot,
    ...(input.installedRoot === undefined ? {} : { installedRoot: input.installedRoot }),
    files: input.files,
    config: input.config,
    components: input.components,
  }
  const collator = new ExtractionCollator(input.files, input.logger)
  const total = input.files.length
  let done = 0
  input.progress?.(done, total)
  const pool = input.parsePool?.(job) ?? null
  if (pool === null) {
    const cleanUp = await initializePlugins(input, job, input.logger)
    try {
      const extractor = createFileExtractor(job, input)
      for (const [fileId] of input.files.entries()) {
        collator.add(await extractor.extract(fileId))
        input.progress?.(++done, total)
      }
    } finally {
      await cleanUp()
    }
    return collator.finish()
  }
  let folding = true
  try {
    const extractions = input.files.map((_, fileId) => pool.extract(fileId))
    // Counted as they finish, not as they are folded, so one slow file does not stall the count;
    // the collator stops at the first file that ends the run, leaving the rest unawaited.
    for (const extraction of extractions) {
      extraction.then(
        () => {
          if (folding) input.progress?.(++done, total)
        },
        () => {},
      )
    }
    for (const extraction of extractions) collator.add(await extraction)
  } finally {
    folding = false
    await pool.close()
  }
  return collator.finish()
}
