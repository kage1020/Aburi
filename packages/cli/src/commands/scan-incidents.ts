import { dirname } from "node:path"
import {
  type CollidingFile,
  compareCodeUnit,
  describeCodePoints,
  groupBy,
  type SkippedFile,
  type UnnameableFile,
} from "@aburi/core"
import type { LspEnrichmentStats } from "@aburi/types"
import { assertNever } from "../errors"
import { writeFullListing, writeListing } from "../listing"
import { describeUnresolvedDeclarations } from "../unresolved-report"
import type { WarnFn } from "../warn"
import { SKIP_REASON_RANK } from "./scan-coverage"
import type { CoverageFault, ScanReport } from "./scan-report"

const SKIP_REASON_ADVICE: Record<SkippedFile["reason"], string> = {
  "over-size": "larger than maxFileSizeBytes. Raise the budget, or leave them out with ignore.",
  unreadable:
    "they stopped being files while the scan ran, so something changed the tree under it — re-run. A read that failed for any other reason ends the run rather than landing here.",
  unroutable:
    "no route into the IR exists for them, decided before any of them was read. Discovery accepted an extension no plugin claims — a bug in the plugin set — or a path segment holds a Symbol id separator, and renaming that segment is the fix. Each detail says which.",
  "parse-failed":
    "the language plugin refused the source. Deterministic: fix the file, or the plugin.",
  "parse-timeout":
    "extraction ran past parseTimeoutMs. Machine-dependent: re-run, and raise the budget if it repeats.",
  "extraction-failed":
    "a plugin threw while extracting, or its Symbols could not enter the Document. This is the reason the run does not exit clean.",
}

type SayIncident = (line: string) => void

export function reportScanIncidents(report: ScanReport, warn: WarnFn, label: string | null): void {
  const sayIncident: SayIncident = (line) => {
    warn(label === null ? `⚠ ${line}` : `⚠ ${label}: ${line}`)
  }
  for (const line of describeUnresolvedDeclarations(
    report.unresolvedDeclarations,
    report.fellBackToSingleComponent,
  )) {
    sayIncident(line)
  }
  reportCoverageFault(report.coverageFault, sayIncident)
  reportPluginNamedFrameworks(report.pluginNamedFrameworks, sayIncident)
  reportUnrepresentable(report.unrepresentableFiles, sayIncident, warn)
  reportTreeReleaseFailures(report.treeReleaseFailures, sayIncident, warn)
  reportUndeclaredVocab(report.undeclaredVocab, report.vocabDiscoveredPath, sayIncident, warn)
  reportParseErrors(report.parseErrorFiles, sayIncident, warn)
  reportConfigOutsideWorkspaceRoot(report, sayIncident)
  if (report.parseFailureCount > 0) {
    sayIncident(
      `${report.parseFailureCount} file(s) could not be parsed and were left out of the IR.`,
    )
  }
  if (report.timeoutCount > 0) {
    sayIncident(`${report.timeoutCount} effect classification(s) hit the per-call timeout budget.`)
  }
  reportSkipped(report.skipped, sayIncident, warn)
  if (report.lspEnrichment !== undefined) reportLspEnrichment(report.lspEnrichment, sayIncident)
}

function reportLspEnrichment(lsp: LspEnrichmentStats, sayIncident: SayIncident): void {
  if (lsp.filesFellBack > 0) {
    sayIncident(
      `LSP enrichment fell back for ${lsp.filesFellBack} file(s); IR field values in those files remain at the untyped tier.`,
    )
  }
  if (lsp.languagesDisabled.length > 0) {
    sayIncident(`LSP disabled mid-run for language(s): ${lsp.languagesDisabled.join(", ")}.`)
  }
  if (lsp.requestsTimedOut > 0 || lsp.requestsFailed > 0) {
    sayIncident(
      `LSP requests: ${lsp.requestsIssued} issued · ${lsp.requestsTimedOut} timed out · ${lsp.requestsFailed} failed.`,
    )
  }
  reportHints(lsp, sayIncident)
}

function reportHints(lsp: LspEnrichmentStats, sayIncident: SayIncident): void {
  const produced = lsp.hintsProduced ?? 0
  const rejected = lsp.hintsRejected
  const refused =
    rejected === undefined
      ? 0
      : rejected.unparseableHover +
        rejected.ownerClassNotFound +
        rejected.memberNotFound +
        rejected.kindMismatch +
        rejected.targetDropped
  if (produced === 0 && refused === 0) return
  sayIncident(
    `LSP receiver hints: ${produced} produced · ${lsp.hintsConsumed ?? 0} resolved a call · ${refused} rejected.`,
  )
}

function reportParseErrors(
  files: ScanReport["parseErrorFiles"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (files.length === 0) return
  sayIncident(`${files.length} file(s) had recoverable parse errors.`)
  writeFullListing(
    files.map((file) => `${file.path}: ${file.detail}`),
    writeDetail,
  )
}

function reportTreeReleaseFailures(
  failures: ScanReport["treeReleaseFailures"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (failures.length === 0) return
  sayIncident(
    `${failures.length} parse tree(s) were not released by the plugin that built them. ` +
      `A tree a plugin does not free is not reclaimed by the garbage collector, so a long ` +
      `enough run exhausts the parser's heap.`,
  )
  for (const [plugin, group] of groupBy(failures, (failure) => failure.plugin)) {
    const first = group[0]
    if (first === undefined) continue
    writeDetail(`    ${plugin} (${group.length}) — ${first.file}: ${first.detail}`)
  }
}

function reportUndeclaredVocab(
  items: ScanReport["undeclaredVocab"],
  recordPath: string | null,
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (items.length === 0) return
  const record = recordPath === null ? "" : ` Recorded in ${recordPath}.`
  sayIncident(
    `${items.length} value(s) were emitted that the emitting plugin's manifest does not declare; ` +
      `strict is off, so the scan kept them.${record}`,
  )
  for (const item of items) {
    writeDetail(`    ${item.kind} ${item.value} — ${item.firstSeenBy} (${item.occurrences})`)
  }
}

function reportCoverageFault(fault: CoverageFault | null, sayIncident: SayIncident): void {
  if (fault === null) return
  const consequence = "The IR is empty and will diff clean against any other empty IR."
  if (fault.kind === "nothing-discovered") {
    sayIncident(
      `No file was discovered to scan. ${consequence} Check ignore and .gitignore, ` +
        "components[].roots, and whether a loaded language plugin claims any extension in this workspace.",
    )
    return
  }
  if (fault.kind === "nothing-parsed") {
    sayIncident(
      `${fault.totalFiles} file(s) discovered, 0 parsed — ${fault.dominantCount} as ` +
        `${fault.dominant}. ${consequence}`,
    )
    return
  }
  const percent = Math.floor((fault.parsedFiles / fault.totalFiles) * 100)
  sayIncident(
    `${fault.parsedFiles} of ${fault.totalFiles} file(s) parsed (${percent}%), below the ` +
      `minParsedFileRatio floor of ${Math.ceil(fault.floor * 100)}%. ` +
      "Raise the coverage, or lower the floor if this is what the workspace looks like now.",
  )
}

function reportPluginNamedFrameworks(
  found: ScanReport["pluginNamedFrameworks"],
  sayIncident: SayIncident,
): void {
  for (const { component, value, frameworkIds } of found) {
    const fix =
      frameworkIds.length === 0
        ? "That plugin provides no framework: remove it, or write the framework id the component is built on."
        : `Write ${frameworkIds.map((id) => `"${id}"`).join(" or ")}.`
    sayIncident(
      `Component "${component}" lists "${value}" in frameworks, which names a plugin, not a framework; the IR carries it as written. ${fix}`,
    )
  }
}

function reportConfigOutsideWorkspaceRoot(report: ScanReport, sayIncident: SayIncident): void {
  if (report.configSource === null) return
  if (report.configPinnedByCaller) return
  if (dirname(report.configSource) === report.workspaceRoot) return
  sayIncident(
    `Config ${report.configSource} sits below the workspace root ${report.workspaceRoot}. ` +
      `Paths inside it (ignore, components[].roots, relative plugin refs) resolve against the root, ` +
      `and the scan covers the whole workspace.`,
  )
}

function reportSkipped(
  skipped: ScanReport["skipped"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (skipped.length === 0) return
  const groups = [...groupBy(skipped, (file) => file.reason)].sort(
    ([a], [b]) => SKIP_REASON_RANK[a] - SKIP_REASON_RANK[b],
  )
  const census = groups.map(([reason, files]) => `${reason}=${files.length}`).join(", ")
  sayIncident(`${skipped.length} file(s) contributed no Symbols: ${census}`)
  for (const [reason, files] of groups) {
    sayIncident(`${reason} (${files.length}) — ${SKIP_REASON_ADVICE[reason]}`)
    writeListing(
      files.map((file) => {
        const detail = file.detail ?? ""
        return detail.length === 0 ? file.path : `${file.path}: ${detail}`
      }),
      writeDetail,
    )
  }
}

function reportUnrepresentable(
  files: ScanReport["unrepresentableFiles"],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  const unspellable: UnnameableFile[] = []
  const colliding: CollidingFile[] = []
  for (const file of files) {
    switch (file.reason) {
      case "unspellable-name":
        unspellable.push(file)
        break
      case "colliding-spelling":
        colliding.push(file)
        break
      default:
        assertNever(
          file,
          "unrepresentable-file reason from @aburi/core, which this CLI has no section for",
        )
    }
  }
  reportUnspellable(unspellable, sayIncident, writeDetail)
  reportColliding(colliding, sayIncident, writeDetail)
}

/** One section per cause, because the fix differs and the two are told apart by nothing else. */
function reportUnspellable(
  files: readonly UnnameableFile[],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (files.length === 0) return
  const byPrefix = groupByKeyOrder(files, (file) => file.unnameablePrefix)
  sayIncident(
    `${files.length} file(s) were left out of the IR and out of its counts, under ${byPrefix.size} name(s) with no spelling here: "/" is the only separator a Document path has, so a name holding a backslash cannot be written down at all. Rename each one below. To leave one out with ignore instead, write its backslash twice — a glob pattern spends a single one as an escape, so the name as printed does not match itself.`,
  )
  for (const [prefix, group] of byPrefix) {
    writeDetail(
      group[0]?.fsPath === prefix
        ? `    ${prefix}`
        : `    ${prefix} — a directory, and the ${group.length} file(s) under it`,
    )
  }
}

function reportColliding(
  files: readonly CollidingFile[],
  sayIncident: SayIncident,
  writeDetail: WarnFn,
): void {
  if (files.length === 0) return
  const byPath = groupByKeyOrder(files, (file) => file.documentPath)
  sayIncident(
    `${files.length} file(s) were left out of the IR and out of its counts, on ${byPath.size} path(s) more than one name claims: the Document holds every string in Unicode NFC, and these names differ only in how they are composed, so normalizing them gives one path for several files. Rename all but one of each group. ignore matches the spelling on disk, so the path below excludes whichever claimant is spelled that way and leaves the rest of the group scannable, while a wildcard over it excludes them all.`,
  )
  for (const [documentPath, group] of byPath) {
    writeDetail(`    ${documentPath} — claimed by ${group.length} file(s) on disk:`)
    for (const file of group) writeDetail(`        ${describeCodePoints(file.fsPath)}`)
  }
}

/** Sorted by key, so the paragraph is the same paragraph on every run. */
function groupByKeyOrder<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  return new Map([...groupBy(items, key)].sort(([a], [b]) => compareCodeUnit(a, b)))
}
