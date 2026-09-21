---
"@aburi/core": patch
"@aburi/cli": patch
---

Let a duplicate Symbol id cost its file, the way every other plugin fault does

`lang-plugin.md` §7.2 has said since before there was a `try` in the scan that one file's bug
does not halt IR generation: a qualified name the grammar refuses costs its file and is named in
`skipped`. Invariant #1 was the exception. `assertIRIntegrity` runs once, over the assembled
document, outside the per-file boundary — so two Symbols under one id were found after every file
had already been extracted, and the run threw and produced no document at all. A workspace of
healthy files yielded nothing because one file confused one plugin: no artifact on disk rather
than a thinner IR.

The check now runs per file, in `scan()`'s `extracted` branch, ahead of every accumulator — so a
refusal leaves nothing half-written, the same property the exception boundary beside it gets from
`runFilePipeline` returning its result at once. The offending file is withdrawn on the existing
terms: `ScanResult.skipped` with `reason: "extraction-failed"`, a `ScanResult.extractionFailures`
entry carrying the new `duplicate-symbol-id` code, a warning naming the file, and exit `3`, so a
run that hit this is still not green. Every other file reaches the document.

Two shapes are answered, both read off the file being extracted so that the message names the
plugin that is actually wrong. Two of one file's own Symbols under one id is the shape that
happens, because an id carries the file it came from, and the message names the id and both
declarations' lines — the id names the qualified name they share and nothing else tells them
apart. An id whose path is not this file's is the other, which `lang-plugin.md` §4.3 now states
outright as a rule; the file that *wrote* the id is the one withdrawn, whichever of the two
discovery reached first, since withdrawing the file the id merely names would take a healthy file
for another's fault. Answering both here is what leaves the document-wide check as a backstop
rather than the first line of defence.

Which of two Symbols to keep is not the core's to decide — they are the plugin's output and it
reported nothing that separates them — so the file goes whole rather than one of the pair being
picked silently.

`@aburi/cli` only follows the wording: the `extraction-failed` skip-reason advice now says "a
plugin threw while extracting, or its Symbols could not enter the Document", since a throw is no
longer the only way into that group.
