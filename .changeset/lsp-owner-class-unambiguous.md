---
"@aburi/core": minor
"@aburi/types": patch
---

LSP enrichment no longer guesses which class a hover means when two files declare a class of that name. A hover gives the owner class by name only (`(method) Repository.save()`), and when the caller's file declared no class of that name the pass took the first one by Symbol id, so `this.save()` in a class extending `models/repository.ts`'s `Repository` could get a `high` edge into `lib/repository.ts`, a file the caller never imports. It now looks in the caller's file first, takes a class from elsewhere only when exactly one carries the name, and otherwise writes no hint and counts it under `hintsRejected.ownerClassNotFound`. The member is now looked up in the file that declares the owner class. `@aburi/types` carries the reworded description of that bucket.

A call the first-by-id pick happened to resolve correctly is now unresolved as well, since the name alone never said which class was meant. With an effect plugin loaded, its caller no longer inherits that callee's effects, which moves the caller's `logic` fingerprint, so an IR scanned before this release, compared with one scanned after, can report such a caller as changed. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed version and is unaffected.
