---
"@aburi/core": minor
---

Refuse a `.gitignore` rule by its length rather than by asking a regex engine

**A `.gitignore` rule between 4,097 and roughly 32,000 characters worked before and now fails
the scan.** That is a break rather than a fix, which is what this note is for.

Where a regex engine's code-size limit falls, and what reaching it costs, is the engine's
business. Measured on Node 24 with `ignore@7.0.6`: V8 accepts a 32,000-character rule in 433 ms
on Windows and refuses one of 33,000 in 348 ms, while a macOS CI runner spent **forty-three
seconds** on a 40,000-character rule. A workspace holding such a line could therefore scan on one
machine and fail on the next — the property the Document exists to avoid — and the scan that did
fail paid most of a minute for it.

So a rule longer than 4,096 characters is refused outright, with the file and the line named,
before any engine sees it. No real pattern reaches that: a gitignore rule is a path glob, and
4,096 is `PATH_MAX` on Linux — the platform with the most generous limit of the three, so a
bound that clears it clears macOS's 1,024 and Windows' 260 as well.

Shorter rules are still compiled when the file is read, so one an engine refuses for another
reason — `a/[/b` is five characters and unterminated — still cannot escape as a bare
`SyntaxError` at a later candidate.
