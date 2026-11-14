import type {
  DeclinedCall,
  ImportEdge,
  Symbol as IRSymbol,
  Logger,
  ParseError,
  ThisBinding,
} from "@aburi/types"
import type { ReceiverTypes, ThisBindingSites } from "../call-site"
import { countBy } from "../collections"
import { CoreError } from "../errors"
import { symbolIdFile } from "../id"
import type { ReadFile } from "../lsp"
import type { DiscoveredFile, SkippedFile } from "./discover"
import type { FileExtraction, FileOutcome } from "./extract-file"
import { type ExtractionEvent, edgesReadOnce } from "./extraction-events"
import type { FileFault, TreeReleaseFailure } from "./pipeline"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"
import type { UndeclaredVocabOccurrence } from "./vocab"

export interface ExtractionFailure {
  file: string
  message: string
  code?: string
}

export interface ParseErrorRecord {
  file: string
  errors: readonly ParseError[]
}

export interface ExtractedFiles {
  symbols: IRSymbol[]
  skipped: SkippedFile[]
  parseErrors: ParseErrorRecord[]
  timeoutEvents: ClassifyTimeoutEvent[]
  parseTimeouts: ParseTimeoutEvent[]
  extractionFailures: ExtractionFailure[]
  treeReleaseFailures: TreeReleaseFailure[]
  undeclaredVocab: UndeclaredVocabOccurrence[]
  importsByFile: Map<string, readonly ImportEdge[]>
  fileContents: Map<string, ReadFile>
  dynamicCallSites: Set<string>
  declinedCalls: DeclinedCall[]
  thisBindings: ThisBindingSites
  receiverTypes: ReceiverTypes
}

type Ran = Extract<FileOutcome, { kind: "ran" }>

/**
 * Folds each file's extraction into the scan's, in file order and saying what each said, so
 * where a file was extracted changes nothing the scan reports.
 */
export class ExtractionCollator {
  readonly #files: readonly DiscoveredFile[]
  readonly #logger: Logger
  readonly #thisBindings: Record<ThisBinding, Set<string>> = {
    class: new Set(),
    instance: new Set(),
  }
  readonly #receiverTypes = new Map<string, string | null>()
  readonly #out: ExtractedFiles = {
    symbols: [],
    skipped: [],
    parseErrors: [],
    timeoutEvents: [],
    parseTimeouts: [],
    extractionFailures: [],
    treeReleaseFailures: [],
    undeclaredVocab: [],
    importsByFile: new Map(),
    fileContents: new Map(),
    dynamicCallSites: new Set(),
    declinedCalls: [],
    thisBindings: this.#thisBindings,
    receiverTypes: this.#receiverTypes,
  }
  readonly #onceSeen = new Set<string>()
  readonly #resolverLinesSaid = new Set<string>()
  readonly #resolverFaults: string[] = []
  readonly #releaseWarned = new Set<string>()
  #next = 0

  constructor(files: readonly DiscoveredFile[], logger: Logger) {
    this.#files = files
    this.#logger = logger
  }

  /** Throws the error of an extraction that ends the run, as the run would have at that file. */
  add(extraction: FileExtraction): void {
    const file = this.#files[extraction.fileId]
    if (extraction.fileId !== this.#next || file === undefined) {
      throw outOfOrder(`file ${extraction.fileId}`, `file ${this.#next}`)
    }
    this.#next += 1
    const released = this.#replay(extraction.events)
    this.#settle(file, extraction.outcome, released)
  }

  finish(): ExtractedFiles {
    if (this.#next !== this.#files.length) {
      throw outOfOrder("the end of extraction", `file ${this.#next}`)
    }
    for (const [plugin, count] of countBy(this.#out.treeReleaseFailures, (f) => f.plugin)) {
      if (count > 1) {
        this.#logger.warn(`Plugin ${plugin} failed to release ${count} parse trees over this run.`)
      }
    }
    for (const [plugin, count] of countBy(this.#resolverFaults, (name) => name)) {
      if (count > 1) {
        this.#logger.warn(
          `Plugin ${plugin}: its import resolver failed ${count} times over this run.`,
        )
      }
    }
    return this.#out
  }

  #replay(events: readonly ExtractionEvent[]): TreeReleaseFailure[] {
    const fresh = events.filter((event) => {
      const once = onceOf(event)
      return once === undefined || !this.#onceSeen.has(once)
    })
    for (const event of events) {
      const once = onceOf(event)
      if (once !== undefined) this.#onceSeen.add(once)
    }

    const released: TreeReleaseFailure[] = []
    for (const event of fresh) {
      switch (event.kind) {
        case "log":
          this.#logger[event.level](event.message, event.meta)
          break
        case "resolver-log": {
          const line = `${event.plugin}\0${event.level}\0${event.message}`
          if (this.#resolverLinesSaid.has(line)) break
          this.#resolverLinesSaid.add(line)
          this.#logger[event.level](event.message, event.meta)
          break
        }
        case "resolver-fault": {
          const first = !this.#resolverFaults.includes(event.plugin)
          this.#resolverFaults.push(event.plugin)
          if (first) {
            this.#logger.warn(
              `${event.message} A name imported through one of its path aliases is attributed ` +
                "to the specifier as written.",
            )
          } else this.#logger.debug(`scan/import-origins: ${event.message}`)
          break
        }
        case "tree-release-failure":
          released.push(event.failure)
          break
        default:
          throw unhandled("event", event satisfies never)
      }
    }
    return released
  }

  #settle(file: DiscoveredFile, outcome: FileOutcome, released: TreeReleaseFailure[]): void {
    const out = this.#out
    switch (outcome.kind) {
      case "unroutable":
        out.skipped.push({
          path: file.path,
          reason: "unroutable",
          detail: "extension survived discovery filter but no plugin claims it",
        })
        return
      case "vanished":
        out.skipped.push({ path: file.path, reason: "unreadable", detail: outcome.detail })
        this.#logger.warn(
          `Skipped ${file.path}: it was no longer a file by the time it was read — ${outcome.detail}`,
        )
        return
      case "fatal":
        this.#release(released)
        throw outcome.error
      case "threw":
        this.#withdraw(file, outcome.message, outcome.code, `extraction threw — ${outcome.message}`)
        this.#release(released)
        return
      case "crashed":
        this.#withdraw(file, outcome.detail, "extraction-thread-ended", outcome.detail)
        return
      case "ran":
        this.#release(released)
        this.#ran(file, outcome)
        return
      default:
        throw unhandled("file outcome", outcome satisfies never)
    }
  }

  #withdraw(file: DiscoveredFile, message: string, code: string | undefined, said: string): void {
    this.#out.skipped.push({ path: file.path, reason: "extraction-failed", detail: message })
    this.#out.extractionFailures.push({
      file: file.path,
      message,
      ...(code === undefined ? {} : { code }),
    })
    this.#logger.warn(`Skipped ${file.path}: ${said}`)
  }

  #release(released: readonly TreeReleaseFailure[]): void {
    for (const failure of released) {
      this.#out.treeReleaseFailures.push(failure)
      if (this.#releaseWarned.has(failure.plugin)) continue
      this.#releaseWarned.add(failure.plugin)
      this.#logger.warn(
        `Plugin ${failure.plugin} did not release the parse tree for ${failure.file}: ${failure.detail}. ` +
          "A tree the plugin does not free is not reclaimed by the garbage collector, so a long " +
          "enough run exhausts the parser's heap.",
      )
    }
  }

  #ran(file: DiscoveredFile, { result, content, undeclaredVocab }: Ran): void {
    const out = this.#out
    // One thread remembers a file's edges once it has extracted it, so what a later read says
    // belongs to no file.
    if (result.kind !== "parse-timeout") this.#onceSeen.add(edgesReadOnce(file.path))
    if (result.parseErrors.length > 0) {
      out.parseErrors.push({ file: file.path, errors: result.parseErrors })
    }
    switch (result.kind) {
      case "parse-timeout": {
        const spent = Math.round(result.timeout.elapsedMs)
        const budget = result.timeout.budgetMs
        out.parseTimeouts.push(result.timeout)
        out.skipped.push({
          path: file.path,
          reason: result.kind,
          detail: `extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms)`,
        })
        this.#logger.warn(
          `Skipped ${file.path}: extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms). Override with config.parseTimeoutMs.`,
        )
        return
      }
      case "parse-failed": {
        const detail = describeParseFailure(result.parseErrors)
        out.skipped.push({ path: file.path, reason: result.kind, detail })
        this.#logger.warn(`Skipped ${file.path}: ${detail}`)
        out.importsByFile.set(result.path, result.imports)
        return
      }
      case "extracted": {
        const fault = result.fault ?? describeIdFault(result.symbols, file.path)
        if (fault !== null) {
          out.skipped.push({ path: file.path, reason: "extraction-failed", detail: fault.message })
          out.extractionFailures.push({ file: file.path, message: fault.message, code: fault.code })
          this.#logger.warn(`Skipped ${file.path}: ${fault.message}`)
          out.timeoutEvents.push(...result.timeoutEvents)
          out.importsByFile.set(file.path, result.imports)
          return
        }
        out.undeclaredVocab.push(...undeclaredVocab)
        out.fileContents.set(file.path, { content, fsPath: file.fsPath })
        out.timeoutEvents.push(...result.timeoutEvents)
        out.symbols.push(...result.symbols)
        out.importsByFile.set(result.path, result.imports)
        for (const key of result.dynamicCallSites) out.dynamicCallSites.add(key)
        out.declinedCalls.push(...result.declinedCalls)
        for (const [key, binding] of result.thisBindings) this.#thisBindings[binding].add(key)
        for (const [key, type] of result.receiverTypes) {
          const seen = this.#receiverTypes.get(key)
          this.#receiverTypes.set(key, seen === undefined || seen === type ? type : null)
        }
        return
      }
      default:
        throw unhandled("file outcome", result satisfies never)
    }
  }
}

function onceOf(event: ExtractionEvent): string | undefined {
  return "once" in event ? event.once : undefined
}

function describeParseFailure(errors: readonly ParseError[]): string {
  const fatal = errors.find((error) => error.recoverable === false)
  if (fatal !== undefined) return `parse reported a non-recoverable error at ${quote(fatal)}`
  const first = errors[0]
  if (first === undefined) return "the language plugin returned no tree"
  return `the language plugin returned no tree; first error at ${quote(first)}`
}

function quote(error: ParseError): string {
  return `${error.line}:${error.column} — ${error.message}`
}

function describeIdFault(symbols: readonly IRSymbol[], path: string): FileFault | null {
  const here = new Map<string, IRSymbol>()
  for (const symbol of symbols) {
    const claimed = symbolIdFile(symbol.id)
    if (claimed !== null && claimed !== path) {
      return {
        code: "duplicate-symbol-id",
        message:
          `Symbol id "${symbol.id}" names ${claimed}, which is not this file. An id carries the ` +
          `file its Symbol was declared in, so the language plugin wrote a path that is not ` +
          `this file's`,
      }
    }
    const twin = here.get(symbol.id)
    if (twin !== undefined) {
      return {
        code: "duplicate-symbol-id",
        message:
          `two Symbols share the id "${symbol.id}" (lines ${twin.source.startLine} and ` +
          `${symbol.source.startLine}); the language plugin gave two declarations one qualified ` +
          `name, and nothing it reported separates them`,
      }
    }
    here.set(symbol.id, symbol)
  }
  return null
}

const REPORT =
  "This is a bug in Aburi — please report it at https://github.com/aburi-dev/Aburi/issues."

function unhandled(what: string, value: never): CoreError {
  return new CoreError(
    `Internal error: the scan does not handle the ${what} ${JSON.stringify(value)}\n${REPORT}`,
    { code: "scan-outcome-unhandled" },
  )
}

function outOfOrder(reached: string, expected: string): CoreError {
  return new CoreError(
    `Internal error: the scan's extraction reached ${reached} while waiting for ${expected}\n${REPORT}`,
    { code: "scan-extraction-out-of-order" },
  )
}
