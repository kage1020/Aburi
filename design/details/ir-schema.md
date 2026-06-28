# IR Schema (`aburi.ir.v1`)

Aburi が出力する中間表現 (Intermediate Representation) のスキーマ定義。
JSON Schema は `schema/aburi.ir.v1.json` を単一の真実とし、本ドキュメントは設計判断の根拠を述べる。

---

## 1. ファイル形式と整列

- フォーマット: JSON (UTF-8、LF)
- インデント: 2 space (デフォルト)、`--compact` で 1 行
- トップレベルキー: アルファベット昇順
- 配列の並び (差分安定性のため固定):
  - `components[]`: `id` 昇順
  - `symbols[]`: `id` 昇順
  - `dependencies[]`: (`from`, `to`, `via`) 辞書順
  - Symbol 内の `decorators[]` / `rules[]` / `effects[]` / `calls[]`: `line` 昇順 (同一行は出現順)

整列規約は **差分安定性の前提条件**。配列順による偽の差分が出てはならない。

## 2. トップレベル構造 (Document)

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.ir.v1.json",  // 必須
  "generator": {                              // 必須
    "name": "aburi",
    "version": "1.0.0",
    "plugins": [                               // 必須・全 plugin (lang/framework/effects) を記録
      { "name": "lang-typescript",  "type": "lang",      "version": "1.0.0", "grammarRevision": "tree-sitter-typescript@0.23.2" },
      { "name": "framework-nestjs", "type": "framework", "version": "1.0.0", "grammarRevision": null },
      { "name": "effects-prisma",   "type": "effects",   "version": "1.0.0", "grammarRevision": null }
    ]
  },
  "generatedAt": "2026-06-19T15:30:00Z",      // 任意 (--no-timestamp で省略可)
  "workspace": {                              // 必須
    "root": ".",
    "managers": [                             // 必須 (空配列可)
      { "tool": "pnpm", "roots": ["packages/*", "apps/*"] }
    ],
    "languages": ["ts"]                       // 必須 (lang plugin 宣言の短形 id、例: ts/tsx/py/go/rs)
  },
  "components": [ /* Component[] */ ],        // 必須
  "symbols": [ /* Symbol[] */ ],              // 必須
  "dependencies": [ /* Dependency[] */ ],     // 必須
  "stats": {                                  // 必須
    "totalFiles": 18,
    "parsedFiles": 18,
    "keptSymbols": 27,
    "droppedSymbols": 7
  }
}
```

- `$schema`: 上位 URL。IDE の JSON Schema 解決と統合検証に使う
- `generatedAt`: 出力者の運用情報。**fingerprint 計算からは除外**。IR をコミットして diff を取る運用では `--no-timestamp` で省略する
- `workspace.root`: 常に `"."`。絶対パスを書かない (IR の可搬性)
- `workspace.managers[].tool`: ランタイム非依存の文字列。代表値は `pnpm`/`npm`/`yarn`/`bun`/`uv`/`poetry`/`pip`/`cargo`/`go`/`mvn`/`gradle`/`hatch`/`pixi`。未知値も拒否しない (新ツール追加時に scheme 改訂を不要にするため)
- `stats`: 人間/CI ログ向け。fingerprint から除外

## 3. Symbol ID 規約

### 3.1 形式

```
<language>:<file-path>#<qualified-name>
```

- `<language>`: 言語プラグインが宣言する識別子 (`ts`, `tsx`, `js`, `py`, `go`, `rs`, ...)
- `<file-path>`: workspace root からの POSIX パス (forward slash 強制)
- `<qualified-name>`: ファイル内で一意な命名

### 3.2 qualified name の組み立て

| シンボル | qualified name |
|---|---|
| top-level function / const / var | `createInvoice` |
| class | `InvoiceService` |
| インスタンスメソッド | `InvoiceService.createInvoice` |
| static メソッド | `InvoiceService::fromJson` |
| nested namespace / class | `Billing.Invoice.create` |
| interface / type alias | `Invoice` |
| default export (匿名関数/クラス含む) | `<default>` |
| 変数代入された関数/クラス式 | 変数名を qname に (例: `const handler = () => ...` → `handler`) |

### 3.3 匿名シンボルの扱い

独立した Symbol エントリにしない。コールバック・即時関数式・無名関数引数は **親 Symbol の `calls` / `effects` / `rules` に吸収** する。位置情報に依存する ID (`<anon@L42>` の類) は使用しない (差分安定性を損なうため)。

例外は §3.2 の `<default>` と「変数代入された関数式」のみ。これらは命名された entry point なので Symbol を持つ。

### 3.4 ID の安定性

- 同じ入力に対して同じ Aburi バージョンが生成する ID は完全一致
- 引数名・ローカル変数名の変更で ID は変わらない
- ファイル移動で ID は変わる (`<file-path>` 部分が変わる) → Diff アルゴリズムが git rename + fingerprint マッチで `moved` ステータスを付与

## 4. Component

monorepo の論理境界。物理 package とは独立。

```jsonc
{
  "id": "billing",                            // 必須・一意・ASCII kebab-case
  "name": "Billing",                          // 必須・人間向けラベル
  "roots": ["apps/billing", "packages/billing-domain"],  // 必須・POSIX 相対
  "publicApi": [                              // 任意
    "apps/billing/src/routes/**",
    "ts:packages/billing-domain/src/index.ts#Invoice"
  ],
  "languages": ["ts"],                        // 必須・短形 lang id
  "frameworks": ["nestjs"],                   // 任意
  "description": null                         // 任意
}
```

- `id` は URL/CLI 引数で扱えるよう ASCII kebab-case 固定
- `publicApi` の要素は **glob** または **symbol id**
- Component の物理境界推定はパッケージマネージャ設定 (`pnpm-workspace.yaml`, `turbo.json`, `go.work`, `Cargo.toml` workspace, `pyproject.toml`/uv workspaces 等) を自動読みする (詳細は別ドキュメント `component-detect.md`)

## 5. Symbol

レビュー単位の中核エンティティ。

```jsonc
{
  "id": "ts:apps/billing/src/InvoiceService.ts#InvoiceService.createInvoice",  // 必須
  "kind": "method",                           // 必須・enum §5.1
  "extKind": null,                            // 任意・言語拡張 §5.2
  "name": "InvoiceService.createInvoice",     // 必須・qualified name
  "language": "ts",                           // 必須・短形 lang id (例: ts / tsx / py / go / rs)
  "component": "billing",                     // 任意 (null = component 外)
  "visibility": "public",                     // 必須・enum §5.3
  "decorators": [ /* Decorator[] */ ],        // 必須
  "signature": { /* Signature */ },           // 任意 (null = signature 不在)
  "rules": [ /* Rule[] */ ],                  // 必須
  "effects": [ /* Effect[] */ ],              // 必須
  "calls": [ /* Call[] */ ],                  // 必須
  "source": { /* SourceRange */ },            // 必須
  "fingerprint": { /* Fingerprint */ },       // 必須
  "confidence": "high",                       // 必須・enum §5.4
  "derivedBy": ["framework:nestjs:controller", "branch-condition"],  // 必須
  "dropped": false,                           // 必須
  "dropReason": null                          // 必須・dropped=true なら non-null
}
```

### 5.1 `kind` (コア enum)

`"function" | "method" | "class" | "interface" | "type" | "const" | "module" | "namespace" | "variable" | "enum" | "constructor"`

コア enum 外は `extKind` で表現する。consumer は未知の `kind` を受け取った場合エラーとして良い (= 厳格 enum)。

### 5.2 `extKind` (言語拡張)

`null` または `<namespace>(:<segment>)+` 形式の string。最低 2 段、任意で多段。namespace は言語/パラダイム識別子:

| namespace | 例 | 担当プラグイン |
|---|---|---|
| `fp:*` | `fp:match`, `fp:adt`, `fp:effect` | 関数型言語プラグイン |
| `oop:*` | `oop:abstract`, `oop:trait` | OOP 拡張プラグイン |
| `meta:*` | `meta:macro`, `meta:proc-macro` | マクロ言語プラグイン |
| `framework:*` | `framework:nestjs:guard`, `framework:react:hook` | フレームワークプラグイン |

`extKind` が non-null のとき `kind` には最も近いコア種別を入れる (`extKind: "fp:match"` のとき `kind: "function"`)。コア語彙のみを読む consumer は `extKind` を無視できる。

### 5.3 `visibility` (enum)

`"public" | "private" | "protected" | "internal" | "package"`

- `public`: 明示的 export または public 修飾子
- `private` / `protected`: クラス内可視性そのまま
- `internal`: workspace 公開だが外部には出さない
- `package`: monorepo package 公開だが component 外には公開しない

### 5.4 `confidence` (enum)

`"high" | "medium" | "low"`

判定基準:

| 値 | 判定基準 |
|---|---|
| `high` | AST 上で明示的 (export 修飾子・throw 文・if 文)、または framework/effect プラグインが明示宣言 |
| `medium` | 識別子マッチ (`prisma.invoice.create` から `db.write` を推論)、命名規約 (`*Service`, `*Controller`) からの判定 |
| `low` | ヒューリスティック (シンボル接続量・ファイル位置のみが根拠) |

`low` のシンボルは Markdown projection でバッジ表示し、レビュアーが「機械の自信なし」を明確に知れるようにする。

### 5.5 `derivedBy` (根拠)

このシンボルがなぜこの形で抽出されたかを示す string 配列。次のいずれかの形:

- `<rule>` — コアの抽出ルール (`branch-condition`, `throw-statement`, `export-keyword`)
- `framework:<name>:<role>` — フレームワークプラグインによる判定 (`framework:nestjs:controller`)
- `effects-plugin:<name>:<action>` — 効果プラグインによる判定 (`effects-plugin:prisma:write`)
- `convention:<name>` — 命名/構造規約による判定 (`convention:service-suffix`)

空配列は「コア抽出パスの自動拾い上げ」を意味する。

### 5.6 `dropped`

- `false` (default): IR 出力対象
- `true`: 装飾と判定されたが、何が落とされたかの透明性のために残す

`dropped: true` のシンボルは `rules`/`effects`/`calls`/`fingerprint` を規定値 (空配列 / 全 fingerprint = "0"*12) にする。Markdown projection では `## Dropped` セクション (折りたたみ) に集約表示する ([markdown-projection.md](markdown-projection.md) §3.6 参照)。`aburi explain` では full 詳細を出す。`dropReason` は人間可読の短文 (例: `"pure DTO"`, `"logger boilerplate"`, `"generated file"`)。

## 6. Decorator

```jsonc
{
  "name": "Post",                             // 必須
  "raw": "Post('/invoices')",                 // 必須・原文
  "arguments": ["'/invoices'"],               // 必須・引数の文字列表現
  "boundary": true,                           // 必須
  "line": 14                                  // 必須
}
```

`boundary: true` の判定は framework プラグインが行う。Aburi コアは決め打ちしない。

## 7. Signature

```jsonc
{
  "inputs": [
    { "name": "createInvoiceDto", "type": "CreateInvoiceDto" }
  ],
  "outputs": ["Promise<Invoice>"],
  "throws": ["CreditLimitExceeded"],
  "async": true,
  "generator": false,
  "typeParameters": []
}
```

- `type` は AST 上で読み取れた文字列表現。型解決はしない (LSP enrichment が任意に正規化する)
- `throws` は明示的 throw 文 + JSDoc `@throws` を併用
- Symbol の `signature` 全体が `null` 可 (class 本体や interface 全体)

## 8. Rule

制御フロー上の意味のある分岐・例外・繰り返し・複合 return。

```jsonc
{
  "type": "guard",                            // 必須・enum §8.1
  "line": 58,                                 // 必須
  "condition": "customer.creditLimit < invoice.total",  // type=guard/switch/match のみ
  "what": null,                               // type=throw のみ
  "expr": null,                               // type=return のみ
  "loopKind": null                            // type=loop のみ ("for"|"while"|"do")
}
```

### 8.1 `type` (enum)

`"guard" | "throw" | "return" | "loop" | "try" | "switch" | "match"`

- `guard`: `if` 文で early return / throw / continue を含むもの
- `throw`: throw 文
- `return`: trivial 以外の return (trivial 判定は `drop-list.md`)
- `loop`: for / while / do
- `try`: try-catch (catch 本体の rules は同 Symbol の rules に展開しない)
- `switch`: switch 文
- `match`: パターンマッチ (`extKind: "fp:match"` シンボルのみで使用)

### 8.2 抽出規約

- 同じ AST ノードが複数 Rule にならない
- `condition`/`what`/`expr` は空白正規化済み (連続空白を 1 個に圧縮、改行除去、120 文字超は末尾 `...`)
- 単純な `return x` / `return true` 等は Rule にしない (含むかどうかは `drop-list.md` の trivial 判定に従う)

## 9. Effect

副作用の検出結果。

```jsonc
{
  "id": "db.write",                           // 必須・effect tag §9.1
  "target": "prisma.invoice.create",          // 必須・callee 文字列
  "line": 75,                                 // 必須
  "plugin": "effects-prisma",                 // 必須・検出元
  "confidence": "high"                        // 必須・Symbol と同じ enum
}
```

### 9.1 コア効果語彙

`namespace:action` 形式の固定セット。どの runtime/言語でも普遍に成立する概念のみ。

| カテゴリ | 値 |
|---|---|
| `db.*` | `db.read`, `db.write`, `db.transaction`, `db.migration` |
| `network.*` | `network.http`, `network.ws`, `network.rpc` |
| `queue.*` | `queue.publish`, `queue.consume` |
| `event.*` | `event.publish`, `event.subscribe` |
| `fs.*` | `fs.read`, `fs.write` |
| `state.*` | `state.mutate`, `collection.mutate` |
| `time.*` | `time.now`, `time.timer` |
| `random` | `random` |
| `env.*` | `env.read`, `env.write` |
| `process.*` | `process.exit`, `process.signal` |

このセットはスキーマバージョン `aburi.ir.v1` 内で追加のみ可、削除/意味変更不可。

### 9.2 プラグイン拡張効果

特定 runtime/ライブラリ/ドメインに固有の効果は `x-<plugin>:<action>` プレフィックスでプラグイン側が宣言する。

例:
- `x-stripe:charge`
- `x-s3:upload`
- `x-nest:lifecycle.on-module-init`
- `x-auth:permission-check`
- `x-react:state-update`

consumer は未知の `x-` 効果を許容し、Markdown projection ではプレフィックスごとセクション化する。

### 9.3 Effect と Call の住み分け

ある call_expression が効果プラグインに認識された場合は `effects[]` のみに載せ、`calls[]` には載せない。重複出力しない。

## 10. Call

効果に該当しない呼び出し。

```jsonc
{
  "target": "pricing.calculateTotal",         // 必須
  "line": 70,                                 // 必須
  "resolved": null                            // 任意・解決済み symbol id
}
```

`resolved` は呼び出し解決機能 (別ドキュメント) が埋める。未解決時は `null`。

## 11. Dependency

シンボル間/コンポーネント間のエッジ。

```jsonc
{
  "from": "billing",                          // 必須・symbol id か component id
  "to":   "pricing",
  "via":  "import",                           // 必須・enum
  "direction": "outbound",                    // 必須・enum
  "effect": null                              // 任意・関連 effect tag
}
```

### 11.1 `via` (enum)

`"import" | "call" | "inherit" | "implement" | "compose" | "http" | "event" | "sql"`

### 11.2 `direction` (enum)

`"outbound" | "inbound" | "bidirectional"`

`from` から見た方向。`bidirectional` は双方向 RPC 等限られた場合のみ。

## 12. SourceRange

```jsonc
{
  "file": "apps/billing/src/InvoiceService.ts",  // 必須・POSIX 相対
  "startLine": 42,                            // 必須・1-based
  "endLine": 91,                              // 必須
  "startColumn": null,                        // 任意・1-based
  "endColumn": null                           // 任意
}
```

`startColumn` / `endColumn` は LSP enrichment 時に埋まる。

## 13. Fingerprint

```jsonc
{
  "api": "9ee77913af43",                      // 必須・12 hex
  "logic": "7ecf8c1cebe7",                    // 必須・12 hex
  "syntax": "a3f2e1d0c9b8"                    // 必須・12 hex
}
```

正確な計算式は別ドキュメント `fingerprint.md` を参照。本ドキュメントでは「3 つの 12-hex 文字列を持つ」「fingerprint 計算は `generatedAt` / `stats` / 配列順以外の noise を含めない」とのみ規定。

3 軸の役割:

| 軸 | 変化条件 | 不変条件 |
|---|---|---|
| `api` | signature / visibility / boundary decorator の変更 | 本体実装の変更では不変 |
| `logic` | rules / effects 集合の変更 | ローカル変数 rename / メソッド順序 / コメント / 装飾追加では不変 |
| `syntax` | AST 構造変更全般 | フォーマットのみの変更では不変 |

`dropped: true` のシンボルは fingerprint 全 12 hex すべて `"000000000000"` 固定。

## 14. 不変条件

スキーマ validator + Aburi 内部で保証:

1. `symbols[].id` は Document 内で一意
2. `components[].id` は Document 内で一意
3. `symbols[].component` が non-null なら `components[].id` に存在
4. `dependencies[].from` / `to` が symbol id 形式なら `symbols[].id` に存在
5. `dropped: true` なら `dropReason` が non-null
6. `confidence` ∈ §5.4 enum
7. `effects[].id` は §9.1 コア語彙 または `x-<plugin>:` プレフィックス
8. `kind` は §5.1 enum
9. `extKind` は `null` または `<namespace>(:<segment>)+` 形式 (最低 2 段、任意で多段)
10. 全 path は POSIX (forward slash)、workspace root 相対
11. 配列の整列規約 (§1) を満たす

不変条件違反は **エラー終了**。warning ではなく。

## 15. バージョニング

### 15.1 `$schema` URL

- `https://aburi.dev/schema/aburi.ir.v1.json` 固定
- 後方互換のあるフィールド追加: v1 内で OK
- フィールド削除 / 型変更 / 意味変更: v2 へ。`$schema` を `aburi.ir.v2.json` に変更する

### 15.2 互換性ポリシー

| 変更 | 互換性 |
|---|---|
| 必須フィールド追加 | 破壊的 |
| 任意フィールド追加 | 非破壊 |
| enum 値追加 (consumer は unknown を許容する範囲のみ) | 非破壊 |
| enum 値削除 | 破壊的 |
| 必須 → 任意 | 非破壊 |
| 任意 → 必須 | 破壊的 |
| フィールド rename | 破壊的 |
| 配列整列ルール変更 | 破壊的 |

`kind` enum は consumer が unknown を error にして良いため、追加も破壊的扱い。`extKind` / `derivedBy` / `effects[].id` (x- 拡張) / `via` は自由文字列に近いので追加自由。

### 15.3 コア効果語彙の凍結

§9.1 のコア効果語彙はバージョン v1 内で **追加のみ** 可。削除・意味変更は禁止。プラグイン拡張は `x-` プレフィックスで完全に分離されているため、コア凍結はプラグイン進化を妨げない。

## 16. 拡張点

Aburi コアを fork せずに拡張できる箇所:

| 拡張対象 | 場所 | 拡張形式 |
|---|---|---|
| 新言語の特殊概念 | `extKind` | `<namespace>:<kind>` |
| ランタイム/ライブラリ固有の効果 | `effects[].id` | `x-<plugin>:<action>` |
| 抽出根拠の追加 | `derivedBy` | 自由 string (慣習として `<plugin>:<reason>`) |
| Component の論理境界 | `components[]` (config 経由) | 任意 |

破壊的に互換性を壊さないため、Aburi コアが消費するフィールドは厳格 enum、プラグインが拡張するフィールドは自由 string と非対称にする。
