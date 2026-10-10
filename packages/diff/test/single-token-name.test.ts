import { guardedBody, sig } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { matchStageNameSignature } from "../src"
import { diffSymbols, fn, method, pairedNames } from "./helpers"

/** The same name on both sides, in two files, with edited bodies: only stage 4 could pair it. */
function movedAndEdited(name: string, build = fn): string[] {
  return pairedNames([build("src/a.ts", name, "aaa")], [build("src/b.ts", name, "bbb")])
}

describe("a name that says one thing is not evidence of identity", () => {
  it("reports two unrelated top-level `main`s as added and removed, not as a move", () => {
    const diff = diffSymbols(
      [fn("src/legacy/runner.ts", "main", "aaa")],
      [fn("src/tools/scaffold.ts", "main", "bbb")],
    )
    expect(diff.summary).toMatchObject({ added: 1, removed: 1, moved: 0, movedChanged: 0 })
  })

  it("does not pair a set of them in id order", () => {
    const base = ["p", "q", "r"].map((f) => fn(`src/${f}.ts`, "main", `a${f}`))
    const head = ["x", "y", "z"].map((f) => fn(`src/${f}.ts`, "main", `b${f}`))
    expect(pairedNames(base, head)).toEqual([])
  })

  it.each([
    ["an owner that repeats the member", "Main.main", method],
    ["a name with no tokens at all", "_", fn],
    ["a single Cyrillic word", "главная", fn],
    ["a long single English word", "initialize", fn],
    ["a single word of a caseless alphabetic script", "مستخدم", fn],
  ])("refuses %s", (_, name, build) => {
    expect(movedAndEdited(name, build)).toEqual([])
  })

  it.each([
    "値",
    "取得",
    "する",
    "初期化",
    "メイン",
    "초기화",
    "ユーザー",
    "ハンドラー",
  ])("refuses a single word written without word boundaries: `%s`", (name) => {
    expect(movedAndEdited(name)).toEqual([])
  })

  it("refuses such a word on the base side too", () => {
    expect(
      pairedNames(
        [method("src/a.ts", "ハンドラー.実行", "aaa")],
        [method("src/b.ts", "実行", "bbb")],
      ),
    ).toEqual([])
  })

  it("reads the base as well as the head", () => {
    expect(
      pairedNames(
        [method("src/a.ts", "Main.main", "aaa")],
        [method("src/b.ts", "Mains.main", "bbb")],
      ),
    ).toEqual([])
    expect(
      pairedNames(
        [method("src/a.ts", "Mains.main", "aaa")],
        [method("src/b.ts", "Main.main", "bbb")],
      ),
    ).toEqual([])
  })

  it.each([
    ["a longer top-level name", fn("src/b.ts", "mainRunner", "bbb")],
    ["a method of that name", method("src/b.ts", "Foo.main", "bbb")],
    ["a three-word top-level name", fn("src/b.ts", "mainRunnerEntry", "bbb")],
  ])("refuses to pair a short base with %s", (_, head) => {
    expect(pairedNames([fn("src/a.ts", "main", "aaa")], [head])).toEqual([])
  })

  it("leaves both in the stage's remainder rather than removing them from the diff", () => {
    const base = fn("src/a.ts", "main", "aaa")
    const head = fn("src/b.ts", "main", "bbb")
    expect(matchStageNameSignature([base], [head])).toEqual({
      matched: [],
      remainingBase: [base],
      remainingHead: [head],
    })
  })
})

describe("a name that says more than one thing is paired", () => {
  it.each([
    ["a method whose member alone is one token", "UserRepo.get", method],
    ["a two-token name whose owner supplies the second token", "Foo.main", method],
    ["a Japanese name", "ユーザー情報を取得する", fn],
    ["a Chinese name", "获取用户信息", fn],
    ["a Korean name", "사용자정보조회", fn],
    ["a Cyrillic name whose camel hump makes a second token", "получитьПользователя", fn],
    ["a method of a caseless alphabetic script", "مستخدم.احصل", method],
    ["a name split on a separator", "ユーザー.取得", method],
    ["a name with a Latin owner", "UserRepo.取得", method],
    ["a phrase built from single words", "初期化処理を実行する", fn],
  ])("pairs %s", (_, name, build) => {
    expect(movedAndEdited(name, build)).toEqual([`${name} -> ${name}`])
  })

  it.each([
    ["composed", "ガイド取得"],
    ["decomposed", "ガイド取得"],
  ])("pairs a name in %s form", (_, name) => {
    expect(movedAndEdited(name)).toEqual([`${name} -> ${name}`])
  })

  it("does not pair two different names that merely share a script", () => {
    expect(
      pairedNames(
        [fn("src/a.ts", "ユーザー情報を取得する", "aaa")],
        [fn("src/b.ts", "注文履歴を保存する", "bbb")],
      ),
    ).toEqual([])
  })

  it("recovers only a signature-identical move, since its member is still one token", () => {
    const signature = sig({
      inputs: [
        { name: "id", type: "string" },
        { name: "y", type: "number" },
      ],
      outputs: ["User"],
    })
    const widened = (name: string) => [fn("src/b.ts", name, "bbb", { signature })]
    expect(
      pairedNames(
        [fn("src/a.ts", "ユーザー情報を取得する", "aaa")],
        widened("ユーザー情報を取得する"),
      ),
    ).toEqual([])
    expect(
      pairedNames([fn("src/a.ts", "getUserInformation", "aaa")], widened("getUserInformation")),
    ).toEqual(["getUserInformation -> getUserInformation"])
  })
})

describe("the rule belongs to stage 4", () => {
  it("leaves stage 3 to pair a one-token name on a logic fingerprint that names something", () => {
    const body = { rules: guardedBody("argv.length === 0") }
    expect(
      pairedNames([fn("src/a.ts", "main", "same", body)], [fn("src/b.ts", "main", "same", body)]),
    ).toEqual(["main -> main"])
    expect(pairedNames([fn("src/a.ts", "main", "same")], [fn("src/b.ts", "main", "same")])).toEqual(
      [],
    )
  })

  it("leaves stage 3 to pair a name that says enough on an evidenceless fingerprint", () => {
    expect(
      pairedNames(
        [fn("src/a.ts", "ユーザー情報を取得する", "same")],
        [fn("src/b.ts", "ユーザー情報を取得する", "same")],
      ),
    ).toEqual(["ユーザー情報を取得する -> ユーザー情報を取得する"])
  })
})
