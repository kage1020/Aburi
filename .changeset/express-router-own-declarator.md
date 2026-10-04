---
"@aburi/framework-express": minor
---

A `Router()` is now read from the declarator of the Symbol being classified. A `const` Symbol's node is its whole declaration statement, and the first declarator in it was read whichever name was asked about, so in `export const router = express.Router(), API_PREFIX = "/api/v1"` every name became a `framework:express:router`, and a `Router()` declared second (`const limit = 10, adminRouter = express.Router()`, or CommonJS `var express = require('express'), router = express.Router()`) was never classified. A name destructured from a `Router()` call (`const { stack } = Router()`) is no longer a Router either. `extractRouterCall` now takes the Symbol's name as a second argument.

The `api` fingerprint reads `extKind`, so it moves for every name this reclassifies: a sibling of a leading `Router()` loses `framework:express:router`, and a `Router()` declared after another name gains it. An IR scanned before this release, compared with one scanned after, reports those Symbols as api changes. A statement that declares a single name is read as before. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.
