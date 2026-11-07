import type { Logger } from "@aburi/types"
import { type ExtractedFiles, ExtractionCollator } from "./collate"
import {
  createFileExtractor,
  type ExtractionJob,
  type ExtractionPlugins,
  type FileExtraction,
} from "./extract-file"

export type { ExtractedFiles, ExtractionFailure, ParseErrorRecord } from "./collate"

/** Extracts a scan's files on threads of its own. */
export interface ParsePool {
  /** The answers may settle in any order; the scan folds them in file order. */
  extract(fileId: number): Promise<FileExtraction>
  /** Ends the pool; an extraction still pending rejects. */
  close(): Promise<void>
}

/** A pool for the job, or `null` for the scan to extract every file on its own thread. */
export type ParsePoolFactory = (job: ExtractionJob) => ParsePool | null

export interface ExtractFilesInput extends ExtractionJob, ExtractionPlugins {
  logger: Logger
  parsePool?: ParsePoolFactory
}

export async function extractFiles(input: ExtractFilesInput): Promise<ExtractedFiles> {
  const job: ExtractionJob = {
    workspaceRoot: input.workspaceRoot,
    files: input.files,
    config: input.config,
    components: input.components,
  }
  const collator = new ExtractionCollator(input.files, input.logger)
  const pool = input.parsePool?.(job) ?? null
  if (pool === null) {
    const extractor = createFileExtractor(job, input)
    for (const [fileId] of input.files.entries()) collator.add(await extractor.extract(fileId))
    return collator.finish()
  }
  try {
    const extractions = input.files.map((_, fileId) => pool.extract(fileId))
    // The collator stops at the first file that ends the run, leaving the rest unawaited.
    for (const extraction of extractions) extraction.catch(() => {})
    for (const extraction of extractions) collator.add(await extraction)
  } finally {
    await pool.close()
  }
  return collator.finish()
}
