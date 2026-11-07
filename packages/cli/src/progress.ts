import type { ScanProgress } from "@aburi/core"
import { type DiffSide, SIDES } from "./commands/diff-revisions"
import type { Terminal } from "./terminal"

/** What `runDiff` is doing: a scan of one side, the end of that scan, or the comparison. */
export type DiffProgress =
  | { readonly kind: "scan"; readonly side: DiffSide; readonly progress: ScanProgress }
  | { readonly kind: "scanned"; readonly side: DiffSide }
  | { readonly kind: "comparing" }

export function describeScanProgress(progress: ScanProgress): string {
  switch (progress.phase) {
    case "discovering":
      return "discovering files…"
    case "extracting":
      return `extracting ${progress.done}/${progress.total} files`
    case "resolving":
      return "resolving calls…"
  }
}

/** Whether `progress` is worth drawing at once: a new phase, or the last file extracted. */
function milestone(progress: ScanProgress, before: ScanProgress | undefined): boolean {
  if (progress.phase !== before?.phase) return true
  return progress.phase === "extracting" && progress.done === progress.total
}

/** A scan's progress on `terminal`'s progress line. */
export function showScanProgress(terminal: Terminal): (progress: ScanProgress) => void {
  let before: ScanProgress | undefined
  return (progress) => {
    terminal.progress(describeScanProgress(progress), milestone(progress, before))
    before = progress
  }
}

/** A diff's progress on `terminal`'s progress line, each side's scan named while it runs. */
export function showDiffProgress(terminal: Terminal): (progress: DiffProgress) => void {
  const running = new Map<DiffSide, ScanProgress>()
  return (event) => {
    switch (event.kind) {
      case "scan": {
        const urgent = milestone(event.progress, running.get(event.side))
        running.set(event.side, event.progress)
        const sides = SIDES.flatMap((side) => {
          const progress = running.get(side)
          return progress === undefined ? [] : [`${side}: ${describeScanProgress(progress)}`]
        })
        terminal.progress(sides.join(" · "), urgent)
        return
      }
      case "scanned":
        running.delete(event.side)
        return
      case "comparing":
        terminal.progress("comparing…", true)
        return
    }
  }
}
