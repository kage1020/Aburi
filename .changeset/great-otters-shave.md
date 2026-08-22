---
"@aburi/core": minor
"@aburi/cli": patch
---

Decide a file the scan cannot open the same way at both stages that open one

Two calls in a scan open files: discovery's `stat` on every candidate, and the `readFile` the
orchestrator does just before extraction. They disagreed about what a failure meant. The
orchestrator absorbed only `ENOENT` and re-threw the rest, and said why — a permission the
checkout got wrong or an exhausted descriptor table depends on how the machine was feeling, so
absorbing it lets one commit produce a different Document on a different day. Discovery
recorded every errno as a skipped file, so the identical `EACCES` on the identical machine
either ended the run or quietly shrank the IR, according to which of the two calls happened to
reach the file first. Nothing gated the second outcome: `minParsedFileRatio` is unset by
default, so the run exited `0`.

One predicate now decides both. It holds `ENOENT` and `ENOTDIR`, because the operating systems
disagree about what to call one event: replacing a directory with a file while a scan runs is
answered `ENOTDIR` on POSIX and `ENOENT` on Windows, and a predicate holding only `ENOENT` made
the same act fatal on one platform and benign on the other. Everything else propagates out of
`discoverFiles` as the operating system raised it, which is what the orchestrator already did,
and reaches the CLI's exit code `1`.

So `unreadable` now means one thing wherever it appears — the file stopped being one while the
scan ran — and `aburi scan`'s advice for it no longer sends the reader to check permissions,
which after this change cannot have caused it.

**`describeThrown` no longer answers a thrown empty string with an empty string.** It exists to
replace a plugin's silence, and `throw ""` produced exactly that, one step further in: the
value lands on `skipped[].detail` and `extractionFailures[].message`, where nothing separates
"the plugin said nothing" from "nobody recorded anything". The guarantee is now non-emptiness
and it is enforced on the result rather than inside the chain, since an object whose `toJSON`
returns `undefined` and whose `toString` returns `""` reaches the end and comes back empty too.
Discovery's `stat` detail and the `.gitignore` read failure both go through it, replacing an
unguarded `(error as Error).message` that left `detail: undefined` for a non-`Error` throw and
a third copy of the same chain.
