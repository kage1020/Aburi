---
"@aburi/core": patch
---

Refuse a `.gitignore` rule by its length rather than by asking a regex engine

A pattern long enough to blow the regex engine's code-size limit is refused with the file and
line named. Where that limit falls, and what reaching it costs, is the engine's business:
measured, V8 refuses somewhere above 32,000 characters on one platform and spends **forty
seconds** arriving at the same verdict on another. A workspace holding such a line could
therefore scan on one machine and fail on the next — the property the Document exists to avoid —
and a scan that did fail paid most of a minute for it.

Any rule longer than 4,096 characters is now refused outright, before the engine sees it. That
rules out no real pattern: a gitignore rule is a path glob and `PATH_MAX` itself is 4096. Shorter
rules are still compiled when the file is read, so one the engine refuses for some other reason
still cannot escape as a bare `SyntaxError` at a later candidate.
