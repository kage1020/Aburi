/**
 * Sink for non-fatal observations — scan incidents, git errors, cleanup failures.
 *
 * One call per line, with no trailing newline: the CLI wrapper adds it when writing to
 * stderr, and a programmatic caller collecting messages into an array does not want one.
 *
 * Declared here rather than in `commands/diff.ts` (which re-exports it) so `scan.ts` can
 * import it without an import cycle.
 */
export type WarnFn = (message: string) => void
