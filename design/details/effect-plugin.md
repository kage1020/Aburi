# 効果プラグイン IF

call_expression を「副作用 (effect)」として分類するためのプラグインインタフェース定義。
1 つの効果プラグインは 1 つのライブラリ・フレームワーク領域 (例: Prisma / NestJS / Stripe / Redis) を担当する。

参照:
- [`ir-schema.md`](ir-schema.md) §9 — Effect 構造
- [`extension-vocab.md`](extension-vocab.md) — Effect id (`x-<plugin>:<action>`) と manifest
- [`lang-plugin.md`](lang-plugin.md) §5.1 — 言語プラグインとの協調点
- [`drop-list.md`](drop-list.md) §5.2 — 効果プラグインが logger 等を drop 対象に追加する場合

---

## 1. 目的

call_expression のテキスト形 (`prisma.invoice.create`) と周辺コンテキストから、その呼び出しが何の効果 (`db.write` / `x-stripe:charge` 等) なのかを判定する。

言語プラグインは「何が呼ばれたか」を文字列レベルで提供するだけ。「それが何を意味するか」を効果プラグインが言語非依存に判定する。

## 2. プラグインの責務

### 2.1 やること

- マニフェストで効果 id (個別 / プレフィックス) を宣言する
- `CallCandidate` を受け取り、自プラグインが認識する効果かを判定する
- 認識した場合は `EffectClassification` (effectId / confidence / derivedBy) を返す
- 認識しない場合は `null` を返す
- 任意で、自プラグインが認識する呼び出しを drop list category C に追加する (logger 系の効果プラグインのみ)

### 2.2 やらないこと

- ソースを parse する (言語プラグインの仕事)
- AST を walk する
- Symbol 自体を生成・修正する
- 他プラグインが分類した結果を上書きする
- `Symbol.derivedBy[]` への直接書き込み (effect 単位の `derivedBy` を返すだけ)
- config.suppress / keep の適用 (コア)

責務を「callee → 効果分類」の純粋関数に閉じる。これにより:
- 効果プラグインはほぼ宣言的なパターンマッチで完結する
- ユニットテストが容易 (callee 文字列を入れて期待 effectId を assert するだけ)
- 言語横断で再利用できる (同じ Prisma プラグインが TS でも Python でも動く想定)

## 3. ライフサイクル

```
1. registry が manifest を validate して load
2. ctx (registry/config) を渡して plugin.init() を呼ぶ
3. 言語プラグインが walkBody で CallCandidate[] を抽出するたびに:
     各 call に対し、有効化された effect plugin を config 順に呼ぶ
       plugin.classify(call, ctx) → EffectClassification | null
     最初に non-null を返した plugin の結果を採用 (§5)
4. 全ファイル終了後 plugin.cleanup?() を呼ぶ
```

## 4. インタフェース

実型は `@aburi/core` の `types` パッケージで定義する。本ドキュメントは契約面のシグネチャを示す。

### 4.1 `EffectPlugin`

```ts
interface EffectPlugin {
  manifest: PluginManifest                   // type: "effects"
  init(ctx: PluginContext): Promise<void>
  cleanup?(): Promise<void>

  // 効果分類 (純粋関数で実装するのが理想)
  classify(call: CallCandidate, ctx: ClassifyContext): EffectClassification | null

  // 任意: drop list category C への追加 (logger 系プラグインのみ実装)
  dropCallees?: string[]                     // identifier path prefix (例: "pino", "winston")
}
```

### 4.2 `CallCandidate` (言語プラグインから)

[`lang-plugin.md`](lang-plugin.md) §4.4 で正規定義される。本 doc では同一の型を参照するだけ。
要約: `{ target, line, argumentCount, inAwait, inNew, literalArgs }` の 6 フィールド。`literalArgs` で SQL 文字列の中身を見たい等のケースに対応 (リテラル以外は `null`)。

### 4.3 `ClassifyContext`

```ts
interface ClassifyContext {
  owner: OwnerSummary                        // call が含まれる Symbol の要約
  file: FileSummary                          // ファイル情報 (imports 含む)
  language: string                           // "ts" / "py" / "rs" 等
  registry: VocabRegistry
  config: AburiConfig
}

interface OwnerSummary {
  id: string                                 // owning Symbol の id
  kind: SymbolKind
  name: string
  extKind: string | null                     // framework plugin が既に判定済みの値
  decorators: { name: string; boundary: boolean }[]
  component: string | null
}

interface FileSummary {
  path: string
  imports: ImportEdge[]                      // 言語プラグインが抽出した import 全件
}
```

`imports` を提供することで「`prisma` という識別子が `@prisma/client` から来ているか、ローカルの自前変数か」を効果プラグインが判別できる。

### 4.4 `EffectClassification`

```ts
interface EffectClassification {
  effectId: string                           // ir-schema §9.1 のコア id または x-<plugin>:<action>
  confidence: 'high' | 'medium' | 'low'      // ir-schema §5.4
  derivedBy: string                          // 例: "effects-plugin:prisma:create"
}
```

返り値の `effectId` は **manifest の `provides.effects[].id` または `provides.effectPrefixes[]` 配下** でなければならない。違反は registry が抽出時に検出してエラー。

## 5. 分類アルゴリズム

### 5.1 first-match-wins

```
for each call in symbol.calls:
  for each effect_plugin in config-order:
    result = effect_plugin.classify(call, ctx)
    if result !== null:
      assign call to effects[] with result
      break    # 後続 plugin は呼ばない
  else:
    leave call in calls[]
```

config 順の前段プラグインが優先される。プロジェクト固有の plugin を上位に配置することで標準 plugin より優先できる。

### 5.1.1 classify() のタイムアウト

各 plugin の `classify(call, ctx)` 呼び出しに **per-call タイムアウト** をコアが設定する。デフォルト 50ms。

- 上書き: `config.classifyTimeoutMs` (default `50`、min `10`、max `5000`)
  - SQL parser を含む plugin は 200-500ms に引き上げが現実的
  - plugin 個別の上書きは不可 (config の単一値、全 plugin 共通)
- タイムアウト超過 → `null` を返したものとして扱い、次の plugin に流す
- **非決定性記録**: タイムアウトが発生した (plugin, target, file:line) を `stats.effectClassifyTimeouts[]` に記録 (v0.1 schema 追加対象)
  - これにより「同じ入力で run 1 では分類成功、run 2 でタイムアウトして calls[] に残る」非決定性が IR から検知可能
  - CI で run 間の `effectClassifyTimeouts` 差を見て plugin 性能劣化を発見できる
- warning log: `Plugin <name> classify() timed out for <target> at <file>:<line>`
- plugin 実装は同期 (Promise を返さない) を推奨。非同期が必要な場合は plugin 自身が timeout を実装すべき

これは AST 数千シンボル × call 数十 × plugin 数の二重ループで遅延 plugin が全体を止めるのを防ぐ。

### 5.2 多重分類を許さない理由 (v0.1)

`prisma.invoice.create` を `db.write` (コア) かつ `x-prisma:invoice.create` (Prisma 詳細) として両方記録したい欲求はあるが、v0.1 では:

- IR の `Symbol.effects[]` が複雑化 (同じ target/line で id 違いが並ぶ)
- diff レポートの整列規約が破綻 (どちらを正準とするか)
- consumer の理解負荷が上がる

v0.1 は first-match-wins で単一 effectId を採用する。多重分類は v0.2 以降で別フィールド (`Effect.aliases?: string[]`) を導入する選択肢を残す。

### 5.3 上位プラグインで「分類しない」を明示する手段

「Prisma plugin は `db.write` ではなく `x-prisma:create` を返したいから、コア db.* を返す汎用 plugin より上位に置く」のような優先制御は config 順で行う。

逆に「特定の call だけは下位 plugin に委ねたい」場合、上位 plugin は `null` を返せば下位に流れる。

## 6. 言語プラグインとの協調

### 6.1 効果プラグインに来る情報

言語プラグインの `walkBody` が `CallCandidate` を返した時点で、コアはそれを各効果プラグインに回す。効果プラグインは AST にはアクセスしない。

### 6.2 owner Symbol が決まる前に呼ばれる場合

ある効果プラグインは owner の `extKind` (framework plugin が既に決定済み) に依存する判断をする (例: NestJS lifecycle は `framework:nestjs:provider` の中でだけ意味を持つ)。

そのため抽出順序は ([`lang-plugin.md`](lang-plugin.md) §5.3 参照):

```
extractSymbols → framework.classifySymbol → walkBody → effects.classify
```

効果プラグインが呼ばれる時点で、owner.extKind は決定済み。

### 6.3 同じ call が複数 owner を持つことはない

call_expression は単一の owning Symbol に属する (nested anonymous function は親に吸収される、[`ir-schema.md`](ir-schema.md) §3.3)。効果プラグインは owner の特定に迷わない。

## 7. logger 系プラグインによる drop 追加

`dropCallees: string[]` をマニフェストで提供すると、コアの drop list category C に該当 callee prefix が追加される ([`drop-list.md`](drop-list.md) §5.2)。

例: `effects-pino` プラグインが `["pino", "child"]` を宣言すると、`pino.info(...)` / `child.info(...)` が effects/calls から除外される。

drop 専用のプラグインを書くことも可能 (`provides.effects: []` だが `dropCallees` のみ宣言)。

## 8. 公式効果プラグイン一覧 (planned)

| plugin | 認識する callee 例 | 主な effect id |
|---|---|---|
| `@aburi/effects-nest` | NestJS lifecycle hooks | `x-nest:lifecycle.on-module-init` 等 |
| `@aburi/effects-prisma` | `prisma.*.{find*,create,update,upsert,delete}` | `db.read` / `db.write` |
| `@aburi/effects-drizzle` | `db.select().from(...)` / `db.insert(...)` | `db.read` / `db.write` |
| `@aburi/effects-trpc` | `trpc.*.{query,mutation}` | `network.rpc` |
| `@aburi/effects-axios` | `axios.{get,post,put,patch,delete}` | `network.http` |
| `@aburi/effects-fetch` | `fetch(...)` (グローバル) | `network.http` |
| `@aburi/effects-bullmq` | `queue.add(...)` / worker | `queue.publish` / `queue.consume` |
| `@aburi/effects-redis` | `client.{get,set,del}` | `x-redis:read` / `x-redis:write` (コア `state.*` は in-process 限定のため Redis は plugin 拡張で表現) |
| `@aburi/effects-pino` | `pino.*` / `child.*` | dropCallees のみ (logger 除外) |
| `@aburi/effects-winston` | `winston.*` | 同上 |
| `@aburi/effects-otel` | `tracer.*` / `metrics.*` / `span.*` | 同上 |

各プラグインの実装詳細はそれぞれの README に。v0.1 では NestJS + Prisma を最低限実装し、他は v0.2 以降。

## 9. パターンマッチの実装例

### 9.1 Prisma 効果プラグイン (擬似コード)

```ts
const READ_METHODS = /^(findUnique|findFirst|findMany|count|aggregate|groupBy)$/
const WRITE_METHODS = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/
const TX_METHODS = /^\$transaction$/

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-prisma.json */ },

  async init(ctx) {
    // Prisma client が `@prisma/client` から import されているか judge するため imports を見たい
  },

  classify(call, ctx) {
    // 識別子チェーンを分解: "prisma.invoice.create" → ["prisma", "invoice", "create"]
    const parts = call.target.split('.')
    if (parts.length < 3) return null

    const [root, model, method] = parts.slice(-3) // 末尾 3 つを取る (this.prisma.invoice.create に対応)

    // root が prisma っぽいか確認
    if (!isPrismaIdentifier(root, ctx.file.imports)) return null

    if (READ_METHODS.test(method)) {
      return { effectId: 'db.read', confidence: 'high', derivedBy: 'effects-plugin:prisma:read' }
    }
    if (WRITE_METHODS.test(method)) {
      return { effectId: 'db.write', confidence: 'high', derivedBy: 'effects-plugin:prisma:write' }
    }
    if (TX_METHODS.test('$' + method)) {
      return { effectId: 'db.transaction', confidence: 'high', derivedBy: 'effects-plugin:prisma:tx' }
    }
    return null
  }
}

function isPrismaIdentifier(name, imports) {
  // imports に '@prisma/client' があり、かつ name がそこから来た PrismaClient のインスタンスっぽい
  // v0.1 では「import に '@prisma/client' があれば prisma っぽい識別子は信用する」程度のヒューリスティック
  return imports.some(i => i.source === '@prisma/client')
}
```

### 9.2 NestJS lifecycle 効果プラグイン (擬似コード)

```ts
const LIFECYCLE_METHODS = {
  onModuleInit: 'x-nest:lifecycle.on-module-init',
  onApplicationBootstrap: 'x-nest:lifecycle.on-application-bootstrap',
  onModuleDestroy: 'x-nest:lifecycle.on-module-destroy',
  onApplicationShutdown: 'x-nest:lifecycle.on-application-shutdown',
}

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-nest.json */ },
  classify(call, ctx) {
    // 「lifecycle hook の本体内で他のシンボルを呼んでいる」ケースで効果が伝播するように設計するなら別途検討
    // v0.1 では「lifecycle hook 自身の呼び出し」を効果とは扱わない (それは framework plugin が extKind で扱う)
    return null
  },
  dropCallees: []  // NestJS は logger を分離せず DI で渡すため、ここでは drop しない
}
```

(NestJS の lifecycle は call として現れず、メソッド名と framework boundary で判定するため、効果プラグインの責務ではなく framework plugin の責務になる)

### 9.3 Stripe 効果プラグイン (擬似コード)

```ts
const ACTIONS = {
  charges: 'x-stripe:charge',
  customers: 'x-stripe:customer.create',  // method が create のとき
  webhooks: 'x-stripe:webhook.deliver',
}

export const plugin: EffectPlugin = {
  manifest: { /* see plugin-effects-stripe.json */ },
  classify(call, ctx) {
    const parts = call.target.split('.')
    if (parts.length < 3) return null
    const [root, resource, method] = parts.slice(-3)

    if (!ctx.file.imports.some(i => i.source === 'stripe')) return null

    if (resource === 'charges' && method === 'create') {
      return { effectId: 'x-stripe:charge', confidence: 'high', derivedBy: 'effects-plugin:stripe:charge' }
    }
    // ... 以下同様
    return null
  }
}
```

## 10. 検証可能な性質 (テスト基準)

| ID | 入力 | 期待 |
|---|---|---|
| EP1 | manifest にない effectId を返す | 抽出時エラー (registry が検出) |
| EP2 | classify が同 input で同 output を返す | 純粋関数性 (副作用なし、状態を持たない) |
| EP3 | classify が throw | warning log、null として扱われる |
| EP4 | 2 plugin が同じ call を分類 | config 順で先頭が勝つ (first-match-wins) |
| EP5 | classify が null を返す | call は `Symbol.calls[]` に残る |
| EP6 | classify が EffectClassification を返す | call は `Symbol.effects[]` に移る、`Symbol.calls[]` には残らない |
| EP7 | `dropCallees` 宣言した plugin | 該当 callee は effects/calls から除外、drop-list §5.2 と同じ |
| EP8 | `effects: []` かつ `dropCallees: ["pino"]` の logger 専用 plugin | classify は null を返し続けるが、pino.* は drop される |
| EP9 | `effectPrefixes: ["x-stripe"]` 配下の任意 id を返す | OK (個別宣言不要) |
| EP10 | classify が `confidence: 'low'` を返す | Symbol.effects[].confidence = "low" がそのまま IR に入る |

## 11. 設計上の決定事項

### 11.1 効果プラグインを純粋関数中心にする理由

`classify(call, ctx) → result` の形は:

- ユニットテストが容易 (state ありのテストハーネスが不要)
- 並列実行可能 (将来のパフォーマンス改善)
- AST に直接触らないので、言語プラグインの内部実装変更に影響されない

抽出パイプライン全体の責務分割を保つために、effects は「分類」だけに徹する。

### 11.2 first-match-wins の選択

config 順という決定論的な優先制御で、設定 1 つで挙動を制御できる。「複雑な合議制」「重み付け投票」は v0.1 で導入する必要がない。

ユーザーが「Prisma の `db.write` を `x-prisma:create` で出したい」と思ったら、Prisma plugin を先頭に置く。

### 11.3 効果プラグインが Symbol.derivedBy を直接書けない理由

`Symbol.derivedBy[]` は「この Symbol がなぜこの形で IR に出ているか」の根拠集合。effect の判定は Symbol 全体の判定根拠ではなく、特定の call の判定根拠なので、`Effect.derivedBy` (effect 単位、1 つ) で十分。

Symbol 単位で「Prisma を使う Symbol」と検索したい用途は、`Symbol.effects[]` を見れば足りる。

### 11.4 言語横断で再利用する想定

Prisma は TS でも Python でも使われる (`prisma-client-py`)。効果プラグインが言語に依存しない設計なら、同一プラグインで両言語の Prisma 呼び出しを認識できる。

`ClassifyContext.language` が渡るので、言語別に挙動を切り替えることも可能。

### 11.5 owner.extKind の利用を許す理由

「framework:nestjs:provider の中の `this.eventBus.publish(...)` だけを `event.publish` 扱いする」のような文脈依存判定を可能にする。owner.extKind は framework plugin が既に決定済み (lang-plugin §5.3 抽出順序)。

### 11.6 SQL 文字列の literal 解析を v0.1 から含める理由

`db.query("SELECT * FROM users WHERE id = ?")` のような文字列ベース ORM は実プロジェクトで頻出。`literalArgs` を CallCandidate に含めれば、SQL parser ライブラリと組み合わせて文字列内容の分析もプラグインで可能になる。AST にアクセスしないという制約はそのままに、必要な情報だけを増やす。
