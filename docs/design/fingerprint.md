# Fingerprint Computation

Exact computation rules for the three axes — `api` / `logic` / `syntax` — of the `Symbol.fingerprint` emitted by Aburi.
Diff stability is guaranteed only by implementations that follow the conventions in this document.

Reference implementation: [`schema/fingerprint.mjs`](https://github.com/kage1020/Aburi/blob/main/schema/fingerprint.mjs)
Invariance tests: [`schema/fingerprint.test.mjs`](https://github.com/kage1020/Aburi/blob/main/schema/fingerprint.test.mjs)

---

## 1. Purpose

| Axis | Changes when | Invariant under |
|---|---|---|
| `api` | Public signature / decorators / visibility / exception declarations change | Body implementation changes |
| `logic` | The set of rules / effects changes | Local variable renames, method reordering, comments, added decoration calls |
| `syntax` | AST structure changes | Formatting-only changes, comments |

Separating the three axes lets the Diff report distinguish "API change", "implementation logic change", and "implementation refactor only".

## 2. Common Specification

### 2.1 Hash function

- Algorithm: **SHA-256**
- Output: **hex representation of the first 6 bytes** (12 characters, 48 bits)
- Encoding: lowercase hex

48 bits makes the collision probability within a single monorepo practically zero (`2^48 ≈ 2.8 × 10^14`). Fingerprints are also read by humans in diff reports, so the string length is kept short.

### 2.2 String normalization (Canonical String)

Applied to every string that enters a fingerprint input:

1. Unicode NFC normalization
2. Collapse consecutive whitespace (space / tab / newline) into a single space
3. Trim leading and trailing whitespace
4. The empty string stays the empty string

### 2.3 Serialization convention (Canonical JSON)

Hash inputs are serialized as JSON before being fed to SHA-256. Serialization follows:

1. Object keys are sorted in **ascending codepoint order**
2. No separator whitespace (`{"a":1,"b":2}` form)
3. Array element order **follows the rules specified in this document** (default: preserve input order)
4. Numbers follow the JSON standard (no decimal point on integers, `NaN` / `Infinity` not allowed)
5. String escaping follows the JSON standard; characters other than ASCII control characters are emitted as-is (no `\uXXXX` required)

Encode as UTF-8, then pass to SHA-256.

## 3. `api` fingerprint

Represents the symbol's **externally observable contract**. Changes when the "public contract" that consumers can depend on changes.

### 3.1 Input fields

```jsonc
{
  "kind": <Symbol.kind>,
  "extKind": <Symbol.extKind>,
  "shortName": <lastSegment(Symbol.name)>,     // see §3.3
  "visibility": <Symbol.visibility>,
  "decorators": [
    {
      "name": <Decorator.name>,
      "raw": <canonical(Decorator.raw)>,        // includes arguments
      "boundary": <Decorator.boundary>
    }
  ],                                            // all decorators, sorted by (name, line)
  "signature": null | {
    "inputs": [{ "type": <canonical(input.type)> }],  // name excluded, input order preserved
    "outputs": [<canonical(output)>],           // input order preserved
    "throws": [<canonical(throw)>],             // sorted (alpha)
    "async": <bool>,
    "generator": <bool>,
    "typeParameters": [<canonical(tp)>]         // input order preserved
  }
}
```

`language` is **not included in the input**. It is already separated by the `<language>:` prefix inside Symbol.id, and by design `language` never changes between Symbols with the same ID. The fingerprint represents only the API surface of a single Symbol.

### 3.2 Formula

```
api_input = CanonicalJSON(object above)
api = lower_hex(SHA-256(UTF-8(api_input))[0..6])
```

### 3.3 `shortName` = `lastSegment(Symbol.name)`

`Symbol.name` is a qualified name (`InvoiceService.createInvoice`, `Class::method`, `A.B.C.method`).
Only the **last segment** goes into the api fingerprint:

```
lastSegment(name):
  if name contains "::"  → return part after last "::"
  if name contains "."   → return part after last "."
  else                    → return name as-is
```

Examples:
- `InvoiceService.createInvoice` → `createInvoice`
- `Class::staticMethod` → `staticMethod`
- `A.B.C.method` → `method`
- `topLevelFunc` → `topLevelFunc`

`<default>` stays `<default>` as-is.

### 3.4 Guaranteed invariance conditions

- Changing `signature.inputs[].name` does not change `api` (parameter names are not part of the contract)
- Changing local variable names, the function body, or rules/effects does not change `api`
- Reordering the **occurrence order** of decorators does not change `api` (because of the sort convention)
- **Changing only the class-scope portion of `Symbol.name` (`InvoiceService.createInvoice` → `BillingService.createInvoice`) does not change `api`** (the last segment is the same)

### 3.5 Guaranteed change conditions

- `visibility` changes → changes
- Any of `signature.inputs[].type` / `outputs` / `throws` changes → changes
- Adding / removing a decorator or changing its arguments → changes (whether boundary or non-boundary)
- `shortName` change (= renaming the method/function itself) → changes
- `async` / `generator` flag change → changes
- `kind` / `extKind` change → changes

### 3.6 Why decorator arguments are included in api

The URL portion of `@Post('/invoices')` and the Guard of `@UseGuards(RolesGuard)` are part of the external contract. If arguments were excluded from the fingerprint, changing the URL would leave `api` unchanged and go undetected during review.

### 3.7 Design so that class rename does not flag every method as an API change

Renaming a class such as `InvoiceService` → `BillingService` is common implementation work, but the public contract of each method (signature, decorators, return type) is unchanged.
A class rename is **detected as `moved` in stage 4 (name+signature similarity)**, with `delta.apiChanged: false`. It is never mass-listed in the API changes section (the highest-severity section).

## 4. `logic` fingerprint

Represents the **meaning executed by the symbol's body**. Changes when the meaning of the implementation changes.

### 4.1 Input fields

```jsonc
{
  "rules": [
    {
      "type": <Rule.type>,
      "condition": <canonical(Rule.condition)> | null,
      "what": <canonical(Rule.what)> | null,
      "expr": <canonical(Rule.expr)> | null,
      "loopKind": <Rule.loopKind> | null
    }
  ],                                            // input order (= source order = ascending line) preserved
  "effects": [
    {
      "target": <canonical(Effect.target)>
    }
  ]                                             // input order (= source order = ascending line) preserved
}
```

`Effect.id` (e.g. `db.write` / `x-prisma:create`) is **not included in the input**. Reasons:

- `id` is the classification result of an effect plugin; changing the plugin configuration (`config.effects[]`) can give the same call a different id
- If `id` were included, merely reversing the order of `effects: ["effects-prisma", "effects-stripe"]` would change the logic FP of the entire IR, making comparison against past IRs impossible
- "The meaning of an effect on a given target" is sufficiently determined by the target string (`prisma.invoice.create`)
- id is used for display (Markdown projection / diff report classification); target is used as the stability indicator

### 4.2 Formula

```
logic_input = CanonicalJSON(object above)
logic = lower_hex(SHA-256(UTF-8(logic_input))[0..6])
```

### 4.3 Guaranteed invariance conditions

- Reordering the **declaration order** of methods leaves each method's `logic` unchanged (computed per-symbol)
- Renaming a local variable that does **not appear** in the strings of rules/effects leaves `logic` unchanged
- Adding comments / changing whitespace → unchanged (canonical string normalization)
- Adding a call classified as decoration (logger / `console.log` / anything dropped at extraction) → unchanged
- Adding / changing decorators → unchanged (decorators belong to the api axis)

### 4.4 Guaranteed change conditions

- Reordering **rules** → changes (control-flow execution order carries meaning)
- Reordering **effects** → changes (side-effect occurrence order carries meaning)
- Changing the expression of `rules[].condition` / `what` / `expr` itself → changes
- Adding / removing an effect, or changing its `target` → changes

### 4.5 Guaranteed invariance conditions (plugin-configuration robustness)

- Even if the `effects[].id` classification of an effect plugin changes (e.g. `db.write` ↔ `x-prisma:create`), `logic` is unchanged as long as the target is the same
- Adding / removing effect plugins or reordering the config does not break the logic stability of the IR
- Time-series comparison against past IRs is robust to plugin configuration changes

### 4.6 Known v0.1 limitations (before LSP enrichment)

- `effects[].target` uses the string as-is. `this.storedCats.push` and `this.cats.push` are different fingerprints
  - When a field rename shows up in the targets of effects, `logic` changes
  - Resolution comes with v0.2 call-resolution / LSP enrichment, which introduces type-informed normalization
- The same applies to identifiers inside `rules[].condition` (`if (storedCats.length > 0)` and `if (cats.length > 0)` are different fingerprints)

These are explicitly declared as "not guaranteed in v0.1". A field rename appearing as `logic changed` during review is, in current v0.1, per spec.

### 4.7 Why effects order is preserved (= not sorted)

By design, the order of effects can carry meaning (transaction boundaries, idempotency, retry safety). Discarding order would give "DB write before event publish" and "event publish before DB write" the same fingerprint, making refactoring-induced bugs undetectable in the diff.

As a trade-off, "unintended reordering" also shows up in the diff, but a miss was judged more costly than noise.

## 5. `syntax` fingerprint

Represents the **AST structure** of the symbol body. Changes on any structural change other than formatting.

### 5.1 Input fields

`syntax` computation is the **responsibility of the language plugin**. AST shapes differ per language, so the core cannot define it.

The language plugin generates a **normalized AST string** per Symbol and computes `Symbol.fingerprint.syntax` from it. The normalized AST string satisfies the following conventions:

1. Contains no comment nodes
2. Contains no position information (line, column, byte offset)
3. Contains no whitespace tokens
4. Is an S-expression representing only node kinds and child-node structure
5. Includes identifier and literal values (concrete values, not structure alone)

Example (TypeScript): use the S-expression from tree-sitter's `node.toString()` with position annotations removed.

```
(method_definition
  name: (property_identifier "createInvoice")
  parameters: (formal_parameters ...)
  body: (statement_block
    (if_statement
      condition: (parenthesized_expression (binary_expression ...))
      consequence: (statement_block (throw_statement ...)))))
```

### 5.2 Formula

```
syntax_input = <normalized AST string generated by the language plugin>
syntax = lower_hex(SHA-256(UTF-8(syntax_input))[0..6])
```

### 5.3 Guaranteed invariance conditions

- Whitespace / newline / indentation changes → unchanged
- Adding / removing comments → unchanged

### 5.4 Guaranteed change conditions

- Adding / removing statements → changes
- Renaming an identifier → changes (`syntax` is structure-based, not meaning-based, so identifiers are treated as part of the structure)
- Changing a literal → changes

### 5.5 Uses of the syntax fingerprint

The main use is the **three-tier display** in the Diff report:

- `api unchanged, logic unchanged, syntax unchanged` → completely unchanged, not shown in the Diff
- `api unchanged, logic unchanged, syntax changed` → implementation refactor only, low-priority
- `api unchanged, logic changed` → semantic change, needs review
- `api changed` → public contract change, needs approval

Symbols with only `syntax changed` are shown collapsed in the Diff report to reduce review load.

### 5.6 Grammar revision dependency (important)

The `syntax` fingerprint **changes wholesale on minor updates of the parser grammar the language plugin adopts**.
tree-sitter grammars routinely rename nodes (`property_identifier` → `member_property`, etc.), so a mere `pnpm update` could turn every Symbol in Aburi `syntax-changed`.

To prevent this:

1. **Language plugins record `grammarRevision` in the IR**:
   On each IR emission, the exact grammar version is recorded in `generator.plugins[type=lang].grammarRevision`.
   **The format is strictly fixed**: `^[\w./@-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$` (e.g. `tree-sitter-typescript@0.23.2`, `@oxc-project/parser@2.1.0+sha.abc123`).
   The manifest schema validates the format. This prevents "incomparable" results caused by plugin authors' notation drift.

2. **Diff computation verifies grammar revision equality**:
   The `grammarRevision` of the same-language plugin in base and head is compared by **string equality**. If they do not match, the `syntax` fingerprint differences for that language are treated as **meaningless**.
   However, api/logic fingerprints go through the plugin's extraction logic, so on grammar version mismatch a warning is shown at the top of the diff report: "**all fingerprint differences may originate from plugin version differences**" (api/logic differences themselves are still emitted normally).
   - Affected Symbols are not shown in the `syntax-only changed` section of the diff report
   - Symbols with `apiChanged: true` / `logicChanged: true` are shown as usual
   - The grammar revision mismatch is shown as a single warning line at the top of the diff report

3. **Enforce the grammar version via peerDependencies in package.json**:
   Each language plugin pins its supported grammar version in peerDependencies, so an inconsistent install is detectable at install time.

The `api` / `logic` fingerprints are defined by plugin-independent computation conventions (§3, §4) and are therefore unaffected by grammar versions. Only `syntax` is subject to this consideration.

## 6. Dropped symbols

Symbols with `Symbol.dropped == true` use a fixed value on all three fingerprint axes:

```jsonc
{
  "api":    "000000000000",
  "logic":  "000000000000",
  "syntax": "000000000000"
}
```

As a result, comparing dropped symbols against each other always yields "no change", and they are excluded from the Diff report.

## 7. Verifiable properties (test criteria)

The reference implementation and every language plugin must pass the following tests.

### 7.1 Identity

| ID | Input | Expected |
|---|---|---|
| T1 | Compute the same Symbol twice | api/logic/syntax all match |
| T2 | Canonical-serialize the Symbol → parse → recalculate | match |

### 7.2 api invariance conditions

| ID | Mutation | Expected |
|---|---|---|
| A1 | Change `signature.inputs[].name` | api unchanged |
| A2 | Change the body (rules/effects) | api unchanged |
| A3 | Reorder decorators (distinct decorators) | api unchanged |
| A12 | Change only the class-scope portion of `Symbol.name` (`Old.method` → `New.method`) | api unchanged |
| A13 | Change `language` (never happens in practice; defensive) | api unchanged (`language` is not part of the input) |

### 7.3 api change conditions

| ID | Mutation | Expected |
|---|---|---|
| A4 | Change `visibility` | api changes |
| A5 | Add a type to `signature.outputs` | api changes |
| A6 | Add a type to `signature.throws` | api changes |
| A7 | Add a decorator | api changes |
| A8 | Change decorator arguments (`@Post('/x')` → `@Post('/y')`) | api changes |
| A9 | `async` true ↔ false | api changes |
| A10 | Change `kind` (`function` → `method`, etc.) | api changes |
| A11 | Change `extKind` | api changes |
| A14 | Change `shortName` (last segment) | api changes |

### 7.4 logic invariance conditions

| ID | Mutation | Expected |
|---|---|---|
| L1 | Rename a local variable that does not appear in rules/effects strings | logic unchanged |
| L2 | Add a comment | logic unchanged |
| L3 | Change whitespace formatting | logic unchanged |
| L4 | Add a decoration (`console.log`, etc.) | logic unchanged |
| L5 | Change a decorator | logic unchanged |
| L11 | Change only the effect's `id` (same target) — plugin configuration robustness | logic unchanged |
| L12 | Adding/removing/reordering effect plugins classifies the same target under a different id | logic unchanged |

### 7.5 logic change conditions

| ID | Mutation | Expected |
|---|---|---|
| L6 | Reorder rules | logic changes |
| L7 | Reorder effects | logic changes |
| L8 | Change a rule's condition | logic changes |
| L9 | Change an effect's target | logic changes |
| L10 | Add / remove an effect | logic changes |

### 7.6 syntax invariance conditions

| ID | Mutation | Expected |
|---|---|---|
| S1 | Add a comment | syntax unchanged |
| S2 | Change whitespace formatting | syntax unchanged |

### 7.7 syntax change conditions

| ID | Mutation | Expected |
|---|---|---|
| S3 | Add a statement | syntax changes |
| S4 | Rename an identifier | syntax changes |
| S5 | Change a literal | syntax changes |

### 7.7.1 syntax test criteria every language plugin must satisfy

S1–S5 fall under the responsibility of each language plugin's `normalizeAst()` implementation, but **the core cannot test the contract itself**, so every plugin must ship the following test harness:

```js
// must be included in the language plugin's test suite
describe('normalizeAst syntax fingerprint contract', () => {
  test('S1: adding a comment leaves syntax unchanged', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { /* note */ return 1 }'));
    expect(a).toBe(b);
  });
  test('S2: whitespace formatting change leaves syntax unchanged', () => {
    const a = normalizeAst(parseSnippet('function f(){return 1}'));
    const b = normalizeAst(parseSnippet('function f() {\n  return 1\n}'));
    expect(a).toBe(b);
  });
  test('S3: adding a statement changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { const x = 0; return 1 }'));
    expect(a).not.toBe(b);
  });
  test('S4: renaming an identifier changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { return x }'));
    const b = normalizeAst(parseSnippet('function f() { return y }'));
    expect(a).not.toBe(b);
  });
  test('S5: changing a literal changes syntax', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { return 2 }'));
    expect(a).not.toBe(b);
  });
});
```

Plugins that do not satisfy this cannot be registered in the official Aburi plugin registry. It is recommended for third-party plugins as well.

### 7.8 Dropped

| ID | Input | Expected |
|---|---|---|
| D1 | Symbol with `dropped: true` | all fingerprints are `"000000000000"` |
| D2 | Same AST treated differently under `dropped: true` / `false` | former is zero, latter is computed normally |

## 8. Cross-implementation compatibility

Prerequisites for different language plugin implementations to produce identical results:

- `api` / `logic` computation is fully defined in §3 and §4 of this document and is therefore reproducible independently of plugins
- `syntax` computation is language-specific (see §5.1). It is reproducible within a given version of the same language plugin
- If a plugin version upgrade changes the AST extraction rules, `syntax` may change destructively
  - `api` / `logic` may also change for the same Symbol (because extraction granularity changes)
  - This is the trade-off of upgrading to a newer language plugin version

## 9. Reference implementation points

Pseudocode for the JavaScript/TypeScript implementation:

```js
import { createHash } from 'node:crypto'

export function lastSegment(qname) {
  // §3.3 — "::" takes priority, then "."
  const byColon = qname.split('::')
  const tail = byColon[byColon.length - 1]
  const byDot = tail.split('.')
  return byDot[byDot.length - 1]
}

export function apiFingerprint(sym) {
  const decorators = [...sym.decorators].sort((a, b) => {
    const byName = a.name.localeCompare(b.name)
    return byName !== 0 ? byName : a.line - b.line
  }).map(d => ({ name: d.name, raw: canonical(d.raw), boundary: d.boundary }))

  const signature = sym.signature ? {
    async: sym.signature.async,
    generator: sym.signature.generator,
    inputs: sym.signature.inputs.map(i => ({ type: canonical(i.type) })),
    outputs: sym.signature.outputs.map(canonical),
    throws: [...sym.signature.throws].map(canonical).sort(),
    typeParameters: sym.signature.typeParameters.map(canonical)
  } : null

  return hash({
    decorators,
    extKind: sym.extKind,
    kind: sym.kind,
    shortName: lastSegment(sym.name),   // §3.3
    signature,
    visibility: sym.visibility
    // language excluded: already separated by the <language>: prefix of Symbol.id
  })
}

export function logicFingerprint(sym) {
  return hash({
    effects: sym.effects.map(e => ({ target: canonical(e.target) })),  // id excluded (§4.5)
    rules: sym.rules.map(r => ({
      condition: r.condition !== null ? canonical(r.condition) : null,
      expr:      r.expr !== null ? canonical(r.expr) : null,
      loopKind:  r.loopKind,
      type:      r.type,
      what:      r.what !== null ? canonical(r.what) : null
    }))
  })
}

function canonical(s) {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

function hash(obj) {
  const json = canonicalJson(obj)
  return createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 12)
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
```
