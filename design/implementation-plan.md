# Implementation Plan (v0.1)

詳細設計 D1-D11 が確定した状態から v0.1 リリースに至るまでの実装作業計画。
TDD (t_wada style) を全 work item に適用する。`Design → AC → Test → Impl → Iterate` の順序を破らない。AC は対応する D 系ドキュメント §9/§10 の「検証可能な性質」が出発点となる。

参照: [`roadmap.md`](roadmap.md) (バージョン別スコープ)、[`details/`](details/) (詳細設計)、[`../schema/`](../schema/) (JSON Schema)。

---

## 1. リポジトリ構造

monorepo を採用 (pnpm workspace)。理由は次の通り:
- 全パッケージで同一 TS / Vitest / Biome 設定を共有
- `@aburi/types` を全パッケージから参照する依存構造
- ローカル開発で plugin と core を同時にいじる頻度が高い
- 公開 npm パッケージは個別 publish (changesets で管理)

```
Aburi/
├── design/
│   ├── roadmap.md
│   ├── implementation-plan.md  (本ドキュメント)
│   └── details/
├── schema/                     (公開 JSON Schema)
├── packages/
│   ├── types/                  (@aburi/types)
│   ├── plugin-registry/        (@aburi/plugin-registry)
│   ├── config/                 (@aburi/config)
│   ├── core/                   (@aburi/core)
│   ├── lang-typescript/        (@aburi/lang-typescript)
│   ├── framework-nestjs/       (@aburi/framework-nestjs)
│   ├── framework-next/         (@aburi/framework-next)
│   ├── effects-prisma/         (@aburi/effects-prisma)
│   ├── effects-nest/           (@aburi/effects-nest)
│   ├── diff/                   (@aburi/diff)
│   ├── markdown-projection/    (@aburi/markdown-projection)
│   ├── cli/                    (@aburi/cli)
│   └── github-action/          (@aburi/github-action)
├── fixtures/                   (integration test 用の擬似プロジェクト)
├── .github/workflows/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── biome.json
├── vitest.workspace.ts
└── README.md
```

---

## 2. ツールチェーン選定

| カテゴリ | 採用 | 理由 |
|---|---|---|
| ランタイム | Node.js >= 24 | 安定 ESM + Permission Model + 組込 fetch / WebStream / `node:test` 拡張 |
| 言語 | TypeScript 5.x | strict mode 全有効 |
| モジュール | ESM only (`"type": "module"`) | tree-sitter WASM が ESM 前提、CJS は除外 |
| パッケージマネージャ | **pnpm** | workspace、`pnpm-lock.yaml` 確認済み |
| バンドラ | **tsdown** (rolldown ベース) | TS → ESM、dts 生成、bin 用 shebang 対応 |
| テスト | **Vitest** | workspace、snapshot、fixture サポート |
| Linter / Formatter | **Biome** | TS + JSON + JSONC 統一 |
| 型生成 | json-schema-to-typescript | 4 つの JSON Schema → `.d.ts` 自動生成 |
| Schema 検証 | **ajv** (Draft 2020-12 strict mode) | 設計検証時点で実証済 |
| バージョニング | changesets | monorepo 個別 publish |
| パーサ | web-tree-sitter + @vscode/tree-sitter-wasm | Windows zero-build、WASM heap 管理規約 ([`details/lang-plugin.md`](details/lang-plugin.md) §8.1) |
| CLI 引数 | commander | 安定、TS 型あり、subcommand サポート |
| CI | GitHub Actions | macOS / Ubuntu / Windows matrix |

依存パッケージは CLI で都度インストールしバージョンを `package.json` に書き込ませる (CLAUDE.md 規約: hardcode 禁止)。

---

## 3. パッケージ間依存

```
            ┌──────────────┐
            │   types      │  ◀── 全パッケージ参照
            └──────┬───────┘
                   │
       ┌───────────┼──────────────────────────┐
       ▼           ▼                          ▼
  plugin-       config                      core
  registry         │                          │
       ▲           │   ┌──────────────────────┤
       │           │   │                      │
       └───────────┴───┴──────┐               │
                              ▼               ▼
                       lang-typescript    framework-*
                              │           effects-*
                              ▼
                            core (再)
                              │
                              ▼
                            diff
                              │
                              ▼
                       markdown-projection
                              │
                              ▼
                            cli
                              │
                              ▼
                       github-action
```

循環参照を作らないため:
- `core` は plugin の `@aburi/lang-typescript` 等を **動的 import**。manifest 名で解決。
- `cli` のみ全 plugin を依存に持つ (auto-install / explicit-install)。
- types は副作用なしの純型定義のみ。

---

## 4. Work Item ブレークダウン

各 work item は以下のフォーマットで管理する:
- ID, 担当パッケージ, 依存 WI, 設計参照, AC (検証可能性質), 実装ステップ

### Stage A: Foundation (前提整備)

#### WI-01: Repo / tooling 初期化
- 担当: ルート
- 依存: なし
- 設計参照: 本計画 §1, §2
- AC:
  - `pnpm install` でルート依存が解決する
  - `pnpm -r build` が空 packages を all green で抜ける
  - `pnpm -r test` が空 packages を all green で抜ける
  - `pnpm -r check` (Biome) が all green
  - tsconfig.base.json の strict 系オプション全有効
- 手順:
  1. `pnpm init`、`pnpm-workspace.yaml` 設定 (`packages/*`)
  2. `pnpm add -D -w` で typescript / vitest / @biomejs/biome / tsdown / @changesets/cli / ajv / json-schema-to-typescript をインストール
  3. tsconfig.base.json, biome.json, vitest.workspace.ts, .editorconfig 配置
  4. ルート package.json scripts: `build` / `test` / `check` / `typecheck`
  5. `.gitignore` (node_modules, dist, .turbo 等)
  6. `pnpm dlx changeset init`

#### WI-02: `@aburi/types`
- 担当: packages/types
- 依存: WI-01
- 設計参照: [`details/ir-schema.md`](details/ir-schema.md), [`details/config.md`](details/config.md), [`details/extension-vocab.md`](details/extension-vocab.md), [`details/diff-algorithm.md`](details/diff-algorithm.md)
- AC:
  - 4 つの公開 JSON Schema から型定義が再生成可能 (`pnpm --filter @aburi/types codegen`)
  - 出力された `dist/ir.d.ts` 等から `import type { IR, Symbol, DiffResult, Config, PluginManifest } from '@aburi/types'` で参照できる
  - 純型のみで runtime コードゼロ
- 手順:
  1. `scripts/codegen.ts` で `schema/aburi.*.json` 4 ファイルを `json-schema-to-typescript` で `.ts` 化
  2. 手書きの補助型 (`LanguageCapabilities`、`LanguagePlugin`、`EffectPlugin`、`FrameworkPlugin` の関数シグネチャ) を別ファイルに分けて export
  3. tsdown で dts のみ出す (`emit: 'dts'`)

#### WI-03: `@aburi/plugin-registry`
- 担当: packages/plugin-registry
- 依存: WI-02
- 設計参照: [`details/extension-vocab.md`](details/extension-vocab.md) §5-§7
- AC (Vitest):
  - 同名 plugin の冪等再登録は no-op
  - reserved namespace (`core` / `aburi` / `_`) 占有を拒否
  - xPrefix mismatch を拒否
  - namespace-type mismatch を拒否
  - 完全重複の id / prefix を拒否
  - prefix vs existing id の shadow を拒否
  - **prefix-prefix 包含** (`framework:acme` vs `framework:acme:jobs`) を双方向で拒否
  - `assertEffectDeclared` / `assertExtKindDeclared` が prefix 所有を尊重
- 実装: 設計修正時の参照実装と等価。TS で書き直し、ajv で manifest を検証してから `register()`。
- 公開 API: `VocabRegistry`, `RegistryError`, `loadPluginManifest(path): Promise<PluginManifest>`

#### WI-04: `@aburi/config`
- 担当: packages/config
- 依存: WI-02
- 設計参照: [`details/config.md`](details/config.md), [`details/extension-vocab.md`](details/extension-vocab.md) §11.3
- AC:
  - JSONC (line / block コメント、trailing comma) を parse
  - ajv strict で `aburi.config.v1.json` 検証
  - `frameworkHints` のキーで `hint:` 接頭辞が自動付与される
  - ユーザーが `framework:hint:*` を直接書いた場合は **拒否**
  - 設定ファイルの探索順序 (cwd → `--cwd` → 親 → workspace root → 暗黙)
- 実装: jsonc-parser + ajv

### Stage B: 抽出パイプライン

#### WI-05: `@aburi/core` 基盤
- 担当: packages/core
- 依存: WI-02, WI-03
- 設計参照: [`details/ir-schema.md`](details/ir-schema.md) §3, §14
- AC:
  - Symbol ID 生成: `<lang>:<file>#<qname>` 形式、`<anon@L42>` を生成しない、`<default>` を fail-fast 検出
  - Canonical JSON serializer: NFC 正規化、object key を codepoint sort
  - Integrity checker: 14 invariant 全件 (uniqueness、references、ordering)
  - Workspace 検出: pnpm-workspaces / npm workspaces (D5)
- モジュール構成:
  - `id.ts` — Symbol ID 生成と衝突検出
  - `canonical.ts` — JSON 正規化
  - `integrity.ts` — invariant 検査
  - `workspace.ts` — package manager autodetect
  - `component.ts` — Component autodetect (D5)

#### WI-06: `@aburi/core` fingerprint
- 担当: packages/core/src/fingerprint
- 依存: WI-05
- 設計参照: [`details/fingerprint.md`](details/fingerprint.md), [`details/ir-schema.md`](details/ir-schema.md) §5.6
- AC:
  - api / logic / syntax の 3 軸 FP がそれぞれ §3-§5 の式に従う
  - dropped シンボルは全 FP が `"000000000000"` (ZERO)
  - decorators が name codepoint asc + line asc で sort されてから hash
  - logic FP の effects は `target` のみで構成 (`id` を含まない)
  - DR1-DR16 (FP 安定性のテスト):
    - 同入力で 100% bit-identical
    - 改行のみの編集で FP 不変
    - decorator 並び替えで FP 不変
    - effect.id のみ違う 2 つで logic FP 一致
    - class rename + 同 method で api FP 一致 (shortName 比較)
- 実装: SHA-256 (Node `crypto`) → 先頭 12 hex
- `grammarRevision` の格納と FP との混在を §5.6 に従って制御

#### WI-07: `@aburi/lang-typescript` (中核)
- 担当: packages/lang-typescript
- 依存: WI-02, WI-05, WI-06
- 設計参照: [`details/lang-plugin.md`](details/lang-plugin.md), [`details/drop-list.md`](details/drop-list.md)
- AC (LP1-LPnn, [`details/lang-plugin.md`](details/lang-plugin.md) §9):
  - top-level function / class / method / interface / type alias / const の SymbolCandidate を生成
  - export / default export / namespace / module を扱える
  - JSDoc / decorator が抽出される
  - `extractSymbols` / `walkBody` / `normalizeAst` の throw が当該ファイル skip となる
  - WASM heap 規約 (parser.delete / tree.delete) に準拠
  - `capabilities.wasmHeapPerWorkerMB` を manifest に明示 (256MB)
- パーサ初期化 / cleanup の規約: `details/lang-plugin.md` §8.1
- Vitest fixture: small TS files + 期待 SymbolCandidate snapshot

#### WI-08: `@aburi/framework-nestjs`
- 担当: packages/framework-nestjs
- 依存: WI-07
- 設計参照: [`details/lang-plugin.md`](details/lang-plugin.md) §5, [`details/extension-vocab.md`](details/extension-vocab.md) §3, [`details/component-detect.md`](details/component-detect.md)
- AC:
  - `@Module` / `@Controller` / `@Injectable` の `extKind` (`framework:nestjs:module` 等) を付与
  - `@Post('/x')` 等の route decorator を boundary としてマーク
  - manifest declares `extKindPrefixes: ["framework:nestjs"]` のみ
  - module / controller / provider の有無で `frameworks: ['nestjs']` を component に自動付与

#### WI-09: `@aburi/framework-next`
- 担当: packages/framework-next
- 依存: WI-07
- 設計参照: 同上 + Next.js App Router 規約
- AC:
  - `page.tsx` / `layout.tsx` / `route.ts` の関数 export に `framework:next:page|layout|route` を付与
  - server / client component の区別 (`"use client"` directive)
  - app/ ディレクトリ配下のみを対象 (pages/ は v0.1 スコープ外)

#### WI-10: `@aburi/effects-prisma` / `@aburi/effects-nest`
- 担当: packages/effects-*
- 依存: WI-07
- 設計参照: [`details/effect-plugin.md`](details/effect-plugin.md), [`details/extension-vocab.md`](details/extension-vocab.md) §3.1
- AC:
  - prisma: `prisma.<model>.<verb>` 呼び出しを `db.write` / `db.read` に分類
  - nest: `EventEmitter2.emit` / `eventBus.emit` を `event.publish` に分類
  - `config.classifyTimeoutMs` を尊重、timeout 時に `stats.effectClassifyTimeouts[]` に記録
  - manifest type=effects、xPrefix と effects[].id の整合

### Stage C: Orchestration

#### WI-11: `@aburi/core` 抽出オーケストレーション
- 担当: packages/core/src/scan
- 依存: WI-04, WI-05, WI-06, WI-07, WI-08, WI-09, WI-10
- 設計参照: [`details/cli-spec.md`](details/cli-spec.md) §6 (`aburi scan`), [`details/component-detect.md`](details/component-detect.md), [`details/drop-list.md`](details/drop-list.md)
- AC:
  - file discovery (ignore + .gitignore 尊重 + maxFileSizeBytes)
  - 言語判定 → 適切な lang plugin 呼び出し
  - framework plugin の `extKind` を SymbolCandidate に merge
  - effect plugin の出力を merge (timeout 尊重)
  - drop-list 適用 (Cat A/B/C/D 順)
  - integrity check pass (uniqueness、ordering)
  - canonical JSON で `out/aburi.ir.json` 出力
- 並列度: `cli-spec.md` §14 (`floor(availableMemoryMB / wasmHeapPerWorkerMB)`)

#### WI-12: `@aburi/diff`
- 担当: packages/diff
- 依存: WI-02, WI-06
- 設計参照: [`details/diff-algorithm.md`](details/diff-algorithm.md)
- AC (DF1-DF18, DF14b):
  - 段 1 完全 ID 一致
  - 段 2 git rename (`git diff --find-renames`)
  - 段 3 logic FP マッチ + name disambiguation
  - 段 4 name+signature similarity (bucket pre-filter, owner similarity, kind 別 threshold)
  - 段 4.5 dropped weak matcher
  - 段 5 added / removed
  - status 判定 (dropped-toggled が最優先、§4)
  - delta 計算 (rules / effects / calls / decorators の added / removed / modified, line fuzz)
  - 出力 `out/aburi.diff.json` が `aburi.diff.v1.json` schema に適合

#### WI-13: `@aburi/markdown-projection`
- 担当: packages/markdown-projection
- 依存: WI-02
- 設計参照: [`details/markdown-projection.md`](details/markdown-projection.md), [`details/ir-schema.md`](details/ir-schema.md) §5.6
- AC:
  - L1 (component overview) / L2 (symbol detail) 出力
  - `## Dropped` 折りたたみセクション
  - confidence バッジ (high なし / medium ⚠ / low ⚠)
  - diff projection (added / removed / changed / moved / moved+changed / dropped-toggled の 6 セクション)
  - `--fail-on` 表示の文字列フォーマット

### Stage D: Interface

#### WI-14: `@aburi/cli`
- 担当: packages/cli
- 依存: WI-04, WI-11, WI-12, WI-13
- 設計参照: [`details/cli-spec.md`](details/cli-spec.md)
- AC:
  - `aburi init` が `aburi.config.jsonc` を生成 (autodetect 結果反映)
  - `aburi scan` が IR + Markdown を `out/` に出力
  - `aburi diff <base>..<head>` が git worktree 経由で base/head IR を生成し diff 出力
  - `aburi diff --base ir-base.json --head ir-head.json` で既存 IR を直接 diff
  - `aburi explain <symbol-id>` で dropped 含む full 詳細を表示
  - `--fail-on <status>` / `--fail-on dropped-toggled:to-kept` / `--fail-on <status>:>N` (count threshold)
  - exit code: 0 (no gate triggered) / 1 (gate triggered) / 2 (input error)
- bin: `dist/bin/aburi.mjs`、shebang `#!/usr/bin/env node`

#### WI-15: `@aburi/github-action`
- 担当: packages/github-action
- 依存: WI-14
- 設計参照: なし (実装規約のみ)
- AC:
  - `action.yml` (composite action) が:
    - `pnpm dlx @aburi/cli@latest` で aburi を解決
    - PR の `base` / `head` ref で `aburi diff` 実行
    - `out/aburi.diff.md` を PR comment として post (既存コメントを更新)
    - `--fail-on` の指定を渡せる
  - `action.yml` 自身は version pin せず、`@aburi/cli` のみ pin

### Stage E: 検証

#### WI-16: 統合テスト
- 担当: ルート
- 依存: WI-14, WI-15
- 設計参照: 全 D
- AC:
  - `fixtures/nestjs-billing/` (架空の NestJS monorepo) に対し:
    - `aburi init` → 期待 config snapshot 一致
    - `aburi scan` → 期待 IR snapshot 一致
    - PR シナリオ A (rule 追加): `aburi diff` → 期待 diff snapshot 一致 (`changed: 1, logicChanged: true`)
    - PR シナリオ B (DTO 増加): `--fail-on dropped-toggled:to-dropped:>10` で exit 1
    - PR シナリオ C (file move): `moved: N` で gate なし
  - fixtures は scratch project として実 TS コードを置く (PoC 試行物から流用しない、設計に従って書く)

#### WI-17: ドキュメント
- 担当: ルート
- 依存: 全 WI
- AC:
  - `README.md` (TL;DR + Quick start + Architecture overview)
  - `docs/plugin-development.md` (新 lang/effects/framework plugin の書き方)
  - `docs/cli-reference.md` (cli-spec.md から自動生成、または書き起こし)
  - 各 package の README

#### WI-18: リリース準備
- 担当: ルート
- 依存: WI-17
- AC:
  - GitHub Actions: `release.yml` (changesets pr → publish)
  - 9 公開パッケージが個別に publishable (`@aburi/types`, `plugin-registry`, `config`, `core`, `lang-typescript`, `framework-nestjs`, `framework-next`, `effects-prisma`, `effects-nest`, `diff`, `markdown-projection`, `cli`, `github-action`)
  - `npm publish --dry-run` が全パッケージで pass
  - SemVer 0.1.0 で初リリース

---

## 5. 進行順と並列性

```
A: WI-01 → WI-02 ─┬→ WI-03 ─┐
                  └→ WI-04 ─┤
                            ▼
B: WI-05 ─→ WI-06 ─→ WI-07 ─┬→ WI-08
                            ├→ WI-09
                            └→ WI-10
                            ▼
C: WI-11 ─→ WI-12 ─→ WI-13
                            ▼
D: WI-14 ─→ WI-15
                            ▼
E: WI-16
                            ▼
F: WI-17 + WI-18
```

並列性の活用:
- Stage A の WI-03 / WI-04 は WI-02 完了後に並列着手可
- Stage B の WI-08 / WI-09 / WI-10 は WI-07 完了後に並列着手可
- Stage F の WI-17 / WI-18 は並列

各 work item の commit 単位:
- WI 開始時に feature branch 作成 (例 `feature/wi-07-lang-typescript`)
- AC ごとに細かく commit (test 追加 / impl / refactor を分ける)
- WI 完了時に PR 経由で main に merge

---

## 6. TDD 適用方針 (各 WI)

各 work item で守る手順:

1. **Design 確認**: 該当 D 系ドキュメントを再読、不明点は md を更新してから着手
2. **AC 抽出**: 本計画の各 WI の AC リストを Vitest の `describe` 名に転写
3. **Test 実装**: AC を表す `test()` を一括で書き、全 `test.fails` で red を確認
4. **Implementation**: 1 test ずつ green にする
5. **Iterate**: refactor → 全 test green を保ち続ける

特例:
- Snapshot test を使う場合は、最初の snapshot は手書きの期待値を `toMatchInlineSnapshot()` で固定する。`toMatchSnapshot()` で auto-write させない (誤値固定の防止)。
- Integration test (WI-16) は fixture project を実 TS コードとして書く。ここに限り「動作確認後に snapshot 固定」を許容する。

---

## 7. CI 設計

```yaml
# .github/workflows/ci.yml (概要)
matrix: [ubuntu-latest, macos-latest, windows-latest] × [node-24]
jobs:
  - install (pnpm install --frozen-lockfile)
  - codegen (pnpm --filter @aburi/types codegen + git diff --exit-code で drift 検出)
  - check (pnpm -r check, biome)
  - typecheck (pnpm -r typecheck)
  - test (pnpm -r test)
  - build (pnpm -r build)
  - schema-validate (ajv で schema/*.json を Draft 2020-12 strict で再チェック)
  - integration (WI-16 fixtures に対する end-to-end)
```

Release workflow (`release.yml`):
- main push 時に `changeset` の有無を判定
- ある場合 PR を起票 (`Release Pull Request`)
- merge 時に `changeset publish` を実行

---

## 8. 確定済み事項

実装着手前に確定した運用ポリシー:

| 項目 | 採用 |
|---|---|
| Node target | Node.js >= 24 |
| 公開 scope | `@aburi/*` (npm 個別 publish、changesets 管理) |
| GitHub org | `kage1020/aburi` (個人) |
| `aburi explain` UI | stdout JSON (対話 TUI は v0.2 以降の検討課題) |
| Snapshot 配置 | 各 package 内 (`__snapshots__/`) |
| Lint ルール | Biome 推奨 + TS strict 系のみカスタム追加 |
| Tree-sitter grammar | `@vscode/tree-sitter-wasm` 同梱 (個別 wasm fetch しない) |

---

## 9. リスクと対策

| リスク | 対策 |
|---|---|
| Tree-sitter WASM の Windows メモリ問題再発 | WI-07 で 100 ファイルのストレステストを CI に組み込む |
| Plugin 動的ロードのバンドル不整合 | `cli` で plugin を `node:module createRequire` 経由で resolve、bundler 同梱しない |
| Snapshot drift で false fail | fixture 用 IR を `aburi scan --snapshot-update` の専用フラグでのみ更新可、CI では禁止 |
| ajv strict mode が schema 変更で壊れる | `schema-validate` CI job が独立で fail を出す |
| Plugin manifest の SemVer / aburi.engines 整合 | WI-03 で manifest 検証時に engines.aburi を実 cli version で satisfies チェック |
| Cross-platform 改行 (Windows CRLF) | Biome で改行統一、`.editorconfig` で LF 強制、git autocrlf 警告 |

---

## 10. 完了の定義 (Definition of Done)

v0.1 リリースとして「完了」とみなす条件:

- 全 18 WI 完了
- CI matrix 全 green
- 全 schema が ajv strict mode で valid
- `fixtures/nestjs-billing/` で end-to-end 動作
- 11 公開パッケージが `npm publish --dry-run` 成功
- README にインストール + 1 行コマンドサンプルが載っている
- 詳細設計 D1-D11 と実装の乖離が無いことを最終 walk-through で確認
