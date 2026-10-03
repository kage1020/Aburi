---
"@aburi/lang-typescript": minor
"@aburi/framework-express": patch
---

Name module-level registrations by what they are written with, not by where they are written

A module-level registration with no quoted path (`app.use(cors())`, `app.use(authMw)`) is now named by the names its arguments carry (`app__use__cors__d0`, `app__use__authMw__d0`), and its path is read wherever it is written. Both used to fall back to a source-order ordinal (`app__use__d0`, `app__use__d1`, …), so inserting one registration above others renamed every later one, and `aburi diff` paired each with the body its id used to hold: adding `app.use(compression())` was reported as removing the authorization guard of the middleware below it.

- **The path.** A path written in backticks with no substitution (`` app.get(`/users`, h) ``) is the path it spells, as one in quotes is. A path written up the chain names the registration (`app.route('/a').get(h)` is `app__get__$a__d0`, where it was named by the handler, so every `app.route(…).get(h)` shared one stem). A comment or a wrapper in front of the path (`("/users")`, `"/users" as string`) no longer hides it. An empty path (`app.get("", h)`) is no path.
- **The names.** With no path, an identifier (`authMw`), a dotted reference (`express.json` → `express_json`), a call's callee (`cors()`), a constructor (`new Logger()`) or a spread (`...mws`) names the registration, several joined by `$`. Registrations whose arguments name nothing (an inline function) keep the ordinal among themselves.
- **Characters.** A name or a path outside ASCII keeps its characters, as the qualified-name grammar does: `app.use(認証)` and `app.use(圧縮)` both used to fold to `app__use____`. The segment is written in Unicode NFC.
- **`derivedBy`** carries `argument-names:<slug>` when the names named it, beside the existing `path-literal:<path>`; never both.

A substitution-free backtick argument is also a literal in `calls[].literalArgs`, so the literal-first-argument check in `@aburi/effects-drizzle` and `@aburi/effects-prisma` now reads it: `` router.delete(`/users/:id`, h) `` is no longer recorded as a Drizzle write, nor `` this.cache.items.delete(`session`) `` as a Prisma one.

`@aburi/framework-express` reads a mount's path the same way, so `` app.use(`/api`, apiRouter) `` is `framework:express:mount`, as its id says, where it was classified `middleware`. A comment between `use`'s arguments is no longer counted as one.

**Existing ids change once.** Every registration the old naming left to the ordinal — a path-less one, one whose path was in backticks or up the chain — and every one whose name or path holds a character outside ASCII gets a new id, so a diff against an IR written before this release reports each as removed and added one time. Rescan the base rather than comparing against a stored IR; `aburi diff <base>..<head>` scans both sides with this release and is unaffected. Measured by scanning before and after: the `nestjs-billing` fixture's 39 ids and the 23 ids of the Express sources the test suites scan (17 registrations, each with a quoted path or an inline handler) are identical; a conventional Express entry file — `helmet()`, `cors()`, `compression()`, `morgan(…)`, three `express.*` parsers, a router mount, a backtick health check, an `app.route(…)` chain, 404 and error handlers — changes 11 of its 14 registration ids, keeping the quoted mount, `app.set(…)` and `app.listen(…)`.
