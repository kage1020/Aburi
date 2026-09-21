import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type {
  CallResolutionStats,
  Component,
  Config,
  Dependency,
  EffectClassifyTimeout,
  EffectPlugin,
  FrameworkPlugin,
  ImportEdge,
  IR,
  Symbol as IRSymbol,
  LanguagePlugin,
  Logger,
  LspEnrichmentStats,
  ParseError,
  PluginRef,
  SourceFile,
  Stats,
  UnresolvedCallDiagnostic,
  VocabRegistry,
  WorkspaceManager,
} from "@aburi/types"
import { dependencyKey } from "../call-site"
import { type CallEdge, resolveCallGraph } from "../callgraph"
import { serializeCanonical } from "../canonical"
import { countBy } from "../collections"
import { CoreError } from "../errors"
import { logicFingerprint } from "../fingerprint"
import { symbolIdFile } from "../id"
import { assertIRIntegrity } from "../integrity"
import { silentLogger } from "../logger"
import { enrichWithLsp, type ReadFile, type ServerFactory, withHintUsage } from "../lsp"
import { compareBy, compareCodeUnit } from "../order"
import { type PropagationStats, propagateEffects } from "../propagate"
import { buildComponentAttribution } from "./attribute"
import {
  type DiscoveredFile,
  discoverFiles,
  type SkippedFile,
  type UnrepresentableFile,
} from "./discover"
import { buildDropCFilter } from "./drop-c"
import { describeThrown, errorCode, isVanishedFile } from "./faults"
import { runFilePipeline, type TreeReleaseFailure } from "./pipeline"
import { buildLanguageRouter } from "./route"
import type { ClassifyTimeoutEvent, ParseTimeoutEvent } from "./timeout"

export interface ScanInput {
  /** Absolute workspace root. Every relative path in the IR is measured against this. */
  workspaceRoot: string
  /** Aburi config (from @aburi/config resolve). */
  config: Config
  languages: readonly LanguagePlugin[]
  frameworks: readonly FrameworkPlugin[]
  effects: readonly EffectPlugin[]
  registry: VocabRegistry
  logger?: Logger
  workspaceManagers?: readonly WorkspaceManager[]
  /**
   * The workspace's Components, which the scan both records on `IR.components` and reads
   * back to attribute each file (component-detect.md).
   *
   * Optional, and omitting it is a statement: a run with no Components attributes every
   * Symbol `null`, so the per-component views have nothing to group by. It stays optional
   * because a caller may legitimately have none to declare — the CLI always resolves them,
   * from the config or by detection, and a Document with an empty `components[]` is one
   * detection was never run for rather than one that found nothing (component-detect.md
   * guarantees at least one Component).
   */
  components?: readonly Component[]
  /** Generator metadata for `IR.generator`. Callers (the CLI) fill in name + version. */
  generator?: { name: string; version: string }
  /**
   * Optional injected LSP server factory. Real production always uses the
   * default (spawn). Tests inject an in-memory mock so no child process is
   * needed. When omitted the enrichment pass uses `spawnStdioServer` from the
   * `lsp` module.
   */
  lspServerFactory?: ServerFactory
}

export interface ScanResult {
  ir: IR
  parseErrors: readonly ParseErrorRecord[]
  /**
   * Every file the scan stopped working on, and why. `over-size` and `unroutable` are
   * decided before anything is read — `unroutable` by discovery when the name cannot hold a
   * Symbol id, and by the router here when no plugin claims the extension. `unreadable` can be
   * raised by either discovery or the read this function does just before extraction, and
   * `parse-failed`, `parse-timeout` and `extraction-failed` are decided during extraction.
   *
   * Not the same as "contributed no Symbols": a file that parses cleanly and declares
   * nothing — an empty file, one that is all imports — is absent from this list and counted
   * in `parsedFiles`, which is correct. What the list is exhaustive over is the set of files
   * the scan gave up on, which is what makes `parsedFiles` derivable from its length.
   *
   * Separate from `parseErrors`, which says what a file that *was* read had wrong with it,
   * but not disjoint from it: a file withdrawn by its parse, or slow enough to be abandoned
   * because it was broken, appears in both.
   */
  skipped: readonly SkippedFile[]
  /** Rich timeout observations for logging / CI signals. Aggregated into `ir.stats` too. */
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  /**
   * One record per file abandoned for exceeding `config.parseTimeoutMs`, in scan order.
   * These files also appear in `skipped` under `reason: "parse-timeout"`, which is what a
   * reader wanting the count consults; this carries the budget and the wall clock beside
   * it, so a caller can report how far over the file went without parsing a message.
   *
   * Deliberately not in `ir.stats`: unlike `effectClassifyTimeouts`, which records a
   * decision the Document embodies, this records a file the Document does not mention.
   */
  parseTimeouts: readonly ParseTimeoutEvent[]
  /**
   * One record per call the resolver left `resolved: null`, with the
   * call-resolution.md bucket that explains why. Counts are aggregated into
   * `ir.stats.callResolution`; the per-call detail deliberately stays out of
   * the IR (call-resolution.md) and is surfaced by
   * `aburi explain --debug-resolution`.
   */
  unresolvedCalls: readonly UnresolvedCallDiagnostic[]
  /**
   * One record per file withdrawn during extraction, in scan order: a plugin threw, or the
   * file's Symbols could not enter the Document (§7.2 — `code: "duplicate-symbol-id"`, the
   * one entry here nothing raised an error for).
   * These files also appear in `skipped` under `reason: "extraction-failed"`, which is what
   * a reader wanting the count consults; this carries the message beside it, the way
   * `parseTimeouts` carries the numbers `skipped` has nowhere to put.
   *
   * Non-empty means something in the run is broken — a plugin bug, or source the plugins
   * cannot express — rather than merely large or slow, which is why the CLI gates on it and
   * not on `skipped` as a whole.
   */
  extractionFailures: readonly ExtractionFailure[]
  /**
   * One record per parse tree the language plugin was asked to free and did not, in scan
   * order. Empty for every plugin that either frees its trees or has nothing to free.
   *
   * Not a fault, and it moves no exit code: every one of these files is in the IR with its
   * Symbols intact, so unlike `extractionFailures` and `unrepresentableFiles` the artifact
   * describes the workspace completely. It is loud-but-not-gating for the same reason
   * `unresolvedDeclarations` is.
   *
   * It is here rather than only in the log because the log is the channel most likely to be
   * off. A leak is silent until the run dies of it, and by then the failure presents as
   * `RangeError: WebAssembly.Memory()` charged to whichever unrelated file was being read at
   * the time — one entry in `extractionFailures` per file for the rest of the run, none of
   * them the cause. This list is the only thing that names the plugin before that happens.
   */
  treeReleaseFailures: readonly TreeReleaseFailure[]
  /**
   * One record per candidate file the Document has no way to name, in path order.
   *
   * These files appear nowhere else. They are not on `skipped`, because the path a skip entry
   * would be recorded under is one the shared path rule refuses; and they are not in
   * `stats.totalFiles`, because a file counted there and absent from `stats.skippedFiles`
   * breaks integrity #21. The Document is silent about them by construction, which is exactly
   * why the list is here: it is the run's only account of a file the format cannot hold.
   *
   * Non-empty means the workspace holds source the IR cannot describe, which is why the CLI
   * gates on it the way it gates on `extractionFailures` — a scan that quietly dropped a file
   * would otherwise report a clean run over an incomplete workspace.
   */
  unrepresentableFiles: readonly UnrepresentableFile[]
}

/**
 * A file the scan withdrew during extraction, whether a plugin threw or its Symbols could not
 * enter the Document. The list means one thing about every entry: the file is gone and the run
 * is not green. How it was lost is what `code` is for.
 *
 * `message` is the plugin's account of the file. For a thrown fault that is the error's
 * message, or the value stringified when what was thrown was not an `Error`; for
 * `duplicate-symbol-id` it is the description of the fault. There is no stack either way: the
 * caller needs to know which file to look at and what was wrong with it, and a stack across a
 * dynamically loaded plugin boundary points at the plugin's own dist rather than at anything
 * actionable.
 *
 * `code` names the fault when one is known, and is absent otherwise. It is what separates
 * "this source is something the plugins cannot express" — a coded
 * `anonymous-symbol-id-attempted`, which a reader can act on by changing the source — from a
 * plugin that crashed, which they can only report. Matching on the message text is the
 * alternative, and it is not one.
 *
 * A present `code` does **not** mean the file was lost to a throw. Most codes here are a
 * thrown error's own, but `duplicate-symbol-id` is not thrown at all: the pipeline ran to
 * completion and the file's Symbols then could not satisfy ir-schema.md invariant #1
 * under `code: "duplicate-symbol-id"`. A caller that branches on `code` sees both alike,
 * which is the point; a caller needing to know how the file was lost reads the code itself.
 */
export interface ExtractionFailure {
  file: string
  message: string
  code?: string
}

export interface ParseErrorRecord {
  file: string
  errors: readonly ParseError[]
}

/**
 * Top-level scan orchestration — the discover → route → pipeline → IR-assembly →
 * integrity-check chain:
 *
 *   1. File discovery via `discoverFiles` — respects `config.ignore`, `.gitignore`, and
 *      `config.maxFileSizeBytes`. Only files whose extension is claimed by a loaded
 *      language plugin survive.
 *   2. Language routing via `buildLanguageRouter`.
 *   3. Per-file extraction through `runFilePipeline` — parse → extractSymbols →
 *      framework classify → walkBody → effect classify (with per-call timeout) →
 *      Category B/C drop → fingerprint.
 *   4. Assemble the IR (Symbols + Components + Dependencies + Stats), sort every array
 *      per the schema's ordering rules.
 *   5. `assertIRIntegrity` — every ir-schema.md invariant must pass before we hand the IR back.
 *
 * Serialization to disk is the caller's job (`writeCanonicalIR` handles the canonical
 * JSON write). Keeping serialization off the scan path lets tests assert on the IR
 * object directly without touching the filesystem.
 */
export async function scan(input: ScanInput): Promise<ScanResult> {
  assertWorkspaceRootAbsolute(input.workspaceRoot)
  const logger = input.logger ?? silentLogger

  const router = buildLanguageRouter(input.languages)
  const langDropPatterns = languageFileDropPatterns(input.languages)

  const discoverOptions: Parameters<typeof discoverFiles>[0] = {
    workspaceRoot: input.workspaceRoot,
    ignore: input.config.ignore ?? [],
    langDropPatterns,
    respectGitignore: input.config.respectGitignore ?? true,
    languageExtensions: router.knownExtensions,
  }
  if (input.config.maxFileSizeBytes !== undefined) {
    discoverOptions.maxFileSizeBytes = input.config.maxFileSizeBytes
  }
  const discovered = await discoverFiles(discoverOptions)

  // Built before the loop and asked per file. `input.components` is the same list the IR
  // records, so a Symbol's `component` and the Component it names are two readings of one
  // input — which is what integrity invariant #3 (Symbol.component → Components[].id
  // existence) checks at the end of this function.
  const attribute = buildComponentAttribution(input.components ?? [])

  const dropCFilterInput: Parameters<typeof buildDropCFilter>[0] = {
    pluginDropCallees: input.effects.flatMap((e) => e.dropCallees ?? []),
  }
  if (input.config.suppress !== undefined) dropCFilterInput.suppress = input.config.suppress
  if (input.config.keep !== undefined) dropCFilterInput.keep = input.config.keep
  const dropCFilter = buildDropCFilter(dropCFilterInput)

  const symbols: IR["symbols"] = []
  const parseErrors: ParseErrorRecord[] = []
  const timeoutEvents: ClassifyTimeoutEvent[] = []
  const additionalSkipped: SkippedFile[] = []
  const parseTimeouts: ParseTimeoutEvent[] = []
  const extractionFailures: ExtractionFailure[] = []
  const treeReleaseFailures: TreeReleaseFailure[] = []
  // One warning per plugin, at the file it first went wrong on. The record below keeps
  // every occurrence; a line per file would be one per file for the rest of the run.
  const warnedReleaseFailure = new Set<string>()
  const importsByFile = new Map<string, readonly ImportEdge[]>()
  const fileContents = new Map<string, ReadFile>()
  const dynamicCallSites = new Set<string>()
  for (const discoveredFile of discovered.files) {
    // Discovery's `languageExtensions` filter already narrowed the file list to extensions
    // the router recognizes. If `route()` still returns null here it means the extension
    // filter and the router disagree — the discovered file survived the filter but the
    // plugin dispatcher rejected it. That is a contract bug worth recording rather than
    // silently dropping.
    const language = router.route(discoveredFile.path)
    if (language === null) {
      additionalSkipped.push({
        path: discoveredFile.path,
        reason: "unroutable",
        detail: "extension survived discovery filter but no plugin claims it",
      })
      continue
    }

    let sourceFile: SourceFile
    try {
      sourceFile = await loadSourceFile(input.workspaceRoot, discoveredFile)
    } catch (error) {
      // Only a file that is no longer one. `isVanishedFile` says which failures those are and
      // why the rest end the run; discovery applies the same predicate to its own `stat`, so
      // the stage a failure lands in does not change what happens to it.
      if (!isVanishedFile(error)) throw error
      const detail = describeThrown(error)
      additionalSkipped.push({ path: discoveredFile.path, reason: "unreadable", detail })
      logger.warn(
        `Skipped ${discoveredFile.path}: it was no longer a file by the time it was read — ${detail}`,
      )
      continue
    }

    // The per-file exception boundary (lang-plugin.md). Every plugin call for this file
    // happens inside `runFilePipeline`, which returns its whole result at once — so a throw
    // leaves no accumulator in this function half-written, and there is nothing to unwind.
    // (Not that nothing is lost: the file's classify-timeout events go with it, because they
    // travel on the result.) The catch lives here rather than in the pipeline because a
    // pipeline that swallowed the exception would need a fourth member on
    // `FilePipelineResult` to say "this file contributed nothing", beside the three fates a
    // pipeline that ran to completion has.
    let result: Awaited<ReturnType<typeof runFilePipeline>>
    const releasesRecordedBefore = treeReleaseFailures.length
    try {
      result = await runFilePipeline({
        file: sourceFile,
        language,
        frameworks: input.frameworks,
        effects: input.effects,
        registry: input.registry,
        config: input.config,
        dropCFilter,
        component: attribute(sourceFile.path),
        log: logger,
        treeReleaseFailures,
      })
    } catch (error) {
      if (isPluginSetFault(error)) throw error
      const message = describeThrown(error)
      // Unlike a timed-out file, this one loses its recoverable parse errors: the result
      // never materialized, so there is nothing to carry them. The thrown message is the
      // diagnostic in their place.
      additionalSkipped.push({
        path: discoveredFile.path,
        reason: "extraction-failed",
        detail: message,
      })
      const code = errorCode(error)
      extractionFailures.push({
        file: discoveredFile.path,
        message,
        ...(code === null ? {} : { code }),
      })
      logger.warn(`Skipped ${discoveredFile.path}: extraction threw — ${message}`)
      continue
    } finally {
      // In a `finally` because the catch above `continue`s. A plugin that both throws while
      // extracting and fails to free the tree is exactly the run that needs to hear both,
      // and the release runs on that path too.
      for (const failure of treeReleaseFailures.slice(releasesRecordedBefore)) {
        if (warnedReleaseFailure.has(failure.plugin)) continue
        warnedReleaseFailure.add(failure.plugin)
        logger.warn(
          `Plugin ${failure.plugin} did not release the parse tree for ${failure.file}: ${failure.detail}. ` +
            "A tree the plugin does not free is not reclaimed by the garbage collector, so a long " +
            "enough run exhausts the parser's heap.",
        )
      }
    }

    // Ahead of the switch because every outcome carries them, for the reasons on
    // `FileOutcomeCommon`.
    if (result.parseErrors.length > 0) {
      parseErrors.push({ file: discoveredFile.path, errors: result.parseErrors })
    }

    // `reason` is the outcome itself for the two that skip. The pipeline's discriminant and
    // `SkippedFile["reason"]` name the same two events, so spelling them again here would be
    // a second copy of the vocabulary to keep in step.
    switch (result.kind) {
      case "parse-timeout": {
        const spent = Math.round(result.timeout.elapsedMs)
        const budget = result.timeout.budgetMs
        parseTimeouts.push(result.timeout)
        // Elapsed and budget rather than the bare fact. They are what the reader acts on —
        // 5100ms against 5000 says raise it, 60000 against 5000 says look at the file — and
        // the log line beside this one was the only place they appeared, on a channel
        // `ABURI_LOG_LEVEL=error` silences. A machine-dependent number is safe here because
        // `detail` is never projected into the Document (`buildStats`), which is the one
        // place the bytes have to be stable.
        additionalSkipped.push({
          path: discoveredFile.path,
          reason: result.kind,
          detail: `extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms)`,
        })
        logger.warn(
          `Skipped ${discoveredFile.path}: extraction reached ${spent}ms, exceeding parseTimeoutMs (${budget}ms). Override with config.parseTimeoutMs.`,
        )
        break
      }
      case "parse-failed": {
        const detail = describeParseFailure(result.parseErrors)
        additionalSkipped.push({ path: discoveredFile.path, reason: result.kind, detail })
        logger.warn(`Skipped ${discoveredFile.path}: ${detail}`)
        // Nothing reads its import edges yet. `resolveCallGraph` looks this map up by the
        // file a Symbol came from, and a withdrawn file has no Symbols, so the entry is
        // inert until the dependency-extraction pass exists. It is written anyway because
        // dropping it would silently discard what the outcome is documented to carry.
        importsByFile.set(result.path, result.imports)
        break
      }
      case "extracted": {
        // Invariant #1, where the file can still be withdrawn and named. Ahead of every
        // accumulator below, so a refusal leaves nothing half-written — the same property the
        // exception boundary above gets from `runFilePipeline` returning its result at once.
        //
        // `discoveredFile.path` rather than `result.path`: the two are one value —
        // `loadSourceFile` copies it and `FileOutcomeCommon` carries it back — and this whole
        // branch is about paths that do not agree, so reading the file's path from two places
        // would put the reader to work proving they are not one of them.
        const collision = describeIdFault(result.symbols, discoveredFile.path)
        if (collision !== null) {
          additionalSkipped.push({
            path: discoveredFile.path,
            reason: "extraction-failed",
            detail: collision,
          })
          extractionFailures.push({
            file: discoveredFile.path,
            message: collision,
            code: "duplicate-symbol-id",
          })
          logger.warn(`Skipped ${discoveredFile.path}: ${collision}`)
          // What this file observed on its way here still happened, and is kept on the same
          // terms the `parse-failed` branch keeps it: the timeouts were measured by a pipeline
          // that ran to completion, so dropping them would under-report
          // `stats.effectClassifyTimeouts` for work the run really did; and the import edges
          // are what the outcome is documented to carry. Unlike the exception boundary above,
          // which loses both because its result never materialized, this branch has a result.
          //
          // The Symbols are the one thing that does not survive — they are the fault — and
          // `fileContents` goes with them, since LSP enrichment only ever looks up a file that
          // reached the IR.
          timeoutEvents.push(...result.timeoutEvents)
          importsByFile.set(discoveredFile.path, result.imports)
          break
        }

        // Held for LSP enrichment, and only for files that reached the IR. Nothing would
        // currently read a refused file's text if it were held — the pass builds one document
        // per file it has Symbols for, and a file that produced none is never looked up — so
        // the placement is what stops it being held rather than what stops it being read.
        fileContents.set(sourceFile.path, {
          content: sourceFile.content,
          fsPath: discoveredFile.fsPath,
        })

        timeoutEvents.push(...result.timeoutEvents)
        symbols.push(...result.symbols)
        importsByFile.set(result.path, result.imports)
        for (const key of result.dynamicCallSites) dynamicCallSites.add(key)
        break
      }
      default:
        // Throws rather than degrading, unlike `classifyConfigError` in `@aburi/cli`: that
        // union crosses a package boundary where the two versions can skew, and this one is
        // declared and consumed in this package.
        throw unhandledOutcome(result)
    }
  }

  // The count the per-file warning above deliberately does not repeat. One line per plugin,
  // and only when it went wrong more than once, so the run says how far the leak got without
  // saying it once per file. Insertion order, so these read as the tail of those lines.
  for (const [plugin, count] of countBy(treeReleaseFailures, (failure) => failure.plugin)) {
    if (count > 1) {
      logger.warn(`Plugin ${plugin} failed to release ${count} parse trees over this run.`)
    }
  }

  symbols.sort(compareBy((symbol) => symbol.id))

  // Optional LSP enrichment pass (lsp-enrichment.md). Runs BEFORE call
  // resolution so the LSP tier's receiver / implementer hints can feed the
  // resolver. When `config.lsp?.enabled !== true` the pass is a total no-op
  // and returns the input unchanged; determinism is preserved because
  // the pass writes only to the strictly bounded set of fields and only
  // when its cache is fully populated first.
  const enrichmentInput: Parameters<typeof enrichWithLsp>[0] = {
    symbols,
    workspaceRoot: input.workspaceRoot,
    fileContents,
    lspConfig: input.config.lsp,
    logger,
  }
  if (input.lspServerFactory !== undefined) enrichmentInput.serverFactory = input.lspServerFactory
  const enrichment = await enrichWithLsp(enrichmentInput)
  const enrichedSymbols = enrichment.symbols
  enrichedSymbols.sort(compareBy((symbol) => symbol.id))

  // Call-resolution + symbol → symbol edge projection (call-resolution.md,
  // ir-schema.md). The resolver rewrites `Symbol.calls[].resolved` in
  // place and returns per-call-site CallEdges; those are then collapsed into
  // `(from, to, via: "call")` Dependency triples with a stable `(from, to, via)`
  // sort. LSP hints (when present) supply the LSP tier.
  const callGraph = resolveCallGraph({
    symbols: enrichedSymbols,
    importsByFile,
    receiverHints: enrichment.receiverHints,
    implementerHints: enrichment.implementerHints,
    dynamicCallSites,
  })
  const symbolEdges = projectSymbolEdges(callGraph.edges)

  // Transitive effect propagation over the resolved call graph
  // (effect-propagation.md). Runs AFTER call resolution and BEFORE the
  // logic-fingerprint recompute below; `api` and `syntax` axes do not read
  // `effects[]`, so only `logic` needs to be refreshed on the augmented
  // symbols (effect-propagation.md).
  const propagation = propagateEffects({
    symbols: callGraph.symbols,
    edges: callGraph.edges,
  })
  const propagatedSymbols = propagation.symbols.map((s) =>
    s.dropped
      ? s
      : {
          ...s,
          fingerprint: { ...s.fingerprint, logic: logicFingerprint(s) },
        },
  )

  // `parsedFiles` is one subtraction: every `additionalSkipped` entry is a file this loop
  // stopped working on and nothing else is, which holds because every branch that pushes one
  // ends its iteration (at most one entry per file). `discovered.skipped` is not netted out —
  // those files were never candidates and are added to `totalFiles` instead. Integrity #21
  // re-checks the same arithmetic only for documents arriving through `readIR`.
  const skipped = [...discovered.skipped, ...additionalSkipped].sort(compareBy((file) => file.path))
  const stats = buildStats({
    totalFiles: discovered.files.length + discovered.skipped.length,
    parsedFiles: discovered.files.length - additionalSkipped.length,
    skipped,
    symbols: propagatedSymbols,
    timeoutEvents,
    propagation: propagation.stats,
    // Where the two halves of `stats.lspEnrichment` meet — see `LspHintUsage` for why the
    // resolver reports rather than writes. This is the only call site that completes the
    // `stats.lspEnrichment` record.
    lspEnrichment:
      enrichment.stats === undefined
        ? undefined
        : withHintUsage(enrichment.stats, callGraph.lspHintUsage),
    callResolution: callGraph.stats,
  })

  const workspace: IR["workspace"] = {
    root: ".",
    managers: [...(input.workspaceManagers ?? [])],
    // `languageId`, not `manifest.name`: the former is the `LanguageId` vocabulary this
    // field is typed with (and the prefix on every Symbol id), the latter is a plugin ref.
    languages: uniqueSorted(input.languages.map((l) => l.languageId)),
  }

  const ir: IR = {
    $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
    generator: {
      name: input.generator?.name ?? "@aburi/core",
      version: input.generator?.version ?? "0.0.0",
      plugins: buildPluginRefs(input),
    },
    workspace,
    components: sortComponents(input.components ?? []),
    symbols: propagatedSymbols,
    dependencies: symbolEdges,
    stats,
  }

  assertIRIntegrity(ir)

  return {
    ir,
    parseErrors,
    skipped,
    timeoutEvents,
    parseTimeouts,
    unresolvedCalls: callGraph.diagnostics,
    extractionFailures,
    treeReleaseFailures,
    unrepresentableFiles: discovered.unrepresentableFiles,
  }
}

/**
 * What to record beside a file the parse refused. Called only for a `parse-failed` outcome —
 * handed a healthy file's empty error list it would confidently report a missing tree.
 *
 * Two conditions reach here and a reader needs them apart: a plugin that could not build a
 * tree at all, and one that built a tree and then refused it. The second is the plugin
 * exercising the `recoverable: false` contract, and its message is the only account of why
 * — so it is quoted, with the position, rather than replaced by a summary.
 *
 * The first has no such message, but it often has recoverable ones, and they are the only
 * thing in the run that says *where* the parse came apart. They are appended rather than
 * dropped, because a withdrawn file is excluded from the CLI's recoverable-error count by
 * construction: this line is the last place they can be read.
 *
 * One error either way. A parse that gave up has usually reported the same collapse several
 * times, and the skip list is one line per file; the rest are on `ScanResult.parseErrors`.
 */
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

/**
 * Why this file's Symbols cannot enter the document, or `null` when they can.
 *
 * `lang-plugin.md` §7.2 says one file's bug costs that file. Invariant #1 was the exception
 * until it was decided here; the changeset that moved it has the account of why.
 *
 * Both faults are read off this file alone, which is what lets the message name the plugin
 * that is actually wrong:
 *
 *   - An id whose path is not this file's, which `lang-plugin.md` §4.3 forbids: the id
 *     contract is `<language>:<file>#<qualified-name>`, so the path segment is the plugin's
 *     claim about where the Symbol was declared, and only a broken plugin writes another
 *     file's. Checked first because it is the fault that can collide with a *different*
 *     file's ids, and the offender is the file being scanned rather than whichever file
 *     happens to own the id already (LP28c).
 *   - Two of this file's own Symbols under one id. The shape that actually happens, because
 *     an id carries the file it came from, so a collision is normally within one file's
 *     candidates.
 *
 * With the first rule in force, two files cannot contribute one id at all: every id that
 * enters carries its own file's path, discovery collapses two spellings of one Document path
 * before either is read, and a routed file goes to exactly one plugin. So there is nothing
 * left for a cross-file check to catch, and `assertIRIntegrity` goes back to being the
 * backstop — for a document this scan did not build, which is the only way invariant #1 can
 * still be violated.
 *
 * A malformed id is deliberately not this function's business: `symbolIdFile` answers `null`
 * for one, and reporting it here would describe a grammar fault as a path fault. The grammar
 * check keeps it.
 *
 * Which of two colliding Symbols to keep is not core's to decide — they are the plugin's
 * output and it has said nothing that separates them — and picking one silently is the
 * failure this was always about. So the file goes, whole, and the message names the fault.
 */
function describeIdFault(symbols: readonly IRSymbol[], path: string): string | null {
  const here = new Map<string, IRSymbol>()
  for (const symbol of symbols) {
    const claimed = symbolIdFile(symbol.id)
    if (claimed !== null && claimed !== path) {
      return (
        `Symbol id "${symbol.id}" names ${claimed}, which is not this file. An id carries the ` +
        `file its Symbol was declared in, so the language plugin wrote a path that is not ` +
        `this file's`
      )
    }
    const twin = here.get(symbol.id)
    if (twin !== undefined) {
      // The lines, because the id names the qualified name the two share and nothing else
      // tells them apart — the reader has two declarations to find, not one.
      return (
        `two Symbols share the id "${symbol.id}" (lines ${twin.source.startLine} and ` +
        `${symbol.source.startLine}); the language plugin gave two declarations one qualified ` +
        `name, and nothing it reported separates them`
      )
    }
    here.set(symbol.id, symbol)
  }
  return null
}

/**
 * Codes that name a fault in the plugin *set* rather than in the file being extracted. The
 * per-file boundary re-throws these and absorbs everything else.
 *
 * Each one repeats for every file by construction, so withdrawing files one at a time would
 * report the workspace as broken instead of the plugin, and would replace a precise
 * diagnostic with a file count:
 *
 * - `scan-plugin-misconfigured` — an effect plugin returning a Promise from the synchronous
 *   `classify`, a language plugin emitting Symbol ids with no language prefix at all.
 * - `invalid-language-id` — the prefix is present but is not a legal `LanguageId`. It comes
 *   from the plugin's own `languageId`, so it is the same on every Symbol it emits.
 * - `vocab-undeclared` — an effect or extKind id the emitting plugin's manifest does not
 *   claim (`effect-plugin.md` EP1). A `RegistryError` rather than a `CoreError`, and the
 *   reason this predicate matches on the code rather than on the class: `@aburi/core` does
 *   not depend on `@aburi/plugin-registry`, and matching on the code also survives a build
 *   where a plugin resolved its own copy of either package.
 *
 * Everything else reachable from a plugin call is a property of the file:
 * `anonymous-symbol-id-attempted` and `invalid-symbol-id` from what a declaration is named,
 * `non-posix-path` from where it lives, and any error a plugin raises on its own behalf.
 *
 * A plugin-wide bug that carries none of these codes still presents as one failure per file
 * rather than as one crash. That is the intended shape — every file named, the messages
 * identical, the count the whole workspace — but it is a weaker diagnostic than a code that
 * says outright what is wrong, which is why the list is worth keeping accurate.
 */
const PLUGIN_SET_FAULT_CODES: ReadonlySet<string> = new Set([
  "scan-plugin-misconfigured",
  "invalid-language-id",
  "vocab-undeclared",
])

function isPluginSetFault(error: unknown): boolean {
  const code = errorCode(error)
  return code !== null && PLUGIN_SET_FAULT_CODES.has(code)
}

/**
 * Serialize an IR to `<output-dir>/aburi.ir.json`. Uses `serializeCanonical` so the
 * output is byte-stable across runs — timestamps and unordered maps do not perturb it.
 */
export interface WriteCanonicalIROptions {
  /**
   * Match `SerializeOptions.format`. "pretty" (the default) matches `aburi scan`'s
   * standard on-disk layout; "compact" mirrors the `--compact` CLI flag.
   */
  format?: "pretty" | "compact"
}

export async function writeCanonicalIR(
  ir: IR,
  outputPath: string,
  options: WriteCanonicalIROptions = {},
): Promise<string> {
  const serialized = serializeCanonical(ir, { format: options.format ?? "pretty" })
  const { writeFile, mkdir } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, "utf8")
  return serialized
}

function assertWorkspaceRootAbsolute(root: string): void {
  if (!isAbsolute(root)) {
    throw new CoreError(
      `ScanInput.workspaceRoot must be an absolute path, got "${root}". A relative root would be resolved against process.cwd() and produce non-portable Symbol ids.`,
      { code: "scan-workspace-not-absolute", value: root },
    )
  }
}

/**
 * The file-drop globs of every loaded language plugin, in one list.
 *
 * Exported because discovery is not the only reader: component detection counts file
 * extensions to decide `Component.languages`, and a file this run refuses to read must not put
 * a language on a component. The caller that has the plugins folds these into
 * `DetectComponentsOptions.ignore` alongside `config.ignore`.
 */
export function languageFileDropPatterns(languages: readonly LanguagePlugin[]): string[] {
  const patterns: string[] = []
  for (const language of languages) {
    if (language.fileDropPatterns) patterns.push(...language.fileDropPatterns)
  }
  return patterns
}

/**
 * `fsPath` opens it, `path` names it.
 *
 * The two differ whenever the filesystem stores a name that is not already in NFC, and reading
 * by the Document's spelling misses on every filesystem that keeps what it was given. What the
 * plugin then sees is `path`, because that is what its Symbol ids are built from and what the
 * Document records — the filesystem spelling stops here.
 */
async function loadSourceFile(
  workspaceRoot: string,
  discovered: DiscoveredFile,
): Promise<SourceFile> {
  const absolute = resolve(workspaceRoot, discovered.fsPath)
  const content = await readFile(absolute, "utf8")
  return { path: discovered.path, content }
}

interface BuildStatsInput {
  totalFiles: number
  parsedFiles: number
  skipped: readonly SkippedFile[]
  symbols: readonly IR["symbols"][number][]
  timeoutEvents: readonly ClassifyTimeoutEvent[]
  propagation: PropagationStats
  lspEnrichment?: LspEnrichmentStats | undefined
  callResolution: CallResolutionStats
}

function buildStats(input: BuildStatsInput): Stats {
  const kept = input.symbols.filter((s) => !s.dropped).length
  const dropped = input.symbols.length - kept
  const stats: Stats = {
    totalFiles: input.totalFiles,
    parsedFiles: input.parsedFiles,
    keptSymbols: kept,
    droppedSymbols: dropped,
    effectPropagation: input.propagation,
    // Unconditional, like effectPropagation: a run with nothing to resolve
    // still reports the shape it observed, so a reviewer can tell "no
    // unresolved calls" apart from "this IR predates the counter".
    callResolution: input.callResolution,
  }
  if (input.timeoutEvents.length > 0) {
    stats.effectClassifyTimeouts = input.timeoutEvents.map(
      (event): EffectClassifyTimeout => ({
        plugin: event.plugin,
        symbolId: event.symbolId,
        timeoutMs: event.budgetMs,
      }),
    )
  }
  if (input.lspEnrichment !== undefined) {
    stats.lspEnrichment = input.lspEnrichment
  }
  // Class B: the key is absent when nothing was lost, so its presence alone answers "did
  // this run drop anything" without a reader having to compare two counters — and a
  // document that omits it while `totalFiles > parsedFiles` is one written before the field
  // existed, which is a distinction `[]` would erase.
  //
  // `detail` is deliberately not carried across. The scan holds one per entry, but the
  // `unreadable` details are Node error messages containing the absolute path, and a
  // canonical document whose bytes depend on where the repository was checked out is not
  // the byte-stable artifact the rest of the pipeline assumes.
  if (input.skipped.length > 0) {
    stats.skippedFiles = input.skipped.map((file) => ({ path: file.path, reason: file.reason }))
  }
  return stats
}

/**
 * Sort by id, and normalize the one Class A field on `Component` (`description`, per
 * `ir-schema.md`) to an explicit `null`.
 *
 * `ScanInput.components` is a public boundary: the in-tree CLI writes the key, but any other
 * `@aburi/core` caller can hand over a `Component` built against the read-side type, where
 * `description` is optional. Without this the scan would emit a document that breaks its own
 * convention, and — because `serializeCanonical` drops `undefined` properties — the omission
 * would be visible only in the written bytes. This is the same failure `WrittenSourceRange`
 * closes on the plugin boundary, on the one other Class A field that crosses a public API.
 */
function sortComponents(components: readonly Component[]): Component[] {
  return components
    .map((c) => ({ ...c, description: c.description ?? null }))
    .sort(compareBy((component) => component.id))
}

/**
 * Collapse per-call-site `CallEdge[]` (`from`, `to`, `via`, `confidence`, `line`)
 * into deduplicated `Dependency` triples keyed on `(from, to, via)`. Multiple
 * calls from the same caller to the same callee become one Dependency — the
 * per-line detail lives on `Symbol.calls[]` and is deliberately not duplicated
 * onto Dependency (ir-schema.md). `direction` is fixed to `"outbound"`
 * (call edges are inherently directional) and `effect` to `null` (effect
 * annotation is a separate propagation pass — effect-propagation.md).
 */
function projectSymbolEdges(edges: readonly CallEdge[]): Dependency[] {
  const seen = new Set<string>()
  const out: Dependency[] = []
  for (const edge of edges) {
    const key = dependencyKey(edge.from, edge.to, edge.via)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      from: edge.from,
      to: edge.to,
      via: edge.via,
      direction: "outbound",
      effect: null,
    })
  }
  out.sort(
    (a, b) =>
      compareCodeUnit(a.from, b.from) ||
      compareCodeUnit(a.to, b.to) ||
      compareCodeUnit(a.via, b.via),
  )
  return out
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCodeUnit)
}

function buildPluginRefs(input: ScanInput): PluginRef[] {
  const refs: PluginRef[] = []
  for (const plugin of input.languages)
    refs.push(buildPluginRef(plugin.manifest.name, "lang", plugin.manifest.version))
  for (const plugin of input.frameworks)
    refs.push(buildPluginRef(plugin.manifest.name, "framework", plugin.manifest.version))
  for (const plugin of input.effects)
    refs.push(buildPluginRef(plugin.manifest.name, "effects", plugin.manifest.version))
  refs.sort(compareBy((ref) => ref.name))
  return refs
}

/**
 * Placeholder grammar revision emitted for lang plugins that do not yet expose their
 * tree-sitter revision through the plugin surface. The schema (ir-schema.md) requires
 * a non-null value for `type: "lang"`; using a stable sentinel keeps IRs schema-valid
 * without pretending we know what revision produced them. Consumers can detect this
 * value and treat it as "pending" for cross-run comparability. A future patch that
 * teaches lang plugins to publish `grammarRevision` will thread it through here.
 */
const PENDING_GRAMMAR_REVISION = "pending@0.0.0"

function buildPluginRef(name: string, type: PluginRef["type"], version: string): PluginRef {
  return {
    name,
    type,
    version,
    grammarRevision: type === "lang" ? PENDING_GRAMMAR_REVISION : null,
  }
}

/**
 * Compile-time guard on the per-file outcome switch. The parameter is `never` when every
 * member of `FilePipelineResult` has a case, so a new one is a type error at the call site.
 *
 * `describeThrown` rather than `JSON.stringify`, which is the difference between a message and
 * a second failure. This arm can only ever run for a member nobody checked, so the value it is
 * handed is by definition unexamined — a circular reference, a `BigInt`, a throwing `toJSON`
 * — and a `stringify` that threw would take the `CoreError` with it, leaving the reader with
 * neither the file nor the stage.
 */
function unhandledOutcome(outcome: never): CoreError {
  return new CoreError(
    `Internal error: the scan does not handle the file outcome ${describeThrown(outcome)}\n` +
      "This is a bug in Aburi — please report it at https://github.com/kage1020/Aburi/issues.",
    { code: "scan-outcome-unhandled" },
  )
}
