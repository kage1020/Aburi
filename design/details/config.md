# Config (`aburi.config.v1`)

Aburi のプロジェクト単位設定ファイル `aburi.json` の完全仕様。
JSON Schema は `schema/aburi.config.v1.json` を単一の真実とする。

参照:
- [`ir-schema.md`](ir-schema.md) — Component の構造
- [`extension-vocab.md`](extension-vocab.md) — plugin manifest と vocab 登録
- [`drop-list.md`](drop-list.md) — suppress/keep/frameworkHints の作用点
- [`lang-plugin.md`](lang-plugin.md) / [`effect-plugin.md`](effect-plugin.md) — plugin enable

---

## 1. ファイル形式と配置

- ファイル名: `aburi.json` または `aburi.jsonc`
- 配置: workspace root (`pnpm-workspace.yaml` / `package.json` 等と同階層)
- 形式: JSONC (コメント可) または JSON
- エンコーディング: UTF-8、LF
- インデント: 2 space

JSONC を許す理由: 人間が書く設定なので、各セクションへのコメントが価値を持つ。生成された JSON は consumer がそのまま parser に渡せる必要があるため JSON 純粋にも対応する。

`aburi.config.ts` / `aburi.config.yaml` は採用しない (AI が config を解釈する前提で、静的 JSON に統一)。

## 2. 全体構造

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",

  // ファイル除外 (drop-list Category A)
  "ignore": ["docs/**", "scripts/legacy/**"],
  "respectGitignore": true,

  // plugin 有効化 (extension-vocab §4)
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs"],
  "effects": ["effects-prisma", "effects-pino"],

  // plugin 個別オプション (任意)
  "pluginOptions": {
    "effects-prisma": { "treatExtendsAsTx": true }
  },

  // Component override (autodetect default)
  "components": [
    { "id": "billing", "roots": ["apps/billing"] }
  ],

  // drop-list 拡張 (Category D)
  "suppress": ["myLogger", "metrics"],
  "keep": ["myLogger.audit"],

  // Framework hints (Tier 3 plugin、extension-vocab §11.3)
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeController": { "boundary": true, "extKind": "framework:acme:controller" }
      }
    }
  ],

  // 出力先
  "output": {
    "dir": "out"
  },

  // 実行モード
  "strict": true,

  // パース/抽出のリソース制限
  "maxFileSizeBytes": 2097152,        // 2 MB (default)、超えるファイルは skip
  "parseTimeoutMs": 5000              // ファイルあたり parse タイムアウト (default 5s)
}
```

すべてのフィールドが optional。空の `{ "$schema": "..." }` でも動く (autodetect が全部やる)。

## 3. `ignore`

drop-list category A に追加する glob パターン配列。

```jsonc
{
  "ignore": ["docs/**", "scripts/legacy/**", "**/*.fixture.ts"]
}
```

- POSIX glob (forward slash)
- workspace root 相対
- micromatch 互換

drop-list §3.1 のコア標準パターンに **追加** される (既存パターンを置換しない)。

## 4. `respectGitignore`

```jsonc
{ "respectGitignore": true }
```

- デフォルト: `true`
- `.gitignore` のパターンを drop-list category A に組み込む

`false` にすると git 無視ファイル (ビルド成果物等) も抽出対象になる。CI で意図的にビルド済みコードも見たい等の特殊用途用。

## 5. Plugin 有効化

### 5.1 `languages` / `frameworks` / `effects`

```jsonc
{
  "languages": ["lang-typescript"],
  "frameworks": ["framework-nestjs", "framework-nextjs"],
  "effects": ["effects-prisma", "effects-pino", "effects-fetch"]
}
```

各配列の要素は **plugin manifest 名** (`name` フィールド)。

### 5.2 解決順序

文字列 `<id>` に対して、Aburi は次の順で resolve する:

1. `<id>` がパス (`./` または `../` で始まる) → 相対パス解決
2. `<id>` を npm パッケージ名として `<id>` を resolve
3. `<id>` を npm パッケージ名として `@aburi/<id>` を resolve (公式 plugin の補助解決)

例:
- `"effects-prisma"` → まず `effects-prisma`、次に `@aburi/effects-prisma` を試す
- `"./aburi-plugins/internal-framework.mjs"` → 相対パス直接

### 5.3 配列順序の意味

| 配列 | 順序の意味 |
|---|---|
| `languages` | 順序意味なし (拡張子で衝突しない限り) |
| `frameworks` | 順序意味なし (decorator 名等で衝突しない限り、衝突時は config 順優先) |
| `effects` | **順序が優先度** (effect-plugin §5.1 first-match-wins) |

`effects` の先頭ほど優先度が高い。プロジェクト固有 plugin を先頭に置けば標準 plugin より優先される。

### 5.4 `pluginOptions`

各 plugin 固有の不透明な設定。

```jsonc
{
  "pluginOptions": {
    "effects-prisma": { "treatExtendsAsTx": true },
    "framework-nestjs": { "considerHttpExceptionAsThrow": false }
  }
}
```

- キーは plugin manifest 名
- 値は plugin が解釈する任意 object (Aburi コアは中身を見ない)
- 各 plugin はオプションの schema を docs に明示する責任を持つ

## 6. `components`

monorepo の論理 component 境界の override。
明示しない場合、コア (D5 Component autodetect) が `pnpm-workspace.yaml` / `turbo.json` / `go.work` / `Cargo.toml` / `pyproject.toml` 等から推定する。

```jsonc
{
  "components": [
    {
      "id": "billing",
      "name": "Billing",
      "roots": ["apps/billing", "packages/billing-domain"],
      "publicApi": [
        "apps/billing/src/routes/**",
        "ts:packages/billing-domain/src/index.ts#Invoice"
      ],
      "frameworks": ["nestjs"]
    }
  ]
}
```

各フィールドは [`ir-schema.md`](ir-schema.md) §4 と同形。**ただし `languages` は config 側で省略可** (省略時は autodetect が補完)。`name` も config 側で省略時は autodetect 結果 (`package.json#name` 等) を使う。schema 上 IR Component は両方必須、config Component は緩い。

### 6.1 マージルール

config に明示された component は autodetect 結果を **置換** する (マージしない):

- config に component A の id がある → autodetect の同 id を捨て、config を採用
- config に component A の id がない → autodetect 結果がそのまま採用される

「autodetect の一部だけ修正したい」用途には ad-hoc な merge は提供しない。修正したい component は明示的に書く。

## 7. `suppress` / `keep` (drop-list 拡張)

```jsonc
{
  "suppress": ["myLogger", "metrics", "tracer"],
  "keep": ["myLogger.audit", "@Transaction"]
}
```

- `suppress[]`: identifier prefix。`myLogger.*` 全体を effects/calls から除外
- `keep[]`: 例外的に保持。`@<name>` 形式は decorator、それ以外は callee

drop-list §6.1 / §6.2 / §7 の評価順序 (keep > suppress > plugin > core) に従う。

## 8. `frameworkHints` (Tier 3 plugin)

コード一切不要で、framework boundary 認識と extKind マッピングを宣言的に追加する仕組み。
extension-vocab §11.3 の Tier 3 plugin の具体形。

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeController": {
          "boundary": true,
          "extKind": "framework:acme:controller",
          "derivedBy": "framework-hint:acme:controller"
        },
        "AcmeInternal": {
          "boundary": false,
          "drop": true
        }
      },
      "classNamePatterns": {
        "*Handler": {
          "extKind": "framework:acme:handler"
        }
      }
    }
  ]
}
```

### 8.1 `decorators`

キーは decorator 名 (装飾子 `@AcmeController` の `AcmeController` 部分)。
値の各フィールド:

| フィールド | 効果 |
|---|---|
| `boundary` | `Decorator.boundary` をこの値に上書き |
| `extKind` | この decorator を持つ Symbol の `Symbol.extKind` を設定 |
| `derivedBy` | `Symbol.derivedBy[]` に追加 |
| `drop` | この decorator を持つ Symbol を category B drop |

すべて optional。

### 8.2 `classNamePatterns`

キーは class 名の glob (`*Handler`、`*Service`、`Abstract*`)。
値は decorators と同じフィールド (`extKind`/`derivedBy`/`drop`、ただし `boundary` は decorator 専用)。

### 8.3 自動 ad-hoc plugin 化

各 `frameworkHints` エントリは内部的に 1 つの ad-hoc plugin として登録される:

```
name: hint-<name>
type: framework
provides.extKindPrefixes:  各 extKind 値に "hint:" を前置した namespace
provides.derivedByPrefixes: 同
provides.frameworks: [<name>]
```

#### 8.3.1 `hint:` 自動前置による namespace 分離

ユーザーが書いた `extKind: "framework:acme:controller"` は内部で **`framework:hint:acme:controller`** に変換される。
これにより以下を回避する:

- 既に `@aburi/framework-acme` plugin がインストールされている場合に `framework:acme` prefix が衝突する事故
- frameworkHints が後から既存 plugin を壊す

`hint:` 自動前置はコアが透過的に行うので、ユーザーは `extKind: "framework:acme:controller"` のまま記述する。生成 IR と Markdown には `framework:hint:acme:controller` として現れる。

例: `extKind: "framework:acme:controller"` → 内部 `framework:hint:acme:controller` → `extKindPrefixes: ["framework:hint:acme"]` を自動推論。

ユーザーは prefix 宣言を意識する必要がない。

### 8.4 衝突

- 同 `name` の entry が複数 → config 検証エラー
- 別 entry が同じ `extKindPrefixes` (自動推論結果) を主張 → registry が起動時にエラー (extension-vocab §6.1)
- 既存 plugin が同じ namespace を所有している場合 → 起動時エラー

## 9. `output`

```jsonc
{
  "output": {
    "dir": "out"
  }
}
```

- `dir` (デフォルト `"out"`): IR/Markdown の出力先 (workspace root 相対)

将来追加候補:
- `format`: `"json"` / `"md"` / `"both"` (デフォルト `"both"`)
- `compact`: `true` で 1 行 JSON

v0.1 は `dir` のみ。

## 10. `strict`

```jsonc
{ "strict": true }
```

- デフォルト: `true`
- `true` の場合、plugin が manifest に未宣言の vocab を生成すると抽出時エラー
- `false` (= `aburi scan --discover` 相当を恒久化) は警告のみで継続

CI のデフォルトは `true`、ローカル開発で discover したい場合は `false` または CLI で `--discover`。

両方指定された場合、CLI フラグが config を上書き。

## 11. CLI からの上書き

config の値は CLI フラグで上書き可能:

| CLI フラグ | 上書きする config |
|---|---|
| `--ignore <glob>` | `ignore[]` に追加 |
| `--no-respect-gitignore` | `respectGitignore: false` |
| `--strict` / `--no-strict` | `strict` |
| `--discover` | `strict: false` 相当 |
| `--output-dir <path>` | `output.dir` |

詳細は [`cli-spec.md`](cli-spec.md) (D10) を参照。

## 12. autodetect (config 不在時の挙動)

config がまったく無い (`aburi.json` が存在しない) 場合、`aburi scan` は次の autodetect を試みる:

```
workspace root の判定:
  - .git ディレクトリの位置 (またはサブディレクトリの内側で最も近い)
  - pnpm-workspace.yaml / package.json workspaces / turbo.json / go.work / Cargo.toml workspace

monorepo 検出:
  - 上記マニフェストから components[].roots を推定

言語検出:
  - 各 component で拡張子の出現頻度から languages を決定

framework 検出:
  - package.json の dependencies に nestjs / next / react / express 等を探す
  - 検出した framework に対応する `framework-<name>` plugin の自動有効化を提案 (実際には enable しない)
```

autodetect だけで動くが、安定性のため `aburi init` で結果を `aburi.json` に書き出すことを推奨する。

## 13. `aburi init` の出力

`aburi init` は autodetect の結果を `aburi.json` として書き出す。例:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  "frameworks": [],
  "effects": [],
  "components": [
    { "id": "billing", "name": "Billing", "roots": ["apps/billing"], "languages": ["typescript"] },
    { "id": "shared",  "name": "Shared",  "roots": ["packages/shared"], "languages": ["typescript"] }
  ]
}
```

ユーザーが framework / effects plugin を後から追加する想定。

## 14. 検証可能な性質

| ID | 入力 | 期待 |
|---|---|---|
| C1 | `{}` だけの config | autodetect で動く |
| C2 | `effects` が空配列 | 効果分類なし、すべて calls に残る |
| C3 | `effects: ["effects-prisma", "effects-stripe"]` | classification は順序通りに評価 |
| C4 | 同じ component id を持つ entry が 2 つ | config validate エラー |
| C5 | `keep` と `suppress` に同じ callee | keep が勝つ (drop-list §7) |
| C6 | `frameworkHints` の同 name が 2 つ | config validate エラー |
| C7 | `frameworkHints` の extKind 値から prefix を自動推論 | registry に登録される |
| C8 | `strict: false` で未宣言 vocab を抽出 | 警告のみ、`out/aburi-vocab-discovered.json` に記録 |
| C9 | CLI `--strict` を渡す | config `strict: false` を上書き |
| C10 | `pluginOptions` で未登録 plugin を指定 | warning (plugin が無効化されているため無視) |

## 14.1 Config schema の互換性ポリシー

`aburi.config.v1.json` の互換性は IR schema (ir-schema.md §15) と同じポリシーに従う。
特に重要:

- `pluginOptions` の **値の中身** は plugin 個別 schema 管理なので Aburi コアの互換性対象外
- `frameworkHints` のフィールド追加は非破壊
- `output.dir` / `strict` のデフォルト値変更は **破壊的扱い** (CI で挙動が変わるため v2 へ)

## 15. 設計上の決定事項

### 15.1 plugin 明示有効化を採用する理由

`node_modules` を scan して `aburi-plugin.json` を見つけたら自動 load する「implicit」案もあるが、

- 一つの rogue パッケージが Aburi 出力に影響
- 開発者が「なぜこの効果が出てるのか」を追跡しにくい
- vocab 衝突が予測不能

を回避するため、明示有効化に統一。`aburi init` が package.json の依存から候補を提案して書き込むので、手作業負担は実質ゼロ。

### 15.2 plugin 名を manifest 名にする理由

npm パッケージ名 (`@aburi/effects-prisma`) と manifest 名 (`effects-prisma`) で命名が冗長になる。config は短い manifest 名で書ける方が読みやすい。Aburi が npm 解決時に `@aburi/<name>` を試すことで公式 plugin の DX は維持。

### 15.3 `pluginOptions` を opaque object にする理由

各 plugin の挙動制御は plugin の責任。Aburi コアが schema を強制すると plugin の進化が遅くなる。

代わりに各 plugin が自身の `pluginOptions` schema を docs に明示し、ユーザーは plugin docs を参照する。

### 15.4 `components` の merge をサポートしない理由

ad-hoc merge は「config を書いたが autodetect の挙動変更で勝手に値が変わる」事故を起こす。**置換** に統一することで、書いた config の挙動は autodetect 変化と独立に予測可能になる。

### 15.5 `frameworkHints` の prefix 自動推論

ユーザーが `extKindPrefixes: ["framework:acme"]` を手書きさせるのは冗長で間違いやすい。`extKind` 値から自動推論することで、最少コードで Tier 3 plugin が成立する。

### 15.6 `aburi.config.ts` を採用しない理由

- AI consumer が config を読み解く前提で、静的 JSON が圧倒的に扱いやすい
- TypeScript 補完は JSON Schema (`$schema`) 経由で十分実現可能 (`biome.json` / `tsconfig.json` の世界観)
- 動的 logic (関数で suppress 判定など) の必要性は低く、必要なら plugin として書く方が再利用性高い
