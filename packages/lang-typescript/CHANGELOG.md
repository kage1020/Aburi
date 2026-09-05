# @aburi/lang-typescript

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
