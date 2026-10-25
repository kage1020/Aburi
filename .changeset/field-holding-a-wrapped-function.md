---
"@aburi/lang-typescript": minor
---

A class field holding a call handed a function is now a member. `handle = withAuth(async (data) => { … })` was a field, so its function was walked on the class: constructing the class reported what calling the member does, and propagated it to every `new UserService()` caller. A class of nothing but such fields was also hinted as a `pure DTO` and dropped, with the function's calls. The field is now a `method` Symbol (`UserService.handle`, `C::handle` for a static field) with a null `signature` and `derivedBy` carrying `call-argument-function`. Its bodies are the functions handed directly to a call on the value's chain, read as a module-level `const` reads them. The wrapping call runs on construction and stays on the class, and a class of such fields is no longer dropped. A function deeper in the value (`withAuth(withLogging(() => …))`) or handed to `new` stays on the class.

An IR scanned before this release, compared with one scanned after, reports each such field's member as added and the class as changed. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
