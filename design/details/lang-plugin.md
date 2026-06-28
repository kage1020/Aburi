# 言語プラグイン IF

Aburi の抽出パイプラインに新しい言語を追加するためのプラグインインタフェース定義。
1 つの言語プラグインは 1 つの `language` id (例: `ts` / `py` / `go`) を担当し、ソース文字列から Symbol 候補と AST メタデータを生成する。

参照:
- [`ir-schema.md`](ir-schema.md) — 生成すべき Symbol の構造
- [`fingerprint.md`](fingerprint.md) §5 — syntax fingerprint への入力規約
- [`extension-vocab.md`](extension-vocab.md) — マニフェスト・vocab 登録
- [`drop-list.md`](drop-list.md) — どこから drop が掛かるか

---

## 1. 目的

抽出パイプラインを言語非依存に保ちつつ、各言語の AST 形状・命名規約・構文糖衣に対応する。

コア (`@aburi/core`) は言語を一切知らない。Symbol という共通形に正規化されたものを受け取り、効果分類・装飾削除・fingerprint 計算・diff 計算を行う。

## 2. プラグインの責務

### 2.1 やること

- 自言語のファイル拡張子を宣言する
- ソースを parse して内部 AST を持つ
- AST から **Symbol 候補** を全件抽出する (drop 判定はコアの仕事だが、判定材料を全部提供する)
- 各 Symbol の Signature・Decorator・Visibility・SourceRange・qualified name・derivedBy (言語レベル) を抽出する
- Symbol 本体を walk して **Rule** と **call_expression** を抽出する
- 各 Symbol について **正規化 AST 文字列** (syntax fingerprint 入力) を生成する
- import 文を抽出して `ImportEdge[]` として返す
- 自言語固有の **File-level / Symbol-level drop hint** をコアに通知する

### 2.2 やらないこと

- effect の分類 ( = effect plugin の責務)
- decorator の boundary 判定 ( = framework plugin の責務)
- `Symbol.fingerprint.api` / `.logic` 計算 ( = コアが正規化済み IR から計算)
- `Symbol.fingerprint.syntax` の hash 計算 ( = コアが plugin の文字列出力を hash する)
- config.suppress / config.keep の適用 ( = コアが drop list 評価時に行う)
- 呼び出し解決 (`calls[].resolved` の埋め込み)
- 多言語跨ぎの Dependency 構築 (コアが import edge から構築)
- Markdown projection 生成

責務を狭く保つことで、新言語追加は AST 抽出だけに集中できる。

## 3. ライフサイクル

```
1. registry が manifest を validate して load
2. ctx (registry/config) を渡して plugin.init() を呼ぶ
3. 言語にマッチするファイルごとに:
     a. plugin.parseFile(file) → ParseResult { tree, errors, imports }
     b. plugin.extractSymbols(tree, ctx) → SymbolCandidate[]
     c. 各 SymbolCandidate について:
          plugin.walkBody(symbol, ctx) → BodyExtraction { rules, calls, returns }
          plugin.normalizeAst(symbol) → string  (syntax fingerprint 入力)
4. 全ファイル終了後 plugin.cleanup?() を呼ぶ
```

コアは効果分類・drop list 適用・fingerprint 計算をその後に行う。

## 4. インタフェース

実型は `@aburi/core` の `types` パッケージで定義する。本ドキュメントは契約としてのシグネチャを示す。

### 4.1 `LanguagePlugin`

```ts
interface LanguagePlugin {
  manifest: PluginManifest                     // type: "lang"

  // ファイルマッチング (extension のみ、glob ではない)
  fileExtensions: string[]                     // e.g. [".ts", ".tsx", ".mts", ".cts"]

  // capabilities (§6)
  capabilities: LanguageCapabilities

  // ライフサイクル
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  // 抽出
  parseFile(file: SourceFile): Promise<ParseResult>
  extractSymbols(tree: ParsedTree, ctx: ExtractionContext): SymbolCandidate[]
  walkBody(symbol: SymbolCandidate, ctx: WalkContext): BodyExtraction
  normalizeAst(symbol: SymbolCandidate): string

  // ファイル/シンボル単位の drop hint (オプション)
  fileDropPatterns?: string[]                  // 自言語固有の glob (例: ["**/*.d.ts"])
  symbolDropHint?(symbol: SymbolCandidate, ctx: ExtractionContext): DropHint | null
}
```

### 4.2 `SourceFile` / `ParseResult`

```ts
interface SourceFile {
  path: string                                 // workspace-relative POSIX
  content: string                              // UTF-8
}

interface ParseResult {
  tree: ParsedTree                             // plugin 内部型 (opaque)
  errors: ParseError[]
  imports: ImportEdge[]
}

interface ParseError {
  message: string
  line: number                                 // 1-based
  column: number                               // 1-based
  recoverable: boolean                         // false → コアはこのファイルをスキップ
}

interface ImportEdge {
  source: string                               // 文字列そのまま (例: "@billing/domain", "./util")
  symbols: string[] | '*'                      // 名前付き import のシンボル名、または "*"
  line: number
  dynamic: boolean                             // import() なら true
}
```

### 4.3 `SymbolCandidate`

```ts
interface SymbolCandidate {
  // IR Symbol の前段。drop 判定前の全件
  id: string                                   // <language>:<file>#<qname>
  kind: SymbolKind                             // ir-schema §5.1 enum
  extKind: string | null                       // §5.2 (plugin 自身が宣言したものから選ぶ)
  name: string                                 // qualified name
  visibility: Visibility
  decorators: Decorator[]
  signature: Signature | null
  source: SourceRange
  derivedBy: string[]                          // 言語レベル根拠 (例: ["export-keyword"])

  // walkBody / normalizeAst に渡す内部ハンドル
  bodyNode: OpaqueAstNode | null
  fullNode: OpaqueAstNode                      // signature + body
}
```

`extKind` を plugin が宣言したものから選ぶ場合、選んだ値は manifest.provides.extKinds または extKindPrefixes 配下でなければならない。違反は registry が起動時に検出する。

### 4.4 `BodyExtraction`

```ts
interface BodyExtraction {
  rules: Rule[]                                // ir-schema §8
  calls: CallCandidate[]                       // 効果分類前の生 call
}

interface CallCandidate {
  target: string                               // callee の文字列表現 (空白正規化前)
  line: number
  argumentCount: number                        // effect plugin が必要に応じて参照
  inAwait: boolean                             // await 配下なら true
  inNew: boolean                               // new 式なら true
  literalArgs: (string | null)[]               // 各引数のリテラル値 (リテラルでなければ null)
}
```

walkBody は **trivial return を rules に出さない** (drop-list §5.3-5.5)。
`return foo()` のような call-only return は call は CallCandidate に入れ、Rule には入れない。

### 4.5 `ExtractionContext` / `WalkContext`

```ts
interface ExtractionContext {
  file: SourceFile
  registry: VocabRegistry                      // ext-vocab §7
  config: AburiConfig
}

interface WalkContext extends ExtractionContext {
  symbol: SymbolCandidate
}
```

### 4.6 `DropHint`

```ts
interface DropHint {
  reason: string                               // ir Symbol.dropReason に直接入る
  category: 'B' | 'C'                          // drop-list §2 のカテゴリ
}
```

例: TypeScript の `export type X = Y` には `{ reason: "type alias", category: "B" }` を返す。

### 4.7 `PluginContext`

```ts
interface PluginContext {
  registry: VocabRegistry
  config: AburiConfig
  workspaceRoot: string                        // 絶対パス (plugin が parser 初期化に使う)
  log: Logger
}
```

## 5. 他プラグインとの協調

### 5.1 Effect plugin との協調

言語プラグインは `CallCandidate[]` を返すまでが仕事。コアが各 call に対して効果プラグインに順次問い合わせ、最初に `EffectClassification` を返したプラグインの結果を採用する。

- 全 effect plugin が null を返した call → `Symbol.calls[]` に残る (target/line/resolved=null)
- ある effect plugin が分類した call → `Symbol.effects[]` に入り、`Symbol.calls[]` には入らない (ir-schema §9.3)

詳細インタフェースは [`effect-plugin.md`](effect-plugin.md) (D3) を参照。

### 5.2 Framework plugin との協調

言語プラグインは Decorator を **raw 文字列・arguments・name** まで抽出する。`boundary` フラグはコアが framework plugin に問い合わせて埋める。

#### 5.2.1 Framework plugin の first-match-wins

複数 framework plugin が config に enable されている場合、効果プラグインと同様 **config 順で first-match-wins** ([`effect-plugin.md`](effect-plugin.md) §5.1 と同規約):

- 各 SymbolCandidate を config 順に framework plugin の `classifySymbol` に渡す
- 最初に non-null を返した plugin の結果を採用 (extKind / boundary 修正等)
- それ以降の plugin はスキップ

これにより「同じ class が NestJS Controller と Custom Framework Controller の両方として認識される」のような曖昧状態を避ける。プロジェクトで競合する場合は config 順で優先制御。

framework plugin は次の入力を受ける:
- `SymbolCandidate` (decorators 含む)
- 所属 component の framework 宣言

それに対し:
- `decorator.boundary` の上書き
- `Symbol.extKind` の埋め込み (例: `framework:nestjs:controller`)
- Category B drop の除外 hint (`@Module` だけの class は pure DTO 扱いしない等)

詳細インタフェースは将来の `framework-plugin.md` を参照 (本ドキュメントでは契約面のみ予約)。

### 5.3 抽出順序

```
plugin.parseFile()                              [lang]
  ↓
plugin.extractSymbols()                         [lang]
  ↓
framework plugin の classifySymbol()            [framework]
  ↓
plugin.walkBody()                               [lang]
  ↓
各 call について effect plugin の classify()    [effects]
  ↓
plugin.normalizeAst()                           [lang]
  ↓
コアが drop list 適用 / fingerprint 計算 / IR 組み立て
```

## 6. Capabilities

`LanguageCapabilities` は plugin が「自言語で何が表現可能か」を宣言する flag セット。コアと他プラグインが分岐に使う。

```ts
interface LanguageCapabilities {
  hasDecorators: boolean
  hasGenerics: boolean
  hasAsync: boolean
  hasMacros: boolean
  hasPatternMatching: boolean
  hasAbstractTypes: boolean                    // abstract class / trait / interface
  hasModules: boolean                          // ES module / Python module / Go package
  hasNamespaces: boolean                       // TS namespace / C# namespace
  hasTypeParameters: boolean
  hasExplicitVisibility: boolean               // public/private キーワード
  hasJsDoc: boolean                            // JSDoc / docstring 等
}
```

実行時リソース予算 (`wasmHeapPerWorkerMB`) は runtime IF ではなく **plugin manifest の `capabilities`** が source-of-truth。CLI は manifest を読んで concurrency を制御するため、runtime に重複させない (§8.1 / cli-spec.md §11 参照)。

framework plugin が `hasDecorators: false` の言語に対して decorator-based 抽出を要求すると、コアが起動時にエラーで止める。

## 7. エラー処理

### 7.1 Parse error

- `recoverable: true` → コアは Symbol 抽出に進む (tree-sitter は通常 recoverable)
- `recoverable: false` → ファイルを skip、stats.parsedFiles から除外、warning log

### 7.1.1 大ファイル skip

ファイルサイズが `config.maxFileSizeBytes` (default: `2 * 1024 * 1024` = 2MB) を超えるファイルは parse せず skip。

- 通常コードは 2MB を超えない (超えるのは generated bundle / minified)
- 大ファイルは WASM heap を食い潰す + parse 時間爆発
- skip ファイルは `stats.skippedFiles[]` (v0.2 で追加予定、v0.1 では warning のみ) に記録
- warning stderr: `Skipped <file>: <size>MB exceeds maxFileSizeBytes (2MB). Override with config.maxFileSizeBytes.`

### 7.1.2 タイムアウト

1 ファイルの parse + extractSymbols + walkBody 合計が `config.parseTimeoutMs` (default: `5000` = 5 秒) を超える場合は abort、当該ファイル skip + warning。
壊れた grammar や病的なソース (深い nesting 等) で全体が止まるのを防ぐ。

### 7.2 抽出例外

- `extractSymbols` / `walkBody` / `normalizeAst` が throw → 該当ファイル全体を skip、warning log
- 抽出パイプライン全体は止めない (1 ファイルのバグで全 IR 生成が止まる事故を防ぐ)
- ただし `--strict` フラグで「最初のエラーで停止」可能

### 7.3 Manifest 違反

- plugin が manifest に宣言していない `extKind` を SymbolCandidate に入れる → 抽出時エラー (drop-list §6.3 / extension-vocab §6.3)
- `--discover` モード時は警告に降格 (extension-vocab §11.5)

### 7.4 言語非対応の構文

- 例: TS plugin が未知の構文要素 (将来の TS 言語拡張) に遭遇 → SymbolCandidate を作らずスキップ、debug log
- これは error ではない (新構文の段階的サポートのため)

## 8. パーサ実装の選択肢

言語プラグインはパーサを自由に選んでよい。条件は次を満たすこと:

- ノード単位で位置情報 (line/column) を取得できる
- 部分的なパース失敗から回復可能 (推奨)
- ノード種別を区別可能 (statement / expression / declaration の分類)
- 言語の **構文糖衣を展開しない**生 AST にアクセスできる (`async function` を `function` + flag に潰さない、等)

代表的選択肢:

| パーサ | 適用 | 備考 |
|---|---|---|
| tree-sitter (WASM) | 多言語 | grammar 豊富、recoverable、Aburi 公式言語プラグインの第一選択 |
| tree-sitter (native) | 多言語 | WASM より高速だが node-gyp ビルド必要 |
| oxc-parser | TS/JS | tree-sitter より高速、TS 専用 |
| ast-grep | 多言語 | tree-sitter ベース、パターン記述が容易 |
| swc | TS/JS | Rust 製、TS 専用 |
| ruff (内部 AST) | Python | Rust 製、AST 公開 API は限定的 |
| go/parser | Go | 標準ライブラリ |
| syn | Rust | proc-macro 経由のみ、CLI 単独利用は重い |

公式 plugin の `@aburi/lang-typescript` は **tree-sitter WASM** を初期実装に採用する (PoC で動作実証済み、Windows での zero-build が利点)。後続バージョンで oxc-parser への置換を検討。

### 8.1 WASM パーサのメモリ管理規約

`web-tree-sitter` などの WASM パーサは Node ヒープと別の WASM heap を持ち、parser インスタンスを明示解放しないと数千ファイル parse で `RangeError: WebAssembly.Memory()` で落ちる既知問題がある。

各 plugin は以下の規約に従う:

1. **parser インスタンスはファイル単位で作成・解放する**
   - `parseFile()` 内で parser を生成し、結果取得後に `parser.delete()` を呼ぶ
   - file scope で生存する `tree` も `tree.delete()` で解放
   - `extractSymbols()` / `walkBody()` で使う中間 node 参照は `parseFile()` のスコープ内で完結させる
2. **並列実行時の WASM heap 予算**
   - plugin manifest の `capabilities.wasmHeapPerWorkerMB` (range: 16–4096 MiB、未宣言時の暗黙デフォルト 256 MiB) が source-of-truth
   - コアは `--concurrency` 上限を `min(指定値, floor(availableMemoryMB / wasmHeapPerWorkerMB))` で抑制する
   - 同じ run に複数 lang plugin が混在する場合、各 plugin の宣言値の **最大** を採用する (もっとも食う lang に合わせる)
3. **native binding fallback の予約**
   - v0.2 以降に `capabilities.preferNative` 等のフラグで native binding (e.g., `tree-sitter` Node bindings) への切り替えを追加可能
   - v0.1 は WASM のみ実装、native fallback は未提供

## 9. 検証可能な性質 (テスト基準)

各言語プラグインは以下のテストを pass しなければならない。

### 9.1 構造抽出

| ID | 入力 | 期待 |
|---|---|---|
| LP1 | top-level function | SymbolCandidate.kind = "function", name = 関数名 |
| LP2 | class | SymbolCandidate.kind = "class", name = クラス名 |
| LP3 | class method | SymbolCandidate.kind = "method", name = `Class.method` |
| LP4 | class static method | name = `Class::method` |
| LP5 | interface (TS/Java/Go) | SymbolCandidate.kind = "interface" |
| LP6 | default export of anonymous function | name = `<default>` |
| LP7 | `const f = () => ...` | name = `f` (変数名を qname に) |
| LP8 | nested class (`Outer.Inner.method`) | name の `.` ネストが正しい |

### 9.2 Signature 抽出

| ID | 入力 | 期待 |
|---|---|---|
| LP9 | `async function f()` | signature.async = true |
| LP10 | `function* g()` | signature.generator = true |
| LP11 | `f(a: number, b: string): boolean` | inputs = [{name:"a",type:"number"},{name:"b",type:"string"}], outputs = ["boolean"] |
| LP12 | `function f<T>()` | typeParameters = ["T"] |
| LP13 | `function f() { throw new MyError() }` | throws = ["MyError"] |

### 9.3 Decorator 抽出 (decorator がある言語)

| ID | 入力 | 期待 |
|---|---|---|
| LP14 | `@Post('/x') method()` | decorators[0] = { name: "Post", raw: "Post('/x')", arguments: ["'/x'"], boundary: <framework が判定>, line: ... } |
| LP15 | 装飾子 2 つ | decorators[] に line 昇順で 2 件 |

### 9.4 Body walk

| ID | 入力 | 期待 |
|---|---|---|
| LP16 | `if (x) throw new E()` | rules に guard + throw |
| LP17 | `return 1` | rules に return なし (trivial) |
| LP18 | `return foo()` | rules に return なし、calls に foo |
| LP19 | `return a + b` | rules に return (expr: "a + b") |
| LP20 | `for (let i...) ...` | rules に loop (loopKind: "for") |

### 9.5 normalizeAst

| ID | 入力 | 期待 |
|---|---|---|
| LP21 | コメントだけ違うコード | normalizeAst が同一文字列 |
| LP22 | 空白だけ違うコード | normalizeAst が同一文字列 |
| LP23 | 識別子が違うコード | normalizeAst が別文字列 |

### 9.6 Import 抽出

| ID | 入力 | 期待 |
|---|---|---|
| LP24 | `import { X } from './y'` | imports = [{source: "./y", symbols: ["X"], line: 1, dynamic: false}] |
| LP25 | `import * as Y from 'z'` | imports = [{source: "z", symbols: "*", line: 1, dynamic: false}] |
| LP26 | `await import('./x')` | imports = [{source: "./x", symbols: "*", dynamic: true}] |

### 9.7 エラー復旧

| ID | 入力 | 期待 |
|---|---|---|
| LP27 | 構文エラーを含むファイル | recoverable error を返す、可能な限り Symbol を抽出 |
| LP28 | 完全に壊れたファイル | 非 recoverable error を返す、core が skip |

## 10. 設計上の決定事項

### 10.1 効果分類を plugin の責務から外す理由

言語プラグインに効果分類を持たせると、`@aburi/lang-typescript` が Prisma/Drizzle/Stripe など何百もの呼び出しパターンを知る必要が出る。責務膨張を避けるため、**言語プラグインは構造を、効果プラグインは識別子パターンを** という分離を徹底する。

### 10.2 Drop 判定の最終決定を plugin から外す理由

drop list (D8) は config / 他 plugin の入力を統合して評価する。言語プラグインは「これは type alias だ」という事実だけを `DropHint` として通知し、最終的に drop するかどうかはコアが決める。

### 10.3 Fingerprint の hash 計算を plugin から外す理由

fingerprint の一貫性 ([fingerprint.md](fingerprint.md) §8) はクロス言語で保証する必要がある。SHA-256 / 12-hex 切り出し / canonical JSON は **コア 1 箇所で実装** し、plugin は normalize された文字列を返すだけにする。

### 10.4 ImportEdge を plugin から得る理由

import 文の構文は言語ごとに大きく違う (TS の `import`, Python の `from X import Y`, Go の `import (...)`)。コアが各言語の import を直接理解するのは負担が大きく、plugin に委ねる。

### 10.5 `extractSymbols` と `walkBody` を分ける理由

抽出は 2 段階:
1. シンボル候補一覧を出す (framework plugin がここで extKind hint を返せる)
2. 各シンボル本体を walk (extKind が決まった後に walk する必要があるため)

framework plugin が extKind を決めた後、その情報に依存して walkBody の挙動を変えたいケース (例: NestJS Controller の場合は @Body 引数を特別扱い) に備える。

### 10.6 `normalizeAst` を別関数にした理由

syntax fingerprint 計算は IR 組み立てとは独立した工程。drop されたシンボルでは normalizeAst を呼ばない (D4 §6)。明示的に分けることでオーバーヘッドを最小化する。
