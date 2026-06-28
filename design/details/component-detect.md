# Component Autodetect

`aburi init` および `aburi scan` (config 不在時) が monorepo の物理構造から論理 Component を推定するアルゴリズム。
config が `components[]` を明示している場合は autodetect 結果より優先される ([`config.md`](config.md) §6.1)。

参照:
- [`ir-schema.md`](ir-schema.md) §4 — Component の構造
- [`config.md`](config.md) §6 / §12 — Component override / autodetect 全体像

---

## 1. 目的

Aburi が「どのファイル群が 1 つの論理単位 (Component) か」を、ユーザー入力ゼロで推定する。

これにより:
- `aburi init` が `aburi.json` の `components[]` を初期値付きで生成できる
- `aburi scan` が `aburi.json` 不在でも動く
- 新規参加者が config を書く前から workspace 構造の見通しを得られる

## 2. 二段階アルゴリズム

```
1. Workspace root 検出
   - CLI 実行 cwd から上方向に走査
   - workspace marker のうち最も外側を root とする

2. Component 抽出
   - root から各 detector を並列実行
   - 検出結果をマージ・dedupe
   - 推定ルールで id / name / languages / frameworks / publicApi を補完
```

### 2.1 Workspace root 検出

cwd から親方向に走査し、次のいずれかが見つかったディレクトリの **最も外側 (root に最も近い)** を workspace root とする:

- `.git/` ディレクトリ
- `pnpm-workspace.yaml`
- `turbo.json`
- `nx.json`
- `lerna.json`
- `go.work`
- `Cargo.toml` (`[workspace]` セクションを含む)
- `pyproject.toml` (`[tool.uv.workspace]` / `[tool.hatch.workspaces]` / `[tool.poetry]` を含む)
- `package.json` (`workspaces` フィールドを含む)
- `.aburi-workspace` (将来用、Aburi 専用マーカー)

複数階層で見つかった場合は外側を採用 (e.g., `.git` を持つ親が monorepo の真の root)。

### 2.2 Component 抽出

各 detector は workspace root を受け取り、自分が扱える marker が存在するかを判定。存在すれば 0 個以上の "workspace candidate" を返す。

```
detector.detect(workspaceRoot) → {
  manager: WorkspaceManager  // tool name + roots
  workspaces: Workspace[]
} | null
```

すべての detector 結果をマージし、同一 path の重複を取り除いた後、各 workspace を Component に変換する。

## 3. 各 Detector

### 3.1 JS/TS エコシステム

| Detector | Marker | Workspace 抽出方法 |
|---|---|---|
| pnpm | `pnpm-workspace.yaml` | `packages:` フィールドの glob を解決 |
| npm/yarn | `package.json` の `workspaces` | 配列 or `{packages: [...]}` を glob 解決 |
| bun | 同上 (npm 互換) | 同上 |
| turbo | `turbo.json` | monorepo の hint として扱う。実 workspace は pnpm/npm 系から取る |
| nx | `nx.json` + `project.json` | `project.json` を含む全ディレクトリ |

#### 3.1.1 glob 解決規約

- POSIX glob (forward slash)
- workspace root 相対
- `**` の最大深度は 10 (誤検出回避)
- 同一 path が複数 glob にマッチしても 1 件扱い
- `node_modules/` 配下は常に除外

### 3.2 Go エコシステム

| Detector | Marker | Workspace 抽出方法 |
|---|---|---|
| go | `go.work` | `use ./module-a` のディレクトリ列挙 |

`go.work` がなく `go.mod` 単独なら、root が単一 module = 単一 Component。

### 3.3 Rust エコシステム

| Detector | Marker | Workspace 抽出方法 |
|---|---|---|
| cargo | `Cargo.toml` with `[workspace]` | `members = [...]` の glob 解決 |

`[workspace]` を持たない `Cargo.toml` 単独なら、root が単一 crate = 単一 Component。

### 3.4 Python エコシステム

| Detector | Marker | Workspace 抽出方法 |
|---|---|---|
| uv | `pyproject.toml` with `[tool.uv.workspace]` | `members = [...]` |
| hatch | `pyproject.toml` with `[tool.hatch.workspaces]` | members |
| poetry (multi-project) | `pyproject.toml` with `[tool.poetry.dependencies]` を持つ複数の `pyproject.toml` を探索 | サブディレクトリの再帰検出 |

Python は workspace 標準が分散しているため、複数 detector を持つ。

### 3.5 その他 (v1.0 以降の対象)

| Manager | Marker | 備考 |
|---|---|---|
| Lerna | `lerna.json` | npm/yarn と重複検出になる |
| Bazel | `WORKSPACE` / `WORKSPACE.bazel` / `MODULE.bazel` | BUILD ファイルから workspace 抽出 |
| Maven | `pom.xml` with `<modules>` | parent project + modules |
| Gradle | `settings.gradle(.kts)` with `include(...)` | included projects |
| Elixir | `mix.exs` umbrella project | `apps_path` 配下 |
| Composer | `composer.json` (composer/installers の場合) | 一般化されておらず留保 |

v0.1 は JS/TS のみ実装、他は detector のプラグインインタフェースを定義しておき、v1.0 で各言語プラグインから追加できる状態にする (§7)。

## 4. Component フィールドの推定

各 workspace から Component へのマッピング。

### 4.1 `id`

優先順位:
1. `package.json#name` (JS/TS): scope を除いて kebab-case 化 (`@scope/billing` → `billing`)
2. `Cargo.toml` の `package.name` (Rust)
3. `pyproject.toml` の `project.name` (Python)
4. `go.mod` の module 名末尾 (Go)
5. workspace ディレクトリのフルパスから末尾セグメントを kebab-case 化

衝突 (同 id を持つ workspace が複数) → サフィックスに親ディレクトリ名を付加 (`billing` → `billing-apps` / `billing-packages`)。

### 4.2 `name`

優先順位:
1. `package.json#name` のフルネーム (`@scope/billing` などスコープ含む)
2. その他マニフェストの `name` フィールド
3. workspace ディレクトリの末尾セグメントをそのまま (大文字化)

### 4.3 `roots`

検出された workspace の path を 1 要素。
workspace root 相対の POSIX path。

### 4.4 `languages`

workspace 配下を浅くスキャン (depth 3 まで) し、拡張子の出現頻度を集計。閾値 (>5% かつ >10 ファイル) を超えた拡張子に対応する language id を含める。

**閾値未満の少数言語ファイル**は次のように扱う:

- `Component.languages[]` には含めない (autodetect の主要言語のみ表示)
- ただし対応する lang plugin が enable されていれば、それらのファイルも通常通り scan して Symbol 抽出する
- 「`Component.languages` に列挙されていない言語の Symbol が現れる」のは正常 (例: 主に TS の component に少数の `.py` script が含まれていて py plugin が有効化されている等)
- 対応 lang plugin が無い言語のファイルは skip + warning (component-detect §6.5 と同じ扱い)

`Component.languages[]` の役割は「この component を理解する上で必要な主要言語」を示すこと。Symbol 抽出範囲とは独立。

拡張子マッピング:

| 拡張子 | language id |
|---|---|
| `.ts`/`.mts`/`.cts` | `ts` |
| `.tsx` | `tsx` |
| `.js`/`.mjs`/`.cjs` | `js` |
| `.jsx` | `jsx` |
| `.py` | `py` |
| `.go` | `go` |
| `.rs` | `rs` |
| `.java` | `java` |
| `.kt`/`.kts` | `kt` |
| `.scala` | `scala` |
| `.rb` | `rb` |
| `.php` | `php` |
| `.cs` | `cs` |
| `.swift` | `swift` |
| `.ex`/`.exs` | `ex` |

このマッピングは固定ではなく、各言語プラグインが宣言する `fileExtensions` ([`lang-plugin.md`](lang-plugin.md) §4.1) から逆引きできる。

### 4.5 `frameworks`

依存マニフェストから既知の framework を検出:

| 検出元 | 検出パターン → framework id |
|---|---|
| `package.json` deps/devDeps | `@nestjs/core` → `nestjs` |
| 同上 | `next` → `nextjs` |
| 同上 | `react` (かつ react-dom) → `react` |
| 同上 | `vue` → `vue` |
| 同上 | `express` → `express` |
| 同上 | `fastify` → `fastify` |
| 同上 | `koa` → `koa` |
| 同上 | `hono` → `hono` |
| 同上 | `astro` → `astro` |
| 同上 | `svelte` (kit/dev) → `svelte` |
| 同上 | `solid-js` → `solid` |
| 同上 | `@trpc/server` → `trpc` |
| `go.mod` | `github.com/gin-gonic/gin` → `gin` |
| 同上 | `github.com/labstack/echo` → `echo` |
| 同上 | `github.com/gofiber/fiber` → `fiber` |
| `pyproject.toml` deps | `django` → `django` |
| 同上 | `fastapi` → `fastapi` |
| 同上 | `flask` → `flask` |

リストは Aburi コアが持つが、各 framework plugin が `manifest.provides.frameworks[]` で名前を宣言した時点で、その framework 名と「検出パターン → 名」マッピングを plugin 側で拡張できる仕組みを v0.2 で導入する (v0.1 はコア固定リスト)。

検出された framework は **`Component.frameworks[]` に記録するだけ** で、対応する plugin を自動有効化はしない (config.md §15.1)。

### 4.6 `publicApi`

`package.json` の `exports` / `main` / `module` / `types` を解決:

```jsonc
// package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts"
  }
}
```

→

```jsonc
{
  "publicApi": ["src/index.ts", "src/client.ts"]
}
```

`exports` がなければ `main` / `module` / `types` から file path を採用。
何もなければ `publicApi: []` (空)。

Python / Go / Rust は v1.0 で各 language plugin が「公開 API ファイル」推定ロジックを提供する。v0.1 は JS/TS のみ。

## 5. 単一プロジェクト (non-monorepo)

どの detector も hit しなかった場合、workspace root を **単一 Component として扱う**:

```jsonc
{
  "id": "<package.json name から推定>",     // または workspace root のディレクトリ名
  "name": "<同上>",
  "roots": ["."]
}
```

これにより、最小限の単一プロジェクト (TypeScript 単発リポジトリ等) でも Aburi が動く。

## 6. Detector の拡張機構

言語プラグインは追加 detector を提供できる:

```ts
interface ComponentDetector {
  id: string                                 // "uv", "cargo", "go-work" 等
  detect(workspaceRoot: string): DetectorResult | null
}

interface DetectorResult {
  manager: WorkspaceManager                  // ir-schema §2 の workspace.managers[] 要素
  workspaces: WorkspaceCandidate[]
}

interface WorkspaceCandidate {
  root: string                               // workspace root 相対 path
  manifestPath: string                       // package.json 等の path
  rawMetadata: unknown                       // manifest の raw 解析結果 (Component 推定の補助)
}
```

各 language plugin の `manifest.provides` に detector を含めるかどうかは v0.2 で拡張する (v0.1 はコア固定の detector セット)。

## 6.5 複数言語/ランタイム混在の扱い

`apps/web` (pnpm) + `apps/api` (cargo) + `services/ml` (uv) のような複数管理ツール混在 monorepo は、各 detector が独立に hit する。

- `workspace.managers[]` に検出されたツールすべてを記録 (例: `[{tool:"pnpm",...}, {tool:"cargo",...}, {tool:"uv",...}]`)
- 各 workspace は所属管理ツールの命名規約で Component 化
- 各 Component の `languages` は配下スキャンで自動決定 (§4.4)
- v0.1 では **TS only** のため、TS 以外の workspace を検出した場合は:
  - Component としては作成する (アーキテクチャ全景を保つため)
  - `languages` に該当言語を含めるが、Symbol 抽出は skip
  - `stats.skippedFiles[]` に「対応 lang plugin 不在」として記録 (v0.2 で別途検討)
  - 警告 stderr: `Component <id> has language <lang> but no lang plugin enabled. Symbols not extracted.`

## 7. 衝突解決

複数 detector が同一 path を返した場合 (例: pnpm + turbo 両方が `packages/billing` を検出):

- workspace candidate を **1 件にマージ** (path で dedupe)
- `manager` 情報は両方記録 (`workspace.managers[]` に 2 件入る)
- Component 自体は 1 つ

複数 detector が同一 id を生成し path が違う場合 (§4.1):
- §4.1 の衝突回避規約でサフィックスを付加

## 8. `.gitignore` / 除外

- 走査時に `.gitignore` のパターンを尊重 (config.respectGitignore に従う)
- `node_modules/` / `vendor/` / `__pycache__/` 等は autodetect 時にも常時除外
- `.git/` の中身は読まないが、その存在は workspace root マーカーとして利用

## 9. パフォーマンス

`aburi init` / `aburi scan` の autodetect 部分は **<200ms (中規模 monorepo)** を目標。

実装ガイド:
- ファイルシステム走査は非同期で並列
- マニフェスト読み取りは memoize
- glob 解決は fast-glob 系の効率実装を使用

## 10. 検証可能な性質

| ID | 入力 | 期待 |
|---|---|---|
| CD1 | `pnpm-workspace.yaml: packages: ["packages/*"]` + `packages/{a,b,c}/package.json` | 3 Component 検出、id は各 package.json#name から |
| CD2 | npm workspaces `["apps/*", "libs/*"]` | apps と libs 配下の全 package を Component 化 |
| CD3 | turbo.json + pnpm-workspace.yaml | 同 workspace を 1 Component、managers[] に 2 件 |
| CD4 | `Cargo.toml` `[workspace] members = ["crate-a"]` | 1 Component (crate-a) |
| CD5 | `go.work` `use ./mod-a ./mod-b` | 2 Component |
| CD6 | どの marker もない単一 TS プロジェクト | 1 Component (root, id=package.json name) |
| CD7 | `package.json#name = "@scope/billing"` | Component.id = "billing", Component.name = "@scope/billing" |
| CD8 | 2 workspace が同 id (両方 "shared") を生成 | サフィックス付加 ("shared-apps" / "shared-packages") |
| CD9 | `dependencies: {"@nestjs/core": "..."}` | frameworks = ["nestjs"] |
| CD10 | `package.json#exports: {".": "./src/index.ts"}` | publicApi = ["src/index.ts"] |
| CD11 | autodetect が何も検出しない & package.json も無い | id = ディレクトリ名 (kebab-case)、name = ディレクトリ名 |
| CD12 | autodetect 後 config.components で override | config が勝つ (config.md §6.1) |
| CD13 | 同じ workspace を pnpm と nx の両方が検出 | dedupe で 1 Component |

## 11. 設計上の決定事項

### 11.1 workspace root を最外周にする理由

複数階層で marker が見つかる場合 (e.g., monorepo 内の sub-project にも `package.json` がある)、内側を root にすると monorepo 全体の構造を取り逃す。最外周を root にすることで、想定外の subset 検出を避ける。

### 11.2 framework plugin の自動有効化を避ける理由

[`config.md`](config.md) §15.1 と同じ理由: rogue 依存・予測不能挙動・追跡困難。検出した framework 名を Component に記録するだけにとどめ、plugin 有効化はユーザー判断 (`aburi init` が候補を console に提案する程度)。

### 11.3 id 推定で package.json name を最優先する理由

monorepo の package.json name は人間が意図して付けた識別子。ディレクトリ名は変わりやすい (リファクタリングで apps → workspaces に rename 等)。package.json name を優先することで Component id が path 変化に強くなる。

### 11.4 単一プロジェクトでも 1 Component を必ず作る理由

「Component が 0 個」状態を許すと、IR 全体の構造が壊れる (Symbol が `component: null` になる)。常に 1 つ以上の Component を保証することで、Markdown projection / diff が単純化される。

### 11.5 言語別 detector を v0.2 以降にする理由

v0.1 は TS only。lang-typescript プラグイン以外が無い状態で多言語 detector を整備しても使われない。各言語プラグインが追加されるタイミングで対応 detector も同時提供する方が責務が明確。

### 11.6 publicApi 自動推定の限界

`package.json#exports` で表現された公開 API は「ファイル単位」で、シンボル単位の細かい指定はできない (Aburi の `publicApi[]` は glob または symbol id を許容)。
v0.1 はファイル glob 出力にとどめ、シンボル単位のフィルタが必要なら config で手動指定してもらう。

将来、各 language plugin の `extractSymbols` 結果と `package.json#exports` をクロス参照して、`publicApi: ["ts:src/index.ts#Invoice", "ts:src/index.ts#createInvoice"]` のような symbol-level 出力に拡張する余地を残す。
