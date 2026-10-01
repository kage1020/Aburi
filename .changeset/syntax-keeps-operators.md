---
"@aburi/lang-typescript": patch
---

The `syntax` fingerprint now changes when an operator, a declaration keyword, a modifier or a primitive type does: `a + b` → `a - b`, `&&` → `||`, `<` → `<=`, `i++` → `i--`, `let` → `const`, `for…in` → `for…of`, `private` → `public`, `x as string` → `x as number`. `normalizeAst` read only named nodes, and tree-sitter holds these as unnamed tokens, so an edit that reached neither `api` nor `logic` (an operator in an assignment, a call argument, a loop header, or an `if` with no early exit) moved no fingerprint, and `aburi diff` reported the Symbol as unchanged and every `--fail-on` gate passed. Quote style, trailing commas, optional semicolons and the brackets the structure already implies still leave the fingerprint alone (`fingerprint.md` §5.1, S6 / S7).

This changes the `syntax` fingerprint of nearly every Symbol without a grammar change, so the `grammarRevision` check (`fingerprint.md` §5.6) does not flag an IR scanned before this release when it is compared with one scanned after: every such Symbol is reported as a syntax-only change. On this repository that is 2,471 of 2,482 non-dropped Symbols, with `api` and `logic` unchanged on all of them. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
