---
"@aburi/core": minor
"@aburi/cli": minor
---

Open a file by the name the filesystem gave it, not the one the Document records

`toDocumentPath` normalizes a path to NFC on the way into the Document (ir-schema.md §1.2), and
three sites then handed that normalized string back to the operating system: the `stat` in
discovery, the `readFile` in the scan orchestrator, and the `file://` URI the LSP pass tells a
language server to open. A filesystem that stores the name it was given — NTFS, ext4 — does not
answer to the normalized spelling, so a file whose name was not already in NFC was reported
`unreadable`, with an `ENOENT` naming a path almost but not quite the one on disk.

`DiscoveredFile` now carries both: `path` for the Document and `fsPath` for whatever opens the
file. Only `path` reaches a Symbol id, so nothing about the artifact changes for a workspace
whose names are all ASCII.

**Two spellings of one name are reported instead of ending the scan.** Both normalize to one
Document path, so the pipeline read one file twice and minted its Symbol id twice — and
`assertIRIntegrity` ended the run on `[#1] duplicate Symbol id`, naming neither file. Every
claimant is now withdrawn and reported on `ScanResult.unrepresentableFiles`, which grew a
`reason` to say which of the two things happened; `aburi scan` prints a section per cause and
exits 3. The collision section spells each name out by codepoint, because the two print
identically in a terminal.

`EnrichmentInput` takes an `fsPaths` map for the same reason the read does. Callers of
`enrichWithLsp` outside the core pass `new Map()` to keep today's behaviour, which is correct for
any path already in NFC.
