# Aburi

シニアエンジニアがコードレビュー時に頭の中で行う「装飾を削り、意味のある制御フロー・ドメインルール・モジュール境界だけを見る」プロセスをツールとして再現するライブラリ。

ロードマップ・バージョン別スコープは [`design/roadmap.md`](design/roadmap.md) を参照。詳細設計は [`design/details/`](design/details/) 配下。

---

## 1. 目的とユースケース

Aburi は、コード全文でも自然言語要約でもない **中間表現 (IR)** を出力する。

### 主要ユースケース
- AI 生成された大量の実装差分を、ビジネスロジック・アーキテクチャ粒度でレビューする
- 新規参加者が大規模コードベースの構造を素早く理解する
- PR 単位の変更影響を、コード行ではなく意味の差分として可視化する

### 主要な比較軸
**同プロジェクトの時系列比較** (PR diff、リリース間、過去バージョン) を一次用途として最適化する。プロジェクト間比較は副次。

## 2. 中核となる設計判断

| 判断 | 採用 | 不採用とその理由 |
|---|---|---|
| IR 形式 | JSON 固定 (Markdown は決定論的派生) | Markdown 一次 IR (機械処理 / schema validation が弱い) |
| Config 形式 | JSONC (`biome.json` 系) | TypeScript / YAML (動的ロジック不要、AI 連携前提のため静的が良い) |
| 抽出戦略 | 「削る」を主・「残す」を従 | 「残すべきもの」のみ定義 (装飾は有限、ロジックは無限) |
| パーサ層 | Tree-sitter コア常駐 + LSP オプショナル enrichment | LSP のみ (CI 不安定・言語別差分大) |
| 構造解釈 | 静的ヒューリスティック + シンボルグラフ | LLM 判定 (検証性 / diff 安定性が消える) |
| diff 安定性 | semantic ID + 3 層 fingerprint (`api`/`logic`/`syntax`) + rename 追跡 | 行ベース diff |
| Diff ステータス | `added`/`removed`/`moved`/`changed`/`moved+changed` | `added`/`removed` のみ (ファイル移動で信用喪失) |
| 設定哲学 | 頑健なデフォルト + 最小限の override | 詳細設定可能 (時系列比較が config 更新で壊れる) |
| 言語語彙 | コア共通語彙 + 言語拡張 (`<namespace>:<kind>`) | コア語彙のみ (関数型 ADT/match などを表現できない) |
| Confidence | categorical (`high` / `medium` / `low`) | 数値 (偽精度の温床) |
| 納品形態 | CLI + GitHub Action ラッパー同梱 | CLI 単体 / Web UI |

## 3. 出力アーキテクチャ

### 3.1 横レイヤー

```
L0: workspace overview     (依存方向・component 境界 — monorepo 全景)
L1: component architecture (公開 API・副作用境界・所属モジュール)
L2: module logic           (制御フロー・ルール・効果 — 関数/メソッド単位)
L3: symbol IR (JSON)       ← Source of Truth
```

L3 が真実。L0/L1/L2 はすべて L3 から決定論的に派生する Markdown。

### 3.2 縦軸ビュー (Slice View)

横レイヤーは「同種を束ねる」のは得意だが、Controller→Service→Repository→Migration を縦断する 1 機能追加では diff が散逸する。

**Slice View**: 変更シンボル集合を呼び出しグラフで連結成分にクラスタリングし、縦切り単位 (フィーチャ単位) で表示する。同じ L3 IR からの派生。

## 4. 抽出パイプライン

```
source files
  ↓ tree-sitter parse  (+ LSP enrich if available)
AST
  ↓ drop list (.scm クエリ + decoration callee set)
filtered AST
  ↓ tag propagation
   - Boundary:  framework decorator / exported symbol / route handler
   - Effect:    db.* / network.* / queue.* / event.* / fs.* / state.* / time.* / random / env.* / process.*
   - Rule:      guard (if + throw/return) / loop / try / switch / match / non-trivial return
   - DataModel: interface / type alias / pure DTO
   - 言語拡張:  fp:match / fp:adt / fp:effect / oop:abstract / meta:macro ...
  ↓ score & filter (タグが付かないシンボルを drop)
symbols
  ↓ normalize (callee whitespace, expression canonicalize, sort)
  ↓ fingerprint (api / logic / syntax)
L3 IR (JSON)
  ↓ project
L2 / L1 / L0 Markdown + Slice View (時系列差分用)
```

詳細は [`design/details/`](design/details/) の各ドキュメント:
- 抽出ルール本体: [`drop-list.md`](design/details/drop-list.md)
- 効果プラグイン IF: [`effect-plugin.md`](design/details/effect-plugin.md)
- 言語プラグイン IF: [`lang-plugin.md`](design/details/lang-plugin.md)
- Fingerprint 計算式: [`fingerprint.md`](design/details/fingerprint.md)

## 5. IR と Config

IR スキーマ (`aburi.ir.v1`) は [`design/details/ir-schema.md`](design/details/ir-schema.md)、JSON Schema は [`schema/aburi.ir.v1.json`](schema/aburi.ir.v1.json)。

設定ファイルは `aburi.json` または `aburi.jsonc` (workspace root)。詳細は [`design/details/config.md`](design/details/config.md)。

**設定させないもの** (時系列比較の安定性のため):
- score 重み
- 出力順
- IR schema
- AST traversal 詳細
- 言語別 node kind の生指定

Config はバージョン管理対象とし、過去 IR を再生成するときは当時の Config を git から取り出して使う運用とする。

## 6. CLI

```bash
aburi init                       # config 生成 (autodetect: workspace manager / framework / 言語)
aburi scan                       # 全体 IR 生成 → out/ir.json + out/workspace.md + out/components/*.md
aburi diff <base>..<head>        # 意味差分 → out/diff.md (PR コメント貼付用)
aburi explain <file-or-symbol>   # 単体シンボルの L2 Markdown を stdout に
```

PR コメント自動投稿は `@aburi/github-action` として薄く同梱。CLI 仕様詳細は [`design/details/cli-spec.md`](design/details/cli-spec.md)。

## 7. Diff 戦略

| ステータス | 検出方法 |
|---|---|
| `added` | 旧 IR に無く新 IR にあるシンボル |
| `removed` | 旧 IR にあり新 IR に無いシンボル |
| `moved` | git rename 検出 + path 違いだが symbol ID 残部一致、または fingerprint マッチ |
| `changed` | 同 ID で `api` / `logic` のいずれかの fingerprint 変化 |
| `moved+changed` | rename された上で fingerprint も変化 |

移動検出パイプライン:
```
1. git diff --find-renames で物理 rename mapping を取得
2. (1) で拾えなかったシンボルは logic fingerprint 一致でマッチ
3. それでも漏れたら name + signature 類似度でマッチ (閾値あり)
4. それも外れたら add + remove として扱う
```

`moved` 単独 (意味変更なし) は diff レポート上で「移動のみ」と明示し、レビュー負荷をゼロにする。アルゴリズム詳細は [`design/details/diff-algorithm.md`](design/details/diff-algorithm.md)。

## 8. 非対象

明示的にスコープ外とするもの:

- LLM による意味判定 (検証性・diff 安定性が消える)
- 美しい SVG 可視化 (diff 不安定 / 既存ツールと被る)
- Lint 用途 (Biome/ESLint が担う)
- 自然言語要約 (IR を AI に投げた先の仕事)
- 設定での score 重み開放
- IR の git track (デフォルト)

## 9. 失敗パターンと回避策

| 失敗 | 回避策 |
|---|---|
| 「それっぽい要約だが信用できない」 | 全 IR 要素に `source range` + `confidence` (`high`/`medium`/`low`) + `derivedBy` |
| 過剰抽象で edge case を落とし false LGTM | 「削る」優先・guard/throw は必ず残す・低 confidence は report で明示 |
| 軽微なリファクタで diff 真っ赤 | semantic ID + 3 層 fingerprint + 正規化パス |
| ファイル移動で大量の add/remove | git rename 検出 + fingerprint マッチ + `moved` ステータス |
| Config 更新で時系列比較が壊れる | 設定可能項目を厳格に絞る・config もバージョン管理対象 |
| 関数型言語が表現不能 | コア語彙 + 言語拡張語彙 (`<namespace>:<kind>`) の二層化 |
| AI 進化で IR の存在意義消滅 | 「AI が読みやすい diff 表現」自体が一次価値・全コード直読みより小さく速く確実 |

## 10. プロジェクト構成

```
Aburi/
├─ design.md                   ← 本書
├─ design/
│  ├─ roadmap.md               ← バージョン別スコープ進行
│  └─ details/                 ← 詳細設計 (IR schema / plugin IF / fingerprint / diff / ...)
├─ schema/                     ← JSON Schema (IR / config)
├─ packages/                   ← npm 公開パッケージ。命名: @aburi/<type>-<name>
│  ├─ core/                    ← @aburi/core (パイプライン本体)
│  ├─ cli/                     ← @aburi/cli (aburi コマンド)
│  ├─ lang-typescript/         ← @aburi/lang-typescript    (type=lang)
│  ├─ framework-nestjs/        ← @aburi/framework-nestjs    (type=framework)
│  ├─ framework-nextjs/        ← @aburi/framework-nextjs    (type=framework)
│  ├─ effects-nest/            ← @aburi/effects-nest        (type=effects, xPrefix=nest)
│  ├─ effects-prisma/          ← @aburi/effects-prisma      (type=effects, xPrefix=prisma)
│  └─ github-action/           ← @aburi/github-action
└─ examples/                   ← サンプル monorepo (テスト + ドキュメント)
```

ツール: Vite (bundle) / Vitest (test) / Biome (lint+format) / pnpm workspaces。
