---
"@aburi/diff": minor
---

Measure how much a name says by its words, not by its token count

`tokenizeName` found word boundaries by comparing code points against `a`–`z`, `A`–`Z` and
`0`–`9`, so a name written in a script with no ASCII case boundary and no separator came back
whole: `ユーザー情報を取得する` and `获取用户信息` were one token each, and
`получитьПользователя` was one token with its camel hump unread.

Jaccard never minded — two names that tokenise whole score 1.0 against each other and 0 against
anything else, which is right for identical and unrelated names alike. What minded was
diff-algorithm.md §3.4.3's admissibility rule, the one place that reads the token *count* as a
measure of how much a name says. It refused `ユーザー情報を取得する` on the same footing as
`main`, on the grounds that one word is not evidence of identity. That is true of `main`. It is
not true of a name two unrelated Symbols would never carry by coincidence.

Two changes, answering two different faults.

**The camel boundary is Unicode case.** `\p{Ll}`, `\p{Lu}`/`\p{Lt}` and `\p{Nd}` in place of the
ASCII ranges, so a hump is a hump in every cased script and `получитьПользователя` splits into
two the way `getUser` does. Titlecase counts as opening a word, for the digraphs that carry it,
and the previous code point is carried along rather than sliced back off the chunk, so the hump
registers in the cased scripts outside the BMP too. This fixes the cased scripts and nothing
else: Japanese and Chinese have no case to read.

**`nameEvidence` in place of the count.** A token of a script that writes its word boundaries is
one word however long it runs. A run of a script that writes none cannot be segmented, so it is
counted instead, over the longest a single word of that script runs: three characters for Han,
which writes a morpheme per character (`初期化`, `数据库`), and six for kana and Hangul, which
write a syllable per character (`ハンドラー`, `데이터베이스`). The quotient is a floor on the
number of words in the run, so it admits only what cannot be one word: `获取用户信息` is 2 and
`ユーザー情報を取得する` is 2 1/3, while `メイン`, `초기화` and `ハンドラー` — `main`,
`initialize` and `handler` — stay under a word alongside the English they translate. Characters
are counted once each, as tokens are, and the name is read in NFC so the verdict does not turn
on which normalisation a toolchain emitted.

Length alone is deliberately not the measure. `initialize` is ten characters and one word, and
two unrelated top-level `initialize(x: string)` are exactly the coincidence the rule exists for,
so a bar on raw length low enough to admit `获取用户信息` would admit `handler`. Nor is
caselessness: Arabic and Hebrew letters are letters rather than words, a run of them is one word,
and a multi-word identifier in those scripts writes a separator the tokeniser already splits on.

Six is the longest word assumed, not the longest there is — `アプリケーション` is one word in
eight and is admitted as though it were more. The constants sit where they do because a name of
seven syllables is more often a phrase than a loanword, and a wrong pairing costs less than the
band of real moves a higher divisor would refuse.

What this buys a morphemic name is narrower than the rule itself: such a name is one token, so
the threshold table still hands it `EXACT_MATCH_ONLY`, and what stage 4 recovers is the
signature-identical move rather than the whole band. The table keeps reading the plain token
count, which is correct there and now says so: its rows are about how coarse a Jaccard over
those tokens can be, and one token against a name of `n` scores 0 or `1/n`. The two rules ask
different questions of the same name.

`nameEvidence` is exported alongside `tokenizeName`.
