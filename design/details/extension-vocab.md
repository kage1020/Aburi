# 拡張語彙レジストリ

Aburi のコアスキーマは厳格 enum で固定された語彙を持つ一方、言語/フレームワーク/効果プラグインが拡張可能な「ゆるい」語彙を持つ。本ドキュメントはその拡張語彙の登録機構を定義する。

参照: [`ir-schema.md`](ir-schema.md) §5.2 / §9.2 / §16
プラグインマニフェスト: [`../../schema/aburi.plugin.v1.json`](../../schema/aburi.plugin.v1.json)

---

## 1. 目的

拡張語彙を整理する理由:

- **発見可能性**: ある Aburi インストールに何が登録されているかを問い合わせ可能にする (CLI / diff レンダラ / IR consumer)
- **検証**: プラグインが生成する extKind / effect.id が、自分のマニフェストで宣言した範囲に収まっているかを runtime で確認する
- **文書化**: 各拡張値が「何を意味するか」を機械可読な形で持つ
- **競合検出**: 同じ識別子を 2 つ以上のプラグインが宣言したとき、エラーで止める

スキーマレベルの検証 ([`aburi.ir.v1.json`](../../schema/aburi.ir.v1.json)) は pattern 一致しか保証しない。意味的に「このプロジェクトで使ってよい値か」を判定するのが本レジストリの責務。

## 2. 拡張対象 (4 種類)

| 対象 | IR 上の場所 | 形式 |
|---|---|---|
| `extKind` | `Symbol.extKind` | `<ns>(:<segment>)+` |
| Effect id (拡張) | `Symbol.effects[].id` | `x-<ns>:<action>` |
| `derivedBy` 文字列 | `Symbol.derivedBy[]` | 自由 (慣習: `<ns>:<reason>`) |
| Framework 名 | `Component.frameworks[]` | `[a-z][a-z0-9-]*` |

語彙は本ドキュメント §3 のマニフェストで宣言される。

## 3. プラグインマニフェスト

各プラグインは **1 つのマニフェスト** を持ち、そこで自分の名前・種別・提供する全 vocab を宣言する。

### 3.1 形式

ファイル名は `package.json` の `aburi` プロパティ、または独立した `aburi-plugin.json`。両方ある場合は前者が優先。

```jsonc
// type=effects plugin (lifecycle hooks 等の効果のみ)
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "effects-nest",
  "version": "1.0.0",
  "type": "effects",
  "xPrefix": "nest",                            // x-nest:* を所有 (§5.2)
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [                                // 個別列挙
      { "id": "x-nest:lifecycle.on-module-init", "description": "..." }
    ],
    "effectPrefixes": [],                        // wildcard 所有 (§3.3)
    "extKinds": [],                              // type=effects は extKinds 宣言不可
    "extKindPrefixes": [],
    "derivedByPrefixes": ["effects-plugin:nest"],
    "frameworks": []                             // type=effects は frameworks 宣言不可
  }
}

// type=framework plugin (boundary 認識・extKind 付与)
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "framework-nestjs",
  "version": "1.0.0",
  "type": "framework",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [],                               // type=framework は effects 宣言不可
    "effectPrefixes": [],
    "extKinds": [
      { "id": "framework:nestjs:controller", "baseKind": "class", "description": "..." }
    ],
    "extKindPrefixes": ["framework:nestjs"],
    "derivedByPrefixes": ["framework:nestjs"],
    "frameworks": ["nestjs"]
  }
}
```

公式 npm パッケージとしては `@aburi/effects-nest` と `@aburi/framework-nestjs` の 2 パッケージに分離されている。

### 3.2 個別列挙 vs プレフィックス所有

vocab 宣言には 2 つのスタイルがある:

| スタイル | 形式 | 用途 |
|---|---|---|
| 個別列挙 | `effects: [{id, description}]` | 値が有限・安定で文書化価値が高い (公開プラグイン) |
| プレフィックス所有 | `effectPrefixes: ["x-acme"]` | 値が頻繁に増減する / 量が多い / 開発反復中 |

両方を併用してよい。`effects: [{id: "x-acme:explicit"}]` + `effectPrefixes: ["x-acme"]` の場合、`x-acme:*` 全体が plugin の所有、`x-acme:explicit` に対しては個別 description が引かれる。

### 3.3 プレフィックスの形式

- `effectPrefixes[]` の要素は `^x-[a-z][a-z0-9-]*$` 形式 (trailing `:` なし、後続 `:<action>` を暗黙に含意)
- `extKindPrefixes[]` の要素は `^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$` 形式 (**最低 2 segment 必須**、`<ns>:<sub-ns>` 以上)

`extKindPrefixes` の 2 segment 最小制約は意図的なもの。`framework` 単独のような一段所有を許すと、複数の framework plugin が同じ最上位 namespace を奪い合う構図になり registry の prefix 排他性が崩れる。`<ns>:<plugin-id>` のように plugin 名を含めることで `framework:nestjs` と `framework:fastify` が共存できる。

プレフィックスは「この plugin が所有する namespace 一段以上」を意味する。`extKindPrefixes: ["framework:acme"]` を宣言した plugin は `framework:acme:controller` / `framework:acme:job` 等を runtime に自由に出力できる。

### 3.4 識別子規約

| フィールド | 形式 |
|---|---|
| `name` | `^[a-z][a-z0-9-]*$` |
| `version` | semver |
| `type` | `lang` / `effects` / `framework` |
| `provides.effects[].id` | `^x-[a-z][a-z0-9-]*:[a-z][a-z0-9.-]+$` |
| `provides.effectPrefixes[]` | `^x-[a-z][a-z0-9-]*$` |
| `provides.extKinds[].id` | `^[a-z][a-z0-9-]*(:[a-z][a-z0-9.-]*)+$` |
| `provides.extKindPrefixes[]` | `^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$` |
| `provides.extKinds[].baseKind` | IR `SymbolKind` enum |
| `provides.derivedByPrefixes[]` | `^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$` |
| `provides.frameworks[]` | `^[a-z][a-z0-9-]*$` |

これらは [`aburi.plugin.v1.json`](../../schema/aburi.plugin.v1.json) で機械検証される。

## 4. 登録ライフサイクル

```
aburi 起動
  ↓ config.effects / frameworks / languages の plugin 一覧を読む
  ↓ 各 plugin を解決 (npm 解決 または project 内 path)
  ↓ マニフェストを取得 (§3) し aburi.plugin.v1.json で schema validate
  ↓ レジストリに登録 (§6 衝突解決)
  ↓ 抽出パイプライン起動
  ↓ 抽出中、plugin が返す extKind / effect.id を registry が「宣言済みか / 所有プレフィックス配下か」検証
       配下にない → エラー終了 (plugin 実装バグ)
       --discover フラグが立っている場合 → 警告のみで継続、aburi-vocab-discovered.json に記録 (§11.5)
```

config に列挙されていない plugin は load されない。明示的 opt-in。

## 5. 名前空間

### 5.1 中央予約 (どの plugin も宣言不可)

| プレフィックス | 用途 |
|---|---|
| `core:*` | Aburi コアエンジン本体 |
| `aburi:*` | Aburi 自身のメタ情報 |
| `_:*` | テスト/予約 |
| `framework:hint:*` | `frameworkHints` (Tier 3) 自動前置用 (§11.3)。npm plugin は宣言不可 |

### 5.2 type 別の所有可能名前空間

| プレフィックス | 所有可能な `type` | 備考 |
|---|---|---|
| `fp:*` | `lang` のみ | 1 ns = 1 言語パラダイム、サブ ns は plugin が個別所有 |
| `oop:*` | `lang` のみ | 同上 |
| `meta:*` | `lang` のみ | 同上 |
| `framework:*` | `framework` のみ | サブ ns (`framework:nestjs:`) は plugin が個別所有 |
| `x-*` | `effects` のみ | `x-<xPrefix>:` 形式。`xPrefix` は manifest で明示宣言 (デフォルトは `name` から `effects-` プレフィックスを除いた残り、例 `effects-prisma` → `prisma`) |

「公式 plugin」と「サードパーティ」という区別は **持たない**。所有はマニフェスト宣言ベース、衝突は起動時に検出。

### 5.3 サブ名前空間の排他所有

`framework:` プレフィックスは複数の `type: framework` plugin が共有するが、サブ名前空間 (`framework:nestjs:` / `framework:react:`) は宣言した 1 plugin が排他所有する。

`fp:` / `oop:` / `meta:` も同様、サブ ns 単位で 1 plugin が所有。

## 6. 衝突解決

### 6.1 重複宣言

| 状況 | 挙動 |
|---|---|
| 2 plugin が同じ `effects[].id` を宣言 | **起動時エラー** |
| 2 plugin が同じ `extKinds[].id` を宣言 | **起動時エラー** |
| 2 plugin が同じ `effectPrefixes[]` を宣言 | **起動時エラー** |
| 2 plugin が同じ `extKindPrefixes[]` を宣言 | **起動時エラー** |
| 2 plugin が同じ `frameworks[]` 名を宣言 | **起動時エラー** |
| 2 plugin が同じ `derivedByPrefixes[]` を宣言 | **起動時エラー** |
| plugin A が `extKinds[].id: "framework:acme:job"`、plugin B が `extKindPrefixes: ["framework:acme"]` を宣言 | **起動時エラー** (B のプレフィックスが A の id を包含) |
| `type: effects` 以外が `x-*` を宣言 | **起動時エラー** |
| `type: lang` 以外が `fp:*` / `oop:*` / `meta:*` を宣言 | **起動時エラー** |
| `type: framework` 以外が `framework:*` を宣言 | **起動時エラー** |
| `x-<prefix>` の prefix 部分が `xPrefix` (default: `name` から `effects-` を除いた残り) と不一致 | **manifest validate エラー** |
| `type: effects` plugin が `extKinds` / `extKindPrefixes` / `frameworks` を宣言 | **manifest validate エラー** (schema if/then) |
| `type: framework` plugin が `effects` / `effectPrefixes` を宣言、または非 `framework:` プレフィックスの extKinds を宣言 | **manifest validate エラー** |
| `type: lang` plugin が `effects` / `effectPrefixes` / `frameworks` を宣言、または非 `(fp\|oop\|meta):` の extKinds を宣言 | **manifest validate エラー** |

回避策: `x-<plugin-name>:` で plugin 名空間を強制することで、サードパーティ間の effect id 衝突は自然に解決される。

### 6.2 中央予約侵害

§5.1 の中央予約 ns をプレフィックスまたは id 段階で含む宣言 → **起動時エラー**。

### 6.3 抽出時の未宣言値

plugin の抽出ロジックが registry に未宣言の extKind / effect.id を生成した場合 → 抽出全体を **エラー終了**。

これは「plugin が silently 新しい語彙を使い始めて time-series 比較が壊れる」事態を防ぐためのフェイルセーフ。

例外: `aburi scan --discover` フラグ時のみ、警告に降格し記録 (§11.5)。

## 7. レジストリ API (consumer 側)

```ts
interface VocabRegistry {
  // 検索 (id 直引き、または所有プレフィックス経由)
  findEffect(id: string): EffectVocab | null
  findExtKind(id: string): ExtKindVocab | null
  findFramework(name: string): FrameworkVocab | null
  findDerivedByOwner(value: string): PluginManifest | null

  // 所有判定
  isEffectOwnedBy(id: string, pluginName: string): boolean
  isExtKindOwnedBy(id: string, pluginName: string): boolean

  // 列挙
  listEffects(): EffectVocab[]
  listExtKinds(): ExtKindVocab[]
  listFrameworks(): FrameworkVocab[]
  listPlugins(): PluginManifest[]

  // 検証 (抽出時)
  assertEffectDeclared(id: string, byPlugin: string): void
  assertExtKindDeclared(id: string, byPlugin: string): void
}
```

`findEffect("x-acme:custom-action")` は、`x-acme:custom-action` が個別列挙されていれば description ありで返し、プレフィックス所有のみなら所有 plugin 情報と description=null で返す。

## 8. CLI (将来用)

`aburi vocab` サブコマンド (D10 で具体化):

```bash
aburi vocab list                                       # 全 vocab を表示
aburi vocab effects                                    # effect id のみ
aburi vocab plugins                                    # plugin 一覧
aburi vocab who-owns x-nest:lifecycle.on-module-init   # この id を所有する plugin
```

## 9. 検証可能な性質 (テスト基準)

| ID | 入力 | 期待 |
|---|---|---|
| V1 | 単独 plugin の manifest を load | 全 vocab が registry に登録 |
| V2 | 2 plugin が同じ effect id を宣言 | 起動時エラー |
| V3 | 2 plugin が同じ extKind を宣言 | 起動時エラー |
| V4 | 中央予約 (`core:foo`) を宣言 | 起動時エラー |
| V5 | `type: effects` が `framework:foo:bar` を宣言 | 起動時エラー |
| V6 | plugin 抽出が未宣言の effect id を返す (strict mode) | 抽出時エラー |
| V7 | plugin 抽出が未宣言の extKind を返す (strict mode) | 抽出時エラー |
| V8 | `name: stripe` が `x-acme:` プレフィックスを宣言 | manifest validate エラー |
| V9 | 同 manifest を 2 回 load | idempotent |
| V10 | `effectPrefixes: ["x-acme"]` 宣言下で `x-acme:anything` を抽出時に生成 | 通過 |
| V11 | A が `extKinds[].id: "framework:acme:job"`、B が `extKindPrefixes: ["framework:acme"]` | 起動時エラー (包含衝突) |
| V12 | `aburi scan --discover` で未宣言値を出す | 警告のみ・`aburi-vocab-discovered.json` に記録 |
| V13 | Framework hints (config §11.3) のみで `@Foo` を boundary 扱い | OK・plugin manifest 不要 |

## 9.5 マニフェスト schema の互換性ポリシー

`aburi.plugin.v1.json` は IR schema (ir-schema.md §15) と同じ互換性ポリシーを採用:

| 変更 | 互換性 |
|---|---|
| 必須フィールド追加 | 破壊的 (v2 へ) |
| 任意フィールド追加 | 非破壊 |
| enum 値追加 (consumer が unknown を許容する範囲) | 非破壊 |
| enum 値削除 | 破壊的 |
| pattern 厳格化 | 破壊的 |
| pattern 緩和 | 非破壊 |
| 配列 unique 制約追加 | 破壊的 |

`type` enum (`lang` / `effects` / `framework`) は consumer が unknown を error にして良いため、追加も破壊的扱い。

## 10. 設計上の決定事項

### 10.1 「公式 vs サードパーティ」を廃止

ある plugin が `npm` 公開か repository ローカルかを Aburi は判別できない。所有判定はマニフェスト宣言ベースに統一。

### 10.2 IR ファイル自体には未宣言値を許す

IR consumer (例: 別環境で Markdown レンダラを実行) は生成時の plugin を持たないかもしれない。registry のガードは生成時のみ、IR ファイルは schema pattern を満たせば valid。

### 10.3 中央予約をハードコードする理由

予約一覧が config で動的に変えられると、ある時点で生成された IR が別環境で「予約衝突」と判定される事故が起きる。Aburi バージョンごとに固定の予約一覧を持つ。

### 10.4 プレフィックス所有を許す理由

社内フレームワーク・実験的 plugin など、vocab が頻繁に増減する / 量が多いケースで、個別列挙を強制すると開発反復が破綻する。プレフィックス所有によって「namespace の所有権」だけを表明し、内容は runtime に委ねる柔軟性を持たせる。

### 10.5 `derivedByPrefixes` の用途

`derivedBy[]` は IR consumer が「この判定はどの plugin が下したか」を知るための文字列。registry に prefix を登録しておくことで、Markdown レンダラが「`framework:nestjs:*` の derivedBy は『NestJS plugin』表示」のような表示制御ができる。

---

## 11. マイナー言語・カスタムプラグインへの対応

新しい言語 / 社内フレームワーク / 一回限りのカスタム規則を Aburi に取り込む手段は、複雑度に応じて 3 つの層がある。

### 11.1 Tier 1: Published plugin

- npm 公開、`type: lang | effects | framework`
- vocab は **個別列挙** が原則 (発見可能性・文書化価値)
- 例: `@aburi/effects-nest`, `@aburi/lang-typescript`

### 11.2 Tier 2: Project plugin

- リポジトリ内 (例: `aburi-plugins/internal-framework.mjs`) のローカルコード
- `package.json` の workspace 経由か config の直接パス指定で参照
- マニフェスト形式は Tier 1 と完全に同じ
- **vocab はプレフィックス所有** を活用してよい (§3.3)
- 例:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "acme-framework",
  "version": "0.0.1",
  "type": "framework",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [],
    "effectPrefixes": [],
    "extKinds": [],
    "extKindPrefixes": ["framework:acme"],
    "derivedByPrefixes": ["framework:acme"],
    "frameworks": ["acme-framework"]
  }
}
```

runtime に `framework:acme:controller` / `framework:acme:job` / `framework:acme:saga` 等を自由に出せる。

### 11.3 Tier 3: Framework hints (コード不要)

- `aburi.json` 内の宣言のみ、コード一切不要
- 「`@MyDecorator` を boundary 扱いしたい」「`class *Handler` を `framework:mycorp:handler` として扱いたい」程度を満たす
- D11 (Config schema) で具体化、本ドキュメントではフックポイントだけ示す
- **ユーザーが書く `extKind: "framework:acme:controller"` は内部で `framework:hint:acme:controller` に自動変換される** (詳細は [`config.md`](config.md) §8.3.1)。コアが透過的に `hint:` を 2 段目セグメントとして挟むことで、既存 npm 公式 `framework-acme` plugin との namespace 衝突を回避
- ユーザーが直接 `extKind: "framework:hint:*"` を入力する行為は **config 検証エラー** (`config-check.mjs` が reject)
- `framework:hint:*` 全体は **中央予約 namespace** (§5.1)、サードパーティ npm plugin は宣言不可
- イメージ:

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeController": { "boundary": true, "extKind": "framework:acme:controller" },
        "AcmeJob":        { "boundary": true, "extKind": "framework:acme:job" }
      },
      "classNamePatterns": {
        "*Handler": { "extKind": "framework:acme:handler" }
      }
    }
  ]
}
```

Aburi コアが内部的に **ad-hoc plugin** として扱い、`framework:acme:*` 系の vocab を自動登録する。コード抽出ロジックは不要。

### 11.4 どの層を選ぶかの判断

| 状況 | 推奨層 |
|---|---|
| 公開された言語 / フレームワークで広く使われる | Tier 1 |
| 社内/プロジェクト固有の framework で、効果検出ロジックが必要 | Tier 2 |
| `@MyDecorator` を boundary 扱いしたい等の単純な分類だけ | Tier 3 |
| マイナー言語 (Crystal/Zig 等) に対応したい | Tier 1 または Tier 2 (tree-sitter grammar + 抽出ロジック必須) |
| プラグイン反復開発中、vocab が固まらない | Tier 2 + `--discover` (§11.5) |

### 11.5 開発反復用: `--discover` モード

```bash
aburi scan --discover
```

- plugin の抽出が registry 未宣言の値を出してもエラーにせず、警告 + `out/aburi-vocab-discovered.json` に記録
- 開発者は記録を見て manifest に promote するか判断
- CI のデフォルトは strict (`--discover` なし)、ローカル開発のみ discover 推奨

#### 11.5.1 `aburi-vocab-discovered.json` 形式

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.vocab-discovered.v1.json",   // v0.1 では存在せず、v0.2 で正式化
  "discoveredAt": "2026-06-21T15:30:00Z",
  "items": [
    {
      "kind": "effect",                       // "effect" | "extKind" | "framework"
      "value": "x-prisma:bulk-delete",
      "firstSeenBy": "effects-prisma",        // 最初にこの値を生成した plugin
      "alsoSeenBy": [],                       // 同 run 内で他の plugin も同じ値を生成した場合 (rare)
      "occurrences": 3,                       // 同 run 内の出現回数 (dedupe 後)
      "samples": [                            // 最初の 3 つの occurrence
        { "file": "apps/billing/src/x.ts", "line": 42, "symbol": "ts:apps/billing/src/x.ts#foo" }
      ]
    }
  ]
}
```

- `firstSeenBy`: 同 run 内で同じ未宣言値を複数 plugin が生成した場合、最初の plugin が所有
- `alsoSeenBy`: 後続 plugin は warning に降格、record に追加
- `occurrences`: 同 run 内で同 (value, plugin) ペアの重複は dedupe され count++

これにより promote 時に「どの plugin の manifest に追加するか」が機械的に決定できる。

### 11.6 マイナー言語 plugin の最小マニフェスト例

`lang-crystal` を仮に書く場合、vocab を増やさず コア語彙だけで賄える:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.plugin.v1.json",
  "name": "lang-crystal",
  "version": "0.1.0",
  "type": "lang",
  "engines": { "aburi": "^1.0.0" },
  "provides": {
    "effects": [],
    "effectPrefixes": [],
    "extKinds": [],
    "extKindPrefixes": [],
    "derivedByPrefixes": ["lang:crystal"],
    "frameworks": []
  }
}
```

`extKind` を使わず Crystal の `class` / `module` / `def` を IR コア enum (`class` / `module` / `function`) に投影するだけ。vocab 宣言の負荷はほぼゼロ。

特殊概念 (`fp:macro`, `oop:abstract` 等) を出したくなったときに、対応する prefix を `extKindPrefixes` に追加する。段階的に拡張可能。
