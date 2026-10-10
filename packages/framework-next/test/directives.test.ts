import { describe, expect, it } from "vitest"
import { detectModuleDirective } from "../src/index"

describe("detectModuleDirective", () => {
  it.each([
    ["'use client' in single quotes", "'use client'\nexport default function Page() {}", "client"],
    ['"use client" in double quotes', '"use client"\nexport default function Page() {}', "client"],
    ["'use server'", "'use server'\nexport async function action() {}", "server"],
    ["a trailing semicolon", '"use client";\nexport default function Page() {}', "client"],
    ["blanks before the semicolon", "'use client' \t;\nexport function X() {}", "client"],
    [
      "leading line comments",
      "// copyright notice\n'use client'\nexport function X() {}",
      "client",
    ],
    ["leading block comments", "/* header */\n'use client'\nexport function X() {}", "client"],
    ["a 'use strict' before it", "'use strict';\n'use client';\nexport function X() {}", "client"],
    [
      "a 'use strict' before 'use server'",
      "'use strict'\n'use server'\nexport function X() {}",
      "server",
    ],
    ["a UTF-8 BOM", "﻿'use client'\nexport function X() {}", "client"],
    ["a BOM and a comment", "﻿// copyright\n'use client'\nexport function X() {}", "client"],
    ["a newline, even with a `+` on the next line", "'use client'\n+ 'x'", "client"],
  ])("reads the directive behind %s", (_label, source, directive) => {
    expect(detectModuleDirective(source)).toBe(directive)
  })

  it.each([
    ["no directive at all", "export default function Page() { return null }"],
    ["a directive after the first statement", "const x = 1\n'use client'\nexport function X() {}"],
    ["a template literal, which is no directive", "`use client`\nexport function X() {}"],
    ["another string statement", "'not a directive'\nexport function X() {}"],
    ["a directive continued on its own line", "'use client' + 'x'\nexport function X() {}"],
    ["an unknown directive before a statement", "'unknown-directive'\nconst x = 1\n'use client'"],
    ["whitespace alone", "   \n   \n"],
  ])("returns null for %s", (_label, source) => {
    expect(detectModuleDirective(source)).toBeNull()
  })
})
