# CLI 仕様

`aburi` コマンドの全シグネチャ・フラグ・引数・exit code・stdout/stderr 規約。

参照:
- [`config.md`](config.md) — 設定ファイルの解決と CLI フラグによる上書き
- [`diff-algorithm.md`](diff-algorithm.md) — `aburi diff` の入力供給方法
- [`markdown-projection.md`](markdown-projection.md) — 出力 Markdown 規約
- [`extension-vocab.md`](extension-vocab.md) — `aburi vocab` の対象

---

## 1. 目的

Aburi の唯一の入口。すべての機能はサブコマンド経由で公開する。

設計原則:
- **CI で自動化しやすい**: 安定 exit code、JSON 出力可、非対話デフォルト
- **人間にも親切**: 適切な help、色付き、進捗表示
- **Unix 慣習に従う**: stdout/stderr 分離、長/短オプション、env var

## 2. コマンド一覧

```
aburi init                                  # 設定ファイル生成
aburi scan                                  # IR 生成
aburi diff <base>..<head>                   # 差分計算
aburi explain <id-or-pattern>               # 単体シンボル/ファイル表示
aburi vocab list|effects|extkinds|plugins|who-owns   # 拡張語彙照会
aburi --version / aburi -v                  # バージョン
aburi --help / aburi -h                     # 全体ヘルプ
```

## 3. 共通オプション

全コマンドで使える:

| オプション | 短縮 | 意味 |
|---|---|---|
| `--cwd <path>` | — | 作業ディレクトリを変更 (config 解決の起点) |
| `--config <path>` | — | 設定ファイルの場所を明示指定 |
| `--log-level <level>` | — | `debug` / `info` / `warn` / `error` (default: `info`) |
| `--no-color` | — | 色付き出力を無効化 |
| `--help` | `-h` | コマンド固有ヘルプを表示 |

トップレベル限定:
| オプション | 短縮 | 意味 |
|---|---|---|
| `--version` | `-v` | バージョン表示 |

## 4. `aburi init`

autodetect 結果から `aburi.json` を生成する。

### 4.1 シグネチャ

```
aburi init [--output <path>] [--force] [--with-suggestions]
```

### 4.2 オプション

| オプション | 意味 |
|---|---|
| `--output <path>` | 出力先 (default: `./aburi.json`) |
| `--force` | 既存ファイルを上書き |
| `--with-suggestions` | 検出された framework に対応する plugin の有効化候補を JSONC コメントで含める |

### 4.3 挙動

1. workspace root を検出 ([`component-detect.md`](component-detect.md) §2.1)
2. 各 detector を実行 (§3)
3. 結果を Component 候補に変換
4. JSON を生成、`--output` に書き出し
5. stdout に概要を出す

### 4.4 既存ファイルがある場合

- `--force` なし → エラー終了 (exit 2)、`--force を使うか別 path を指定してください`
- `--force` あり → 上書き、警告を stderr に

### 4.5 exit code

| code | 意味 |
|---|---|
| 0 | 生成成功 |
| 1 | autodetect 失敗 (権限など) |
| 2 | 既存ファイルあり + `--force` なし、または不正な `--output` |

### 4.6 stdout 出力例

```
✓ Detected 3 components (pnpm workspaces)
✓ Detected 2 languages: ts, tsx
✓ Detected 1 framework: nestjs (in apps/billing)
✓ Wrote ./aburi.json

Next steps:
  1. Install lang plugin: pnpm add -D @aburi/lang-typescript
  2. Install framework plugin (optional): pnpm add -D @aburi/framework-nestjs
  3. Install effect plugins (optional): pnpm add -D @aburi/effects-prisma
  4. Enable them in aburi.json (uncomment the suggested entries)
  5. Run: aburi scan
```

`--with-suggestions` を渡すと、検出 framework に対応する公式 plugin の install/enable 行を `aburi.json` に **コメントアウト状態で含める**。ユーザーがコメント解除すれば即有効化できる:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "languages": ["lang-typescript"],
  // Detected: nestjs. Install with: pnpm add -D @aburi/framework-nestjs
  // "frameworks": ["framework-nestjs"],
  "components": [/* ... */]
}
```

## 5. `aburi scan`

ワークスペースをスキャンして IR を生成する。

### 5.1 シグネチャ

```
aburi scan [--output-dir <path>] [--format <json|md|both>] [--no-md|--no-json]
           [--strict|--no-strict] [--discover]
           [--quiet] [--compact]
           [--concurrency <n>]
           [--no-respect-gitignore]
           [--ignore <glob>]
```

### 5.2 オプション

| オプション | 意味 |
|---|---|
| `--output-dir <path>` | 出力ディレクトリ (default: `config.output.dir` or `out`) |
| `--format <json\|md\|both>` | 出力形式 (default: `both`) |
| `--no-md` | `--format json` のショートカット |
| `--no-json` | `--format md` のショートカット |
| `--strict` / `--no-strict` | `config.strict` を上書き |
| `--discover` | `--no-strict` + 未宣言 vocab を `out/aburi-vocab-discovered.json` に記録 |
| `--quiet` | 進捗表示を抑制、stdout は最終サマリのみ |
| `--compact` | JSON を 1 行にコンパクト化 |
| `--concurrency <n>` | パーサ並列数 (default: CPU - 1) |
| `--no-respect-gitignore` | `config.respectGitignore: false` 相当 |
| `--ignore <glob>` | `config.ignore[]` に追加 (繰り返し指定可) |

### 5.3 挙動

1. config を解決
2. plugin を load、registry 構築
3. workspace を走査、各ファイルを並列パース
4. 抽出パイプライン: drop list → tag propagation → effect classification → fingerprint → Symbol 確定
5. `<output-dir>/ir.json` + `<output-dir>/workspace.md` + `<output-dir>/components/*.md` を書き出し
6. stdout に最終サマリを 1 行

### 5.4 exit code

| code | 意味 |
|---|---|
| 0 | 抽出成功 |
| 1 | 抽出エラー (ファイルアクセス・unrecoverable parse error の連鎖) |
| 2 | config エラー (schema 違反・解決失敗) |
| 3 | plugin エラー (load 失敗・manifest 違反・未宣言 vocab を strict mode で検知) |

### 5.5 stdout 出力例

```
✓ Loaded 3 plugins (1 lang, 1 framework, 1 effects)
✓ Parsed 1234 files in 12.4s
✓ Extracted 542 kept · 87 dropped symbols
✓ Wrote out/ir.json + out/workspace.md + 3 component files
```

`--quiet` 時は最後の 1 行のみ:
```
542 kept · 87 dropped · 3 components
```

### 5.6 stderr (warnings)

```
⚠ Plugin "effects-prisma" emitted undeclared id "x-prisma:bulk-delete" (use --discover to record)
⚠ Parse failed (recoverable): apps/legacy/old.ts:42 — Unexpected token
```

## 6. `aburi diff`

2 つの IR を比較。

### 6.1 シグネチャ

```
aburi diff <base>..<head>                                  # git ref を指定
aburi diff --base <ir.json> --head <ir.json>               # 既存 IR を直接指定
```

### 6.2 オプション

| オプション | 意味 |
|---|---|
| `--base <path>` | base IR ファイルパス (ref 指定の代わり) |
| `--head <path>` | head IR ファイルパス |
| `--output-dir <path>` | diff.json / diff.md の出力先 |
| `--format <json\|md\|both>` | 出力形式 |
| `--filter <kinds>` | カンマ区切りの change kind 限定 (`added,removed,changed,moved,moved+changed`) |
| `--fail-on <kinds>` | 指定 kind (status 粒度) の変更が 1 件でもあれば exit 3 (CI gate 用) |
| `--quiet` | stdout を最終サマリ 1 行のみに |

### 6.3 引数

ref 指定形式:
- `main..HEAD` — base=main, head=HEAD
- `v1.0.0..v1.1.0` — タグ比較
- `abc123..def456` — commit 直接指定

git が利用できない場合は `--base / --head` ペアで既存 IR ファイルを渡す。

### 6.4 挙動

ref 指定時:
1. **事前検証** (§6.4.1)
2. git worktree を一時作成、base ref を check out
3. base で `aburi scan` を実行、IR を一時保存
   - **使用する config**: **head 側の `aburi.json`** を base scan にも適用する (head の view で base を解釈する。base に古い config が残っていても無視)
   - 理由: base ref に当時の config を使うと「config 変更 = IR 全変化」となり diff が壊れる。head 視点で固定すると config 差は自動的に解決される
   - 上書きしたい場合は将来 `--base-config <path>` を提供 (v0.2 検討)
4. head (元の cwd) で `aburi scan` を実行
5. 2 IR を比較し diff を計算 ([`diff-algorithm.md`](diff-algorithm.md))
6. `<output-dir>/diff.json` + `<output-dir>/diff.md` を書き出し
7. stdout に summary 1 行
8. worktree を片付け

ファイル指定時: 1-3 を skip、5 から開始。

### 6.4.1 git 事前検証 (ref 指定時)

worktree 作成前に以下を順に確認し、失敗時は exit 1 + 具体的な remediation メッセージを stderr に出す:

| チェック | 失敗時メッセージ |
|---|---|
| `git rev-parse <base>` が成功する | `Base ref '<base>' not found. If this is a CI shallow clone, run: git fetch --deepen=50 origin <base>` |
| repository が shallow ではない (`git rev-parse --is-shallow-repository` が `false`) | `Repository is shallow. aburi diff requires base ref history. Run: git fetch --unshallow` |
| sparse-checkout が無効 (`git config core.sparseCheckout` が `false` or 未設定) | `Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable` |
| `git submodule status` が空 (v0.1 は submodule 非対応) | `Submodules detected: <list>. v0.1 does not support submodule-aware diff.` (warning、続行) |
| Windows でシンボリックリンクを含む base ref かを試走 | `Symbolic links in working tree may fail to materialize in worktree on Windows.` (warning、続行) |

#### 6.4.1.5 base ref における plugin 依存解決

`aburi diff <base>..<head>` で base ref をスキャンする際、Aburi は **head の `node_modules` を共有** する (worktree は base のソースを別 path に展開するだけで、依存解決は元 cwd の `node_modules` を使う)。

- **理由**: §6.4 で「head の `aburi.json` を base scan にも適用」と決めたため、plugin set も head 由来。base scan のために base ref の `package.json` から再 install するとビルド時間が爆発し、shallow clone では `--frozen-lockfile` が機能しない
- **既知の制約**: base ref のソースが head の plugin で抽出可能でないケース (例: base が古い framework version の構文を持ち、head の framework plugin が新版本のみ対応) では parse/抽出が失敗する可能性
  - これは「IR generator は head 環境で固定」という設計の帰結
  - 失敗時は該当ファイルが skip され warning log
- 「base ref に当時の plugin set を適用したい」要求は v0.2 以降で `--base-plugins <path>` を検討

#### 6.4.2 GitHub Actions ガイダンス

`aburi diff` を CI で使う際の必須設定:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0    # full history (shallow だと aburi diff が失敗)
```

または `fetch-depth: 50` 以上で base ref が含まれる深さ。デフォルト `1` は使えない。

### 6.5 exit code

| code | 意味 |
|---|---|
| 0 | diff 計算成功 (差分の有無は問わない) |
| 1 | 計算エラー (IR 不正・git エラー) |
| 2 | 引数エラー (`<base>..<head>` 構文違反・`--base/--head` の片方欠落) |
| 3 | `--fail-on` 該当変更が検出された (CI gate) |

### 6.6 stdout 出力例

通常:
```
+5 -3 ~12 ↔2 ⤴1   (added · removed · changed · moved · moved+changed)
→ out/diff.md
```

`--quiet`:
```
+5 -3 ~12 ↔2 ⤴1
```

### 6.7 `--fail-on` の用途

CI で「特定 status の変更が含まれる PR はマージ前に承認必須」のようなゲートに使う:

```bash
aburi diff main..HEAD --fail-on changed,removed
# status が "changed" または "removed" のシンボルが 1 件でもあれば exit 3
```

#### 受け付ける値 (v0.1)

| 種類 | 値 |
|---|---|
| Status 粒度 | `added` / `removed` / `changed` / `moved` / `moved+changed` / `dropped-toggled` |
| Delta 粒度 | `api-changed` / `logic-changed` / `syntax-changed` |
| Direction 粒度 | `dropped-toggled:to-dropped` / `dropped-toggled:to-kept` |
| 件数閾値 | `<value>:><N>` (例: `dropped-toggled:>10` で 10 件超のとき発火) |

カンマ区切りで複数指定可能。

#### Direction 別 fail-on の用途

`--fail-on dropped-toggled:to-kept` は「これまで dropped 扱いだったシンボルが kept になった」検知に使う。drop ルール緩和の意図的レビューに有用。
逆 `dropped-toggled:to-dropped` は「kept だったものが dropped 化した」検知 (DTO 統合の影響範囲確認等)。

#### 件数閾値の用途

drop ルール変更で `dropped-toggled` が大量発火するのが正常なケース (DTO 全変更等) では、単純な `--fail-on dropped-toggled` は誤発火する。`--fail-on dropped-toggled:>50` で「50 件超のときのみ block」のような閾値が現実的。

#### 評価規則

- Status 粒度 (`changed` 等): 該当 status の Symbol が 1 件でもあれば発火
- Delta 粒度 (`api-changed` 等): status が `changed` または `moved+changed` で、対応する `delta.<axis>Changed: true` が 1 件でもあれば発火

例:

```bash
aburi diff main..HEAD --fail-on api-changed
# delta.apiChanged: true のシンボルが 1 件でもあれば exit 3
# logic だけ変わった changed や、moved (status のみ) は影響しない

aburi diff main..HEAD --fail-on api-changed,removed,dropped-toggled
# API 変更 OR 削除 OR drop 規則変動 で発火
```

これにより CI gate を細粒度に設定でき、「API 変更だけ承認必須、logic 変更は warning」のような運用が v0.1 から可能。

## 7. `aburi explain`

単体 Symbol / ファイル / パターンマッチの詳細を表示。

### 7.1 シグネチャ

```
aburi explain <id-or-pattern> [--output <path>] [--ir <path>] [--no-rescan]
```

### 7.2 引数

`<id-or-pattern>` は次のいずれか:
- **完全 Symbol id** — 文字列に `#` を含み、`<language>:<path>#<qname>` 形式に一致 → 直引き
- **ファイルパス** — 文字列に `/` を含み、`#` を含まない、existing file → 該当ファイルの全 Symbol を表示
- **部分一致パターン** — 上のいずれにも該当しない場合 → 各 Symbol の qualified name (`Symbol.name`) に対して **case-sensitive substring match** で候補を集める

#### 7.2.1 部分一致の正確な定義 (v0.1)

- **case-sensitive** (`getUser` と `getuser` は別物)
- **substring match** on `Symbol.name` のみ (= qualified name 全体に対する部分一致、`Service.create` で `InvoiceService.createInvoice` がヒット)
- **glob 不対応** (`*Service` のような pattern は v0.2 で検討)
- 候補が複数なら exit 2 + 候補リスト stdout

### 7.3 オプション

| オプション | 意味 |
|---|---|
| `--output <path>` | ファイル書き出し (default: stdout) |
| `--ir <path>` | 既存 IR ファイルを使う (default: `out/ir.json` がなければ scan を起動) |
| `--no-rescan` | IR ファイルが古くても再 scan しない |

### 7.4 挙動

1. IR を読む (なければ `aburi scan` を内部呼び出し)
2. 引数を解決:
   - 完全 id → 直引き
   - ファイル → そのファイルの Symbol 全件
   - パターン → name 部分一致で候補を集める
3. Markdown projection ([`markdown-projection.md`](markdown-projection.md) §7) を生成
4. stdout (or `--output`) に出す

### 7.5 候補が複数あるとき

```
Multiple matches for "createInvoice":
  1. ts:apps/billing/src/InvoiceService.ts#InvoiceService.createInvoice
  2. ts:apps/billing/src/legacy/OldService.ts#OldService.createInvoice
  3. ts:packages/test/src/factories.ts#createInvoice

Specify the full id to disambiguate.
```

exit code: 2 (ambiguous).

### 7.6 exit code

| code | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 引数の symbol が見つからない |
| 2 | 候補が複数あり disambiguation 必要 |

## 8. `aburi vocab`

登録された拡張語彙の照会。

### 8.1 サブコマンド

```
aburi vocab list                            # 全 vocab
aburi vocab effects                         # effect id のみ
aburi vocab extkinds                        # extKind のみ
aburi vocab plugins                         # plugin 一覧
aburi vocab who-owns <id>                   # この id の所有 plugin
```

### 8.2 共通オプション

| オプション | 意味 |
|---|---|
| `--json` | テーブル表示の代わりに機械可読 JSON 出力 |

### 8.3 exit code

| code | 意味 |
|---|---|
| 0 | 成功 |
| 1 | id が見つからない (who-owns のみ) |
| 2 | サブコマンド指定なし or 不正 |

### 8.4 出力例

`aburi vocab effects`:
```
core / db.read           — Database read operation
core / db.write          — Database write operation
...
effects-nest / x-nest:lifecycle.on-module-init      — NestJS OnModuleInit hook
effects-prisma / (prefix x-prisma)                  — Prisma plugin namespace
```

`aburi vocab who-owns x-nest:lifecycle.on-module-init`:
```
Plugin:      effects-nest (v1.0.0)
Type:        effects
Declaration: explicit (provides.effects[])
Description: NestJS OnModuleInit hook
```

## 9. exit code 規約 (全コマンド共通)

| code | 用途 |
|---|---|
| 0 | 完全成功 |
| 1 | 実行時エラー (IO・抽出・git) |
| 2 | 入力エラー (CLI 引数 / config / 未指定 / 曖昧) |
| 3 | plugin エラー / fail-on ゲート / strict 違反 |

128+N は致命的シグナル (Aburi 自身は使わない)。

## 10. stdout / stderr 規約

| ストリーム | 用途 |
|---|---|
| stdout | 結果 (summary 行・JSON・Markdown 本体)。pipe 可能、CI parse 対象 |
| stderr | 進捗・警告・エラーメッセージ・色付き UI |

例: `aburi diff main..HEAD --quiet > result.txt 2> log.txt`

`--json` フラグ (`aburi vocab` のみ) は stdout を機械可読 JSON 専用にする。

## 11. 環境変数

| 変数 | 意味 |
|---|---|
| `ABURI_CONFIG` | config ファイルパス (--config と同等) |
| `ABURI_LOG_LEVEL` | --log-level と同等 |
| `NO_COLOR` | 値があれば色付け off (標準慣習) |
| `FORCE_COLOR` | 値があれば色付け強制 on (標準慣習) |
| `CI` | 値があれば CI mode (§12) |

CLI フラグ > 環境変数 > config ファイル の優先度。

## 12. CI mode

`CI=true` env 検出時の自動切り替え:

- 進捗アニメーションを抑制 (最終サマリのみ)
- 色付けを off (`FORCE_COLOR` あれば on)
- エラー時にスタックトレースを出す (debug 時のみ)

明示 `--ci` フラグでも有効化可能 (env が立っていない CI 環境用)。

## 13. config 解決順序

```
1. --config CLI フラグ
2. ABURI_CONFIG env
3. <cwd>/aburi.jsonc
4. <cwd>/aburi.json
5. 親ディレクトリで 3-4 を再帰探索 (workspace root まで)
6. autodetect (config 不在で動く)
```

`--cwd` を渡すと cwd が変わるため探索起点も変わる。

## 14. 並列性

- `aburi scan` のパーサ並列数: default = `max(1, CPU_count - 1)`
- `--concurrency <n>` で上書き
- 実効並列数は `min(指定値, floor(availableMemoryMB / wasmHeapPerWorkerMB))` で抑制される ([`lang-plugin.md`](lang-plugin.md) §8.1)
  - WASM heap 予算超過で落ちるのを防ぐためのガード
  - worker あたり予算は **plugin manifest の `capabilities.wasmHeapPerWorkerMB`** が source-of-truth (range: 16–4096 MiB、未宣言時 256 MiB)
  - 同 run に複数 lang plugin が混在するときは宣言値の **最大** を採用する
- メモリ制約のある CI では `--concurrency 1` を推奨 (debug 用)

将来 (v0.2 以降): worker pool ではなく Node worker_threads を使う。

## 15. 将来予定 (v0.2 以降)

| 機能 | 概要 |
|---|---|
| `aburi watch` | ファイル変更を監視して IR を再生成 |
| `aburi doctor` | config / plugin の整合性チェック |
| `aburi serve` | LSP-like local server (IDE 連携) |
| `aburi vocab list --json` 拡張 | merged with discoverer output |

v0.1 では上記未実装。シグネチャだけ予約しておき、将来の互換性 break を避ける。

## 16. ヘルプ出力

`aburi --help`:

```
aburi - Render meaningful code structure as IR for review

Usage:
  aburi <command> [options]

Commands:
  init       Generate aburi.json from autodetect
  scan       Generate IR from current workspace
  diff       Compute diff between two IRs
  explain    Show single symbol details
  vocab      Show registered extension vocabulary

Common options:
  --cwd <path>           Set working directory
  --config <path>        Override config file location
  --log-level <level>    debug | info | warn | error
  --no-color             Disable colored output
  -h, --help             Show help for command
  -v, --version          Show version

Run "aburi <command> --help" for command-specific options.
```

各コマンドの `--help` も同様に「Usage / Options / Examples」の 3 セクション構成。

## 17. 検証可能な性質

| ID | 入力 | 期待 |
|---|---|---|
| CL1 | `aburi --version` | バージョン文字列を 1 行出力、exit 0 |
| CL2 | `aburi --help` | 全コマンド help、exit 0 |
| CL3 | `aburi nope` | 不明コマンド、exit 2 |
| CL4 | `aburi init` 既存 aburi.json あり | exit 2、エラー文言 stderr |
| CL5 | `aburi init --force` | 既存上書き、exit 0、警告 stderr |
| CL6 | `aburi scan` (config なし)  | autodetect で動く、exit 0 |
| CL7 | `aburi scan --discover` | undeclared vocab を記録、exit 0 |
| CL8 | `aburi scan` strict + 未宣言 vocab | exit 3 |
| CL9 | `aburi diff main..HEAD --fail-on changed` 変更あり | exit 3 |
| CL10 | `aburi diff` 引数欠落 | exit 2 |
| CL11 | `aburi explain <ambiguous>` | exit 2、候補リストを stdout |
| CL12 | `aburi vocab who-owns <unknown>` | exit 1 |
| CL13 | `aburi vocab list --json` | machine-readable JSON、exit 0 |
| CL14 | stdout を pipe で受ける (`aburi scan --quiet | wc -l`) | エスケープなしで読める |
| CL15 | `NO_COLOR=1 aburi scan` | 色付けなし |
| CL16 | `CI=true aburi scan` | 進捗アニメ抑制 |
| CL17 | `--log-level debug aburi diff` エラー時 | スタックトレース stderr |
| CL18 | `aburi --config ./custom.json scan` | 指定 config を使用 |

## 18. 設計上の決定事項

### 18.1 ステータス系 exit code を 3 つに絞る

0 / 1 / 2 / 3 の 4 値のみ。Linux 慣習を尊重しつつ、CI gate (`--fail-on`) のためのコードを 3 で予約。
細分化された exit code は consumer の負担を増やすので避ける。

### 18.2 stdout / stderr 厳格分離

CI で `2>/dev/null` や `> result.txt` を使ったときに混乱しないため、進捗・警告はすべて stderr。
結果データ (summary / JSON / Markdown) のみ stdout。

### 18.3 `--fail-on` を v0.1 から入れる理由

CI ゲートはレビュー導入時に最も価値が出る機能。「危険な変更で PR を自動ブロック」が成立すると Aburi の採用が一気に進む。後付けすると CI 設定の書き直しが必要なので最初から提供。

### 18.4 `aburi diff` の git worktree を使う理由

base ref を check out すると現在の作業内容を退避する必要があり、誤って commit してない変更を失う事故がある。git worktree なら head の作業ディレクトリを保ったまま base を別 path で展開できる。

### 18.5 `aburi explain` の部分一致対応

完全 id を毎回タイプするのは負担。部分一致で候補を返し、複数なら disambiguation する UX が現実的。
ID 衝突がない大半のケースでは 1 hit、ambiguous は明示エラー。

### 18.6 `aburi vocab` を独立サブコマンドにする理由

vocab は IR とは独立した照会対象。`aburi scan --show-vocab` のような flag より、`aburi vocab` 単独コマンドの方が discoverability が高い (helper の help にも単独表示される)。

### 18.7 環境変数を CLI フラグの代替にする理由

CI / Docker / Makefile では env で設定する方が flag を渡し回すより楽。標準慣習 (`NO_COLOR` / `CI`) を尊重し、Aburi 独自の env (`ABURI_*`) も用意。

### 18.8 v0.2 機能の予約理由

`aburi watch` / `aburi doctor` / `aburi serve` の名前を v0.1 で「予約」しておくことで、将来追加時に名前衝突や互換性 break が起きないようにする。実装はしないが docs に記載。
