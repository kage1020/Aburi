# Diff Algorithm

2 つの IR (base / head) を比較し、意味差分を生成する `aburi diff` のアルゴリズム定義。

参照:
- [`ir-schema.md`](ir-schema.md) §3 — Symbol ID 規約
- [`fingerprint.md`](fingerprint.md) — 3 軸 fingerprint
- [`extension-vocab.md`](extension-vocab.md) — diff レポートに登場する vocab

---

## 1. 目的

Aburi の主要ユースケース「PR レビューを意味粒度で行う」の中核機能。
コード行 diff ではなく、Symbol 単位で「何が追加・削除・移動・変更されたか」を出す。

レビュアーの作業を:
- 大量の行差分をスクロール → やめる
- 「移動だけのシンボル」「実装リファクタのみ」を折りたたみ → 視界から外す
- 「公開契約 / ビジネスロジック / 副作用」が変わった箇所のみに集中

## 2. 入力と出力

### 2.1 入力

2 つの IR (`aburi.ir.v1`):
- `baseIR`: 比較元
- `headIR`: 比較先

両方とも `schema` バージョンが一致している必要がある (不一致はエラー終了)。

### 2.2 入力供給方法

```bash
aburi diff <base>..<head>             # git ref を指定 (両方を再生成)
aburi diff --base ir-base.json --head ir-head.json  # 既存 IR を直接指定
```

git ref 指定の場合、Aburi は内部で:
1. base ref を check out して `aburi scan` を実行 (IR 生成)
2. head ref に戻す (またはそもそも worktree を使う)
3. 2 つの IR を比較

git worktree を使うと head を保ったまま base IR を生成できるため、デフォルトはこの方式。

### 2.3 出力

```bash
out/diff.json     # Diff 結果 (aburi.diff.v1.json schema)
out/diff.md       # PR コメント貼付用 Markdown projection
```

`stdout` には summary 1 行を出す。詳細は `out/diff.md` を参照させる。

## 3. マッチングアルゴリズム (5 段)

base/head の Symbol をペア付けする。

```
入力: baseIR.symbols, headIR.symbols
出力: matchedPairs[], remainingBase[], remainingHead[]
```

### 3.1 段 1: 完全 ID 一致

```
baseById = {s.id: s for s in baseIR.symbols}
headById = {s.id: s for s in headIR.symbols}

for id in keys(baseById) ∩ keys(headById):
  pair = (baseById[id], headById[id])
  matched.push({base: pair[0], head: pair[1], rationale: 'id-match'})
  remove from remainingBase / remainingHead
```

最も一般的なケース。ファイル移動なし・名前変更なしの Symbol はここで決着。

### 3.2 段 2: git rename 検出 (git 利用可能時のみ)

```
if git available and ref-based diff:
  renameMap = git diff --find-renames base..head
              → {oldpath: newpath}
  
  for sym in remainingBase:
    if sym.source.file in renameMap:
      newPath = renameMap[sym.source.file]
      expectedId = sym.id with old path replaced by newPath
      if expectedId in remainingHead:
        pair, rationale: 'git-rename'
        remove from remaining
```

git の rename 検出が物理レベルで mapping を返すため、最も信頼できる移動検出手段。

### 3.3 段 3: logic fingerprint マッチ

git rename で拾えなかった or git 不在のケース。

```
logicMap = group remainingBase by sym.fingerprint.logic (dropped を除外)
         → {logic_hash: [base symbols with same logic]}

for h in remainingHead (dropped を除外):
  candidates = logicMap[h.fingerprint.logic]
  if len(candidates) == 0:
    continue  # 段 4 へ流す
  if len(candidates) == 1:
    pair, rationale: 'logic-fingerprint'
    remove from remaining
  else:  # 複数候補
    best = argmax over candidates of nameSimilarity(c.name, h.name)
    if best.similarity >= 0.85:
      pair, rationale: 'logic-fingerprint+name-disambiguation'
      remove from remaining
    else:
      continue  # 段 4 へ流す (全候補を unmatched のまま残す)
```

logic fingerprint が一致 = 意味が同じ。これで「ファイル移動 + リネームなし」「ファイル移動 + 軽微なリファクタ」のかなりを拾える。

段 3 で **pair できなかった head シンボルはすべて段 4 に流す**。段 3 で「最良候補があるが閾値未満」だった場合も例外なく段 4 で再評価する。

dropped シンボル同士は全 fingerprint が `"000000000000"` のため、巨大に同 hash として一致する。dropped 同士のマッチは段 3/4 から除外、専用 weak matcher (§3.4.5) で処理する。

### 3.4 段 4: name + signature 類似度 (最後の手段)

```
# Bucket pre-filter (O(N) hash bucketing) で K^2 を抑制
buckets = group remainingBase by (kind, signatureNullness)
        → { (kind, sigNull): [base symbols] }

for h in remainingHead:
  bucket = buckets.get((h.kind, h.signature === null))
  if !bucket || bucket.length === 0: continue
  best = null
  for b in bucket:
    score = 0.5 * nameSimilarity(b.name, h.name)
          + 0.3 * signatureSimilarity(b.signature, h.signature)
          + 0.2 * ownerSimilarity(b.name, h.name)         # §3.4.6
    if score > best?.score:
      best = {symbol: b, score}
  threshold = thresholdFor(h)                             # §3.4.3
  if best && best.score >= threshold:
    pair, rationale: 'name-signature'
    remove from remaining and from bucket
```

#### 3.4.0 bucket pre-filter (必須)

段 4 は O(K^2) で実装すると K=500 (Repository pattern / Zod schema 多用) で実用速度を割る。
bucket pre-filter として `(kind, signature === null ? 'no-sig' : 'has-sig')` の組合せでハッシュ分割し、各 head を対応 bucket 内のみで線形評価する。
これにより実効計算量は K の bucket あたりサイズの 2 乗、通常 ≤ 数十 で線形に近い。

#### 3.4.3 symbol kind 別閾値

短名 (`getUser` vs `getUsers` のような 1-2 token 名) で誤爆を避けるため、symbol kind と name token 数に応じて閾値を調整する:

```
thresholdFor(kind, headName):
  tokenCount = tokenize(lastSegment(headName)).length
  if tokenCount <= 1:
    return 1.0                  # 1 token name は段 4 で pair しない (false positive 防止)
  if tokenCount == 2:
    return 0.95                 # 厳しめ (例: 'getUser' vs 'getUsers' で 0.5 → 通らない)
  return 0.85                   # default
```

加えて `signature: null + null` の組み合わせ (interface/type/class 本体など) は signatureSimilarity が常に 1.0 を返す。signature null の symbol は **段 4 で pair しない** (情報量不足):

```
if h.signature === null && all candidates have signature === null:
  skip pair, leave for added/removed
```

#### 3.4.4 設定によるチューニング

`config.diff.nameSignatureThreshold` (default: `null` = symbol kind 別自動) で全体閾値を上書き可能 (v0.2)。v0.1 は自動のみ。

#### 3.4.5 段 4.5: dropped 専用 weak matcher

dropped シンボルは fingerprint がゼロのため段 3/4 で使えない。git rename が無い環境で dropped が移動した場合に拾うため、dropped 専用の軽量マッチャを段 4 の後に走らせる:

```
for h in remainingHead where h.dropped:
  best = null
  for b in remainingBase where b.dropped:
    if b.kind != h.kind: continue
    # qualified name の末尾セグメント + ファイル basename
    score = 0.5 * (lastSegment(b.name) === lastSegment(h.name) ? 1 : 0)
          + 0.5 * (basename(b.source.file) === basename(h.source.file) ? 1 : 0)
    if score > best?.score:
      best = {symbol: b, score}
  if best && best.score >= 0.5:  # 片方一致でも採用
    pair, rationale: 'dropped-weak-match'
    remove from remaining
```

これにより「DTO ファイルをディレクトリ rename しただけ」のような変更が `droppedAdded:10 / droppedRemoved:10` ではなく `moved:10` として記録される。
誤検出のリスクはあるが、dropped はそもそも IR の主視界外なので影響は小さい。

#### 3.4.1 nameSimilarity

トークン分割 (camelCase / snake_case / `.` / `::`) → Jaccard 類似度。Levenshtein は鋭敏すぎるため不採用。

```
tokenize("InvoiceService.createInvoice") = ["invoice", "service", "create", "invoice"] (lowercase, dedupe)
jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

#### 3.4.6 ownerSimilarity (R-8: 同名 method 衝突回避)

`shortName` (last segment) のみで類似度を計算すると、class ごと rename された method (`UserRepo.getUser` → `UsersRepository.getUser`) を同名の別 class の同名 method (`AdminRepo.getUser`) と誤 pair する。
これを防ぐため score 式に **owner segment 類似度** を 0.2 重みで加える:

```
ownerOf(qname):
  byColon = qname.split('::')[0..-2]               # static method の Class:: 部分
  byDot   = qname.split('.')[0..-2]                # nested.namespace.Class 部分
  return all but last segment, joined back
  # 'Class::method' → 'Class'
  # 'A.B.C.method'  → 'A.B.C'
  # 'topLevel'      → ''   (empty)

ownerSimilarity(baseName, headName):
  baseOwner = ownerOf(baseName)
  headOwner = ownerOf(headName)
  if baseOwner === '' && headOwner === '': return 1.0   # top-level functions
  if baseOwner === '' || headOwner === '': return 0.0
  return jaccardTokens(baseOwner, headOwner)
```

これにより:
- `UserRepo.getUser` vs `AdminRepo.getUser` → name=1.0, sig=1.0, owner=jaccard("UserRepo", "AdminRepo")≈0.33 → 合計 0.5+0.3+0.066=0.866 (kind=method なら threshold 0.85、ぎりぎり通る — 段 1 が UserRepo.getUser を消化済の場合のみ起きるエッジ)
- `UserRepo.getUser` vs `UsersRepository.getUser` (class rename) → owner=jaccard("UserRepo", "UsersRepository")≈0.5 → 合計 0.5+0.3+0.1=0.9 → 通る (期待通り)
- `UserRepo.findById` vs `UsersRepository.findById` (class rename + method 維持) → 合計 0.9 → 通る

#### 3.4.2 signatureSimilarity

null + null → 1.0
null + non-null or 逆 → 0.0
両方 non-null →
- inputs の型一致率 (順序考慮)
- outputs の型一致率
- throws の集合一致率 (順序非依存)
を平均

### 3.5 段 5: 残りは added / removed

ここまでで pair されなかった symbol は確定:

- `remainingHead` → status: `added`
- `remainingBase` → status: `removed`

### 3.6 dropped シンボルの扱い

`dropped: true` のシンボルは段 3/4 のマッチング対象から **除外**:

- fingerprint が全ゼロのため段 3 で 100% 衝突する
- name+signature だけで一致判定するには情報量が少なすぎる

代わりに段 4.5 (§3.4.5) で dropped 専用の weak matcher を走らせる:

1. 段 1 (完全 ID 一致) で拾えれば確定
2. 拾えなければ段 4.5 で `lastSegment(name) + basename(file)` の弱マッチを試す
3. それでも合わなければ「dropped が消えた/増えた」として独立カウント (diff レポート "dropped + changes" セクションに集約)

dropped は IR の主視界外なので段 4.5 の誤検出リスクは許容する。

### 3.7 抽出時のシンボル ID 衝突 (fail-fast)

ir-schema §14 #1 「`symbols[].id` は Document 内で一意」を守るため、Aburi コアは以下を **抽出時に fatal error** として停止する:

- 同一 ID の Symbol が複数生成される (例: 同一ファイルで複数の `export default function` が混在、CJS の `module.exports.default` と ESM `export default` が同居)
- `<default>` シンボルが同一ファイル内で 2 つ以上検出される
- dropped と非 dropped で同一 ID が衝突する

エラーメッセージは `Symbol ID collision at <file>: <id>` を出し、ユーザーに該当箇所の修正を促す。
これにより diff アルゴリズムは uniqueness invariant を前提に動作できる。

## 4. ステータス判定

各 matched pair について:

```
droppedToggled = base.dropped != head.dropped     // §4.1
pathChanged    = base.source.file != head.source.file
apiChanged     = base.fingerprint.api    != head.fingerprint.api
logicChanged   = base.fingerprint.logic  != head.fingerprint.logic
syntaxChanged  = base.fingerprint.syntax != head.fingerprint.syntax

fingerprintChanged = apiChanged || logicChanged || syntaxChanged

if droppedToggled:
  status = "dropped-toggled"                       // 最優先で振り分け
elif pathChanged && fingerprintChanged:
  status = "moved+changed"
elif pathChanged:
  status = "moved"
elif fingerprintChanged:
  status = "changed"
else:
  status = "unchanged"
```

unchanged はデフォルト出力には含めない (件数だけ summary に集計)。

### 4.1 `dropped-toggled` status の存在理由

`dropped: false → true` (kept → dropped) または `dropped: true → false` (dropped → kept) の遷移は、**drop ルールや plugin 構成の変更で発生する**:

- DTO 判定強化ルール追加 → 多数の class が一斉に `dropped: true` 化
- framework plugin 追加で旧 dropped (decorator 無し) が boundary 化 → `dropped: false`

このとき fingerprint は (`a..b` → `0..0` または逆) と必然的に全変化する。
`changed` 扱いにすると **「DTO ルール変更だけで全 DTO が api-changed として API 変更セクション (重要度最上位) に列挙される」** という典型的な誤レポートが起きる。

`dropped-toggled` を独立 status として扱うことで:

- delta (`apiChanged` 等) を **算出しない** (常に false 相当として扱う)
- Markdown projection で専用セクション「Drop 規則変動」に格納 (折りたたみ)
- `--fail-on dropped-toggled` で明示的に CI ゲートにできる

## 5. Delta 計算 (changed / moved+changed のみ)

「何が」変わったかを field 単位で計算:

### 5.1 fingerprint 軸

```
delta.apiChanged    = base.fp.api    != head.fp.api
delta.logicChanged  = base.fp.logic  != head.fp.logic
delta.syntaxChanged = base.fp.syntax != head.fp.syntax
```

3 軸とも変わっていれば「実装も契約も意味も全変更」。

### 5.2 配列 diff (rules / effects / calls / decorators)

各配列に対して **3 種類の delta** を計算:

- `added[]`: head にあり base に無い要素
- `removed[]`: base にあり head に無い要素
- `modified[]`: 両方にあるが内容が違う要素 (例: `condition` だけ変わった rule)

要素の同一性判定:
- Rule: `(type, line)` で同一視 (line は許容差 ±2 として fuzz、§5.2.1)
- Effect: `(id, target)` で同一視
- Call: `(target, line)` (line fuzz)
- Decorator: `(name)` で同一視

##### 5.2.1 line fuzz の理由

行番号は人為的編集で微妙にズレるため、`(type, condition)` が同じなら同じ rule とみなす方が delta が読みやすい。デフォルト ±2 行差まで許容、それ以上は別 rule 扱い。

`config.diff.lineFuzz` (default: `2`、`0` で fuzz 無効、最大 `10`) で調整可能。大量の prettier 設定変更などで 5 行ずれるプロジェクトは `5` 等に上げる。

ただし fingerprint 自体は line を含まない (D4 §4) ので、line fuzz は **delta 表示用のみ**。fingerprint 一致判定には影響しない。

##### 5.2.2 Decorator delta の arguments 扱い

Decorator は `(name)` で同一視するが、`arguments` の差を delta で表示する:

```
Decorator delta (modified):
- @Post: arguments '/invoices' → '/invoices/v2'
- @UseGuards: arguments AuthGuard → AuthGuard,RoleGuard
```

`raw` を line-fuzz と組み合わせて modified 判定:
- 同 name + line fuzz 内 + arguments 違い → modified
- 同 name + arguments 同じ + line のみ違う → 暗黙的に同じ (delta に出さない)

##### 5.2.3 Component diff の `modified` 判定

Component には `modified` を出さない (added / removed / changed の 3 状態のみ)。
`changed` 内部の delta フィールドで `rootsChanged` / `publicApiChanged` / `frameworksChanged` の bool で差を示す。実際に変わったフィールドの **before/after 配列を全部出す** (modified 差分は出さない、フィールド単位で出す:
```
Component changed: billing
  roots: ['apps/billing'] → ['apps/billing', 'packages/billing-domain']
  frameworks: [] → ['nestjs']
```

### 5.3 signature delta

```
delta.signature = {
  inputs: { added: [...], removed: [...], modified: [...] },
  outputs: { added: [...], removed: [...] },
  throws:  { added: [...], removed: [...] },
  asyncChanged: bool,
  generatorChanged: bool,
  typeParametersChanged: bool
}
```

signature が両方 null → delta.signature = null。

### 5.4 component / visibility delta

```
delta.componentChanged = base.component != head.component
delta.visibilityChanged = base.visibility != head.visibility
```

Component 変更は「責務の再配置」を意味するので diff レポートで強調する。

## 6. Component / Dependency diff

Symbol だけでなく Component / Dependency も別配列で diff する。

### 6.1 Component diff

```
componentDiff = {
  added:   [Component],         // head のみ
  removed: [Component],         // base のみ
  changed: [{
    before: Component,
    after:  Component,
    delta: { rootsChanged, publicApiChanged, frameworksChanged }
  }]
}
```

### 6.2 Dependency diff

```
dependencyDiff = {
  added:   [Dependency],
  removed: [Dependency]
}
```

Dependency は (from, to, via) で同一性判定。direction / effect の変更は added+removed の組として扱う (modified 不要)。

## 7. 出力形式

### 7.1 Diff 結果 JSON (`out/diff.json`)

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.diff.v1.json",
  "generator": { "name": "aburi", "version": "1.0.0" },
  "base": {
    "ref": "main",                                   // git ref または "ir-base.json"
    "irSchema": "aburi.ir.v1.json"
  },
  "head": {
    "ref": "HEAD",
    "irSchema": "aburi.ir.v1.json"
  },
  "summary": {
    "added":           5,
    "removed":         3,
    "moved":           2,
    "movedChanged":    1,
    "changed":         12,
    "droppedToggled":  4,
    "unchanged":       142,
    "droppedAdded":    4,
    "droppedRemoved":  1,
    "componentsAdded":   1,
    "componentsRemoved": 0,
    "componentsChanged": 2,
    "depsAdded":     3,
    "depsRemoved":   1
  },
  "symbols": [
    { "status": "added",   "symbol": { /* Symbol */ } },
    { "status": "removed", "symbol": { /* Symbol */ } },
    { "status": "moved",   "before": {...}, "after": {...}, "rationale": "git-rename" },
    { "status": "changed", "before": {...}, "after": {...}, "delta": { /* see §5 */ } },
    { "status": "moved+changed", "before": {...}, "after": {...}, "rationale": "...", "delta": {...} },
    { "status": "dropped-toggled", "before": {...}, "after": {...}, "direction": "to-dropped" | "to-kept" }
  ],
  "components": {
    "added":   [ /* Component[] */ ],
    "removed": [ /* Component[] */ ],
    "changed": [ /* {before, after, delta} */ ]
  },
  "dependencies": {
    "added":   [ /* Dependency[] */ ],
    "removed": [ /* Dependency[] */ ]
  }
}
```

`status: "unchanged"` は出力に含めない (summary でカウントのみ)。

### 7.2 Markdown projection (`out/diff.md`)

PR コメント貼付を想定したフォーマット:

```md
# Aburi diff: main..HEAD

**Summary**: +5 added, -3 removed, ~12 changed, 2 moved, 1 moved+changed

## ⚠ API 変更 (要レビュー)

### `InvoiceService.createInvoice` *(method)*
- **signature**: outputs `Promise<Invoice>` → `Promise<InvoiceWithReceipt>`
- decorator added: `@UseGuards(AuthGuard)`

## 🔧 Logic 変更

### `RolesGuard.canActivate` *(method)*
- **effects added**:
  - `db.write: prisma.audit.create` (L75)
- **rules added**:
  - guard: `!user.verified` (L42)

## ➕ Added (5)

### `InvoiceService.refund` *(method)*
- boundary: `@Post('/refund')`
- effects: `db.write`, `event.publish`
- rules: guard, throw

## ➖ Removed (3)

### `ObsoleteController.endpoint` *(method)*
- was: `@Get('/old')`

## 🔀 Moved (意味変更なし)

<details>
<summary>2 件 (折りたたみ)</summary>

- `apps/billing/old.ts#X` → `apps/billing/new.ts#X` (git rename)
- `packages/util/a.ts#Y` → `packages/util/b.ts#Y` (logic fingerprint match)
</details>

## 🧱 Component changes

### added: `payments`
- roots: `apps/payments`
- public API: `apps/payments/src/routes/**`

## 🔗 Dependency changes

### added
- `billing` → `payments` (via: import)
```

セクション順は **重要度高 → 低**:

1. API 変更 (warning)
2. Logic 変更
3. Added (新規)
4. Removed (削除)
5. Moved+Changed (移動かつ変更)
6. Moved (意味変更なし — 折りたたみ)
7. Component changes
8. Dependency changes
9. Dropped 変動 (折りたたみ)
10. Syntax-only 変更 (折りたたみ)

折りたたみセクションは **レビュー負荷ゼロ** で見える。

## 8. 性能特性

### 8.1 計算量

| 段 | 計算量 |
|---|---|
| 段 1 (ID 一致) | O(N) hash map lookup |
| 段 2 (git rename) | O(R) where R = renamed files |
| 段 3 (logic fingerprint) | O(N) hash map lookup |
| 段 4 (name+signature) | O(K^2) where K = remaining unmatched |

K は通常 < 100 (大半が段 1 で決着するため)。実用上 O(N) で線形。

### 8.2 メモリ

base + head の Symbol を両方メモリに載せる。中規模 monorepo (1万 Symbol) で 100MB 未満。
大規模 (>10万) では streaming で扱う必要があるが v0.1 対象外。

### 8.3 目標

中規模 monorepo (~1000 ファイル、~5000 Symbol) で **diff 計算 <2 秒** (IR 生成除く)。
IR 生成込みでも <30 秒 (Workspace 全 scan 込み)。

## 9. エッジケース

### 9.1 schema バージョン不一致

base.$schema != head.$schema → エラー終了。
将来 v2 が出たら upgrader を提供する。

### 9.2 base が空 / head が空

- base 空 → 全 head Symbol が added
- head 空 → 全 base Symbol が removed
- 両方空 → empty diff

### 9.3 component id 衝突

base/head で同じ Component id を持つが roots が違う場合:
- componentDiff.changed として記録、delta.rootsChanged = true
- Symbol が新 component に移った場合は componentChanged = true で記録

### 9.4 plugin 構成の違い

base が effects-prisma plugin 有効、head が無効の場合:
- base で db.write だったものが head では calls 残り
- Symbol の logic fingerprint が変わるので "changed" として現れる
- 原因が plugin 構成差であることは Diff から直接わかる仕組みは持たない (v0.2 で `generator.plugins[]` を IR に記録する案)

### 9.5 大量の moved

ディレクトリ rename で全シンボルが moved になるケース:
- summary に集約 (`moved: 1234`)
- Markdown は「ディレクトリ rename と推定」と表示してまとめる (将来機能、v0.1 は個別列挙でも可)

### 9.6 dropped 同士のマッチ失敗

dropped シンボルは段 1 (完全 ID 一致) → 段 4.5 (weak matcher §3.4.5) の順で試行する。
同 ID で残れば unchanged 扱い、段 4.5 で拾えれば `moved` (rationale: `dropped-weak-match`)、それでも合わなければ droppedRemoved として独立カウント。

## 10. 検証可能な性質

| ID | 入力 | 期待 |
|---|---|---|
| DF1 | 同一 IR を base/head に与える | summary すべて 0、changes/components/dependencies 全て空 |
| DF2 | head に新 Symbol 1 件 | added: 1、Markdown の Added セクションに 1 件 |
| DF3 | base から Symbol 1 件削除 | removed: 1 |
| DF4 | rule の condition だけ変えた | changed: 1, delta.logicChanged: true, delta.apiChanged: false |
| DF5 | signature の outputs を変えた | changed: 1, delta.apiChanged: true |
| DF6 | ファイル rename (git rename 検出可) | moved: 1, rationale: "git-rename" |
| DF7 | ファイル rename + rule 追加 | moved+changed: 1, rationale: "git-rename" |
| DF8 | ファイル rename (git 不在) で logic fp 一致 | moved: 1, rationale: "logic-fingerprint" |
| DF9 | method 名 rename (同 file、同 logic) | moved: 1, rationale: "name-signature" (logic fp 同じだが ID 違う) |
| DF10 | base/head で複数 Symbol が同 logic fp | name 類似度で disambiguate、適切に pair |
| DF11 | component 追加 | components.added に 1 件 |
| DF12 | dependency 追加 | dependencies.added に 1 件 |
| DF13 | dropped Symbol を pair (ID 同じ) | unchanged 扱い |
| DF14 | dropped Symbol が消えた (basename も変わった) | droppedRemoved にカウント |
| DF14b | dropped Symbol を別ディレクトリへ移動 (basename 同一) | moved: 1, rationale: "dropped-weak-match" |
| DF15 | schema バージョン不一致 | エラー終了 |
| DF16 | line だけ違う同 rule (±2 以内) | delta.rules.modified なし (line fuzz) |
| DF17 | line が大きく違う同条件の rule (>2) | delta として added + removed |
| DF18 | syntax だけ変更 (logic/api 不変) | changed, delta.syntaxChanged のみ true → Markdown では「syntax-only 折りたたみ」 |

## 10.1 Diff schema の互換性ポリシー

`aburi.diff.v1.json` の互換性は IR schema (ir-schema.md §15) と同じ。
特に CI gate (`aburi diff --fail-on`) が依存するため:

- `MatchRationale` enum 追加は **破壊的** (consumer の `--fail-on` 設定が固定値依存のため)
- status enum (`added` / `removed` / `changed` / `moved` / `moved+changed` / `dropped-toggled`) の追加は **破壊的**
- `summary` フィールド追加は非破壊

## 11. 設計上の決定事項

### 11.1 5 段マッチングを採用する理由

単一手段 (ID 一致のみ) では ファイル rename・method rename・refactor で大量の false add/remove が出る。
複数手段を順次適用することで、信頼度の高い段から順に確定させて精度を上げる:

1. ID 一致 (確定情報)
2. git rename (物理確定)
3. logic fingerprint 一致 (意味同一性)
4. name + signature 類似度 (heuristic)

段 4 の閾値 0.85 は仮値。実プロジェクトでチューニングする。

### 11.2 段 3 で dropped を除外する理由

`fingerprint.logic = "000000000000"` の dropped シンボル同士が大量に「マッチ」してしまい、意味のない pair が作られる。
dropped は段 1 (完全 ID 一致) で先に決着させ、残りは段 4.5 の専用 weak matcher (`lastSegment + basename`、§3.4.5) で軽量に拾う。
段 4.5 は誤検出リスクを織り込んだ上で「dropped はそもそも IR の主視界外なので影響は小さい」前提で動かす。

### 11.3 line fuzz (±2) を delta 表示のみに使う理由

fingerprint 計算に line を含めると、空行 1 行入っただけで全 logic FP が変わる。fingerprint は line-free に保つ ([fingerprint.md](fingerprint.md) §4)。
ただし delta 表示時に line だけ違う rule を別物として並べると視認性が悪い。表示時のみ ±2 を許容する。

### 11.4 unchanged を出力に含めない理由

unchanged Symbol を全件出すと IR と同サイズの diff になり実用にならない。summary でカウントのみ提供、詳細は IR 自体を参照する。

### 11.5 git を必須にしない理由

CI 環境では git 履歴が浅い (`shallow clone`) こともあり、git rename 検出が常に使えるとは限らない。fingerprint ベースのフォールバック (段 3) を必須にすることで、git 不在でも動く。

### 11.6 Markdown 折りたたみセクションの目的

「移動だけ」「syntax だけ」のシンボルはレビュアーが見る必要がない。折りたたみ表示にすることで、PR コメントの可読性を保ちながら全情報を保持する。GitHub の `<details>` 要素はデフォルトで折りたたまれる。

### 11.7 component / dependency diff を Symbol diff と分離する理由

Component / Dependency はアーキテクチャレベルの変更。Symbol の追加削除と混在させると見通しが悪い。トップレベル別フィールドで管理し、Markdown でも別セクション。

### 11.8 plugin 構成差の検出を v0.2 に回す理由

base と head で plugin set が違うと、同じソースでも IR が変わる。これは「意味」ではなく「観測」の差。
v0.1 では「IR を信用する」前提で diff し、plugin 差は別仕組み (`generator.plugins[]` を IR に記録) で扱う。v0.1 でこれを入れると schema を変更する必要が出るため後送り。
