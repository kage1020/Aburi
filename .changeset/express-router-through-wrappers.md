---
"@aburi/framework-express": minor
---

A `Router()` initializer is now read through `as`, `satisfies` and `!` as well as parentheses, as the plugin already reads a route's arguments and receiver chain: `const router = express.Router() as express.Router`, `const r = Router() satisfies Router` and `const r = Router()!` are `framework:express:router`, as their bare spellings are, and so is a parenthesized `Router()` with a comment before it (`const r = (/* api */ Router())`). None of them was classified.

The `api` fingerprint reads `extKind`, so it moves for each const this classifies. An IR scanned before this release, compared with one scanned after, reports those Symbols as api changes, and the Markdown projection's Boundary effect surface gains those of them that have effects. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
