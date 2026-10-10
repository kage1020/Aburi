import type { IR, NotComparedFile } from "@aburi/types"
import { EXIT } from "../exit-codes"
import { joinCapped } from "../listing"
import type { WarnFn } from "../warn"
import { type DiffSide, type ScanPair, SIDES } from "./diff-revisions"
import type { ScanReport } from "./scan-report"

export interface ComparedDocuments {
  baseIR: IR
  headIR: IR
  notCompared: readonly NotComparedFile[]
  scans: ScanPair | null
}

export function faultedSides(scans: ScanPair | null): DiffSide[] | null {
  return scans === null ? null : SIDES.filter((side) => scans[side].exitCode !== EXIT.SUCCESS)
}

export function warnAboutComparison(compared: ComparedDocuments, warn: WarnFn): void {
  const { baseIR, headIR, scans } = compared
  if (headIR.stats.callResolution === undefined) {
    warn(
      `⚠ head IR has no stats.callResolution, so the call-resolution census is unavailable for this diff. Re-run \`aburi scan\` on the head revision to record it.`,
    )
  }
  warnOnUnenumerableLosses(baseIR, "base", warn)
  warnOnUnenumerableLosses(headIR, "head", warn)
  warnOnSymmetricLosses(compared.notCompared, warn)
  if (scans === null) {
    warnOnRecordedFaults({ base: baseIR, head: headIR }, warn)
    return
  }
  warnOnRecoverableParseErrors(scans, warn)
  warnOnScanFault(scans, faultedSides(scans) ?? [], warn)
}

function warnOnRecoverableParseErrors(scans: ScanPair, warn: WarnFn): void {
  const affected = SIDES.filter((side) => scans[side].parseErrorCount > 0)
  if (affected.length === 0) return
  const where = affected.map((side) => `${side} ${scans[side].parseErrorCount}`).join(", ")
  warn(
    `⚠ Files with recoverable parse errors (${where}) reached the IR rather than stats.skippedFiles, so nothing marks them as doubtful. ` +
      `Their Symbol sets can be short, which moves added / removed without a file having been skipped.`,
  )
}

function warnOnScanFault(scans: ScanPair, faulted: readonly DiffSide[], warn: WarnFn): void {
  if (faulted.length === 0) return
  const clauses = faulted.map((side) => `${side}: ${describeScanFault(scans[side])}`)
  warn(
    `⚠ ${clauses.join("; ")}. This run exits 3 even though the diff was written. ` +
      `Fix it, or the comparison is against a workspace one side could not read.`,
  )
}

function describeScanFault(report: ScanReport): string {
  const withdrawn = report.extractionFailures.length
  if (withdrawn > 0) return `extraction withdrew ${withdrawn} file(s)`
  const fault = report.coverageFault
  const unnameable = report.unrepresentableFiles.length
  if (unnameable > 0 && (fault === null || fault.kind === "nothing-discovered")) {
    return `${unnameable} file(s) have names no Document path can spell`
  }
  const alsoUnnameable =
    unnameable === 0 ? "" : ` (and ${unnameable} more have names no Document path can spell)`
  if (fault === null) return "it did not exit clean"
  switch (fault.kind) {
    case "nothing-discovered":
      return "it discovered no file to read"
    case "nothing-parsed":
      return `none of the ${fault.totalFiles} file(s) it found parsed${alsoUnnameable}`
    case "below-floor":
      return `${fault.parsedFiles} of ${fault.totalFiles} file(s) parsed, below the floor the workspace set${alsoUnnameable}`
  }
}

function warnOnRecordedFaults(irs: Record<DiffSide, IR>, warn: WarnFn): void {
  for (const side of SIDES) {
    const withdrawn = (irs[side].stats.skippedFiles ?? []).filter(
      (file) => file.reason === "extraction-failed",
    )
    if (withdrawn.length === 0) continue
    warn(
      `⚠ ${side} IR records ${withdrawn.length} file(s) withdrawn during extraction: ${joinCapped(withdrawn.map((file) => file.path))}. ` +
        `The scan that wrote it exited 3; this diff does not, because the fault was reported where it happened.`,
    )
  }
}

function warnOnUnenumerableLosses(ir: IR, side: DiffSide, warn: WarnFn): void {
  if (ir.stats.skippedFiles !== undefined) return
  const unparsed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unparsed <= 0) return
  const consequence = side === "head" ? "removed" : "added"
  warn(
    `⚠ ${side} IR reports ${unparsed} file(s) it did not parse but has no stats.skippedFiles to name them, so this diff cannot tell a lost file from a deleted one. Symbols from those files are reported as ${consequence}. Re-run \`aburi scan\` on the ${side} revision to record the list.`,
  )
}

function warnOnSymmetricLosses(notCompared: readonly NotComparedFile[], warn: WarnFn): void {
  if (notCompared.length === 0) return
  warn(
    `⚠ ${notCompared.length} file(s) were skipped by both scans; see notCompared[] in diff.json: ${joinCapped(notCompared.map(notComparedName))}.`,
  )
}

function notComparedName(file: NotComparedFile): string {
  return file.basePath === undefined ? file.path : `${file.basePath} → ${file.path}`
}
