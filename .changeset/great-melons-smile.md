---
"@aburi/diff": patch
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
not true of a name two unrelated Symbols would never carry by coincidence, and the cost was a
whole band of moves: a top-level function that moved file with an edited body came back as
`added` + `removed` rather than `moved+changed`.

Two changes, answering two different faults.

**The camel boundary is Unicode case.** `\p{Ll}`, `\p{Lu}`/`\p{Lt}` and `\p{Nd}` in place of the
ASCII ranges, so a hump is a hump in every cased script and `получитьПользователя` splits into
two the way `getUser` does. Titlecase counts as opening a word, for the digraphs that carry it.
This fixes the cased scripts and nothing else: Japanese and Chinese have no case to read.

**`nameEvidence` in place of the count.** A character of a morphemic script — Han, the two kana,
Hangul — is a word with no boundary written after it, so it counts as the word it is; a token of
any other script is one word however long it runs. `获取用户信息` is six, `ユーザー情報を取得する`
is eleven, and both are now read by stage 4.

Length is deliberately not the measure. `initialize` is ten characters and one word, and two
unrelated top-level `initialize(x: string)` are exactly the coincidence the rule exists for — so
a bar on length low enough to admit `获取用户信息` at six characters would admit `handler` at
seven. Nor is caselessness the measure: Arabic and Hebrew letters are letters rather than words,
a run of them is one word, and a multi-word identifier in those scripts writes a separator the
tokeniser already splits on. `главная`, `مستخدم` and `main` are all still refused.

The threshold table keeps reading the plain token count, which is correct there and now says so:
its rows are about how coarse a Jaccard over those tokens can be, and a one-token name admits
only 0 and 1 whatever script wrote it. The two rules ask different questions of the same name.

`nameEvidence` is exported alongside `tokenizeName`.
