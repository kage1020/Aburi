# Drop List 標準セット

Aburi の差別化要因である「装飾を削る」抽出戦略の核となる規約。
どのファイル・シンボル・ノードを IR から取り除くか、あるいは取り除いた事実を `dropped: true` として残すかを定義する。

参照: [`ir-schema.md`](ir-schema.md) §5.6 (dropped 規約) / §8.2 (Rule 抽出規約)
拡張機構: [`extension-vocab.md`](extension-vocab.md) (plugin が drop 規則を追加する場合)

---

## 1. 目的

抽出パイプラインが「意味あるロジック」だけを残せるよう、装飾的・儀式的・自明な構造を判別して取り除く。
ノイズが少ない IR を作ることで:

- diff レポートが「変えた意味」だけを示し、レビュー集中度が上がる
- AI consumer が IR を読むときの token を削減する
- fingerprint が安定する (装飾追加で diff が真っ赤にならない)

drop は「捨てる」ではなく「視界から外す」。透明性のため、シンボル単位の drop は `dropped: true` で IR に残す。

## 2. drop の 4 階層

| 階層 | 対象粒度 | IR 上の扱い |
|---|---|---|
| A. File-level skip | ファイル全体 | symbols/dependencies に一切出ない (stats.totalFiles からも除外) |
| B. Symbol-level drop | Symbol 単体 | `dropped: true` + `dropReason` で残る、fingerprint は全ゼロ |
| C. Node-level filter | Symbol 内部の call / return / decorator | call/return/effect/rule から個別除外、Symbol 自体は残る |
| D. Config/Plugin 拡張 | A/B/C すべての階層に上乗せ | §7 評価順に従う |

## 3. Category A: File-level skip

ファイル全体を抽出対象から外す。AST parse すらしない。

### 3.1 コア標準パターン

| パターン | 理由 |
|---|---|
| `**/node_modules/**` | 依存ライブラリ |
| `**/dist/**` `**/build/**` `**/out/**` `**/target/**` | ビルド成果物 |
| `**/.next/**` `**/.nuxt/**` `**/.svelte-kit/**` `**/.output/**` | フレームワークビルドキャッシュ |
| `**/coverage/**` | カバレッジレポート |
| `**/__snapshots__/**` `**/*.snap` | テストスナップショット |
| `**/*.d.ts` `**/*.d.mts` `**/*.d.cts` | TS 型宣言ファイル (実装なし) |
| `**/*.generated.*` `**/*.gen.*` `**/*.g.ts` | 自動生成 |
| `**/*.min.js` `**/*.bundle.js` | minified/bundled |
| `**/__pycache__/**` `**/*.pyc` | Python キャッシュ |
| `**/.venv/**` `**/venv/**` `**/site-packages/**` | Python 仮想環境 |
| `**/target/**` `**/Cargo.lock` | Rust |
| `**/vendor/**` `**/go.sum` | Go |

### 3.2 言語プラグインの追加

各言語プラグインは自言語固有の skip パターンを追加できる。例:

- `lang-typescript`: `**/*.d.ts`, `**/*.config.{js,ts,mjs,cjs}` (任意)
- `lang-python`: `**/__pycache__/**`, `**/*.pyi`
- `lang-rust`: `**/target/**`, `**/Cargo.lock`

### 3.3 .gitignore 連携

デフォルトで `.gitignore` のパターンを尊重する (`--no-respect-gitignore` で無効化可能)。

これにより `dist/` 等を明示的に書かなくても、git に無視されているファイルは自動で skip される。

### 3.4 設定追加

`config.ignore[]` のグロブパターンが Category A に追加される。

## 4. Category B: Symbol-level drop

Symbol 自体は IR に残るが `dropped: true` + `dropReason` でマークされ、fingerprint は全ゼロ。
Markdown projection からは除外、`aburi explain <symbol>` でのみ表示される。

### 4.1 コア標準パターン

| パターン | dropReason |
|---|---|
| class with only field declarations, no methods, no boundary decorator | `"pure DTO"` |
| interface declaration | `"interface (data model)"` |
| type alias declaration | `"type alias"` |
| empty function/method (body is `{}`) | `"empty body"` |
| re-export only (`export { X } from './y'`) | `"re-export"` |
| single-literal class (only `static` / `readonly` constant fields) | `"pure constants"` |

### 4.2 「pure DTO」の判定

class が以下をすべて満たすとき `pure DTO`:

- ボディに method がない (constructor 含む、ただし `class { constructor(public x: number) {}` のような shorthand-property constructor は許容)
- boundary decorator (framework plugin が `boundary: true` 判定したもの) を持たない
- ボディは field 宣言のみ

判定はコアが行うが、各言語プラグインが「pure DTO 判定の補助ルール」を追加してよい (例: `class-validator` の `@IsString` 等は装飾扱い、それ以外は通常の決定子)。

### 4.3 「interface (data model)」を drop する理由

interface はデータ形状を表現する宣言で、制御フロー・効果を持たない。Aburi の主用途 (ロジック差分レビュー) では IR に詳細を残さなくてよい。

ただし「あるシンボルが `Invoice` interface を実装する」のような関係は `Dependency` (via=`implement`) として `dependencies[]` に残す。interface の存在自体は知れる。

### 4.4 plugin の追加

言語/フレームワークプラグインは Category B に追加できる:

- `lang-typescript`: enum (?) — enum を data model 扱いするか、活用次第。設定可能にする
- `framework-nestjs`: `@Module` だけで本体無しの class は drop しない (boundary を持つため Category B 対象外)

## 5. Category C: Node-level filter

Symbol 自体は残し、その中の特定ノードを effects/calls/rules から除外する。

### 5.1 呼び出し (call_expression) の drop

| callee パターン | 理由 |
|---|---|
| `console.{log,info,warn,error,debug,trace,table,dir,group,groupEnd}` | ロギング |
| `process.stdout.write` / `process.stderr.write` | 標準出力 |
| `print` / `println` / `eprintln` (言語別) | 言語標準ロギング |
| `panic` (Rust の panic は plugin で扱う) | (本セットには含めない) |

これらは effects にも calls にも入らない。

### 5.2 plugin の追加

効果プラグインが「自分が認識しない logger」を Category C に追加できる。例:
- `effects-pino`: `pino.*`, `child.*` (logger.child の戻り値)
- `effects-winston`: `winston.*`, `createLogger().*`
- `effects-otel`: `tracer.startSpan`, `span.setAttribute`, `metrics.counter`

これらの plugin が config に有効化されていれば該当 callee が抽出から除外される。
有効化されていなければ通常の call として残る (= 自社ロガーは何もしないと calls[] に出続ける)。

### 5.3 trivial return の drop

`return` 文のうち、返却式が次のいずれかなら **rule に含めない**:

| AST 形 | 例 |
|---|---|
| 文字/数値/真偽/null/undefined リテラル | `return 1` / `return 'x'` / `return true` |
| identifier | `return x` |
| `this` または member 連鎖 (任意深度) | `return this.value` / `return obj.a.b.c` |
| 単項演算子 + trivial 式 | `return !x` / `return -count` |
| `void` 式 | `return void 0` |

**non-trivial return** (rule に含める):
- 二項/論理演算 (`return a + b`, `return x > 0`, `return a && b`)
- 三項演算 (`return x ? a : b`)
- 関数呼び出しを **含む** が他に式が絡む (`return foo() + 1`, `return [...foo(), 1]`)
- オブジェクト/配列リテラルで spread/動的計算を含む (`return { ...x, status: 'ok' }`)
- テンプレートリテラル with interpolation (`return \`hello ${name}\``)
- new 式と他の合成 (`return new Foo() ?? bar`)

### 5.4 return が単純な call_expression のみのとき

`return foo()` / `return this.bar()` のように **返却式が単一の call** のときは:

- rule に return として **含めない** (重複を避ける)
- call 自体は通常通り `calls[]` (または効果として `effects[]`) に記録される

これで `return foo()` を含む forward メソッドは「rules: 空、calls: foo」となり、forward の本質が表現される。

### 5.5 trivial 判定の再帰定義

```
isTrivialExpr(node):
  literal             → true
  identifier          → true
  this                → true
  member_expression   → isTrivialExpr(node.object)   # 任意深度
  unary_expression    → isTrivialExpr(node.argument)
  parenthesized       → isTrivialExpr(node.expression)
  otherwise           → false

isTrivialReturn(returnStatement):
  arg = returnStatement.argument
  if arg is null            → true   # 値なし return
  if isTrivialExpr(arg)     → true
  if arg is call_expression → "call-only" (Rule にせず call は通常通り記録)
  otherwise                 → false  # non-trivial return Rule
```

call_expression の引数が trivial かどうかは判定に含めない (call は call として独立に記録されるため、return wrapping の評価には不要)。

### 5.6 decorator の drop

Aburi コアは decorator を drop しない。framework plugin が `boundary: true/false` を判定するだけ。
非 boundary decorator (`@deprecated`, `@experimental` 等) も IR に残す (api fingerprint に影響するため)。

## 6. Category D: Config/Plugin 拡張

### 6.1 `config.suppress[]`

Category C (call drop) に追加する identifier prefix:

```jsonc
{
  "suppress": ["myLogger", "metrics", "telemetry"]
}
```

これにより `myLogger.*` / `metrics.*` / `telemetry.*` の call は effects/calls から除外される。

### 6.2 `config.keep[]`

Category C の drop から例外的に保持するパターン:

```jsonc
{
  "keep": ["@Transaction", "myCriticalLogger.audit"]
}
```

- `@<name>` 形式: decorator name (常にコアでは drop しないので意味は弱いが、明示性のために許容)
- `<callee>` 形式: 呼び出しを drop 対象から外す (例: `myCriticalLogger.audit` は monitoring の核なので残す)

### 6.3 Framework hints による drop 追加 (Tier 3 plugin)

[`extension-vocab.md`](extension-vocab.md) §11.3 の Framework hints から:

```jsonc
{
  "frameworkHints": [
    {
      "name": "acme-framework",
      "decorators": {
        "AcmeInternal": { "boundary": false, "drop": true }
      }
    }
  ]
}
```

`@AcmeInternal` 装飾されたシンボルは Category B に追加される。

## 7. 評価順序

複数の drop ルール / keep ルールが衝突する場合の優先度。**上ほど強い**:

```
1. config.keep                          (強制保持)
2. config.suppress                       (強制 drop、ただし keep に負ける)
3. plugin の drop ルール (manifest.dropCallees 含む)  (Category C/B に追加)
4. コアの drop ルール                     (Category A/B/C 標準セット)
5. デフォルト                            (drop しない)
```

`@aburi/effects-pino` のような effect plugin が `dropCallees: ["pino"]` を宣言した場合、これは **level 3** の plugin drop rule として扱う。`config.keep: ["pino.audit"]` (level 1) で個別保持できる。

具体例:
- `console.log` がコアで drop 対象 (level 4) かつ `config.keep: ["console.log"]` あり → keep が勝ち、保持
- `myLogger.info` が `config.suppress: ["myLogger"]` で drop 候補 (level 2) かつ `config.keep: ["myLogger.audit"]` あり → `myLogger.info` は drop、`myLogger.audit` は保持
- ある plugin が `panic!` を drop 対象に追加 (level 3) → `config.keep` で例外可能、コアでは触れない

## 8. 検証可能な性質 (テスト基準)

抽出パイプラインが満たすべき性質。

### 8.1 File-level (Category A)

| ID | 入力 | 期待 |
|---|---|---|
| A1 | `node_modules/foo/bar.ts` を含む scan | symbols に出ない、stats.totalFiles から除外 |
| A2 | `*.d.ts` 含む scan | 同上 |
| A3 | `.gitignore` に書かれたファイル | 同上 (`--no-respect-gitignore` でない限り) |
| A4 | `config.ignore: ["docs/**"]` を追加 | `docs/` 配下が skip |

### 8.2 Symbol-level (Category B)

| ID | 入力 | 期待 |
|---|---|---|
| B1 | pure DTO (`class Foo { x: number; y: string }`) | `dropped: true, dropReason: "pure DTO"` |
| B2 | `interface Foo { x: number }` | `dropped: true, dropReason: "interface (data model)"` |
| B3 | `type Bar = string` | `dropped: true, dropReason: "type alias"` |
| B4 | `export { x } from './y'` | `dropped: true, dropReason: "re-export"` |
| B5 | boundary decorator を持つ class (`@Controller`) はメソッドなしでも | `dropped: false` |

### 8.3 Node-level (Category C)

| ID | 入力 | 期待 |
|---|---|---|
| C1 | `console.log(x)` を含むメソッド | effects/calls に出ない |
| C2 | `return 1` のみのメソッド | rules に return が出ない |
| C3 | `return this.foo()` のみのメソッド | rules に return なし、calls に `this.foo` |
| C4 | `return a + b` のメソッド | rules に return (expr: "a + b") |
| C5 | `return { ...x, status: 'ok' }` のメソッド | rules に return |

### 8.4 Config/Plugin (Category D)

| ID | 入力 | 期待 |
|---|---|---|
| D1 | `config.suppress: ["myLogger"]` で `myLogger.info(x)` | 抽出から除外 |
| D2 | `config.keep: ["console.log"]` で `console.log(x)` | calls に残る |
| D3 | `config.keep` と `config.suppress` 両方に同じ callee | keep が勝つ |

### 8.5 trivial 判定の単体テスト

| ID | 入力式 | trivial か |
|---|---|---|
| T1 | `1` | yes |
| T2 | `'x'` | yes |
| T3 | `x` | yes |
| T4 | `this.x.y.z` | yes |
| T5 | `!x` | yes |
| T6 | `-this.count` | yes |
| T7 | `foo()` | call-only (return rule にしないが calls には載る) |
| T8 | `this.bar()` | call-only |
| T9 | `foo() + 1` | no |
| T10 | `x ? a : b` | no |
| T11 | `{ ...x }` | no |
| T12 | `\`hello ${name}\`` | no |

## 9. 設定例

最小設定 (デフォルトで十分):

```jsonc
{ "$schema": "https://aburi.dev/schema/aburi.config.v1.json" }
```

カスタム drop を入れた中規模プロジェクト:

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.config.v1.json",
  "ignore": ["docs/**", "scripts/legacy/**"],
  "suppress": ["myLogger", "metrics", "datadog"],
  "keep": ["myLogger.audit"]
}
```

## 10. 設計上の決定事項

### 10.1 「捨てる」ではなく `dropped: true` で残す理由

- 透明性: なぜ落としたかが IR から問い合わせ可能 (`aburi explain X`)
- 再現性: 過去 IR と現在 IR を比較したとき、「drop されたシンボル」も対応付けが可能
- デバッグ: drop ルール変更時に「次回からこれが入る/抜ける」を予測しやすい

stats.droppedSymbols でドロップ件数を見せ、誤検出 (本来残すべきものを drop) を発見しやすくする。

### 10.2 ファイル単位 (Category A) は dropped: true にしない理由

ファイル単位で全シンボルを `dropped: true` にすると IR が肥大化する (node_modules を全部入れたら数十万エントリ)。stats からも除外して「Aburi の関心外」を明確にする。

「ファイル単位での drop 履歴」が必要になったら別の機構 (`stats.skippedFiles[]` 等) を追加検討。

### 10.3 「pure DTO」を drop する理由

DTO はデータ形状で、ビジネスロジックを持たない。レビュー時に「型が変わったか」は重要だが、それは別の関心 (型変更レビュー) であり、Aburi の主用途とは異なる。

DTO 自体の存在は `dropped: true` で残るので消えはしない。型の変更検出は将来別機能で扱う。

### 10.4 trivial return を call-only にして rule から外す理由

`return foo()` のような forward メソッドで rule に return が入ると、見た目が冗長になる (calls に foo もある)。call として 1 度だけ記録し、rule は意味のある分岐・throw・複合 return に集中させる。

ただし `return foo() + 1` のように合成があるものは別の意味なので rule に残す。

### 10.5 keep > suppress > plugin > core の優先順位

ユーザーの意図は常にコア/plugin に優先する。「コアが logger を drop するが、自社の `auditLog.write` は監査ログとして残したい」という要求が一般的なので、keep を最優先にする。

ただし「config.keep で `console.log` を残す」のような選択も技術的に許可する (debug 用途で残したいプロジェクト等)。

### 10.6 plugin の drop ルールを Category 3 段目に置く理由

plugin はコアより詳細な知識 (`pino.child(...).info`) を持つので、コアより優先して drop 判定できる。ただしユーザー設定 (config) はさらに優先される。
