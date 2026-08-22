---
"@aburi/core": minor
"@aburi/cli": minor
---

Refuse a backslash in a filename instead of rewriting it into a path separator

`toDocumentPath` and `toPosixRelative` began by rewriting every `\` into `/`, before any
validation ran. A backslash is a legal POSIX filename character, so a file named
`weird\name.ts` was silently renamed to `weird/name.ts`: the Symbol ids built beside it named
a path nothing can open, and `a\b.ts` beside `a/b.ts` collapsed onto one path, which invariant
#1 reported as duplicate ids rather than as the filenames that produced them. The shared path
rule has always refused the character and has a message for it; nothing reached the check,
because the rewrite spent the character first.

The two entry points now normalize NFC and validate what they are given. Converting a native
path is the caller's job, because only the caller knows it holds one — `toRelativePosix` in
`workspace.ts` shows the shape, rewriting on the platform separator, which is a separator
exactly where a filename cannot hold one.

**Migration.** A caller passing a native path to either entry point must convert it first:

```ts
import { sep } from "node:path"
toDocumentPath(sep === "/" ? nativePath : nativePath.split(sep).join("/"))
```

Nothing in this repository needed the change: the file walk takes its paths from `glob`, which
returns POSIX separators on every platform.

`aburi scan` reports such a file and exits 3. It cannot be recorded on `stats.skippedFiles`,
because that path is held to the same rule, nor counted in `stats.totalFiles` without being
recorded, because integrity #21 pins the skip list's length to `totalFiles - parsedFiles`. So it
leaves the census the way a file no plugin claims does, and `ScanResult.unrepresentableFiles`
plus the stderr paragraph built from it are the run's only account of it — which is why the exit
code moves. `aburi explain` answers for one of these files without consulting the document, since
no document could hold it.

`aburi diff` names it as the fault for the side that has it, in ref mode, where it runs the
scans. `--base` / `--head` reads two documents and neither records the file, so a rename into
such a name reads as deletions there: `dependencySideView` builds its lost-file set from
`stats.skippedFiles`, which this file is absent from by construction. That is a limit of the
frozen path grammar rather than of the diff, and is recorded as a v2 shape in `ir-schema.md`
§15.4.
