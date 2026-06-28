# Roadmap

Aburi のバージョン別スコープと進行計画。詳細設計 (D1-D11) は確定済み。本ドキュメントは「どの版で何を出すか」のみ扱う。
実装の進め方・パッケージ分割・作業ブレークダウンは [`implementation-plan.md`](implementation-plan.md) を参照。

詳細設計の所在: [`design/details/`](details/) / スキーマ: [`schema/`](../schema/)。

---

## 確定設計成果物

| ID | 内容 | 文書 |
|---|---|---|
| D1 | IR schema 完全定義 | [`details/ir-schema.md`](details/ir-schema.md) + [`../schema/aburi.ir.v1.json`](../schema/aburi.ir.v1.json) |
| D2 | 言語プラグイン IF | [`details/lang-plugin.md`](details/lang-plugin.md) |
| D3 | 効果プラグイン IF | [`details/effect-plugin.md`](details/effect-plugin.md) |
| D4 | Fingerprint 計算式 | [`details/fingerprint.md`](details/fingerprint.md) |
| D5 | Component autodetect | [`details/component-detect.md`](details/component-detect.md) |
| D6 | Diff アルゴリズム | [`details/diff-algorithm.md`](details/diff-algorithm.md) + [`../schema/aburi.diff.v1.json`](../schema/aburi.diff.v1.json) |
| D7 | 拡張語彙の登録機構 | [`details/extension-vocab.md`](details/extension-vocab.md) + [`../schema/aburi.plugin.v1.json`](../schema/aburi.plugin.v1.json) |
| D8 | Drop list の標準セット | [`details/drop-list.md`](details/drop-list.md) |
| D9 | Markdown projection 規約 | [`details/markdown-projection.md`](details/markdown-projection.md) |
| D10 | CLI 仕様 | [`details/cli-spec.md`](details/cli-spec.md) |
| D11 | Config schema | [`details/config.md`](details/config.md) + [`../schema/aburi.config.v1.json`](../schema/aburi.config.v1.json) |

全文書は contextless で読めることを保証している。実装で参照する際は文書内 §番号を必ず明示する。

---

## v0.1: MVP

PR レビュー用途で価値検証する最小構成。

### スコープに含むもの

- **言語**: TypeScript のみ (`.ts` / `.tsx`)
- **パーサ**: Tree-sitter WASM (`web-tree-sitter` + `@vscode/tree-sitter-wasm`)
- **Workspace 検出**: pnpm-workspaces / npm workspaces (autodetect)
- **Framework hint**: NestJS / Next.js (App Router) — 2 plugin
- **抽出**: drop list + 局所効果検出 + Rule + Boundary
- **コマンド**: `aburi init` / `aburi scan` / `aburi diff <base>..<head>` / `aburi explain`
- **Diff**: `added` / `removed` / `moved` / `changed` / `moved+changed` / `dropped-toggled` の 6 ステータス全て
- **出力**: JSON IR + Markdown projection (L1 + L2)
- **配布**: `@aburi/cli` + `@aburi/github-action`

### スコープ外

- LSP enrichment / 効果伝播 / L0 workspace overview (mermaid) / Slice View
- TS 以外の言語
- LLM 連携 / グラフ可視化

---

## v0.2: 効果伝播と縦軸

### 追加するもの

- **効果伝播**: シンボル呼び出しグラフを構築し、`prisma.invoice.create` を呼ぶメソッドを呼ぶメソッドにも `db.write` を伝播
- **Symbol 間 Dependency**: IR の `dependencies[]` に symbol → symbol エッジを追加 (v0.1 は component → component のみ)
- **Slice View**: PR の変更シンボル集合を呼び出しグラフで連結成分にクラスタリング、Markdown で縦切り表示
- **L0 workspace overview**: monorepo 全景を mermaid graph で出力
- **LSP optional enrichment**: 型解決を使った効果推論精度向上 (`SourceRange.startColumn` / `endColumn` 補完含む)
- **追加 framework**: React 関数コンポーネント / Express middleware
- **追加効果プラグイン**: `@aburi/effects-prisma` / `@aburi/effects-drizzle` / `@aburi/effects-trpc`

### 着手前に必須の詳細設計

- `details/call-resolution.md` — 呼び出し解決 (型なし環境/LSP 環境両方)
- `details/effect-propagation.md` — 伝播ルール
- `details/slice-view.md` — クラスタリングアルゴリズム選定 (graph SCC か Louvain か)
- `details/lsp-enrichment.md` — LSP との通信 / フォールバック規約

### スコープ外

- TS 以外の言語
- 関数型言語の `fp:*` 拡張語彙の実装

---

## v1.0: 多言語

### 追加するもの

- **言語プラグイン**: Python (`@aburi/lang-python`) / Go (`@aburi/lang-go`)
- **Workspace 検出拡張**: uv / poetry / cargo / go.work
- **言語横断 IR**: 同 monorepo 内で TS + Python + Go を統一スキーマで出力 (`components[].languages` で複数言語を持つ)
- **効果プラグイン拡張**: `@aburi/effects-django` / `@aburi/effects-fastapi` / `@aburi/effects-sqlalchemy` / `@aburi/effects-gorm`
- **大規模 monorepo 対応**: worker pool による並列パース、>1000 ファイル `aburi scan` を 30 秒以内
- **関数型言語プラグイン (実証)**: Scala または Rust 1 言語、`fp:match` / `fp:adt` 拡張語彙の実装

### 着手前に必須の詳細設計

- `details/multi-language-id.md` — 言語横断の symbol ID 衝突回避と相互参照
- `details/performance.md` — 並列化アーキテクチャ
- `details/fp-extension-impl.md` — `fp:*` 拡張語彙の具体仕様

---

## v1.x 以降の検討候補 (未確定)

- Aburi 自身を MCP server 化し、AI コーディングエージェントから直接呼び出せるようにする
- IR の差分を `aburi review` で AI に投げ、自動レビューコメント生成 (Aburi は IR の生成のみ、レビューは別ツール経由)
- Slice View の自動命名 (現状はクラスタ ID のみ、名前は人間 or LLM)
- Web UI で IR を可視化
