# @aburi/lang-typescript

## 0.6.0

### Minor Changes

- f17849d: A `try` statement's `catch` and `finally` blocks are now walked into the enclosing Symbol. The `finally` block is walked like the `try` block, since it runs on every path: its rules join the Symbol's `rules[]`, and its calls join `calls[]`, or `effects[]` where an effect plugin classifies them. The `catch` clause contributes its calls the same way and none of its rules (`ir-schema.md` §8.2): a guard, a `throw` or a nested `try` in an error handler, and a `finally` nested inside it, stay out of `rules[]`, so rewriting an error handler's control flow does not move `logic`. A call in the clause is recorded exactly when it would be in the `try` block, under the same drop list. Neither block was walked, so a database write, an HTTP call or an event publish added in either one reached no `calls[]` or `effects[]`, and `aburi diff` reported the edit as a syntax-only change.

  A call in either block now resolves like any other and adds a `via: "call"` edge to `dependencies[]`, so an effect reached through a call in a `catch` or a `finally` propagates to every caller: a Symbol whose own source did not change can gain a propagated effect from this release. Nothing on an effect found in a `catch` says it runs only on the error path. In the other direction, a plain call that no effect plugin classifies, added in a `catch`, moves nothing, because `logic` reads rules and effects only (`fingerprint.md` §4.1): an edit to a `catch` block trips `--fail-on logic-changed` only when it adds, removes or changes an effect, directly or through a helper that has one. A `try` written at module top level is still in no Symbol, so nothing in it is walked.

  This moves the `logic` fingerprint of every Symbol whose `finally` block holds a rule or an effect, and of every Symbol that gains an effect, direct or propagated, through a call in either block, so an IR scanned before this release compared with one scanned after reports those Symbols as logic changes. On this repository, scanning one tree with both versions adds 166 calls to the `calls[]` of 62 Symbols, 106 of them resolved, grows `dependencies[]` from 2053 to 2129 edges, and moves the `logic` fingerprint of 3 Symbols, all for rules in a `finally` block. No `api` or `syntax` fingerprint moves, and no Symbol changes drop status. This repository's `aburi.json` loads no effect plugin, so no effect moves here; a codebase that loads one also sees the effects of the new calls, and along the new edges the propagated ones. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

- b90750e: A class's head — `abstract`, its type parameters, `extends` and `implements` — now reaches its `syntax` fingerprint. Only the class body was serialized, and a class has no signature for the `api` axis to read, so re-parenting a class, adding or dropping `abstract`, or adding a type parameter moved no fingerprint and `aburi diff` reported no change. An anonymous `export default class extends Base {}` is covered, and so is a class merged with an interface written above it. The head follows the body and is left out when empty, so a class with none keeps its fingerprint. Neither `api` nor `logic` has a place for a head, so such an edit is reported as a syntax-only change, which the Diff report shows collapsed. An interface's `extends` and type parameters are still not read (`lang-plugin.md` LP8p).

  This moves the `syntax` fingerprint of every class that has a head, so an IR scanned before this release, compared with one scanned after, reports those classes as syntax-only changes, with `api` and `logic` unchanged, and trips `--fail-on changed` or `syntax-changed`. On this repository, scanning one tree with both versions moves the `syntax` fingerprint of 23 Symbols, all of them classes (the tree has 39), and no `api` or `logic` fingerprint. Aburi does not yet compare `grammarRevision` at diff time as `fingerprint.md` §5.6 specifies, and the plugin publishes a fixed placeholder for it, so nothing warns you when a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected. A class whose type parameters carry a variance modifier (`class Box<in out T>`) has its head read the way the grammar recovers it, taking `in` for the parameter's name: until the grammar gains variance support, renaming such a parameter changes nothing where the body does not name it, and once it does, those classes move a second time.

- 3b52db9: A call through a default import resolves to the module's default export

  `import connect from "./client"` was read as a named import of `connect`, so `connect()` linked at `high` confidence to the module's named `connect` (and took its effects) when the default export was another function, and a default export that was anonymous (`export default () => …`) or imported under another name than its declaration's was never reached. The language plugin now reports a default binding as `default as <local>`, as `{ default as x }` already was, and call resolution looks it up as the file's `<default>` Symbol or the declaration carrying `export-default`, including a member reached through it (`Svc.run()`). A module with no default export leaves the call unresolved, bucketed `no-match`, and one with two (TS2528) leaves it `ambiguous`. `@aburi/core` exports the `"default"` half of that spelling as `DEFAULT_EXPORT_NAME`. The NestJS plugin reads a default-imported decorator by the name the file gave it, at `high` from `@nestjs/*` and `medium` from anywhere else, and `import { default as Controller }` now classifies the same way instead of being matched as `default`, which no vocabulary lists.

  A default export written as an export clause, `export { connect as default }`, is not reached, because the TypeScript plugin does not read export clauses and nothing marks `connect` as the default export. `import connect from` followed by `connect()` used to resolve to `connect` there only because the two names matched, and is now unresolved, bucketed `no-match`. A default export that is a value (`export default withAuth(Page)`), a member of an anonymous default class and a default re-exported from another module stay unresolved, as they were. A language plugin that reports a default import as a bare name is read as before: nothing checks the spelling.

  A call that resolves differently can change the effects its caller inherits, so with an effect plugin loaded this moves the `logic` fingerprint of every Symbol whose propagated effects change with it, including through an `export { X as default }` call that no longer resolves. A NestJS class or method whose decorator is imported as `{ default as … }` now classifies, which moves its `api` fingerprint. An IR scanned before this release, compared with one scanned after, reports those Symbols as changed. On this repository, which has no relative default import in its scanned sources and loads no effect plugin, scanning one tree with both versions gives a byte-identical IR. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugins and is unaffected.

- dfffac9: A name a destructuring parameter binds now shadows outer names. `function f({ save }) { save() }` used to link `save()` to an imported or file-scope `save` and take on its effects, because the parameter was known only by its pattern text. Each `Signature.inputs` entry for a destructuring parameter now lists the names it binds in a new optional `bindings` field, and the call resolver treats each of them as a parameter, the same as `function f(save) { save() }`. A rest parameter whose binding destructures lists them too (`...[save]` is `{ name: "[save]", type: "", rest: true, bindings: ["save"] }`), while a single-name parameter, `...save` included, has no `bindings`: its `name` is already the binding, and neither has a pattern that binds no name, such as `{}`. Where a syntax error leaves text inside the pattern that the parser could not place, or the pattern holds an expression that is not a binding (`{ a: obj.b, c }`), only the names the parser placed are listed, and the file is scanned as before. A malformed array pattern such as `[a, ?, b]` lists `a` and `b`.

  A function that calls, by its bare name, a Symbol that one of its own destructuring parameters binds, as in `function f({ save }) { save() }` with a `save` declared in or imported into the module, no longer links that call. Its edge leaves `calls[].resolved` and `dependencies[]` and takes the effects it carried with it, and because `logic` is computed after effect propagation, the function and every caller that inherited those effects move `logic` although nobody edited them. An IR scanned before this release, compared with one scanned after, reports them as logic changes and trips `--fail-on logic-changed` or `changed`. No `api` or `syntax` fingerprint moves, since neither reads `bindings`. On this repository, where no destructuring parameter binds a name its own file imports or declares, scanning one tree with both versions keeps all 3,270 Symbol ids and moves no fingerprint, no `calls[].resolved` and no dependency; 7 parameters gain `bindings`. There is no `grammarRevision` counterpart for `logic` to warn you that a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

- 6097160: An `if` is now recorded as a `guard` only when its body can leave the flow the `if` sits in. A `return` inside a callback written in the body (`list.forEach((i) => { if (!i) return })`), a `break` of a `switch` nested there, and a `break` or `continue` of an inner loop used to count, so the enclosing `if` became a guard nobody wrote: giving a callback in an `if` a block body, `(i) => { return i.id }` for `(i) => i.id`, was reported as a logic change and tripped `--fail-on logic-changed`. A `return`, `break` or `continue` inside a function written in the body, a method or a class static block included, no longer counts; a `break` counts only when its loop, `switch` or label is outside the `if`, and a `continue` only when its loop or label is. A `throw` or `process.exit()` still counts wherever the body holds it, inside a callback too, since a callback called synchronously throws or exits through the `if`. Giving a callback a block body is now a syntax-only change when it returns a trivial expression or a lone call. When it returns anything else, the block's `return` still adds a `return` rule its concise twin never had, because only a walk root's expression body is read as a `return`, so that edit is still a logic change.

  This moves the `logic` fingerprint of every Symbol that had such a guard, so an IR scanned before this release compared with one scanned after reports those Symbols as logic changes. On this repository, scanning one tree with both versions removes 7 of its 1,472 guard rules and moves the `logic` fingerprint of the 7 Symbols that held them, out of 2,756 kept: each is an `if` around a loop whose `break` or `continue` used to count, one of them with a callback's `return` as well. No `api` or `syntax` fingerprint moves, and no Symbol's calls or drop status change. There is no `grammarRevision` counterpart for `logic` to warn you that a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

- 4d22c3e: Overload signatures written beside their implementation (`function parse(input: string): Config;` before `function parse(input: any): any { … }`, and method overloads in a class, constructors and `static` and `#`-private methods included) now fold into the implementation's Symbol as declarations with no body, so they reach its `syntax` fingerprint. They were dropped, so an edit to an overload never reached the Symbol it belongs to: `aburi diff` reported adding, removing or retyping a module-level overload as no change at all, and a method's only as a change to its class, whose body serializes every member. Such an edit is now a syntax-only change on the function or method itself. The implementation still leads and supplies the signature, the range and the body, so `api` and `logic` do not move, and such Symbols now carry `declaration-merged`. Overloads with no implementation beside them still produce no Symbol. A module-level generator overload (`export function* g(a: string): Iterable<string>;`) is one the grammar does not parse as a signature, so it still does not fold; in a class body it does. A member written as overloads or as an accessor pair, beside a merged namespace's export of the same name, now lists `declaration-merged` in `derivedBy` once rather than twice; no fingerprint reads `derivedBy`.

  This moves the `syntax` fingerprint of every overloaded function, method and constructor once, so an IR scanned before this release, compared with one scanned after, reports each of them as a syntax-only change, with `api` and `logic` unchanged, and trips `--fail-on changed` or `syntax-changed`. On this repository, which writes no overloads, scanning one tree with both versions keeps all 3242 Symbol ids and moves no fingerprint. Aburi does not yet compare `grammarRevision` at diff time, so nothing warns you when a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

- d54a82a: Name module-level registrations by what they are written with, not by where they are written

  A module-level registration with no quoted path (`app.use(cors())`, `app.use(authMw)`) is now named by the names its arguments carry (`app__use__cors__d0`, `app__use__authMw__d0`), and its path is read wherever it is written. Both used to fall back to a source-order ordinal (`app__use__d0`, `app__use__d1`, …), so inserting one registration above others renamed every later one, and `aburi diff` paired each with the body its id used to hold: adding `app.use(compression())` was reported as removing the authorization guard of the middleware below it.

  - **The path.** A path written in backticks with no substitution (``app.get(`/users`, h)``) is the path it spells, as one in quotes is. A path written up the chain names the registration (`app.route('/a').get(h)` is `app__get__$a__d0`, where it was named by the handler, so every `app.route(…).get(h)` shared one stem). A comment or a wrapper in front of the path (`("/users")`, `"/users" as string`) no longer hides it. An empty path (`app.get("", h)`) is no path.
  - **The names.** With no path, an identifier (`authMw`), a dotted reference (`express.json` → `express_json`), a call's callee (`cors()`), a constructor (`new Logger()`) or a spread (`...mws`) names the registration, several joined by `$`. Registrations whose arguments name nothing (an inline function) keep the ordinal among themselves.
  - **Characters.** A name or a path outside ASCII keeps its characters, as the qualified-name grammar does: `app.use(認証)` and `app.use(圧縮)` both used to fold to `app__use____`. The segment is written in Unicode NFC.
  - **`derivedBy`** carries `argument-names:<slug>` when the names named it, beside the existing `path-literal:<path>`; never both.

  A substitution-free backtick argument is also a literal in `calls[].literalArgs`, so the literal-first-argument check in `@aburi/effects-drizzle` and `@aburi/effects-prisma` now reads it: ``router.delete(`/users/:id`, h)`` is no longer recorded as a Drizzle write, nor ``this.cache.items.delete(`session`)`` as a Prisma one.

  `@aburi/framework-express` reads a mount's path the same way, so ``app.use(`/api`, apiRouter)`` is `framework:express:mount`, as its id says, where it was classified `middleware`. A comment between `use`'s arguments is no longer counted as one.

  **Existing ids change once.** Every registration the old naming left to the ordinal — a path-less one, one whose path was in backticks or up the chain — and every one whose name or path holds a character outside ASCII gets a new id, so a diff against an IR written before this release reports each as removed and added one time. Rescan the base rather than comparing against a stored IR; `aburi diff <base>..<head>` scans both sides with this release and is unaffected. Measured by scanning before and after: the `nestjs-billing` fixture's 39 ids and the 23 ids of the Express sources the test suites scan (17 registrations, each with a quoted path or an inline handler) are identical; a conventional Express entry file — `helmet()`, `cors()`, `compression()`, `morgan(…)`, three `express.*` parsers, a router mount, a backtick health check, an `app.route(…)` chain, 404 and error handlers — changes 11 of its 14 registration ids, keeping the quoted mount, `app.set(…)` and `app.listen(…)`.

- b681720: A returned bracket access whose index is computed, `return cache[computeKey(key)]` or `return LABELS[await prisma.user.count()]`, is no longer read as a trivial return, and neither is one anywhere on the returned expression's trivial spine, under a unary operator or a member chain (`return !flags[flagName(x)]`, `return this.table[await loadIndex(x)].value`). Only the object was checked, and a trivial return is not walked, so in a block body every call in the index was lost from `calls[]` and `effects[]`: reading the index from the database was reported as a syntax-only change, and the same call was recorded as soon as it was hoisted into a local. A concise arrow body is walked whole and always recorded the call, so the two spellings now agree. Such a return is now a `return` rule in either spelling, and its calls are recorded. `items[0]`, `map[key]` and `this.items[0]` stay trivial, and so does an index that is a type-level wrapper around a name (`obj[key as keyof T]`, `a[i!]`), while `return x as T` stays a rule. An index that is a template literal, an `await` or a conditional is not trivial even without a call, so ``return a[`k`]`` and `return a[await p]` are rules.

  This moves the `logic` fingerprint of every Symbol that returns a bracket access with a non-trivial index, so an IR scanned before this release, compared with one scanned after, reports those Symbols as logic changes and trips `--fail-on changed` or `logic-changed`. A block-bodied Symbol whose body is only such a return had no rule naming anything and, with the call lost, no effect, so its `logic` named nothing and the diff had to pair it by name; it now carries a `return` rule with an `expr`, so it starts pairing on its `logic` fingerprint, and one moved to another file and renamed in the same change is no longer reported as one Symbol removed and another added. On this repository, scanning one tree with both versions moves no fingerprint and adds no call, because no Symbol here returns such an access. `expr` is still not cut at 120 characters as `ir-schema.md` §8.2 specifies, and an index that awaits a query passes that length readily. Aburi does not yet compare `grammarRevision` at diff time as `fingerprint.md` §5.6 specifies, and the plugin publishes a fixed placeholder for it, so nothing warns you when a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

### Patch Changes

- 80be216: A JSDoc `@throws` tag without braces no longer records the first word of its description as a thrown type. `@throws If the id is unknown.` used to put `If` in `signature.throws`, so rewording the comment was reported as an API change and could trip `--fail-on api-changed`. A bare word now counts only when it is the tag's whole text and reads as a type name (`@throws PaymentDeclined`, `@throws Errors.NotFound`); anything else records nothing. TSDoc's `@throws {@link NotFoundError}` (and `{@linkcode …}`, `{@linkplain …}`) now records `NotFoundError` instead of `@link NotFoundError`, and a link that names no declaration, such as a URL, records nothing. A tag written later on the same line still ends the text before it, so `@throws A @throws B` records both.

  `throws` is an input of the `api` fingerprint and one of the three terms of the `signatureSimilarity` score that pairs a renamed Symbol with its old self. A codebase with brace-less prose `@throws` therefore sees api changes on the first run after upgrading, on Symbols nobody touched, wherever an IR scanned before this release is compared with one scanned after; and a rename whose pairing leaned on those words may pair differently, or not at all. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with this release and is unaffected. On this repository, which writes its `@throws` braced or as a single type name, scanning one tree with both versions moves no fingerprint.

  LSP enrichment keeps a reader of its own in `@aburi/core` for the `@throws` in a callee's hover, which fills `inferredThrows` and is not an `api` input. It now follows the same rule, so the two fields no longer disagree about what one tag declares.

- 36fd72f: A parameter's optional marker, default and rest marker now reach the `api` fingerprint. Each `Signature.inputs` entry can carry two new optional fields, written only when true: `optional` for a parameter written `a?: T` or with a default, and `rest` for `...ids: T[]`. The api fingerprint hashes them beside `type`, which stays the annotation alone; a rest parameter's `name` is now the bare binding (`ids` rather than `...ids`). Making an optional parameter required, dropping a default, or turning `T[]` into `...T[]` used to leave every fingerprint identical, so `aburi diff` reported no change and `--fail-on api-changed` passed. The diff now reports an api change and names the parameter under `signature.inputs modified`. The Markdown output prints the markers where TypeScript writes them (`a?: string`, `...ids: string[]`, and `limit?` for a default), and an untyped parameter as its name alone rather than `x: `. A parameter whose name a recovered parse left missing, such as `f(?: string)`, is named by the text the source wrote rather than by an empty string.

  Functions with an optional, defaulted or rest parameter get a new `api` value once. A parameter with neither carries no new key, so its hash is byte-identical. Scanning this repository, 191 of its 2,714 kept Symbols moved `api`, and none moved `logic`, `syntax`, `calls[].resolved` or `dependencies[]`. Those can move in one narrow case: a function calls, by its bare name, a Symbol that one of its own rest parameters also names, as in `function run(...save) { save() }` with a `save` declared in or imported into the module. The bare name now shadows that Symbol, as any other parameter's name does, so the call no longer resolves to it. The edge and the effects it carried leave the function, and because `logic` is computed after effect propagation, callers that inherited those effects move `logic` too. An IR scanned before this release, compared with one scanned after, reports the affected Symbols as changed; rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides and is unaffected.

- 463d616: Rule `condition`, `what` and `expr` strings are now written in the form the IR schema gives them: comments are taken out, whitespace is collapsed to one space, and a string longer than 120 characters is cut to its first 120 plus `...`. A long guard or return no longer makes the IR fail the schema's `maxLength`, a re-wrapped guard is no longer listed under "rules modified", and a comment inside a condition or return no longer moves the `logic` fingerprint unless it is the only thing between two tokens. The scan also applies the collapse and the cut at the plugin boundary, so every language plugin's rules fit the schema. `@aburi/core` exports `normalizeRuleText` and `normalizeRuleStrings` for plugins that want to write the form themselves.

  A baseline IR written by an earlier version, compared with one written by this one, reports every Symbol with a rule string longer than 120 characters or holding a comment as changed, once, with those rules under "rules modified"; a Symbol changed for another reason also lists there, that one time, any condition or throw value whose whitespace this version collapses. Regenerating the baseline settles it.

- Updated dependencies [3b52db9]
- Updated dependencies [dfffac9]
- Updated dependencies [80be216]
- Updated dependencies [50c0bd2]
- Updated dependencies [a6cd1ac]
- Updated dependencies [36fd72f]
- Updated dependencies [eb4ab00]
- Updated dependencies [463d616]
- Updated dependencies [47f8ef9]
  - @aburi/core@0.6.0
  - @aburi/types@0.6.0

## 0.5.0

### Minor Changes

- cac0837: An arrow with an expression body now gets the `return` rule its block spelling does, wherever the arrow is a Symbol's walk root: `const canEdit = (u) => u.role === "admin"` reports `return: u.role === "admin"` as `function canEdit(u) { return u.role === "admin" }` always has. The body was walked as a bare expression, so editing it moved no rule, and so no `logic` fingerprint where the body holds no effect: `aburi diff` filed the edit under syntax-only changes, and `--fail-on logic-changed` did not fire. The same triviality rules apply as for `return`: a lone call or `new` records the call and adds no rule, and a name, literal or member chain adds nothing. The one pair of parentheses an object-literal body needs is not part of `expr`. Calls are collected exactly as before. Variable-assigned arrows, class fields holding an arrow, registered handlers and `export default` arrows are the walk roots covered; an arrow written inside another body, such as a callback passed to `map` inside a function, is not one and still adds no rule. A function a module-level `const` hands its initializer's call is a walk root, so `const doubled = xs.map((x) => x * 2)` does get the rule.

  This moves the `logic` fingerprint of every concise arrow whose expression is non-trivial, so an IR scanned before this release compared with one scanned after reports those Symbols as logic changes. On this repository, scanning one tree with both versions moves 29 Symbols, all of them concise arrows, and leaves every Symbol's calls unchanged. This repository has almost no JSX, so a `.tsx` codebase sees more: an arrow component's markup is now its `expr` (`export const A = (p) => <p>{p.x}</p>` reports `return: <p>{p.x}</p>`), so every such component moves once, and from then on a `className` or label edit is a logic change. `expr` is still not cut at 120 characters as `ir-schema.md` §8.2 specifies (#332), and JSX bodies pass that length routinely. A concise arrow with a non-trivial expression that is moved to another file and renamed in one change now pairs on its `logic` fingerprint, as its block twin always has; before, its logic named nothing, so it had to pair by name, and two names far apart were reported as one Symbol removed and another added.

- 2b85a00: An export of a namespace merged into a class is named as the class's static member, and a call through the class name reaches it

  `class C { m() {} }` beside `namespace C { export function m() {} }` produced one Symbol, `C.m`,
  carrying the method's range and both bodies' calls. The export is now `C::m`, the static member
  TypeScript resolves it as, and the method keeps `C.m`. Ids of every such export change from `C.x`
  to `C::x`, and so do the ids of everything declared under one (`C::Inner.g`). What the namespace
  does not export keeps the dot (`C.local`).

  Other effects visible in a Document or a diff against an older one:

  - The instance member no longer folds with the export, so it loses `declaration-merged` and its
    `mergedDeclarations`. Its syntax fingerprint changes, and a diff against an older Document
    reports it as modified though nobody touched it.
  - A namespace holding only types may be written before the class. There its `export type m`
    used to lead the fold, so the Symbol was a dropped `type` and the method's calls and effects
    went nowhere. They now appear on `C.m`, with `C::m` the dropped type.
  - A `static m()` beside `export function m()` in the namespace is now one Symbol, `C::m`,
    where it was two (`C::m` and `C.m`). A `static m()` beside `export type m` folds the same
    way, as a value and a type of one name do elsewhere.
  - In `@aburi/core`, file and import scope resolve `C.m()` to `C::m` when it exists: a class-name
    receiver reads the static side. A call to a real static method, which resolved to nothing,
    now gets an edge, and a call to a namespace export gets one again. Component and workspace
    scope still compare the target with `Symbol.name` verbatim. LSP enrichment now finds a
    static member's document symbol, which it looked up by the text after the last `.`.
  - In `@aburi/diff`, rename matching reads the member after the last separator of either kind,
    so `C::Inner.g` is matched on `g` rather than `Inner.g`.

- d23fc40: A function an object literal holds is now a Symbol of its own. `export const api = { get: async () => fetch("/x"), post() { send() } }` declares `api.get` and `api.post`, each with its own rules, calls, effects and signature, where the handlers used to be in no Symbol at all: an edit to one moved no `logic` fingerprint, a write inside one was reported nowhere, and a call such as `api.post()` resolved to nothing. A handler map, an object of validators or callbacks and a route table written this way are now reviewed handler by handler.

  - A member is `kind: "method"`, `visibility: "public"`, and carries `object-method` in `derivedBy`, plus `property-assigned-function` for the `get: () => …` spelling and `accessor-declaration` for `get` / `set`. Methods, accessor pairs, generator and `async` methods, and properties holding an arrow or a function expression all count, read through `as const`, `satisfies`, `as` and parentheses. A property holding a generator function (`g: function* () {}`) does not, as a module-level `const` holding one does not, and neither does a half-written arrow the parser recovered with no body. A `let` or `var` binding is read as a `const` is, and comes out as `kind: "const"` too.
  - Because a member is a `method`, an empty one (`{ onClose() {} }`) gets the Category-B "empty body" drop hint a class's empty method gets, so a map of no-op handlers mints Symbols that are dropped straight away. Scanning this repository, 12 of the 32 new Symbols are.
  - An object nested under a named key is read the same way, at any depth: `{ v1: { get() {} } }` declares `api.v1.get`. Only functions mint Symbols, so a configuration object of plain values declares nothing new.
  - A key with no qualified-name segment declares nothing, as for a class member: a computed key, a number, or a quoted key that is not an identifier. A quoted key that spells an identifier (`"get": …`) is the member `get`. A `#` name declares nothing either, which is where an object parts from a class: a class's `#v` is its private member, but outside a class body `#v` is a SyntaxError the grammar parses anyway.
  - The binding stays a `const` with no signature. Its body is now the object literal less its members, so a value the object evaluates when it is defined (`client: makeClient()`), and a function it holds without a Symbol of its own (`h: withAuth(() => …)`, a computed key), is reported on the binding, where it used to be reported nowhere. Such a binding carries `object-literal-initializer` in `derivedBy`, which is the one change on a binding whose object holds nothing to walk.
  - No binding's `api` or `syntax` fingerprint moves: the binding is still described by its whole declaration. Its `logic` fingerprint moves only where the object evaluates something with a rule or an effect that used to be reported nowhere — a call an effect plugin classifies, or a function with a rule and no Symbol of its own. An IR scanned before this release compared with one scanned after reports each member as added.

  Still not read: an object that is the default export (`export default { fetch() {} }`), one assigned to `module.exports`, one handed to a call (`Object.freeze({ … })`, `useQuery({ … })`), one in an array, one a destructuring declaration reads, and one a class field holds, which stays on the class (`lang-plugin.md` LP7g).

- c28f20c: Carry the receiver a decorator was written through, and read it against the file's imports

  `@nest.Controller()` and `@tsed.Controller()` were indistinguishable by the time a framework
  plugin saw them. `readDecorator` reduced a qualified decorator to its leaf identifier, so
  `Decorator` said `Controller` and nothing said which module it came from — and
  `readImportedNames` skipped `symbols: "*"` edges outright, so even a recorded
  `namespaceBinding` was never indexed. Both halves had to be wrong for the bug to hold, and
  both were.

  The consequence was the provenance table in `lang-plugin.md` §5.2.2 being out of order in its
  last row. A decorator written through a module object landed in "no edge binds it" and came
  back `high`, while the _named_ import of the same decorator from the same library came back
  `medium`. The file that disclosed more was trusted less.

  `Decorator` now carries `qualifier`: the receiver verbatim, `nest` for `@nest.Controller()`
  and `a.b` for `@a.b.C()`. It is Class B per `ir-schema.md` §1.1 — a bare decorator omits the
  key entirely — so a document written before this change reads exactly as it did, and `raw`
  still quotes the whole written form. `@aburi/framework-nestjs` resolves a qualified decorator
  through the receiver's first segment, which is the only part that can name something in
  scope, and looks that segment up in **both** binding indexes: `import * as nest` binds the
  module object under `namespaceBinding`, `import nest from` binds it as a named symbol, and a
  decorator written through either has disclosed the same thing.

  A qualified decorator deliberately does **not** resolve its _leaf_ through the named-import
  index. The leaf is a property of a module object, not an identifier in the file's scope, so a
  file that imports `Controller` by name from NestJS while writing `@tsed.Controller()` no
  longer reports the second as though it were the first.

  **What changes for a caller**

  - A NestJS Symbol classified from a module object of a competing library now reports
    `confidence: "medium"` where it reported `high`, whether the module was bound by
    `import * as` or by a default import.
  - `SymbolClassification.decoratorBoundaries` is keyed on the decorator as the source **wrote**
    it, receiver included: `nest.Controller`, not `Controller`. The contract always said
    "written name"; before `qualifier` existed the leaf _was_ that name. The leaf alone is not a
    usable key, because two decorators on one Symbol can share it while resolving to different
    vocabulary, and a shared key flags both — putting `boundary: true` on a decorator that was
    never classified, which `drop-b` then reads.
  - `@aburi/framework-nestjs` renames the exported `ImportedNames` to `ImportedBindings`, now an
    interface of two maps rather than one map, and `resolveDecoratorName` takes the decorator
    (`Pick<Decorator, "name" | "qualifier">`) instead of a bare name. Both are in the published
    types.
  - `@aburi/plugin-registry` adds `assertNamespaceBinding`, the namespace-edge counterpart to
    `assertImportBinding`: a `namespaceBinding` that is present but empty is an upstream fault
    rather than an edge to skip.

  Most `api` fingerprints do not move: `canonicalizeDecorators` names the fields it takes and
  `qualifier` is not among them, while `raw` already carried the receiver. The exception is a
  decorator whose classification changes, since `ApiInput` includes `extKind` and
  `decorators[].boundary` — a decorator that used to resolve its leaf through a named import and
  now resolves its receiver can stop matching the vocabulary, and its Symbol's api hash moves
  with it. That movement is the fix working.

- 8f12dbd: A function's parameter defaults are walked with its body

  `function f(x = g()) {}` and `const a = (y = k()) => l()` reported no call to `g` or `k` anywhere,
  because a Symbol's walk covered its body and not its parameter list. A method's defaults were
  kept, but on the class rather than the method. Every function-like Symbol — a function, an arrow,
  a method, a field holding a function, an inline handler — now walks its parameter defaults ahead
  of its body, and the class skips a member's parameter list as it skips the member's body, so
  nothing is reported twice. A constructor's defaults stay on the class too, as its body does.
  Decorators, a parameter's included, stay on the class, because they run when the class is
  defined. `fingerprint.logic` moves on a Symbol whose defaults hold a rule or an effect, and on a
  class that carried one of its members'.

- 41a75a0: A decorator written in parentheses is named after what it encloses

  `@(Controller)` is legal TypeScript, and the extractor named it after its text, `(Controller)`. That
  name matched no framework's vocabulary, so a class decorated that way stayed unclassified even when
  the file imported `Controller` from `@nestjs/common`. `@(nest\n  .Controller)` also put a line break
  into `Decorator.name`. A name, a member path or a call in parentheses is now read through them:
  `Controller`, `Controller` with qualifier `nest`, and so on, also when only an argument inside
  them is malformed. `raw` still quotes the parentheses.

  TypeScript accepts any expression there, but the grammar does not. `@(x as any)`, `@(x!)` and
  `@(a[b])` reach the extractor only through error recovery, and there is no name to read from them.
  They keep their place in the list under the reserved name `<expression>`, exported as
  `UNNAMED_DECORATOR`, with the text in `raw`. `Decorator.name` is now always an identifier or that
  marker.

- 07d0962: A `#`-private member keeps its `#` in its qualified name

  `v() {}` beside `#v() {}` produced one Symbol, `Q.v`, carrying both bodies and the visibility of
  whichever was written first. A qualified-name segment after a separator may now open with one
  `#`, and the private member is `Q.#v` (`Q::#v` when static). What changes for existing IR:

  - Ids and `Symbol.name` of every `#`-private member change from `Q.v` to `Q.#v`, and the api
    fingerprint's `shortName` from `v` to `#v`. Comparing IR built before this change with IR built
    after it reports those members as changed.
  - The LSP tier now resolves a call such as `this.#v()`: tsserver's hover names `C.#v`, which is
    now a Symbol, so the call gets an edge where it used to count as `memberNotFound`. Private
    members also get columns from document symbols.
  - A qualified name may not open with `#`, and `isQnameSegment` admits `#v` only when called with
    `{ privateName: true }`. A quoted `"#v"() {}` and an index `obj["#v"]` are still the public
    property with those characters: the first has no Symbol, the second a `<computed>` segment.

- 09fc3b3: Internal refactor: trim narrative comments, share duplicated helpers, collapse redundant tests, and rename unclear identifiers across the workspace. Public exports are unchanged apart from additions.

  - `@aburi/core` now exports the ordering helpers (`compareCodeUnit`, `compareBy`, `stringArraysEqual`), the collection helpers (`groupBy`, `countBy`) and the tree-sitter shim (`SyntaxNode`, `asSyntaxNode`, `findNamedChildOfType`, `findFirstDescendantOfType`, `calleeText`, `calleeLeaf`, `anyCallCalleeMatches`) that the framework plugins previously each carried a copy of.
  - `@aburi/plugin-registry/plugin-input` gains `receiverConfidence`, `defineEffectsManifest` and `matchesModuleOrSubpath`, which the four effects plugins now share.
  - `@aburi/lang-typescript` reads string-literal call arguments through the same decoder as member
    names, so an escape sequence inside a route path or `literalArgs` entry is now decoded instead of
    dropped. **This moves Symbol ids and `fingerprints.api`** for any call whose literal carries an
    escape: `app.get("/us\u0065rs")` was `$usrs` and is now `$users`, and `db.query("SELECT\t1")`
    reports `literalArgs` as `["SELECT<TAB>1"]` rather than `["SELECT\\t1"]`. The first `aburi diff`
    after updating reports those Symbols as changed. Hence the minor bump.
  - `@aburi/core` `detectWorkspaceRoot` no longer aborts on a `package.json` / `Cargo.toml` /
    `pyproject.toml` it could not read in a directory **above** the root it settles on. The walk asks
    every ancestor whether it declares workspaces, so a malformed or unreadable manifest outside the
    project — `$HOME/package.json` at mode 600 on a shared machine — used to fail the whole command
    with a path the reader has no business fixing. A failure at or below the settled root is still
    raised, unchanged: that one is the workspace's own, and absorbing it would root every Symbol id at
    the package the command was run from. `aburi scan` is where this is observable.
  - `@aburi/cli` `init` resolves the workspace root through the same code path as `scan`. With the
    above in place this is a refactor and not a behaviour change: a malformed root manifest still
    exits 1 out of `detectManagers`, and a manifest above the root still does not fail the command.
  - `@aburi/framework-react` `calleeText` returns `null` rather than `""` for an empty callee, matching `@aburi/framework-express`.

- 128b9e6: The `syntax` fingerprint now changes when an operator, a declaration keyword, a modifier or a primitive type does: `a + b` → `a - b`, `&&` → `||`, `<` → `<=`, `i++` → `i--`, `let` → `const`, `for…in` → `for…of`, `private` → `public`, `x as string` → `x as number`. It also changes when a hole in an array or a destructuring pattern does: `const [, token] = parts` → `const [token] = parts`. `normalizeAst` read only named nodes, and tree-sitter holds all of these as unnamed tokens, so an edit that reached neither `api` nor `logic` (an operator in an assignment, a call argument, a loop header, or an `if` with no early exit) moved no fingerprint, and `aburi diff` reported the Symbol as unchanged and every `--fail-on` gate passed. The quotes around a string that needs no escape either way, trailing commas, optional semicolons and the brackets the structure already implies still leave the fingerprint alone (`fingerprint.md` §5.1 item 4, rows S2a–S2c and S5a). A token the parser inserted to repair a broken file is no longer read.

  This changes the `syntax` fingerprint of nearly every Symbol, so an IR scanned before this release, compared with one scanned after, reports nearly every Symbol as a syntax-only change, with `api` and `logic` unchanged. Aburi does not compare `grammarRevision` at diff time yet, and the plugin publishes a fixed placeholder for it, so nothing warns you when a stored IR predates this release. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with the installed plugin and is unaffected.

- bf2498f: A `const` initialised by a call now carries the functions it hands that call: `export const POST = withAuth(async (req) => { … })`, `memo(function Row() {…})`, `forwardRef((props, ref) => …)` and `t.procedure.query(() => …)` get the handler's rules, calls and effects, and `derivedBy` carries `call-argument-function` to say where they came from. They were walked by nothing, so the const had none and no other Symbol held the code, and an edit to the handler moved no `logic` fingerprint and passed `--fail-on logic-changed`. The const stays a `const` with no signature (LP7b), and the reading is the one a registration statement already uses (LP20g): every function written as a direct argument of a call on the initializer's spine. That reading asks nothing about the call, so collection code gets bodies too: `const names = users.map((u) => u.name)`, `const ids = xs.filter(…).map(…)`. The wrapping call itself is not recorded as one of the const's calls. Each function handed this way is a walk root, so a concise arrow's expression body is read as its return value, as for a variable-assigned arrow: `const doubled = xs.map((x) => x * 2)` reports `return: x * 2`, as `xs.map((x) => { return x * 2 })` does. Still not read: a function inside an argument (`withAuth(withLogging(async () => { … }))`) or inside an object (`useQuery({ queryFn: () => { … } })`), one handed to `new`, an initializer behind `await`, a destructuring declaration, `export default withAuth(…)`, and a class field written the way the const is (LP7c lists them). The `syntax` fingerprint is unchanged, because the const is still described by its whole declaration.

  A const handing its call more than one function carries the rest on `mergedDeclarations`, as a registration with several handlers does, and each of those entries now names the declaration as its `fullNode`, on a registration too, where it used to name the function.

  An IR scanned before this release compared with one scanned after reports a `logic` change on every such const whose function has a rule or an effect.

### Patch Changes

- fa3f7a4: An `import("…")` type first in a call's type arguments or before `[]` no longer breaks the parse

  The grammar reads `import("./m")` as a call, so `importActual<typeof import("./m")>()` — how
  `vi.mock` keeps a module's originals — and `import("./m").Rule[]` were recoverable parse errors,
  and at module level `export const b = g<typeof import("./m")>()` took the declaration after it
  down too; four or more of those in a row lost every Symbol in the file. Such a file is now parsed
  once more with each of those `import(…)` replaced by a name of the same length, and the tree still
  reads the original text. Files that carried only this error leave the recoverable-parse-error
  listing, and each such `import(…)` keeps the import edge a clean one has.

- 56b6538: Make the recoverable-parse-error warning worth reading: stop counting the tsx grammar's `&`, and name the files

  Two halves of one complaint. The warning that says a scan read files it could not fully parse
  reported a bare count, and on a React codebase most of that count was the grammar rather than the
  workspace.

  **The grammar's `&`.** `@vscode/tree-sitter-wasm`'s tsx grammar reads `&` inside JSX as the
  opening of an HTML character reference and raises an ERROR when no `;` closes it. So
  `<CardTitle>Subscription & Billing</CardTitle>` and `href="/x?utm_source=a&utm_medium=b"` —
  ordinary prose and a tracking URL — were parse errors, while `&amp;`, `&nbsp;`, an attribute whose
  `&` stands alone and `{"a & b"}` were not. Measured on `shadcn-ui`, 110 of 3,912 `.tsx` files
  carried a recoverable parse error and every one of them was this. No published grammar has fixed
  it as of 2026-09, and the dependency is a `^0.3.1` range, so a fix would arrive on its own if one
  ever shipped.

  Nothing was lost by it and nothing is lost by dropping it: the same component written with `&` and
  with `&amp;` extracts the same Symbols, the same signature and the same `calls[]`, including a call
  written below the ampersand. What it cost was the signal — a warning that fires on 3% of files as a
  matter of course stops being read — so `collectParseErrors` no longer reports that one shape
  (`lang-plugin.md` LP27a).

  The shape is narrow so a file that really was truncated is not dropped with it. The run the grammar
  could not place has to open with an ampersand-led token, sit among a JSX element's children or
  inside a JSX attribute's string value, and — among children — hold none of `{`, `}`, `<`, `>`,
  which JSX text cannot contain. That last rule matters because tree-sitter merges an adjacent
  unparseable stretch into one ERROR node: without it, an `&` earlier in the same children swallowed
  everything after it, and `<div>a & } b</div>` went quiet. The four characters are ordinary inside
  an attribute's string, so the rule does not reach there.

  A truncation whose ERROR sits outside both positions still reports, including in a file that
  carries one of each: `export const U = () => <div><p>a & b</p>` reports the unterminated `<div>`
  and nothing else.

  **The files behind the count.** `⚠ N file(s) had recoverable parse errors.` was the whole warning,
  and mostly these files are in the IR, so `stats.skippedFiles[]` does not hold them and no per-file
  log line is written for them either — there was nowhere to look up which files they were. `aburi
scan` now lists them under that line, each with the first error reported for it and a count when
  there was more than one.

  The listing is **uncapped**, unlike the skip census below it, and sits up with the other sections
  whose entries exist nowhere else. Capping the only account of something is the loss rather than
  the shape of it. `aburi diff` is unchanged here on purpose: it runs both scans, each report names
  its own files with the side in the header, so the diff-level line stays a count and a consequence
  rather than a third printing of every doubtful path.

  Minor for `@aburi/cli` rather than patch: `ScanReport` gains a required `parseErrorFiles`.
  `parseErrorCount` is kept, set from that list's length where the report is built.

- 568ab0c: A call on a literal or other unnamed expression no longer withdraws the file

  The callee normalizer copied the source text of any receiver it did not model into the call
  target. `[...names].sort()` became `[...names].sort`, whose `...` is two empty segments, and every
  effect plugin's segment guard threw on it, so the file and all of its Symbols were withdrawn and
  `aburi scan` exited 3 — in files that never import the plugin's library. An IIFE put its whole
  function body into `calls[].target`. Such a receiver (a literal, `new C()`, `await`, a binary
  expression, a function expression) now contributes the reserved `<computed>` segment and marks the
  call `dynamicReceiver`: `[...names].sort()` is `<computed>.sort`, an IIFE is `<computed>`.
  `svc!.save()` and other type wrappers around a name keep their text; around anything else they
  answer what they wrap, and a text holding an empty segment or a line break answers `<computed>`.

  `calls[].target` does not reach the diff's fingerprints, but an effect's target is its call's
  target, and `effects[].target` does. So a Symbol with an effect classified on such a receiver
  shows `~` (logic) once after upgrading, and receivers that differed only in their text now share
  one target: `new PrismaClient().user.create(…)` and `(await getDb()).user.create(…)` are both
  `<computed>.user.create`, and their propagated effects merge into one entry where both reach a
  caller. The first one's effect also drops from `high` to `medium` confidence, since the client's
  name was only ever visible in the receiver's text.

- 1cc9220: Stop reporting a type parameter's `in` / `out` variance modifier as a recoverable parse error

  The typescript grammar `@vscode/tree-sitter-wasm` ships has no rule for TypeScript 4.7's variance
  annotations, so `interface A<out T>`, `class E<in out T>` and `type F<out T> = …` were parse errors
  in files `tsc` accepts. On `zod` that was every recoverable parse error the scan reported: 21 in 4
  files, all in its `v4` schema declarations. No published release of the grammar has fixed it.

  The same declarations written with and without their modifiers extract the same Symbols, with the
  same signatures and calls. What the error cost was the signal, the same way the tsx grammar's `&`
  did, so `collectParseErrors` now drops this shape too (`lang-plugin.md` LP27c). One thing the
  grammar does lose, before and after this change: an annotated type alias's `normalizeAst` reads
  the modifier where the parameter's name should be, so renaming that parameter does not change it.
  The file just no longer says it is doubtful.

  Recovery does not split an annotated parameter one way. Usually the modifier becomes the
  parameter's name and the real name an ERROR after it, or inside it when there is a constraint or a
  default; in some longer lists, `zod`'s among them, each `out` is the ERROR, before a parameter that
  parsed clean. So the rule reads the words before the parameter's constraint and default back across
  those pieces, and drops the ERROR only when they are `in`, `out` or `in out` and then one name, in
  the type parameters of a class, an interface or a type alias. A `const` among them is allowed on a
  class only, and a reserved word or a predefined type's name is not a name. A repeated or misordered
  modifier, two names, `<out in>`, `interface A<const out T>`, a name after a constraint, a stray
  token, and a modifier on a function's or method's own type parameters all still report, as `tsc`'s
  parser rejects them too. The rule does not read a type alias's right-hand side, so
  `type A<out T> = T`, which only `tsc`'s checker refuses, is dropped as well.

- Updated dependencies [aedc9fd]
- Updated dependencies [5a9ebda]
- Updated dependencies [8187694]
- Updated dependencies [666f383]
- Updated dependencies [0f168b1]
- Updated dependencies [d6de3b0]
- Updated dependencies [2b85a00]
- Updated dependencies [c28f20c]
- Updated dependencies [1d09de8]
- Updated dependencies [664e993]
- Updated dependencies [41a75a0]
- Updated dependencies [07d0962]
- Updated dependencies [09fc3b3]
- Updated dependencies [8402798]
- Updated dependencies [3dd0dd0]
- Updated dependencies [d2ad0b0]
  - @aburi/types@0.5.0
  - @aburi/core@0.5.0

## 0.4.0

### Minor Changes

- be8e2b9: One Symbol per declared entity, however many declarations wrote it

  A getter beside its setter, an overload beside its implementation, and a reopened namespace or
  interface each made `extractSymbols` emit two SymbolCandidates under one id. Integrity invariant 1
  (`ir-schema.md` §14) refuses that, and it is checked once over the finished document rather than
  per file — so `class Box { get value() {} set value(n) {} }` did not cost its own file, it ended
  the run and took every other file's Symbols with it.

  TypeScript models all three the same way: one entity, several declarations. So does extraction
  now. The first declaration claims the Symbol and every scalar on it; later declarations of the
  same id contribute their `derivedBy` and their body instead of becoming a second Symbol. First
  wins because legal source already orders them — TypeScript requires the class or function to
  precede the namespace merged into it, and requires a merge's declarations to agree on whether
  they are exported.

  Two constructs are handled before that rule rather than by it, because it would answer them
  wrongly:

  - **An overload declaration is skipped.** A `method_signature` in a class body declares nothing
    the implementation beside it does not, and it is written _first_ — so folding it as the leading
    declaration would report the member as body-less and give it the overload's parameter types.
    Top-level overloads have always behaved this way (`function_signature` is not in the statement
    switch); a class matches now, so the same source does not answer differently depending on where
    it is written.
  - **An accessor pair is led by the getter.** A property's type is what reading it answers, so
    taking the setter's signature would report the member as `(n) => void`.

  `SymbolCandidate` gains `mergedDeclarations?: MergedDeclaration<TNode>[]`: the further
  declarations, in source order, each carrying both its `bodyNode` and its `fullNode`. Without the
  field, folding a pair would drop the setter's body — a `set password(v)` that hashes the value has
  effects. Without `fullNode` on the entry, a reopened `enum E {}` would fingerprint as though the
  second declaration had never been written, because an enum candidate has no body at all. Only the
  bodies reach `walkBody`, which is what keeps a merged namespace from being walked twice. The key is
  absent, never empty, on a Symbol with one declaration, so the single-declaration path is untouched
  and no existing fingerprint moves.

  `derivedBy` and `decorators` join the same way. A lost `boundary` decorator is not cosmetic:
  `interface P {}` written above `@Controller() class P {}` is legal, so the declaration that claims
  the Symbol is the one carrying none.

  Two drop rules were reading one declaration where they should read all of them, and one was reading
  decorators nowhere. `classifySymbolDropHint` now honours a boundary decorator for every kind rather
  than only for classes — core's `decideSymbolDrop` answers `null` on a boundary and then defers to
  this hint, so an unguarded arm here is the one that decides. `classifyClassBody` reads class bodies
  only, so a merged `interface C {}` does not contribute members the class does not have.

  Two namespace fixes come with it, because folding a reopened namespace requires reaching one.

  An unexported `namespace` at statement position is parented under an `expression_statement`, which
  the statement switch never looked through — so every unexported namespace lost its own Symbol
  _and_ everything declared inside it.

  And a dotted `namespace A.B {}` is sugar for `namespace A { namespace B {} }`. Reading the dotted
  text as one qualified-name segment is what the id builder refuses, and the throw cost the file every
  Symbol it had; it declares one Symbol per segment now, with the body under all of them.

- f9195d6: A class member written as a field holding a function is a member

  `create(data) { … }` and `create = async (data) => { … }` are the same member written two
  ways, and only the first had a Symbol. The second was a `public_field_definition`, so its body
  stayed on the class — and because `new C()` resolves to the class Symbol
  (`call-resolution.md` CR15), a factory whose whole body is `return new UserService(prisma)`
  was reported as writing to the database. The same report the class-body change was about,
  reproduced on the other common way to write a service.

  A field whose value is an arrow or a function expression now gets a member Symbol of its own:
  `kind: "method"`, named by the class-member convention (`C.create`, `C::create` for a static
  one), with the function's signature and the field's decorators. The class stops carrying its
  body. `arrow_function` and `function_expression` are the set, which is exactly the set
  `const f = …` already used at module level, so the two levels are one decision.

  What separates it from a field that is not a member is when the value runs: `seed = makeSeed()`
  runs on construction and stays on the class; `seed = () => makeSeed()` runs when it is called
  and moves. A parameter default (`create = (x = f()) => …`) and a decorator's arguments stay on
  the class the way a method's do, because that is where they run.

  The drop list follows: a class whose members are function-valued fields is no longer read as a
  pure DTO.

  Four shapes are deliberately left where they were. A computed, string-literal or numeric
  member name gets no Symbol — admitting a name the qualified-name grammar refuses would turn a
  file that extracts today into a file lost at the per-file boundary. A generator field is
  outside the function set at both levels. A field whose value is a function behind a wrapper
  (`handle = withAuth(async (r) => …)`, `useCallback`, `memoize`) is a call expression, not a
  function, so it is a field: the report this fixes still reproduces on that spelling. And a
  field named `constructor`, which an engine refuses and the grammar accepts, is refused a
  Symbol rather than given the segment reserved for what `new C()` runs.

  The IR moves for every class with a function-valued field: one new Symbol per field, and the
  class's `fingerprint.logic` loses the bodies it was carrying, as do the callers whose
  propagated effects came through one.

- 3774de6: Free the parse tree the language plugin hands over

  A WASM parse tree is not something the JavaScript garbage collector can reach. `lang-plugin.md`
  §8.1 says so and names the consequence — `RangeError: WebAssembly.Memory()` after some thousands
  of files — but told the plugin to free a tree it had already given away, and nobody on the other
  side picked it up. `@aburi/core` contained no `delete` call at all, so every file that parsed
  successfully left its tree in the WASM heap for the rest of the run.

  `LanguagePlugin` gains an optional `releaseTree(tree)`. `runFilePipeline` calls it once per
  non-null tree, in a `finally` that covers every way out of the file: the success path, a file
  withdrawn by a `recoverable: false` error, a file abandoned on `parseTimeoutMs`, and a throw out
  of `extractSymbols`, `walkBody` or `normalizeAst`. A plugin whose trees are ordinary
  garbage-collected objects omits the method and nothing changes for it.

  The core is the only side that can do this. `parseFile` gives the handle away at step 1 and the
  tree stays live until `normalizeAst` has read the last node out of it — a plugin that deleted
  its own tree on the way out would be handing back something already dead. The one place the
  plugin still frees it is a `parseFile` that fails _after_ parsing, where the caller never
  receives the handle.

  A release that fails is recorded rather than propagated. It runs in a `finally`, so a throw
  there would silently become the file's outcome — replacing the diagnostic a failing file was
  already carrying, and turning a file that produced a perfectly good set of Symbols into an
  extraction failure. The record is structural: `ScanResult.treeReleaseFailures` names the
  plugin, the file and what went wrong, because a leak is silent until the run dies of it, and
  by then it presents as `RangeError: WebAssembly.Memory()` charged to whichever unrelated file
  was being read when the heap ran out. `ScanReport` carries it to the CLI, which prints it
  grouped by plugin with what the leak costs. It moves no exit code: every one of those files is
  in the IR, so the artifact describes the workspace completely.

  A `releaseTree` declared as something other than a function is recorded there too, in its own
  words — a contract violation is deterministic and fixable in a line, and reading it through the
  same `TypeError` catch as a parser failure would describe it as one. A `null` `releaseTree` is
  read as "nothing to free", the way the optional call it replaced did.

  `@aburi/lang-typescript` implements it as `tree.delete()`, and is exported with `satisfies` so
  the method stays required on the exported type.

- 0a74d65: Parse JavaScript with a grammar that accepts JSX

  `.js`, `.mjs` and `.cjs` were read with the TypeScript grammar, which does not accept JSX. The
  JavaScript coverage exists so `@aburi/framework-react` can classify React sources in
  plain-JavaScript codebases, and a React source written in `.js` contains JSX in `.js` — which
  is what `create-next-app`'s JavaScript template emits and what CRA emitted.

  The grammar recovers past JSX rather than failing, so the file still reached the IR and the
  declarations mostly survived. What did not survive is everything from the first tag onwards:
  the JSX a classifier reads to recognise a component, and every call written inside the markup.
  On the `create-next-app` JavaScript template, both components came out `extKind: null` and a
  handler written `onClick={() => track(c)}` contributed no call to any Symbol. A hook still
  classified, because a hook is recognised by its name.

  The three JavaScript extensions now route to the tsx grammar, which is where `.jsx` already
  went. The TypeScript extensions do not move.

  What a JavaScript file gives up is the old-style type assertion `<T>expr` — legal TypeScript,
  never legal JavaScript, and accepted in a `.js` file only because that file was being read as
  TypeScript. It is the only thing the tsx grammar refuses that the TypeScript grammar accepts:
  measured over 6,000
  published `.js` / `.cjs` / `.mjs` files, every one produces a byte-identical tree under both.

  A React app written in JavaScript therefore gains the calls inside its markup, its framework
  classification, and — where a declaration did not survive recovery — Symbols it did not have.
  It also stops contributing to the recoverable-parse-error count, which is the only signal a
  reader gets that a file's Symbol set may be short.

- 2dfb45d: A function written in plain sight has its body walked

  Two shapes where the extractor was looking straight at a function and did not see it.

  **Behind a wrapper.** `const h = (() => { … })`, `… satisfies H`, `… as any`, `…!` — a
  parenthesis, a type assertion and a non-null assertion all leave the value exactly what it was,
  but the test for "is this binding a function" only accepted a bare arrow or function
  expression. The binding came out `kind: "const"` with no body, so everything it did was in no
  Symbol. It now reads through those wrappers, in the one predicate the whole plugin shares, so a
  module-level binding, a class field and a registration argument cannot answer differently.

  A **call** is not a wrapper. `withAuth(() => …)` returns a function by convention and nothing
  in the tree says so; reading through it would be a guess rather than an unwrap.

  **In argument position.** `app.post("/users", async (req, res) => { … })` already produced a
  Symbol for the registration, with no body — so a route whose handler wrote to the database
  reported nothing, and every route in a file shared one `fingerprint.logic`, because they all
  had zero rules and zero effects. The functions written as direct arguments of the calls on the
  statement's spine are now the Symbol's bodies, in source order: `app.route(p).get(h1).post(h2)`
  and `app.use(h0).router.get(h1)` are each one statement and one Symbol, and both handlers are
  walked. "Function" is the same predicate as above and no wider — a generator argument
  registers no body — and a half-written handler the parser only recovered registers none either.

  The registration's own `signature` stays `null`: it is the registration, not the handler, and
  reading the handler's would publish the framework's callback shape as the route's API. Its
  **normalized string stays the whole call**, for the same reason from the other direction: what
  the registration runs is the walk's question, and what it _is_ — its path, its method, the
  middleware standing between them and the handler — is the fingerprint's. Narrowing to the body
  would have made `app.get(p, authenticate, h)` and `app.get(p, h)` serialize identically, so a
  route gaining or losing its auth middleware would have produced no signal on any axis.

  The receiver side reads through wrappers too, which it did not: it hand-unwrapped parentheses
  and nothing else, so `(app as Express).get(p, h)` and `app!.get(p, h)` were not registrations
  at all. They are now, which means **new Symbol ids appear** in a workspace that writes them.

  What else moves: a registration Symbol with an inline handler gains that handler's calls, rules
  and effects, and its `fingerprint.logic` changes wherever the handler contributes a rule or an
  effect. `fingerprint.syntax` and `fingerprint.api` do not move at all. A registration with no
  function argument (`app.listen(3000)`), or one whose handler is passed by name
  (`app.get("/x", handler)`), is unchanged.

- 6676ca7: Read a quoted class member name as the name it spells, instead of losing the file

  `class C { "ok"() {} }` and `class C { 1() {} }` are legal TypeScript — the member is addressed
  as `C["ok"]` / `C[1]` — and both cost the file every Symbol it had. The plugin handed the name
  node's _source text_ to the Symbol-id builder, which refuses anything that is not an identifier;
  the throw was caught at the per-file boundary, and the file was named in `stats.skippedFiles`
  with `reason: "extraction-failed"`. Widening the qualified-name grammar to ECMAScript's
  IdentifierName closed this for a Japanese or accented declaration; a quoted or numeric property
  name is a `PropertyName` and was outside that widening by construction.

  A written name and a qualified-name segment are two different things now. One function answers
  what segment a member's name maps to, or `null` when the grammar has none for it — which is the
  answer `ir-schema.md` §3.2 already gives a computed name: **no Symbol, no diagnostic**, and the
  body stays on the class, where its calls and rules are still reported.

  **A quoted name that decodes to an identifier is that identifier.** A property key is a string,
  so `"ok"() {}` and `ok() {}` declare the same property — `tsc` calls the pair TS2393, a
  duplicate _implementation_ — and they fold onto one Symbol the way a field and a method of
  the same name already do. The literal is decoded rather than unquoted, so an escaped spelling
  names the member it spells.

  **A name the parser guessed at is refused**, and it arrives in two shapes. A literal that parsed
  in part keeps its node and is read as incomplete. One that did not parse at all leaves no
  literal behind: recovery re-emits the surviving characters as a plain name, so `"\uZZZZ"() {}`
  used to record a member called `ZZZZ` — a name the source does not spell. Both now have no
  Symbol, which makes the second the one case where this removes a Symbol the previous release
  produced. What says the name is a guess is an ERROR among the member's own children, so a
  member whose _body_ fails to parse keeps its Symbol as before.

  Two things follow from having one answer rather than two:

  - **`"constructor"() {}` is the constructor.** A class element whose property name is
    `constructor` is the constructor whatever the spelling. Read as a method it took the instance
    qualified name, where it collided with a real constructor's. Two spellings that carry the
    segment stay off the construction path, because neither is a property name: a `static` member,
    and a `#`-private one, whose `#` is exactly what the segment drops.
  - **A field holding a function is gated the same way a method is.** The field gate refused every
    name not written as an identifier, because a name the id builder refuses was a lost file. That
    reason is gone, so `"ok" = () => {}` is now the member `ok` — a Symbol where there was none.

  One diagnostic is corrected on the way past. A module specifier written as a line continuation
  followed by an escape the grammar refuses — `import x from "\<newline>\uZZZZ"` — was reported as
  naming no module, on top of the syntax errors that already said why the name could not be read.
  The continuation contributes no character, so the read came back empty and was indistinguishable
  from an empty literal; reading whether the literal was _wholly_ read tells them apart.

  `@aburi/core` exports `isQnameSegment`, the single-segment predicate a producer needs to ask
  _before_ it builds. `isQualifiedName` is the wrong one for that question and fails quietly: it
  answers about a finished name, so it admits `.` and `::`, and a caller vetting one member name
  with it would accept `"a.b"` and mint the nested qualified name `C.a.b` out of a single member.

- 7f9ed89: Extract the declarations that are written without a body

  Two statement shapes never reached the extractor, and both of them declare an entity the source
  has no other place to say. A member written `abstract doIt(): void` arrives as an
  `abstract_method_signature`, which the class-body switch did not admit — so `abstract class A {
abstract doIt(): void; run() {} }` reported `A` and `A.run`, and the member the class actually
  promises its subclasses was missing from the IR. And `declare` is a modifier tree-sitter spells
  as a wrapper node around the declaration, which the statement switch did not read through — so
  `declare function f(): void`, `export declare class C { m(): void }` and `declare namespace N {
… }` produced no Symbols at all. `.d.ts` files are dropped before extraction on purpose, but
  these forms are written in ordinary `.ts` files and were not.

  An abstract member is now a `method` with a null `bodyNode` and `abstract-declaration` on
  `derivedBy`; a declaration under a `declare` gets the SymbolCandidate it would get written
  without the keyword, plus `ambient-declaration`, and the members and nested declarations under
  it come with it. Reading the wrapper _through_ rather than matching on it is what makes each
  form reach the arm it belongs in. It also puts the export one node further up than a reader of
  `node.parent` looks, so `export declare class C {}` needs the wrapper stepped over before it
  reads as exported at all — which `statementParent` now does for every reader that asks.

  A signature with no body is a Symbol only under a `declare`. Written outside one it is an
  overload declaration and the implementation beside it is the entity, which is how a top-level
  `function f(): void` has always behaved and how a class body's `m(): void` still behaves; an
  ambient context has no implementations to defer to, so there the signature is the whole
  declaration. `declare global { … }` and `declare module "express" { … }` stay silent: each
  augments a scope that is not this module, and the only qualified name available for what is
  inside would claim that name for this file.

- e0df71f: A class body is what defining and constructing the class runs

  A class Symbol's `bodyNode` is the whole `class_body`, and `walkBody` descended into every
  member — so each method's calls and rules were recorded a second time on the class. That is
  not only duplication in the IR: `new C()` resolves to the class Symbol (`call-resolution.md`
  CR15), so effect propagation carried the duplicates up into callers that touch nothing. A
  factory whose whole body is `return new UserService(prisma)` was reported as writing to the
  database.

  A class Symbol's body is now what **defining and constructing** the class runs: field
  initialisers, static blocks, and the constructor. A method body belongs to the method's own
  Symbol.

  The constructor stays for the same reason the rest goes. `new C()` runs it, and the Symbol
  the instantiation resolves to is the class — drop it and a `constructor() { prisma.user.create(...) }`
  becomes invisible to every caller that instantiates the class. It is recorded on
  `#C.constructor` too, and propagates nowhere twice, because nothing resolves a call to a
  constructor.

  Only the _body_ is skipped, and only for a member that has a Symbol of its own. Both halves
  are load-bearing:

  - A parameter default (`m(x = f())`) sits outside the member's own `bodyNode`, which is its
    `statement_block`. Skipping the whole member would lose it.
  - A computed member (`[Symbol.iterator]() {}`) and a member of an anonymous default class are
    not Symbols at all, so their bodies have nowhere else to be recorded and stay on the class.

  Which member has a Symbol is now one predicate, `memberHasOwnSymbol`, that extraction and the
  walk both read — and both ask about the same node. The walk reads the class off the body it is
  walking rather than off the Symbol, because a folded Symbol's `fullNode` is its **leading**
  declaration: `const C = 1` written above `class C { m() {} }` heads the Symbol with a
  `lexical_declaration`, and asking that node whether the class has member Symbols answered no.

  `static constructor()` is not the construction path. `new C()` never runs a static member, and
  the check now says so — it used to put the static member's body on the class and give it the
  instance qualified name, where it collided with the real constructor's. `tsc` refuses the
  source; this plugin also parses `.js`, where it is legal.

  The skip reaches the Symbol's own body nodes and no others: a class written inside a function
  or a method is not extracted, so every call in it still belongs to the Symbol whose body
  encloses it.

  Class Symbols' `calls`, `rules`, `effects` and `fingerprint.logic` move as a result, and so do
  the callers those effects reached. `fingerprint.api` and `fingerprint.syntax` do not: the
  normalized AST still covers the whole class body.

  **Scope.** A member written as a field holding an arrow — `create = async (d) => { ... }` — is
  not a `method_definition`, so it has no Symbol of its own and its body stays on the class, where
  it propagates to callers that construct the class. Constructing the class creates the closure and
  does not run it, so the heading above does not describe that shape; nothing here changes it, and
  it is a common way to write a service.

- d21fb6b: Record the `export` keyword as evidence on every kind of declaration

  `derivedBy` carried `export-keyword` for an exported function, class and variable and carried
  nothing for an exported interface, type alias, enum or namespace. `visibility` was right for all
  seven — `computeTopLevelVisibility` reads the statement the declaration was written as, so every
  exported declaration was already `public` — so what a consumer got was not a missing field but a
  spelling-dependent answer: asking a Symbol "was this exported?" through the evidence vocabulary
  was answered for the `const` and answered with silence for the `interface` beside it. The four
  builders wrote a one-token `derivedBy` naming the kind and stopped there.

  They now read the keyword like the others do, and one reader answers for every kind. It has to be
  one, because the node each builder holds is different — the `module` for a namespace, the
  enclosing `lexical_declaration` for a variable, the declaration itself for the rest — and two
  readers is where the kinds start to disagree again. The reader reaches the statement through the
  `declare` wrapper, so `export declare interface I {}` answers as `export interface I {}` does.
  Within one statement `export default` still replaces the keyword rather than joining it: the
  statement cannot be written with both, and the default export is the token a framework plugin
  reads to find a page or a component. Across two statements they join as they always have —
  `const Page = …` followed by `export default Page` reports both. `export default interface I {}`
  therefore carries `export-default` now, where it used to carry no export evidence at all.

  The change is additive for every spelling the language accepts: no Symbol disappears, and no
  legal declaration loses a token it carried. One illegal spelling the grammar accepts does change
  answer — `export default const x = 1` reported `export-keyword` and now reports `export-default`,
  which is what the same two keywords on a class have always reported — and the new answer is
  pinned. Exported interfaces, type aliases, enums and namespaces gain a `derivedBy` entry they did
  not have, so IR output and any diff of it against an older document will show it.
  `export-keyword` was already declared in the plugin manifest, so nothing downstream has to be
  registered. `lang-plugin.md` §9.1 records the rule as LP6b.

- 1abc31a: Read a bracket access in a callee as the property it addresses

  `prisma["user"].create({ data })` was reported as a call to `prisma.create`. The walk read the
  object of a `subscript_expression` and dropped the index, so the target named a call that is
  nowhere in the program — spelled exactly like an ordinary two-segment method call, and one
  segment short of the `<client>.<model>.<verb>` shape `@aburi/effects-prisma` matches. The
  `db.write` was lost with it, and nothing in the report said a write had gone missing.

  **A string-literal index is the segment it spells.** `prisma["user"].create(…)` and
  `prisma.user.create(…)` address one property and now produce one target, `prisma.user.create`,
  with no `dynamicReceiver` — the receiver is a name, written with brackets. The literal is
  decoded rather than unquoted, a template that substitutes nothing counts as one, and an index
  the parser guessed at is refused whether the ERROR stands inside the literal (`obj["a\u12b"]`)
  or beside it (`prisma["user" "audit"]`, a missing operator). Where the brackets sit does not
  matter: `prisma.user["create"]()` folds the same way.

  **An index that names no segment is reported as one that names none.** An identifier
  (`prisma[model]`), a number (`items[0]`), a substituting template, a string the qualified-name
  grammar has no segment for (`obj["a-b"]`, `obj["a.b"]`, `""`): the bracket contributes the
  reserved segment `<computed>` — `prisma.<computed>.create` — and the call carries
  `dynamicReceiver`. `<` is outside that grammar, so a target carrying the segment matches no
  Symbol id and no Symbol name; it resolves against nothing rather than against whatever the
  shortened name happened to find.

  **The sentinel is a name to no consumer.** A plugin that reads a fixed position of a target now
  meets a segment that names nothing where it expected a name, and segment _count_ is what several
  of them match on:

  - `@aburi/effects-prisma` credits a computed model only where the receiver names a client
    binding. `prisma[model].create(…)` is a `db.write` at `medium`, as the issue asks; `queues[id].upsert(job)`
    and `sets[key].delete(item)` stay unclassified, which is the answer `queue.upsert(job)` already got.
  - `@aburi/effects-trpc` now reads `dynamicReceiver` at all, and records such a call at `medium`
    rather than `high`. `handlers[key].query()` reaches a proxy call's segment count with none of
    its evidence, and the plugin asserted certainty on every shape it matched.
  - `@aburi/types` exports `COMPUTED_TARGET_SEGMENT`, so a producer and a consumer spell the
    segment from one place rather than by hand. The IR schema records it in `Call.target` and
    `Effect.target` descriptions.

  **What a reader will meet after upgrading.**

  - A call target may carry a segment the source writes in brackets, and `items[0].save()` reads
    as `items.<computed>.save` where it read as `items.save`.
  - The logic fingerprint reads `effects[].target`, so the first diff across the upgrade reports
    logic changes on symbols whose source did not change.
  - A call an effect plugin claims is in no call-resolution bucket — a classified call never
    reaches `calls[]` — so for `prisma[model].create()` the record of the computed model is
    `effects[].target` plus the `medium` tier, not `stats.callResolution.unresolved.dynamic`.
  - `@aburi/effects-nest` matches an emitter name at a fixed position, so `this.emitter[i].emit(e)`
    stops being an `event.publish` where it was one. The name is still spelled in the target, one
    segment further back; reading through the sentinel is a change to that plugin's own rule and
    is left to it.
  - A configured `suppress` / `keep` prefix matches on exact-or-dot-prefix, so
    `suppress: ["metrics.increment"]` stops matching `metrics["http"].increment(n)`, which is now
    `metrics.http.increment`. Nothing warns about a prefix that matches nothing.
  - `process["exit"]()` is recognized as an early exit, so an `if` that ends in one is a guard.

- a4d3cff: Keep a file that names things legally

  Three shapes fed something that is not a name into the Symbol-id builder, which threw — and
  the throw cost the file every Symbol it had, not the one declaration:

  | source                                             | before       | now             |
  | -------------------------------------------------- | ------------ | --------------- |
  | `export const { GET, POST } = handlers`            | file skipped | `#GET`, `#POST` |
  | `export const [a, b] = pair`                       | file skipped | `#a`, `#b`      |
  | `export function ユーザー取得() {}`                | file skipped | `#ユーザー取得` |
  | `export function café() {}`                        | file skipped | `#café`         |
  | `export class A { [Symbol.iterator]() {} m() {} }` | file skipped | `#A`, `#A.m`    |

  The last row states it sharpest: one member nobody can name cost the class and every sibling.

  **The qualified-name grammar is ECMAScript's IdentifierName.** `[A-Za-z_$][A-Za-z0-9_$]*`
  becomes `[$_\p{ID_Start}][$\p{ID_Continue}]*`. Only `$` and `_` are named:
  `$` is in neither property, `_` is in `ID_Continue` and not `ID_Start`, and ZWNJ and ZWJ —
  which ECMAScript names separately — are already inside `ID_Continue` here, measured. `schema/aburi.ir.v1.json#/$defs/SymbolId` already accepted every
  one of these, so this closes a gap between the two rather than opening one. What it still
  refuses is what is not a name — a pattern's text, a computed member's brackets.

  **A destructuring declaration produces one Symbol per binding.** `{ a: b }` binds `b`, not the
  key `a`; `{ a = fallback }` and `[a = fallback]` bind `a` and read `fallback`, which is a name
  from another file and not a declaration here. Each binding is a `const` carrying
  `destructured-binding` in `derivedBy` — declared in the plugin manifest alongside the other
  language-level rationales — and that token is what explains several Symbols sharing one source
  range.

  A node type the pattern walk does not model is **refused** rather than passed over. Binding
  nothing for an unmodelled wrapper is indistinguishable from a pattern that declares nothing,
  and a binding lost that way leaves no Symbol, no diagnostic and no `skipped` entry — which is
  worse than the throw this change replaces, because that one was at least named.

  **A class member with a computed name produces no Symbol, and no diagnostic.** Mangling the
  brackets into a segment would invent a name the source does not contain, and two different
  computed keys can collapse onto one segment. A computed name is not a name static analysis can
  record — the position `lang-plugin.md` LP26e takes on a computed module specifier.

  **One integrity consequence.** `symbols[].name` was excluded from invariant #19 (Unicode NFC)
  because the qualified-name grammar was ASCII and NFC leaves ASCII alone. Measured, that no
  longer holds — `isQualifiedName("cafe" + U+0301)` is `true` now — so the field moves onto #19's
  list, which is what the exclusion said should happen if the grammar widened. `symbols[].id`
  stays excluded on a reason that does still hold: `symbolIdViolation` checks NFC in its own
  right rather than as a side effect of an ASCII grammar.

  No existing Symbol id changes: measured by scanning the `nestjs-billing` fixture before and
  after and diffing the id sets — 38 ids, identical.

### Patch Changes

- 5b4dc55: Read `export default Page` as the export of the declaration it names

  A default export written apart from its declaration — `const Page = () => …` on one line and
  `export default Page` on the next — was not an export at all as far as extraction was concerned.
  `isDefaultExport` reads the declaration's parent, and the parent of a top-level `const` is the
  module: the statement that exports it is a sibling, and nothing linked the two.

  So the Symbol reported `visibility = "internal"` and carried no `export-default`, which are the
  two signals a framework plugin reads. `app/page.tsx` written this way classified as
  `framework:react:component` and stayed internal, where the same file written `export default
function Page()` is a public `framework:next:page`. One of the two most common ways to write a
  React component described a different boundary than the other.

  Extraction now collects the names a module hands to `export default` — one pass over the
  module's own statements, not a search per declaration — and gives the matching top-level
  declaration `public` visibility and `export-default` on `derivedBy`, before framework
  classification runs.

  The value is read through `unwrapValue`, the one reader that answers what a wrapper is for every
  question this plugin asks about a node, so `export default Page satisfies NextPage` — and the
  `(Page)`, `Page as FC` and `Page!` spellings — link back like the bare one. A framework reading
  `export-default` does not depend on which was written, which is the whole of the point.

  What the reading stops at is what is not a reference to a declaration: a call
  (`export default withAuth(Page)`, where a value is returned by convention and nothing in the tree
  says so), a value the module builds (`{ Page }`), a member of one (`Routes.Page`), and an
  identifier that names an import, which declares nothing in the file to reach. `export { Page as
default }` is an export clause, and no clause spelling — `export { Page }` included — is read for
  visibility yet; covering only the `default` one would make the answer depend on the clause's
  contents.

  A declaration reached by name is reached by a bare name. A class member called `Page`
  (`Shell.Page`, `Shell::Page`) and a namespaced declaration (`Routes.Page`) carry a separator no
  bare identifier can spell. A call Symbol's qname is a single identifier-legal segment with no
  separator to rely on, so it is refused by kind instead: a registration statement is not a
  declaration an `export default <identifier>` could be naming.

- 9e32538: Read the parameter of a parenthesis-free arrow

  `export const greet = name => "hi"` was extracted as a zero-arity function. The signature
  reader looked for a `parameters` field or a `formal_parameters` child, and an arrow written
  without parentheses has neither: the grammar hangs its single binding off a `parameter` field
  as a bare identifier. The parenthesised spelling of the same function, `(name) => "hi"`, was
  read correctly, so the two ways of writing one parameter disagreed.

  `inputs` is compared positionally by the api fingerprint, so both directions of that
  disagreement produced a wrong report:

  - **Dropping the parameter was no change at all.** `name => "hi"` → `() => "hi"` left both
    revisions reading zero-arity with the body untouched, so the Symbol was `unchanged` and
    every caller still passing an argument was told nothing.
  - **Adding parentheses was an api change.** `x => x + 1` → `(x) => x + 1` moved `inputs` from
    `[]` to one entry and reported `apiChanged` on a function whose contract nobody touched.

  Both now report what the source did. The parameter is read from the `parameter` field and
  emitted untyped — `{ name: "x", type: "" }` — which is exactly what `(x) => …` already
  produced, so the two spellings are one signature. Nothing else about the form changes: `async
x => …` still sets `async`, and `() => 1` still reports no inputs.

  Anything downstream of the signature moves with it — the api fingerprint, `signature.inputs`
  in the diff delta, and the `signatureSimilarity` term that matches a renamed function. A
  report over sources that use the parenthesis-free form may show api changes on the first run
  after upgrading that the previous version did not surface, and lose ones it surfaced for the
  added parentheses.

- 203ea78: Read the three import forms that lost their dependency edge

  `import x = require('./m')`, an `import()` behind a magic comment, and an `import()` whose
  specifier is a template all produced no `ImportEdge` and no diagnostic — a file importing only
  through `require` looked import-free, and the calls through the missing binding fell out of
  relative resolution into the `no-match` bucket with nothing saying why.

  Each missed for its own reason. A require-equals hangs its specifier off an
  `import_require_clause` rather than the statement's `source` field, so the reader found
  nothing. A magic comment is a _named_ node, so the first argument of `import()` was the comment
  rather than the specifier. A template is a `template_string`, not a `string`, so the literal
  reader refused it.

  The require-equals edge is a **namespace** edge — `symbols: "*"` with the binding on
  `namespaceBinding` — and not the default binding it superficially resembles. `x` names the
  module object the way `import * as x from './m'` does, and call resolution acts on the
  difference: the namespace arm strips the head off `x.foo()` and looks for `foo` in the target
  file, where a `symbols: ["x"]` edge would send it looking for `x.foo` there, which the target
  does not have. `dynamic` is false because the field means "written as `import()`" and this
  form is not — and because both loops in `callgraph.ts` that read a file's edges skip a
  dynamic one, the value is also what keeps this import in reach of call resolution.

  A clause that did not parse is not read at all. The grammar admits nothing but a string
  literal for the specifier, so `require("a" + b)` is a syntax error — but error recovery
  leaves the operand it could read as a direct child of the clause with the `source` field
  attached, and reading it would answer `a`. `require('./m', 'y')` would answer the second
  argument.

  A template _with_ a substitution stays computed and stays silent, which is the boundary this
  change is careful about: joining a substituting template's fragments would answer `"./"` for
  `` `./${p}` `` — an edge to a module the author never named, and a worse answer than none.

  An empty specifier written in either new form (`import x = require("")`, `import(`)``) goes
  through the same gate as `import("")` and is reported as the empty specifier it is.
  `firstNonCommentChild` moves to `ast-helpers.ts`, where the decorator reader takes it too;
  `imports.ts` drops its private `findChildByType`, a duplicate of `ast-helpers`' `findChild`.

- 9c17405: Weigh the receiver before attributing a database effect to a call

  `delete`, `create`, `update` and `select` are shared vocabulary — `Map`, `Set`, the DOM,
  RxJS stores and every HTTP router spell their verbs the same way an ORM does. Both
  classifiers matched on that vocabulary plus a file-level import gate, and the gate answers
  "does this file use the library", which a file is free to answer yes to while most of its
  calls belong to something else. So a repository holding a `Map` cache beside its Prisma
  client recorded `this.cache.items.delete(key)` as a `db.write` at `high` — the tier a
  hand-annotated effect gets — and an Express router beside its Drizzle queries did the same
  for `router.delete("/users/:id", handler)`.

  Three checks now stand between the shape and the record. A first argument the library could
  never take rules the call out entirely: no Prisma method and no Drizzle root takes a bare
  literal, so a route registration is not classified at all. Then the receiver sets the tier
  rather than being assumed — the segment holding the client is matched word-wise against
  each plugin's vocabulary of client binding names, so `prismaClient`, `readReplicaDb` and
  `_db` land at `high` while `cache`, `router`, `store` and `apiClient` do not. And the
  argument count is weighed against what the method actually takes, which is one for most of
  them and two for `$transaction`, Postgres' `selectDistinctOn(columns, projection)` and
  Drizzle's `transaction(callback, config)`.

  Anything short of all three downgrades to `medium`, it does not drop the effect. Effect
  plugins never see the AST, so a client bound under a house naming convention and an
  unrelated object of the same shape are not separable from the callee string — dropping the
  first would be as wrong as claiming the second at `high`. The same reasoning governs the
  argument count: it is a syntactic count, and a classifier is the first thing to read it as
  a signature, so a miscount costs the tier rather than erasing a write and logging nothing.

  `@aburi/lang-typescript` stops counting comments as arguments. They are grammar `extras`,
  so tree-sitter hangs them inside the argument list: `db.delete(\n  users, // soft delete
is not used\n)` reported two arguments, and a leading comment took `literalArgs[0]` from
  the argument it belongs to. Both fields now match the source's arguments in count and in
  order.

  `@aburi/plugin-registry/plugin-input` gains the readers both plugins share:
  `identifierWords` / `identifierMentions` (a word split, so `feedback` does not read as
  `db`) and `hasLiteralFirstArgument`. `effect-plugin.md` §5.4 carries the rule for the next
  effect plugin whose verbs are someone else's too.

  **What the first scan after this shows.** `confidence` is part of effect identity in the
  diff (`effectsEqual`) and propagates along call-graph edges as a floor, so every effect
  that moves from `high` to `medium` reports as `modified` — plus the ancestors that inherit
  it — against source that did not change. That is the reclassification landing, not a
  regression.

- 155bed3: Ship the packages, not the workshop

  Installing `@aburi/cli` and its dependency closure put 22.08 MB of prebuilt parser binaries
  on disk to read 2.86 MB of them. Nothing in that was deliberate — each piece was a default
  nobody had reason to look at until the sizes were measured side by side. Every number
  below is decimal MB, measured on this branch against its base.

  `@vscode/tree-sitter-wasm` was the bulk of it. It ships sixteen prebuilt grammars totalling
  21.66 MB — bash, C#, C++, Ruby, Rust, PHP, PowerShell and the rest — and
  `@aburi/lang-typescript` loads exactly two of them, `tree-sitter-typescript` and
  `tree-sitter-tsx`, together 2.86 MB. npm cannot install part of a tarball, so every
  consumer paid for the other fourteen, 18.80 MB, to sit on disk unread.

  `scripts/copy-grammars.mjs` now vendors the two we parse with into the package's own
  `wasm/` at build time and the dependency drops to a devDependency, which takes that
  directory from 22.08 MB to 2.86 MB. The copies are byte-identical to the upstream files.
  `wasm/NOTICE` records their provenance and reproduces both the licence text upstream
  distributes and the component registration from its `cgmanifest.json`, and bumping the
  grammars stays an ordinary devDependency bump.

  The rest was the published tarballs. `files` listed `src` beside `dist`, so the TypeScript
  sources shipped a second time next to the bundle built from them — and the sourcemaps
  already embedded `sourcesContent`, so that copy was not even what a debugger reads.

  Maps are no longer emitted at all: 1.67 MB across the workspace, most of it the same
  source text a third time. `declarationMap` alone drove it — `sourceMap` never had any
  effect on this build, because it is `rolldown-plugin-dts` that turns on rolldown's shared
  `output.sourcemap` whenever `declarationMap` is set, and that is what overrode
  `sourcemap: false` in all seventeen `tsdown.config.ts` files. `declarationMap` is now off
  in `tsconfig.base.json` with a note naming `dts: { sourcemap }` as the direct lever, since
  setting it back silently restores every byte.

  With the sources gone there is no longer a reason to ship the bundle unminified, so
  `minify` is on: summed across the seventeen published packages, every `.mjs` under `dist/`
  goes from 916,821 to 279,839 bytes.

  Published output is now `dist/*.mjs` and `dist/*.d.mts`, plus `wasm/` for the language
  plugin. The trade is that a stack trace from an installed copy no longer resolves to
  original source; the sources remain a `git clone` away, and no API, behaviour or emitted
  IR changed anywhere.

- 8443f90: Decode the escapes in a module specifier instead of deleting them

  `readLiteralSpecifier` joined only a literal's `string_fragment` children, and tree-sitter puts
  an escape in a sibling `escape_sequence` node — so the escape was deleted rather than decoded
  and the reader handed back a shorter string that looked perfectly well-formed.

  | written        | before | now               |
  | -------------- | ------ | ----------------- |
  | `"\x2E/e"`     | `/e`   | `./e`             |
  | `"./a\u002Fb"` | `./ab` | `./a/b`           |
  | `"./a\tb"`     | `./ab` | `./a` + TAB + `b` |

  The first row is the one that costs the most. `isRelativeSpecifier` accepts a `./` or `../`
  prefix and nothing else, so an escaped leading dot left a specifier that names a sibling file
  bucketed as `external` — "out of reach by construction" rather than "we misread the string" —
  and call resolution's relative tier never consulted the edge. The rest are edges pointing at
  modules that do not exist, indistinguishable in the IR from ones that do. None of it produced a
  diagnostic.

  `decodeEscapeSequence` is a new unit with its own table: the control escapes, the quoted
  characters, `\xHH` / `\uHHHH` / `\u{...}` (by code point, so an astral escape is not truncated
  to its low 16 bits), the line continuation, and the identity case. It is wired into the
  specifier reader only, and reaches the dynamic, re-export and require-equals paths with it.

  **One behaviour change beyond decoding.** A literal that is nothing but a line continuation
  decodes to the empty string, so it now hits the empty-specifier diagnostic instead of producing
  an edge whose source was a backslash and a newline. A literal made only of _other_ escapes
  (`"\n\t"`) still gets an ordinary edge — the gate tests emptiness, not blankness.

  An ill-formed escape never reaches the decoder: `"\uZZZZ"`, `"\u12b"`, `"\u{}"` and `"\xZZ"` parse
  as ERROR nodes rather than `escape_sequence` and are already reported as recoverable syntax
  errors. A literal made of nothing else still comes back as its own source text rather than as
  the empty string, so the parser's syntax error stays the only thing said about it — calling it
  empty as well would be a third diagnostic claiming the author wrote no module name, and they
  did.

  **A braced escape is different**: the grammar checks its shape, not its range, so
  `"\u{110000}"` does arrive — and `String.fromCodePoint` throws a `RangeError` on it, which would
  leave `parseFile`, land on the per-file boundary and cost the whole file. It is range-checked
  and handled the way `\1` and `\8` are: an escape with no legal value comes back as its own text,
  because inventing one would put a module name in the IR that the source does not contain.
  Nothing downstream learns the specifier was illegal, which stays true of all three.

- Updated dependencies [be8e2b9]
- Updated dependencies [81dadb6]
- Updated dependencies [a358a5a]
- Updated dependencies [3774de6]
- Updated dependencies [ff059d7]
- Updated dependencies [6676ca7]
- Updated dependencies [6d4730f]
- Updated dependencies [e7f1d49]
- Updated dependencies [203ea78]
- Updated dependencies [3e180e8]
- Updated dependencies [1abc31a]
- Updated dependencies [155bed3]
- Updated dependencies [a4d3cff]
- Updated dependencies [ba9e505]
  - @aburi/types@0.4.0
  - @aburi/core@0.4.0

## 0.3.0

### Minor Changes

- 5c36d16: Relicense from MIT to the Apache License 2.0.

  The terms are still permissive, and nothing about how you may use, modify, or
  redistribute Aburi narrows. Apache 2.0 adds two things MIT leaves unsaid: an
  express patent grant from every contributor, and a termination clause that
  withdraws it from anyone who brings a patent claim over the work. Redistributors
  now also carry two obligations MIT did not impose. State the changes you made to
  any file you modified, and pass along the `NOTICE` file.

  Each package now ships a copy of the licence in its own tarball, which Apache
  2.0 section 4(a) asks for and the SPDX field alone did not satisfy.

  Versions published before this change stay under MIT. A licence already granted
  cannot be withdrawn, so anyone depending on an earlier release keeps the terms
  they got.

- e760103: Read a decorator wherever the grammar parents it, order them by source position, and let a JSDoc block reach past one

  **This changes what a Symbol carries, and the first scan after upgrading will report
  `modified` Symbols that no source change explains.** Decorators feed
  `mergeFrameworkClassification`, so a class that had no `extKind` can now have one; `signature`
  moves with the JSDoc change; and both feed the api and logic fingerprint axes. The drift is the
  point of the fix rather than a side effect — the Symbols were wrong before — but it lands as
  diff noise exactly once.

  ## Where the decorator is written no longer changes whether it is read

  A decorator always belongs to the declaration it precedes. Tree-sitter parents it beside that
  declaration when nothing separates the two, and inside it when the `export_statement` rule
  (`decorator* 'export' ['default'] declaration`) has nowhere to put it — so it is the position
  relative to the keyword that decides, not whether a wrapper exists. Only the first was read:

  | source                           | where the decorator sits                    | read before |
  | -------------------------------- | ------------------------------------------- | ----------- |
  | `class C { @A() m() {} }`        | preceding sibling in the class body         | yes         |
  | `@A() export class C {}`         | preceding sibling in the `export_statement` | yes         |
  | `@A() class C {}`                | child of `class_declaration`                | no          |
  | `export @A() class C {}`         | child of `class_declaration`                | no          |
  | `export default @A() class C {}` | child of `class_declaration`                | no          |
  | `@A() abstract class C {}`       | child of `abstract_class_declaration`       | no          |
  | `@A() export @B() class C {}`    | one of each                                 | only `A`    |

  The symptom was an IR that contradicted itself: `export @Controller("x") class A {}` produced a
  class with no boundary owning routes that had one.

  Every row is legal TypeScript except the last, which `tsc` rejects as TS8038 — decorators may
  not appear on both sides of `export`. The grammar accepts it, so it still reaches the extractor
  from a half-edited file, and reading the union rather than one side means such a file loses no
  decorator on the way to being reported.

  `readDecorators` now returns the union of the preceding-sibling run and the declaration's own
  `decorator:` field children. The two cannot overlap — a node has one parent, so a preceding
  sibling of the declaration is never also its child — which is why the union needs no
  deduplication. A **parameter** decorator (`m(@P() x)`) stays out of both: it is a child of the
  parameter, and the method does not field-tag it.

  ## Decorators are ordered by source position

  `framework-nestjs` resolves a class carrying several recognised decorators by taking the first
  in source order, so the order is a contract. It was a line sort with an alphabetical tiebreak,
  and `Decorator` has no column — so two decorators on one line came out in name order:

  ```ts
  @Injectable()
  @Catch(HttpException)
  class F {} // was framework:nestjs:filter
  @Injectable()
  @Catch(HttpException)
  class F {} // was framework:nestjs:provider
  ```

  A newline decided the classification, and `mergeFrameworkClassification` stamped the result
  `confidence: "high"` either way. Ordering on the node's byte offset settles it: total, agrees
  with the line ordering integrity invariant #11 checks, and needs no tiebreak.

  ## A JSDoc block reaches past a decorator, and only JSDoc counts

  `readLeadingJsDoc` stopped at a decorator, so `/** @throws E */ @Get() handler() {}` discarded
  the block and every `@throws` tag in it. A decorator is now stepped over — it belongs to the
  member rather than separating anything from it.

  That opens the space _between_ decorators, which is where `// biome-ignore`, ticket references
  and commented-out decorators are written. So the run now collects only `/**` blocks, which is
  what the function always claimed to read: an ordinary `/* … */` and a `//` line are prose, and
  the one consumer (`readThrows`, scanning the joined text for `@throws`) cannot tell prose from
  a declaration once both are in it. **A `@throws` written in a `//` or `/* */` comment therefore
  stops counting**, which it should never have done.

  An anonymous token still ends the run, which is what keeps a stray `;` from handing a member
  someone else's documentation.

  ## Also

  `@/* why */ Foo()` parses, and the decorator was being named after the comment rather than
  after `Foo`.

- 4c16cad: Point every schema id at the documentation domain

  The four JSON Schemas identified themselves as `https://aburi.dev/schema/...`, a host this
  project does not own and never served them from. The docs site is `aburi.kage1020.com`, so
  that is the name the `$id`s, the `$schema` `const`s, the `$schema` an `aburi init` writes,
  and the plugin manifests now carry.

  The documentation site now serves the four schemas under `/schema/`, so each `$id` resolves
  to the document it names and an editor reading a `$schema` line gets completion and
  validation from it. A build-time check refuses to publish a schema whose `$id` disagrees with
  the URL it is served at.

  `$schema` is validated with a `const`, so an `aburi.json` or a plugin manifest still naming
  the old host is rejected until the string is updated — a find-and-replace of
  `aburi.dev/schema` with `aburi.kage1020.com/schema`, or a re-run of `aburi init --force`.

- ed1c3a0: Refuse an empty module specifier instead of emitting an edge that names no module

  `import x from ""` used to end the run. `readStringLiteral` returned `""` for an empty literal
  and all three call sites guarded only on `null`, so every form the reader produces an edge for
  produced one whose `source` names nothing, with no diagnostic:

  ```ts
  import a from ""; // { source: "", symbols: ["a"] }
  import ""; // { source: "", symbols: "*" }
  export * from ""; // { source: "", symbols: "*" }
  export { X } from ""; // { source: "", symbols: ["X"] }
  import type { B } from ""; // { source: "", symbols: ["B"] }
  const p = import(""); // { source: "", symbols: "*", dynamic: true }
  ```

  `ImportEdge.source` is contractually a non-empty specifier (`lang-plugin.md` §4.4), and the
  shared guards in `@aburi/plugin-registry/plugin-input` throw when it is not. So the guard fired
  on syntax a user can legally write — and because it fires inside a plugin, it took the whole
  scan with it:

  ```
  src/a.controller.ts   @Controller class, plus one `import x from ""`
  src/b.service.ts      @Injectable class, nothing wrong with it

  scan() → throws. No IR at all; `BService` is discarded along with the offending file.
  ```

  The reach is wide: a decorator-driven framework plugin walks the edge list for every file
  holding a decorated class or method, so any controller with a half-typed import ends the scan.
  Before framework plugins read import edges, the throw needed an effect plugin _and_ a call
  candidate in the same file.

  ## What the plugin does instead

  An empty specifier produces no edge and one **recoverable** `ParseError` at the literal's own
  line and column, naming which construct it belongs to — `export * from ""` is not an import, and
  being told that it is sends the author to the wrong line. The file keeps its Symbols: what
  withdraws one is a parse that returned no tree at all, which this is not.

  The diagnostic travels the channel a syntax error already uses, and reaches as far as that
  channel goes — `ScanResult.parseErrors`, carrying the file, line, column and message. The CLI
  renders parse errors as a count alone, so someone running `aburi scan` sees `1 file(s) had
recoverable parse errors` and has to read the programmatic result for the rest. That is an
  existing gap in the reporting layer rather than something this change introduces.

  Empty and absent stay apart. `readStringLiteral` returning `null` means the node was not a string
  literal — a computed specifier (`import(p)`, `import("" + x)`) the reader does not follow, which
  is not a fault in the source and gets no diagnostic. A literal that is present and empty is
  something someone typed. Collapsing the two into one silent `null` is the drop this change exists
  to stop, and it would also report a fault against perfectly good code.

  The test is emptiness, not blankness: `import a from " "` still produces an edge, because `" "`
  is a module name that will not resolve, which is the type checker's business. `tsc 6.0.3` reports
  TS2307 for the value forms above and TS2882 for the bare side-effect import — all of them parse,
  which is why they reach the extractor at all.

  The guard in `plugin-input` is unchanged. A third defensive layer would hide the next producer
  bug, which is the guard's whole job.

  ## What changes in the IR

  Nothing disappears from `dependencies`: `ImportEdge`s are not serialized — they reach
  `resolveCallGraph` and stop there, and an empty specifier was never relative, so no resolution
  tier ever consulted it.

  One second-order effect is visible. `bindsToExternalImport` buckets an unresolved call as
  `external` when its head is bound by a non-relative import, and `""` counted as non-relative.
  A call bound by the withdrawn edge now buckets as `no-match`, shifting `stats.callResolution` by
  one. Neither bucket describes a broken specifier — `external` means "a bare package, out of reach
  by construction" — and the parse error is the channel that does.

  ## Contract

  `extractImports` now returns `{ edges, errors }` rather than `ImportEdge[]`. It is part of the
  package's public surface, which is why this is a minor rather than a patch; `parseTypescriptFile`
  is unaffected and merges the import errors into `ParseResult.errors` alongside the syntax ones.

- 14bdb6b: Separate the `LanguageId` and `PluginRef` vocabularies

  `aburi.json` uses the key `languages` at two nesting levels with two different
  vocabularies: the top-level array holds plugin refs the loader resolves as module
  specifiers, while `components[].languages` holds `LanguageId`s constrained to
  `^[a-z][a-z0-9]*$`. Both writers conflated them.

  - `LanguagePlugin` gains a required `languageId` field. `@aburi/core` projects it into
    `IR.workspace.languages`, which previously received `manifest.name` and therefore
    emitted `"lang-typescript"` — a value that fails the frozen `aburi.ir.v1` schema for
    every first-party plugin. Third-party language plugins must add the field.
  - `LanguageId` is now a branded type constructed through `makeLanguageId` (exported from
    `@aburi/core`), so a manifest name can no longer be assigned where a language id belongs.
  - `aburi init` writes plugin manifest names (`lang-typescript`, `framework-nestjs`) in the
    top-level arrays and keeps `LanguageId`s inside `components[]`. It previously wrote
    detector ids, so the loader looked for the non-existent `@aburi/ts` package and the
    documented `init` then `scan` quick start failed on every project.
  - `InitReport` gains `unmappedLanguages` / `unmappedFrameworks`, and the CLI warns about
    them. A detected language with no first-party plugin leaves `languages` empty, which is
    otherwise invisible until the next command stops.
  - `--with-suggestions` names the language plugin first, per `cli-spec.md` §4.6: it is a
    hard requirement for the next `aburi scan`, where a framework plugin only widens
    classification.
  - `aburi scan` refuses to run when no language plugin resolves, instead of writing an IR
    with zero Symbols and an empty `workspace.languages` at exit 0. That document fails the
    schema's `minItems: 1`, and two of them diff to `+0 -0 ~0` — so every `--fail-on` gate
    downstream passed regardless of what changed.
  - New integrity invariant #18: `workspace.languages` is non-empty, every entry satisfies
    the `LanguageId` grammar, and every `Symbol.language` appears in it. It also covers an IR
    read off disk, which `readIR` brands without validating.

### Patch Changes

- fc8f3c9: Read a declaration's leading comments and decorators from the declaration, not from the file

  `readLeadingJsDoc` and `collectDecoratorNodes` ask the same question — _the run of siblings
  immediately before this declaration_ — and both answered it by reading the parent's whole
  child list and searching it for the declaration's own position.

  `children` and `namedChildren` are not field reads. Each unmarshals every child across the
  WASM boundary into a fresh JS object, and caches the result on one JS wrapper, so the next
  `node.parent` pays for the list again. The parent of a top-level declaration is the entire
  program: a file of N declarations paid O(N) per declaration.

  Both now walk backwards from the node with `previousSibling` / `previousNamedSibling`, which
  stops when the run ends — nearly always immediately, since most declarations carry neither a
  comment nor a decorator.

  Measured on one file of exported one-line functions, alternating between the two versions
  so machine drift lands on both arms (min of three runs each, whole `scan`, ms):

  | declarations | before | after | after (repeat) |
  | ------------ | ------ | ----- | -------------- |
  | 1,000        | 451    | 214   | 206            |
  | 2,000        | 1232   | 304   | 326            |
  | 4,000        | 12208  | 502   | 516            |

  The exponent is the claim, not the digits: doubling the declarations multiplied the old
  time by 2.7 and then 9.9, and the new one by about 1.5 both times — sub-linear, because a
  fixed ~200 ms of startup dominates at this size. A 1.5 MB file of ~18,000 declarations, the
  shape a generated API client or a Prisma type file has and comfortably inside
  `maxFileSizeBytes`, now extracts in about 1.9 s where it had been taking minutes.

  Two behaviour changes come with the rewrite rather than falling out of it.

  **A comment no longer ends a decorator run.** Tree-sitter treats a comment as a named node
  and puts it wherever it was written, including between two decorators or between the
  decorators and the `export` keyword. Stopping there let a `// biome-ignore` or a TODO detach
  `@Injectable()` from the class it decorates — silently, since decorators feed the framework
  classifier, so the Symbol came out with the wrong `extKind` rather than with an error.
  Comments are now skipped, the way `readCallArguments` already skips them. This also fixes
  the same shape inside a class body (`class C { @A() /* note */ m() {} }`), which had been
  losing its decorator since before this change.

  **The `export_statement` special case is gone.** The grammar's rule is
  `decorator* 'export' ['default'] declaration`, so a wrapped export's decorators are the
  declaration's own preceding siblings and the named walk steps over the keywords to reach
  them; the sweep-filter that used to handle it separately was doing the same job less
  precisely.

  Two placements the walk does not reach, pinned by tests here and closed in the change that
  follows: a decorator on a declaration with no wrapper to hold it (`@A() class C {}` at top
  level, or `export @A() class C {}`) is parsed as a _child_ of the declaration rather than a
  sibling, so it is not read.

- Updated dependencies [5c36d16]
- Updated dependencies [e2dab93]
- Updated dependencies [309f093]
- Updated dependencies [74aa475]
- Updated dependencies [fc8f3c9]
- Updated dependencies [630460f]
- Updated dependencies [f73eb46]
- Updated dependencies [4c2d5aa]
- Updated dependencies [060d7a5]
- Updated dependencies [74aa475]
- Updated dependencies [1e59445]
- Updated dependencies [c825c74]
- Updated dependencies [8ce6ed4]
- Updated dependencies [4c16cad]
- Updated dependencies [6d3d390]
- Updated dependencies [c3654c3]
- Updated dependencies [0b39623]
- Updated dependencies [da20510]
- Updated dependencies [baa6857]
- Updated dependencies [b8763eb]
- Updated dependencies [cafd4b8]
- Updated dependencies [667f9b7]
- Updated dependencies [54881d5]
- Updated dependencies [37715cd]
- Updated dependencies [dbdc8aa]
- Updated dependencies [836b05a]
- Updated dependencies [85ade16]
- Updated dependencies [14bdb6b]
  - @aburi/core@0.3.0
  - @aburi/types@0.3.0

## 0.2.0

### Minor Changes

- b2f4382: Give `SymbolId`, `ComponentId`, and `SliceId` separate identities instead of three names for `string`.

  Aburi mints three kinds of identifier and each owns a namespace, but all three were the
  same type. `SymbolId` and `ComponentId` were bare aliases of `string`
  (`aburi.ir.v1.json#/$defs/*` are `{"type": "string"}`, and json-schema-to-typescript
  faithfully generates what the schema says); `SliceId` did not exist at all, so
  `SliceRecord.id` was `string` and `SliceRecord.members` was `string[]`. Nothing stopped a
  Component id being passed where a Symbol id was wanted, and `"slice:" + members[0]` — the
  Slice-id derivation — was an expression any file could open-code, because its result was
  assignable to the field it fed.

  `SymbolId` and `ComponentId` are now nominal types, `SliceId` exists and is nominal too,
  and `dependencies[].from` / `.to` are `SymbolId | ComponentId` rather than `string` — the
  union is honest about the one array that holds both kinds, while still refusing an
  arbitrary string. Every brand comes from a constructor: `makeSymbolId` / `trySymbolId` /
  `makeComponentId` in `@aburi/core` and `sliceIdFor` in `@aburi/diff`. Assertions
  (`x as SymbolId`) survive in four documented places and nowhere else — `packages/core/src/id.ts`,
  `sliceIdFor` plus the untyped-input predicate in `packages/diff/src/slice.ts`, the single
  `parsed as unknown as IR` in `readIR`, and per-package test fixtures, which need to be able
  to write a malformed id for the cases that exist to reject one.

  Two call sites were building Symbol ids by concatenation behind a type annotation and now
  go through the constructor: the call-graph resolver and the LSP enrichment pass, which
  assemble _speculative_ callee ids and test them for existence. Those use `trySymbolId`, the
  non-throwing variant — an id that cannot be built is a callee that cannot exist, which is
  the same answer as a well-formed id absent from the Symbol table, so resolution behaviour is
  unchanged. `@aburi/diff`'s git-rename stage, which rebuilds an id around a moved file path,
  goes through the same constructor for the same reason.

  The brands are TypeScript-only and erased at runtime. Scanning and diffing the
  `nestjs-billing` fixture produces byte-identical `ir.json`, `diff.json`, `workspace.md`, and
  `diff.md` before and after.

  ### Schema

  `aburi.ir.v1.json` and `aburi.diff.v1.json` gain three `$defs` — `DependencyEndpoint`,
  `SliceId`, and a loose `SymbolId` on the diff side — extracted verbatim from the inline
  subschemas they replace. The validation semantics are identical; the change exists so the
  generator has a named alias to attach a brand to. The brand itself is applied by a
  post-processing pass in `packages/types/scripts/codegen-lib.ts`, not by a `tsType`-style
  keyword in the schema: these are frozen v1 documents published for validators outside this
  repository, and a non-standard keyword would make every strict-mode validator reject the
  schema itself. That is the same reasoning that kept the Slice anchor keyword out of the file.

  ### Two new integrity invariants
  - **#16 — no reserved namespace.** Slice ids are `"slice:" + <anchor Symbol id>`, so a
    language plugin claiming the token `slice` would mint Symbol ids indistinguishable from
    Slice ids and make the derivation produce `slice:slice:…`. Branding cannot fix this — the
    strings are genuinely the same shape — so `makeSymbolId` rejects the token, and
    `checkIRIntegrity` rejects it in a Symbol id or a Dependency endpoint from a document it did
    not build. Only the whole token is reserved; `slicer` is still legal. `@aburi/diff` reports
    it as its own `SliceRecord` violation kind too, because `buildDiff` is public API and runs
    no integrity check. No plugin uses `slice` today.
  - **#17 — ids satisfy their own grammars.** `readIR` brands a whole parsed document with one
    `as unknown as IR`, which is the only way to type a JSON parse — so ids read from disk used
    to acquire their brand without anything looking at them, while every other route ran a
    constructor. #17 closes that: `symbols[].id` must satisfy `isSymbolId` and `components[].id`
    must satisfy `isComponentId`. It is also what catches a language plugin that asserts the
    brand instead of calling the constructor.

  ### Behaviour changes
  - **`ComponentId` accepts a digit-leading segment.** The pattern was
    `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and is now `^[a-z0-9]+(-[a-z0-9]+)*$`, in both
    `aburi.ir.v1.json` and `aburi.config.v1.json`. Component ids are derived by kebab-casing a
    package or directory name, and `3d-force-graph` / `7zip-bin` are ordinary npm names — the
    letter-first rule made the documented derivation partial for no benefit. Loosening a pattern
    is additive: every document that validated before still does.
  - **Component detection fails loudly on a name that yields no id at all.** After the pattern
    change only one case remains — a name that kebab-cases to the empty string. It now raises
    `invalid-component-id` naming the package or directory it came from, instead of putting `""`
    in `components[].id` and producing an IR that fails its own schema somewhere else entirely.
    The CLI wraps it as a `config-error`, so it exits 2 (input) rather than 1 (runtime).
  - **A Symbol id file path may not contain `:` or `#`.** They are the id's own separators, so a
    path holding either assembles into a string that still matches the schema pattern but splits
    back into parts the producer never wrote. `makeSymbolId` now refuses them, which is what lets
    `isSymbolId` recover the parts and re-run the constructor's own check.

  ### Packages with no source change

  `@aburi/config` and `@aburi/plugin-registry` are bumped for the `ComponentId` pattern change
  in `aburi.config.v1.json` and for the `@aburi/types` dependency, respectively; neither has a
  source diff.

  ### For plugin authors

  `SymbolCandidate.id` and `OwnerSummary.id` are `SymbolId` rather than `string`. A language
  plugin that already builds ids with `makeSymbolId` — as `@aburi/lang-typescript` does —
  needs no change. One that concatenates the parts itself will stop type-checking and should
  switch to the constructor, which enforces the `ir-schema.md` §3.1 grammar it was assuming.

- df2f3ec: Report why calls stay unresolved instead of dropping them silently.

  `docs/design/slice-view.md` §5.4 gives calls with `resolved: null` no `CallEdge`,
  so a Controller → Service pair whose link the resolver could not identify shows
  up as two unrelated singleton Slices. The behaviour is intentional and unchanged
  — what was missing is any way for a reviewer to tell that apart from a genuinely
  disconnected change. This implements the diagnostic surface
  `docs/design/call-resolution.md` §8.1 had specified but left unbuilt, and with it
  the previously unsatisfiable test criteria CR27 / CR28 / CR29 of §10.4.

  `resolveCallGraph` now classifies every unresolved call into one of the five
  §8.1 buckets — `local-scope`, `external`, `dynamic`, `ambiguous`, `no-match` —
  using a fixed precedence so an unchanged workspace always reports the same
  numbers. Which calls resolve, the `CallEdge[]` they produce, and the resulting
  `slices[]` are all byte-identical to before.

  Surfaces:

  - `aburi scan` and `aburi diff` print one stdout line, e.g.
    `calls 1310 · resolved 1203 · unresolved 107 (external 30 · dynamic 60 · no-match 17)`.
    Zero-valued buckets are omitted. When the head IR predates the counter,
    `aburi diff` omits the line rather than printing misleading zeroes, and says so
    on stderr so the absence is not itself silent.
  - The `## 🧵 Slice View` section of `out/diff.md` gains a note when any member
    carries unresolved calls, plus a `⚠ N unresolved calls` marker on the affected
    members and singletons. Computed from the IR Symbols the diff already embeds —
    `aburi.diff.v1.json` is unchanged and `SliceRecord` gains no field.
  - `aburi explain <symbol> --debug-resolution` renders a `## Call resolution`
    table with the per-call bucket and, for `ambiguous`, the competing candidates.
    Per-call reasons are not persisted in the IR (§8.1), so the flag always
    rescans and is rejected alongside `--no-rescan` or `--ir`.

  No CI gate and no tuning knob was added: `--fail-on` is untouched, and
  `--debug-resolution` changes only what is printed
  (`docs/design/overview.md` §2, `slice-view.md` §14.7).

  Schema addition (non-breaking, additive per `ir-schema.md` §15.2): `Stats` grows
  an optional `callResolution` object holding `totalCalls`, `resolvedCalls`, and
  the five `unresolved` bucket counters. It is optional so documents produced
  before the field existed stay valid v1, but the current scan pipeline always
  emits it. New IR integrity invariant #15 re-derives all three numbers from
  `symbols[]`, so the census cannot drift from the document it describes.

  Public API additions:

  - `@aburi/types`: `CallResolutionStats` and `UnresolvedCallBuckets` (generated
    from the schema), plus the non-schema `UnresolvedCallBucket` /
    `UnresolvedCallDiagnostic` records. `CallCandidate` gains an optional
    `dynamicReceiver` flag — language plugins set it when the callee's receiver was
    an expression (`getRepo().save()`), which normalization otherwise collapses
    into something indistinguishable from a qualified name.
  - `@aburi/core`: `resolveCallGraph` returns `stats` and `diagnostics` alongside
    `symbols` / `edges`, accepts an optional `dynamicCallSites` input, and exports
    `makeCallSiteKey`. `ScanResult` gains `unresolvedCalls`.
  - `@aburi/markdown-projection`: `formatCallResolutionLine`, and an optional
    `unresolvedCalls` field on `ProjectSymbolExplainContext`. Explain output is
    byte-identical when it is omitted.
  - `@aburi/cli`: `DiffReport.callResolutionLine`, `ScanReport.callResolutionLine`
    / `ScanReport.unresolvedCalls`, and `ExplainOptions.debugResolution`.
  - `@aburi/lang-typescript`: reports `dynamicReceiver` for call, subscript, and
    parenthesized-expression receivers. Call target strings are unchanged, so no
    fingerprint moves.

- 2c5366d: Add `@aburi/framework-express`, a new framework plugin that classifies Express
  sources into five `framework:express:*` extKinds so Router-based apps and
  plain `app.get(...)` registrations can be scanned by Aburi.

  Recognised shapes (first-match-wins in the order listed):

  - `framework:express:router` — `const r = Router()` / `const r = express.Router()`
  - `framework:express:route` — `receiver.<method>(path, handler)` where `<method>`
    is one of `get` / `post` / `put` / `patch` / `delete` / `all`
  - `framework:express:middleware` — `.use(...)` with an arity-3 inline handler
    (or an identifier reference — flagged with `medium` confidence)
  - `framework:express:error-middleware` — `.use(...)` with an arity-4 handler
  - `framework:express:mount` — `.use(pathLiteral, identifier)` two-arg shape

  Confidence is `high` when the file imports `express` (ESM or CommonJS
  `require('express')`) and `medium` otherwise — the classification survives so
  the workspace projection still surfaces the shape, but consumers can treat
  medium-confidence rows as candidates for review.

  `@aburi/lang-typescript`: extends `extractSymbols` to promote module-level
  member-call expression statements (`app.get('/x', handler)`) into a new
  `kind: "call"` `SymbolCandidate` when the leaf method is in a small
  framework-registration whitelist. Symbol.id qnames are position-independent
  (`receiver__method[__pathSlug]__d<N>`) so IR fingerprints stay stable when
  leading imports or comments shift the source lines below.

  `@aburi/types`: adds `"call"` to the `SymbolKind` union and an optional
  `confidence?` field on `SymbolClassification` so framework plugins can express
  "matches the shape but I can't fully anchor it" (Express `.use(logger)` is
  `medium` unless the file imports `express`). Both fields are additive and
  optional — existing plugins (react / next / nestjs) remain unaffected.

  `@aburi/core`: the scan pipeline now threads `SymbolClassification.confidence`
  through to `Symbol.confidence`. When no framework classifier matches, or the
  winning classifier omits confidence, the value collapses to `"high"` at the
  `mergeFrameworkClassification` boundary so downstream code always sees a
  single, concrete `Confidence` encoding.

- f5cb552: Add `@aburi/framework-react`, a new framework plugin that classifies React
  sources into seven `framework:react:*` extKinds so React codebases (Vite / CRA
  / library authors — not just Next.js App Router) can be scanned by Aburi.

  Recognised shapes (first-match-wins in the order listed):

  - `framework:react:hook` — `/^use[A-Z]/` naming, with an extra `hook-call`
    `derivedBy` signal when the body calls another `use*` function
  - `framework:react:context` — `const X = createContext(...)` / `React.createContext(...)`
  - `framework:react:forward-ref` — `const X = forwardRef(...)` / `React.forwardRef(...)`
  - `framework:react:memo` — `const X = memo(...)` / `React.memo(...)`
  - `framework:react:provider` — PascalCase function whose returned JSX has
    `<X.Provider>` at its root
  - `framework:react:hoc` — `/^with[A-Z]/` naming
  - `framework:react:component` — PascalCase function whose body returns JSX
    (fallback)

  Detection is decorator-free: signals come from the symbol's name (leaf-of-qname
  regex), its `bodyNode` (tree-sitter walker looking for `jsx_element` /
  `jsx_self_closing_element` / `jsx_fragment`), and its `fullNode` (pre-order
  walk finding the outermost `call_expression` for the const-wrapper family). The
  plugin duck-types the tree-sitter node surface rather than depending on
  `web-tree-sitter` directly.

  `@aburi/lang-typescript`: extends `fileExtensions` and the internal
  `EXTENSION_GRAMMAR` map to accept `.js` / `.mjs` / `.cjs` (TypeScript grammar,
  permissively) and `.jsx` (tsx grammar, JSX-aware). This is what lets
  `@aburi/framework-react` classify React sources in plain-JavaScript codebases.

  `@aburi/cli`: `aburi init --with-suggestions` now maps a detected `react`
  framework to `@aburi/framework-react` alongside the existing `nestjs` /
  `nextjs` entries.

### Patch Changes

- 14bcd59: Settle what "no value" looks like in the IR, and make every writer say it the same way.

  `aburi.ir.v1` had two ways to spell an absent value and no rule for choosing between them. `SourceRange.startColumn` was written as an explicit `null`, `Signature.inferredThrows` had its key dropped entirely, and `Symbol.component` was never written at all — three conventions inside one document, none of them stated anywhere. Consumers absorbed the cost: `Symbol.component` and `Symbol.signature` each forced a `x === null || x === undefined` check at every read site, because a field that can be absent _and_ null has three states standing in for two meanings.

  Those checks stay. Writers are now consistent, but a document written before that cannot be rewritten, and `aburi diff` reads a committed IR as its base — so the reader half of the rule ("an absent Class A key reads as `null`") is what carries compatibility, and every `?? null` in the core, diff and projection packages is that rule's implementation rather than clutter to be cleaned up. A regression test now pins it: an IR with the keys stripped still validates, still passes the integrity check, and still diffs clean against one that has them.

  `ir-schema.md` §1.1 now fixes the rule, and the classification follows mechanically from the declared type rather than from anyone's judgement: a nullable optional is **Class A** — the writer always emits the key, carrying `null` when there is no value, and a reader treats an absent key as `null`. A non-nullable optional is **Class B** — the key's presence is itself the signal, so the writer omits it rather than substituting `[]`, `false`, or `null`. Every optional property in the schema now states its class in its `description`, which reaches plugin authors as JSDoc on the generated types, and a test fails on any future optional that lands without one.

  The writers that disagreed with the rule now follow it. `Symbol.component` and `Component.description` are emitted as explicit `null`, so a detected Component and a configured one have the same shape. Two output changes come with that, both in `@aburi/cli`: every Symbol gains `"component": null` and every Component gains `"description": null`, and a config-declared Component **loses** `publicApi` / `frameworks` when they are empty, where it previously wrote `[]`. Fingerprints, dependencies and stats are byte-identical either way. A config entry that omits `languages` now falls back to `["ts"]` as detection already did, instead of writing an `[]` that the IR schema rejects.

  `SymbolCandidate.source` is typed as the new `WrittenSourceRange`, which requires both column keys. A language plugin that builds a `SourceRange` without them no longer compiles. This is the one breaking change here, and it is deliberate: `serializeCanonical` drops `undefined` properties, so an omitted column is invisible in TypeScript and visible only in the emitted bytes. Plugins that already write `startColumn: null, endColumn: null` — as the in-tree TypeScript plugin does — need no change. The read-side `SourceRange` stays optional on purpose, because an IR loaded off disk may predate the rule and must remain representable.

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [efe3cbd]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/core@0.2.0
  - @aburi/types@0.2.0

## 0.1.0

### Minor Changes

- 7ea4c8e: Introduce `@aburi/lang-typescript`, the first Aburi language plugin. Implements the full lang-plugin.md contract on top of `web-tree-sitter` and the pre-built typescript / tsx grammars from `@vscode/tree-sitter-wasm`:

  - **`parseFile`** — lazily initializes the WASM runtime once per process and caches every loaded grammar. Each call creates a fresh `Parser`, parses the file, collects recoverable syntax errors from the tree, and releases the parser before returning so the WASM heap stays flat across long scans (the discipline documented in lang-plugin.md §8.1).
  - **`extractSymbols`** — surfaces top-level functions / classes / interfaces / type aliases / enums / namespaces / variable-assigned functions, class instance and static methods (with `.` vs `::` separators), the reserved `<default>` sentinel for anonymous default exports, and nested namespace paths. Populates `Signature` with async / generator flags, positional inputs with names + types, outputs, sorted throws (both `throw new X()` statements and JSDoc `@throws {X}` tags), and type parameters. Extracts decorators with raw / arguments / line preserved (boundary defaults to false for framework plugins to override).
  - **`walkBody`** — emits guard / throw / return / loop / try / switch rules with the drop-list `isTrivialReturn` rule fully implemented (literal / identifier / member-chain / unary-of-trivial returns are dropped; `return f()` records the call but skips the rule). CallCandidate captures `target`, `line`, `argumentCount`, `inAwait`, `inNew`, and per-argument literal values.
  - **`normalizeAst`** — emits a positionless, comment-free, whitespace-free S-expression with identifier and literal values preserved. Feeds `syntaxFingerprint` in `@aburi/core`.
  - **`symbolDropHint`** — Category B hints for interface (`interface (data model)`), type alias, pure DTO, pure constants, and empty function body. Category A file patterns cover `**/*.d.ts` / `**/*.d.mts` / `**/*.d.cts`.
  - **Import extraction** — static named / default / namespace / bare / mixed imports, `export ... from ...` re-exports, and dynamic `import()` calls collapse into a normalized `ImportEdge[]`.

  Public API: `langTypescriptPlugin` (ready-to-register instance), `LangTypescriptPlugin` (class), `langTypescriptManifest`, `parseTypescriptFile`, `extractSymbols`, `walkBody`, `normalizeAst`, `extractImports`, `classifySymbolDropHint`, `TYPESCRIPT_FILE_DROP_PATTERNS`.

- 358f76f: Cut the initial `0.1.0` release of the Aburi ecosystem.

  This is the first public version of every workspace package that ships. The
  v0.1 scope defined in [`docs/roadmap.md`](https://github.com/kage1020/Aburi/blob/main/docs/roadmap.md)
  is complete:

  - **Foundation** — `@aburi/types` (schema-generated + hand-written interfaces),
    `@aburi/plugin-registry` (vocab registry + conflict enforcement),
    `@aburi/config` (JSONC + ajv-validated loader with framework-hint
    normalisation), `@aburi/core` (Symbol id, canonical JSON, 11 IR invariants,
    autodetect, scan orchestration).
  - **Language** — `@aburi/lang-typescript` (tree-sitter WASM TS/TSX plugin).
  - **Frameworks** — `@aburi/framework-nestjs`, `@aburi/framework-next`.
  - **Effects** — `@aburi/effects-prisma`, `@aburi/effects-nest`.
  - **Diff + projection** — `@aburi/diff` (5-stage semantic matcher +
    status + delta), `@aburi/markdown-projection` (workspace / component / diff
    / explain views).
  - **Delivery** — `@aburi/cli` (`aburi init | scan | diff | explain`, exit codes
    0 / 1 / 2 / 3, `--fail-on` gate), `@aburi/github-action` (composite action +
    marker-based PR comment upsert).

  ### Publishing pipeline
  - `.github/workflows/ci.yml` — matrix (ubuntu / macos / windows) runs Biome
    `check`, `typecheck`, `build`, `test` on every PR and every push to `main`.
  - `.github/workflows/release.yml` — on push to `main`, `changesets/action@v1`
    either opens a "Version Packages" PR (when there are pending changesets) or,
    if that PR was already merged, runs `pnpm release` (typecheck + test + build
    - `changeset publish`) to push every bumped package to npm.
  - Authentication uses [**npm Trusted Publishing**](https://docs.npmjs.com/trusted-publishers)
    (OIDC). No `NPM_TOKEN` secret is stored anywhere; pnpm 11.11.0 exchanges the
    workflow's OIDC token for a short-lived publish credential at publish time.
    Sigstore attestation is emitted via `provenance=true` in the workflow's
    `.npmrc`, and consumers verify tarballs with `npm audit signatures`.
  - `changesets/action` reads the `New tag: …` lines the publish command prints
    and creates a matching GitHub Release per per-package tag
    (`@aburi/<pkg>@0.1.0`).
  - Every public package.json carries `repository.directory` so npm links back
    to the correct monorepo subdirectory, plus explicit `author`, `homepage`,
    and `bugs` fields.

  ### One-time trusted-publisher setup (required before the first publish)

  For each of the 13 publishable `@aburi/*` packages, register a trusted
  publisher on npmjs.com pointing at this repository's release workflow:

  1. On the package settings page (e.g.
     `https://www.npmjs.com/package/@aburi/cli/access` — for a not-yet-published
     package, first do a one-time manual `npm publish` to reserve the name, or
     configure the trusted publisher on the org account before publishing).
  2. Under "Trusted Publisher", add:
     - **Provider**: GitHub Actions
     - **Repository**: `kage1020/Aburi`
     - **Workflow filename**: `release.yml`
     - **Environment**: leave blank (no environment gating today)
  3. Repeat for all 13 packages, or configure the trusted publisher on the
     `@aburi` org so newly-scoped packages inherit it.

  Once configured, no rotation, no secret storage, and no static credential is
  ever created. Revoking access is a one-click delete on the npm settings page.

  ### Consumer entry points at 0.1.0
  - `npm i -D @aburi/cli @aburi/lang-typescript @aburi/framework-<yours>`
    (see the [root README](https://github.com/kage1020/Aburi#readme) for the
    quick start).
  - `uses: kage1020/Aburi/packages/github-action@main` in a workflow to gate
    PRs on the semantic diff. The action is referenced by repo path (composite
    action convention), and the CLI version it invokes is picked by the workflow
    author via the `version` input, so future CLI patch releases roll out to
    consumers without a fresh action tag. When per-release ref pinning is
    wanted, use the per-package tag `changesets/action` creates
    (`@aburi/github-action@0.1.0`) — an unscoped `v0.1.0` tag is intentionally
    not published because `changeset publish` names monorepo tags per package.

### Patch Changes

- 405dcfa: Ship the v0.1 documentation set.

  - **Root `README.md`** — rewritten from a status placeholder into a full quick
    start: install / init / scan / diff / GitHub Action, a "why not just `git diff`"
    motivation with the four canonical scenarios, an architecture-at-a-glance
    block that walks source → IR → derived views, and a package matrix pointing
    at every workspace member.
  - **Per-package `README.md`** — 12 new files (`@aburi/types`,
    `@aburi/plugin-registry`, `@aburi/config`, `@aburi/core`,
    `@aburi/lang-typescript`, `@aburi/framework-nestjs`, `@aburi/framework-next`,
    `@aburi/effects-prisma`, `@aburi/effects-nest`, `@aburi/diff`,
    `@aburi/markdown-projection`, `@aburi/cli`). Each covers the pitch, install,
    the shape of the API the package exports, and design-doc references.
    `@aburi/github-action` already had one and is untouched.
  - **`docs/cli-reference.md`** — operator-facing per-subcommand reference for
    `aburi init / scan / diff / explain`: flags, `--fail-on` grammar, exit-code
    table, environment variables, config discovery order, and programmatic entry
    points.
  - **`docs/plugin-development.md`** — walkthrough for authoring `LanguagePlugin`
    / `FrameworkPlugin` / `EffectPlugin`, the manifest contract, the two-signal
    layered gate convention for effect classifiers, testing pattern, and CLI
    loader resolution rules.

  Docs-only change. Patch-bump every public package so the `files: ["dist", "src",
"README.md"]` package.json entry ships the freshly written README when the
  next release is cut.

- Updated dependencies [19f2494]
- Updated dependencies [a8882f0]
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/core@0.1.0
