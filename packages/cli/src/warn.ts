/**
 * Sink for non-fatal observations — scan incidents, git errors, cleanup failures.
 *
 * One call per line, with no trailing newline: the CLI wrapper adds it when writing to
 * stderr, and a programmatic caller collecting messages into an array does not want one.
 *
 * It lives here rather than where it started. `commands/diff.ts` declared it and already
 * imports from `commands/scan.ts`, so leaving it there would have made `scan.ts` import back
 * out of `diff.ts` and close the cycle. `diff.ts` re-exports the name, so the package's public
 * surface is unchanged.
 */
export type WarnFn = (message: string) => void
