# Fingerprint 計算式

Aburi が出力する `Symbol.fingerprint` の `api` / `logic` / `syntax` 3 軸の正確な計算式定義。
差分安定性は本ドキュメントの規約に従う実装によってのみ保証される。

参照実装: `schema/fingerprint.mjs`
不変性テスト: `schema/fingerprint.test.mjs`

---

## 1. 目的

| 軸 | 変化する条件 | 不変な条件 |
|---|---|---|
| `api` | 公開シグネチャ / 装飾子 / 可視性 / 例外宣言の変更 | 本体実装の変更 |
| `logic` | rules / effects 集合の変更 | ローカル変数 rename・メソッド順入れ替え・コメント・装飾呼び出し追加 |
| `syntax` | AST 構造の変更 | フォーマットのみの変更・コメント |

3 軸を分けることで Diff レポートが「API 変化」「実装ロジック変化」「実装リファクタのみ」を区別できる。

## 2. 共通仕様

### 2.1 ハッシュ関数

- アルゴリズム: **SHA-256**
- 出力: **先頭 6 バイトの hex 表現** (12 文字、48 bit)
- エンコーディング: lowercase hex

48 bit は 1 monorepo 内で衝突確率を実用上ゼロにする (`2^48 ≈ 2.8 × 10^14`)。fingerprint は人間も diff レポートで目視するため文字列長を抑える。

### 2.2 文字列正規化 (Canonical String)

fingerprint 入力に含まれる全ての文字列に適用:

1. Unicode NFC 正規化
2. 連続空白 (space / tab / 改行) を単一 space に圧縮
3. 前後の空白を除去
4. 空文字列はそのまま空文字列

### 2.3 シリアライズ規約 (Canonical JSON)

ハッシュ入力は JSON でシリアライズしてから SHA-256 に通す。シリアライズは以下に従う:

1. オブジェクトのキーは **codepoint 昇順**
2. 区切りの空白なし (`{"a":1,"b":2}` 形式)
3. 配列要素の並びは **本ドキュメントが指定する規則に従う** (デフォルトは入力順保持)
4. 数値は JSON 規格通り (整数に小数点なし、`NaN` / `Infinity` 不可)
5. 文字列のエスケープは JSON 規格に従い、ASCII 制御文字以外はそのまま出力 (`\uXXXX` 不要)

UTF-8 にエンコードしてから SHA-256 に渡す。

## 3. `api` fingerprint

シンボルの **外部から観測可能な契約** を表す。consumer が依存できる「公開契約」が変わったときに変化する。

### 3.1 入力フィールド

```jsonc
{
  "kind": <Symbol.kind>,
  "extKind": <Symbol.extKind>,
  "shortName": <lastSegment(Symbol.name)>,     // §3.3 参照
  "visibility": <Symbol.visibility>,
  "decorators": [
    {
      "name": <Decorator.name>,
      "raw": <canonical(Decorator.raw)>,        // arguments まで含む
      "boundary": <Decorator.boundary>
    }
  ],                                            // 全 decorator、(name, line) で sort
  "signature": null | {
    "inputs": [{ "type": <canonical(input.type)> }],  // name 除外、入力順保持
    "outputs": [<canonical(output)>],           // 入力順保持
    "throws": [<canonical(throw)>],             // sort (alpha)
    "async": <bool>,
    "generator": <bool>,
    "typeParameters": [<canonical(tp)>]         // 入力順保持
  }
}
```

`language` は **入力に含めない**。Symbol.id 内の `<language>:` プレフィックスで既に分離されており、同 ID の Symbol 間で `language` が変化することは設計上ない。fingerprint は同一 Symbol の API 表面のみを表す。

### 3.2 計算式

```
api_input = CanonicalJSON(上記オブジェクト)
api = lower_hex(SHA-256(UTF-8(api_input))[0..6])
```

### 3.3 `shortName` = `lastSegment(Symbol.name)`

`Symbol.name` は qualified name (`InvoiceService.createInvoice`, `Class::method`, `A.B.C.method`)。
api fingerprint には **last segment のみ** を入れる:

```
lastSegment(name):
  if name contains "::"  → return part after last "::"
  if name contains "."   → return part after last "."
  else                    → return name as-is
```

例:
- `InvoiceService.createInvoice` → `createInvoice`
- `Class::staticMethod` → `staticMethod`
- `A.B.C.method` → `method`
- `topLevelFunc` → `topLevelFunc`

`<default>` は そのまま `<default>`。

### 3.4 約束する不変条件

- `signature.inputs[].name` を変更しても `api` は変わらない (引数名は契約に含めない)
- ローカル変数名・関数本体・rules/effects を変更しても `api` は変わらない
- decorator の **存在順序** を入れ替えても `api` は変わらない (sort 規約のため)
- **`Symbol.name` の class scope 部分のみ変更 (`InvoiceService.createInvoice` → `BillingService.createInvoice`) では `api` は変わらない** (last segment が同じ)

### 3.5 約束する変化条件

- `visibility` が変わる → 変化
- `signature.inputs[].type` / `outputs` / `throws` のいずれかが変わる → 変化
- decorator の追加・削除・引数変更 → 変化 (boundary / 非 boundary 問わず)
- `shortName` 変更 (= method/function 本体名の変更) → 変化
- `async` / `generator` フラグの変更 → 変化
- `kind` / `extKind` 変更 → 変化

### 3.6 decorator 引数を api に含める理由

`@Post('/invoices')` の URL 部分や `@UseGuards(RolesGuard)` の Guard は外部契約の一部。引数を fingerprint から外すと「URL を変えたのに api 不変」となり、レビュー時に検知できない。

### 3.7 class rename で全メソッドが API 変更扱いにならない設計

`InvoiceService` → `BillingService` への class rename は実装作業として頻発するが、各メソッドの公開契約 (signature, decorators, return type) は変わっていない。
class rename は **段 4 (name+signature 類似度) で `moved` として検出** され、`delta.apiChanged: false` となる。API 変更セクション (重要度最上位) に大量列挙されることはない。

## 4. `logic` fingerprint

シンボルの **本体が実行する意味** を表す。実装の意味が変わったときに変化する。

### 4.1 入力フィールド

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
  ],                                            // 入力順 (=source order = line 昇順) を保持
  "effects": [
    {
      "target": <canonical(Effect.target)>
    }
  ]                                             // 入力順 (=source order = line 昇順) を保持
}
```

`Effect.id` (例: `db.write` / `x-prisma:create`) は **入力に含めない**。理由:

- `id` は effect plugin の分類結果であり、plugin 構成 (`config.effects[]`) を変えると同じ呼び出しでも別 id になる
- `id` を含めると `effects: ["effects-prisma", "effects-stripe"]` を `[..., ...]` 順序逆転しただけで全 IR の logic FP が変わり、過去 IR との比較が不能になる
- 「同じ target に対する効果の意味」は target 文字列 (`prisma.invoice.create`) で十分に決まる
- id は表示用 (Markdown projection / diff レポートの分類) で使い、安定性指標としては target を使う

### 4.2 計算式

```
logic_input = CanonicalJSON(上記オブジェクト)
logic = lower_hex(SHA-256(UTF-8(logic_input))[0..6])
```

### 4.3 約束する不変条件

- メソッドの **宣言順序** を入れ替えても各メソッドの `logic` は不変 (per-symbol で計算するため)
- ローカル変数のうち rules/effects の文字列に **出現しない** ものを rename しても `logic` は不変
- コメント追加・空白変更 → 不変 (canonical 文字列正規化のため)
- decoration とみなされた呼び出し (logger / `console.log` / 抽出時に drop されたもの) の追加 → 不変
- 装飾子の追加・変更 → 不変 (装飾子は api 側)

### 4.4 約束する変化条件

- rules の **順序** を入れ替える → 変化 (制御フローの実行順は意味を持つ)
- effects の **順序** を入れ替える → 変化 (副作用の発生順は意味を持つ)
- `rules[].condition` / `what` / `expr` の式そのものを変更 → 変化
- effect の追加・削除・`target` の変更 → 変化

### 4.5 約束する不変条件 (plugin 構成耐性)

- effect plugin の `effects[].id` 分類が変わっても (例: `db.write` ↔ `x-prisma:create`)、target が同じなら `logic` は不変
- 効果プラグインの追加・削除・config 順序入れ替えで、IR の logic 安定性が壊れない
- 過去 IR との時系列比較は plugin 構成変更に対して頑健

### 4.6 v0.1 既知の限界 (LSP enrichment 前)

- `effects[].target` は文字列そのままを使う。`this.storedCats.push` と `this.cats.push` は別 fingerprint
  - フィールド rename が effects の target に出るケースでは `logic` は変化する
  - 解消は v0.2 の call-resolution / LSP enrichment で型情報経由の正規化を入れたとき
- `rules[].condition` 内の識別子も同様 (`if (storedCats.length > 0)` と `if (cats.length > 0)` は別 fingerprint)

これらは「v0.1 で約束しないもの」として明示する。レビュー時にフィールド rename が `logic changed` として現れるのは、現状の v0.1 では仕様通り。

### 4.7 effects の順序を保持する理由 (= sort しない)

設計上、効果の順序は意味を持つ場合がある (transaction 境界、idempotency、retry 安全性)。順序を捨てると「DB write の前に event publish」「event publish の後に DB write」が同じ fingerprint になり、リファクタリング起因のバグを diff で検知できなくなる。

トレードオフとして「意図しない順序入れ替え」も diff に出るが、noise より miss の方が高コストと判断した。

## 5. `syntax` fingerprint

シンボル本体の **AST 構造** を表す。フォーマット変更以外のあらゆる構造変更で変化する。

### 5.1 入力フィールド

`syntax` 計算は **言語プラグインの責務**。言語ごとに AST 形が違うためコア側では定義できない。

言語プラグインは Symbol ごとに **正規化 AST 文字列** を生成して `Symbol.fingerprint.syntax` を計算する。正規化 AST 文字列は次の規約を満たす:

1. コメントノードを含まない
2. 位置情報 (行・列・byte offset) を含まない
3. 空白トークンを含まない
4. ノード種別と子ノードの構造のみ表現する S 式
5. 識別子・リテラルの値は含む (構造のみではなく具体値も)

例 (TypeScript): tree-sitter の `node.toString()` から position 注釈を除去した S 式を使う。

```
(method_definition
  name: (property_identifier "createInvoice")
  parameters: (formal_parameters ...)
  body: (statement_block
    (if_statement
      condition: (parenthesized_expression (binary_expression ...))
      consequence: (statement_block (throw_statement ...)))))
```

### 5.2 計算式

```
syntax_input = <言語プラグインが生成した正規化 AST 文字列>
syntax = lower_hex(SHA-256(UTF-8(syntax_input))[0..6])
```

### 5.3 約束する不変条件

- 空白・改行・インデント変更 → 不変
- コメント追加・削除 → 不変

### 5.4 約束する変化条件

- 文の追加・削除 → 変化
- 識別子 rename → 変化 (`syntax` は意味ではなく構造ベースなので、識別子も構造の一部として扱う)
- リテラル変更 → 変化

### 5.5 syntax fingerprint の用途

主な用途は Diff レポートの **三段階表示**:

- `api unchanged, logic unchanged, syntax unchanged` → 完全不変、Diff に出さない
- `api unchanged, logic unchanged, syntax changed` → 実装リファクタのみ、low-priority
- `api unchanged, logic changed` → 意味変化、要レビュー
- `api changed` → 公開契約変化、要承認

`syntax changed` のみのシンボルは Diff レポートで折りたたみ表示にし、レビュー負荷を下げる。

### 5.6 grammar revision 依存 (重要)

`syntax` fingerprint は **言語プラグインが採用する parser grammar の minor アップデートで一斉に変化する**。
tree-sitter grammar はノード命名 (`property_identifier` → `member_property` 等) が日常的に変わるため、`pnpm update` だけで Aburi の全 Symbol が `syntax-changed` 化する。

これを防ぐため:

1. **言語プラグインは `grammarRevision` を IR に記録する**:
   各 IR 出力時に grammar の正確な版本を `generator.plugins[type=lang].grammarRevision` に記録。
   **形式は厳格固定**: `^[\w./@-]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$` (例: `tree-sitter-typescript@0.23.2`、`@oxc-project/parser@2.1.0+sha.abc123`)。
   manifest schema が format を validate する。plugin 作者の表記揺れによる「比較不能」を防ぐ。

2. **Diff 計算時に grammar revision 一致を確認する**:
   base と head の同一言語 plugin の `grammarRevision` を **文字列等値比較** する。一致しない場合、その言語の `syntax` fingerprint 差分は **意味を持たない** として扱う。
   ただし api/logic fingerprint は plugin の抽出ロジック経由なので、grammar 版本不一致時は警告として「**全 fingerprint 差分は plugin 版本差由来の可能性あり**」を diff レポート冒頭に表示する (api/logic 差分自体は通常通り出す)。
   - diff レポートで該当 Symbol を `syntax-only changed` セクションに出さない
   - `apiChanged: true` / `logicChanged: true` のシンボルは通常通り表示
   - grammar revision 不一致は diff レポート冒頭に警告として 1 行表示

3. **package.json の peerDependencies で grammar 版本を強制**:
   各 language plugin は対応 grammar 版本を peerDependencies で固定し、不整合 install を install 時に検出可能にする。

`api` / `logic` fingerprint は plugin 実装に依存しない計算規約 (§3, §4) で定義されているため grammar 版本に影響されない。`syntax` のみがこの考慮の対象。

## 6. Dropped シンボル

`Symbol.dropped == true` のシンボルは fingerprint の 3 軸すべて固定値:

```jsonc
{
  "api":    "000000000000",
  "logic":  "000000000000",
  "syntax": "000000000000"
}
```

これにより dropped シンボル同士の比較は常に「変化なし」となり、Diff レポートからも除外される。

## 7. 検証可能な性質 (テスト基準)

参照実装と全ての言語プラグインは以下のテストを pass しなければならない。

### 7.1 同一性

| ID | 入力 | 期待 |
|---|---|---|
| T1 | 同一 Symbol を 2 回計算 | api/logic/syntax すべて一致 |
| T2 | Symbol を canonical serialize → parse → recalculate | 一致 |

### 7.2 api 不変条件

| ID | 変更操作 | 期待 |
|---|---|---|
| A1 | `signature.inputs[].name` を変更 | api 不変 |
| A2 | 本体 (rules/effects) を変更 | api 不変 |
| A3 | decorator の並び順入れ替え (異なる decorator) | api 不変 |
| A12 | `Symbol.name` の class scope 部分のみ変更 (`Old.method` → `New.method`) | api 不変 |
| A13 | `language` を変更 (実運用では起きないが defensive) | api 不変 (`language` は入力に含めない) |

### 7.3 api 変化条件

| ID | 変更操作 | 期待 |
|---|---|---|
| A4 | `visibility` 変更 | api 変化 |
| A5 | `signature.outputs` に型追加 | api 変化 |
| A6 | `signature.throws` に型追加 | api 変化 |
| A7 | decorator の追加 | api 変化 |
| A8 | decorator の引数変更 (`@Post('/x')` → `@Post('/y')`) | api 変化 |
| A9 | `async` true ↔ false | api 変化 |
| A10 | `kind` 変更 (`function` → `method` 等) | api 変化 |
| A11 | `extKind` 変更 | api 変化 |
| A14 | `shortName` (last segment) 変更 | api 変化 |

### 7.4 logic 不変条件

| ID | 変更操作 | 期待 |
|---|---|---|
| L1 | rules/effects の文字列に出現しないローカル変数 rename | logic 不変 |
| L2 | コメント追加 | logic 不変 |
| L3 | 空白フォーマット変更 | logic 不変 |
| L4 | decoration (`console.log` など) の追加 | logic 不変 |
| L5 | decorator 変更 | logic 不変 |
| L11 | effect の `id` のみ変更 (target は同じ) — plugin 構成変更耐性 | logic 不変 |
| L12 | effect plugin の追加/削除/順序変更で同じ target が別 id に分類される | logic 不変 |

### 7.5 logic 変化条件

| ID | 変更操作 | 期待 |
|---|---|---|
| L6 | rules の順序入れ替え | logic 変化 |
| L7 | effects の順序入れ替え | logic 変化 |
| L8 | rule の condition 変更 | logic 変化 |
| L9 | effect の target 変更 | logic 変化 |
| L10 | effect の追加・削除 | logic 変化 |

### 7.6 syntax 不変条件

| ID | 変更操作 | 期待 |
|---|---|---|
| S1 | コメント追加 | syntax 不変 |
| S2 | 空白フォーマット変更 | syntax 不変 |

### 7.7 syntax 変化条件

| ID | 変更操作 | 期待 |
|---|---|---|
| S3 | 文の追加 | syntax 変化 |
| S4 | 識別子 rename | syntax 変化 |
| S5 | リテラル変更 | syntax 変化 |

### 7.7.1 各 language plugin が満たすべき syntax テスト基準

S1-S5 は各 language plugin が実装する `normalizeAst()` の責任範囲だが、**コア側は契約を試験できないため**、各 plugin は次のテストハーネスを提供しなければならない:

```js
// language plugin の test suite に必ず含める
describe('normalizeAst syntax fingerprint contract', () => {
  test('S1: コメント追加で syntax 不変', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { /* note */ return 1 }'));
    expect(a).toBe(b);
  });
  test('S2: 空白フォーマット変更で syntax 不変', () => {
    const a = normalizeAst(parseSnippet('function f(){return 1}'));
    const b = normalizeAst(parseSnippet('function f() {\n  return 1\n}'));
    expect(a).toBe(b);
  });
  test('S3: 文の追加で syntax 変化', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { const x = 0; return 1 }'));
    expect(a).not.toBe(b);
  });
  test('S4: 識別子 rename で syntax 変化', () => {
    const a = normalizeAst(parseSnippet('function f() { return x }'));
    const b = normalizeAst(parseSnippet('function f() { return y }'));
    expect(a).not.toBe(b);
  });
  test('S5: リテラル変更で syntax 変化', () => {
    const a = normalizeAst(parseSnippet('function f() { return 1 }'));
    const b = normalizeAst(parseSnippet('function f() { return 2 }'));
    expect(a).not.toBe(b);
  });
});
```

これを満たさない plugin は Aburi 公式 plugin registry に登録できない。サードパーティ plugin も推奨。

### 7.8 Dropped

| ID | 入力 | 期待 |
|---|---|---|
| D1 | `dropped: true` の Symbol | fingerprint すべて `"000000000000"` |
| D2 | 同じ AST が `dropped: true` / `false` で異なる扱い | 前者は zero、後者は通常計算 |

## 8. クロス実装互換性

異なる言語プラグイン実装が同じ結果を出すための前提:

- `api` / `logic` 計算は本ドキュメント §3 §4 で完全定義されているため、プラグイン非依存で再現可能
- `syntax` 計算は言語固有 (§5.1 参照)。同じ言語プラグインのバージョン内では再現可能
- プラグインのバージョンが上がって AST 抽出ルールが変わった場合、`syntax` は破壊的に変化しうる
  - `api` / `logic` も同じ Symbol に対して変化しうる (抽出粒度が変わるため)
  - これは新しい言語プラグインバージョンへのアップグレード時の trade-off

## 9. 参照実装ポイント

JavaScript/TypeScript 実装の擬似コード:

```js
import { createHash } from 'node:crypto'

export function lastSegment(qname) {
  // §3.3 — :: 優先、次に .
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
    // language は除外: Symbol.id の <language>: プレフィックスで分離済
  })
}

export function logicFingerprint(sym) {
  return hash({
    effects: sym.effects.map(e => ({ target: canonical(e.target) })),  // id は除外 (§4.5)
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
