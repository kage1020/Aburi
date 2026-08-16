/**
 * Sink for non-fatal observations — scan incidents, git errors, cleanup failures.
 *
 * One call per line, with no trailing newline: the CLI wrapper adds it when writing to
 * stderr, and a programmatic caller collecting messages into an array does not want one.
 *
 * It lives here rather than beside its first user because both `runScan` and `runDiff` take
 * one, and `commands/diff.ts` already imports from `commands/scan.ts` — declaring it in
 * either would make the other import backwards.
 */
export type WarnFn = (message: string) => void
