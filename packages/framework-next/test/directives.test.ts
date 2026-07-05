import { describe, expect, it } from "vitest"
import { detectModuleDirective } from "../src/index"

describe("detectModuleDirective — top-of-module directive detection", () => {
  it("recognizes a bare 'use client' directive as the first statement", () => {
    expect(detectModuleDirective("'use client'\nexport default function Page() {}")).toBe("client")
    expect(detectModuleDirective('"use client"\nexport default function Page() {}')).toBe("client")
  })

  it("recognizes a bare 'use server' directive", () => {
    expect(detectModuleDirective("'use server'\nexport async function action() {}")).toBe("server")
  })

  it("accepts a trailing semicolon after the directive", () => {
    expect(detectModuleDirective('"use client";\nexport default function Page() {}')).toBe("client")
  })

  it("accepts leading line comments before the directive", () => {
    expect(detectModuleDirective("// copyright notice\n'use client'\nexport function X() {}")).toBe(
      "client",
    )
  })

  it("accepts leading block comments before the directive", () => {
    expect(detectModuleDirective("/* header */\n'use client'\nexport function X() {}")).toBe(
      "client",
    )
  })

  it("returns null when the directive is not the first statement", () => {
    expect(detectModuleDirective("const x = 1\n'use client'\nexport function X() {}")).toBeNull()
  })

  it("returns null when there is no directive at all", () => {
    expect(detectModuleDirective("export default function Page() { return null }")).toBeNull()
  })

  it("returns null for template-literal directives (spec disallows them)", () => {
    expect(detectModuleDirective("`use client`\nexport function X() {}")).toBeNull()
  })

  it("returns null for other string-literal statements", () => {
    expect(detectModuleDirective("'not a directive'\nexport function X() {}")).toBeNull()
  })

  it("returns null for whitespace-only input", () => {
    expect(detectModuleDirective("   \n   \n")).toBeNull()
  })

  it("returns null for a directive appended to an expression", () => {
    // The string continues into a larger expression, so it is not a bare statement.
    expect(detectModuleDirective("'use client' + 'x'\nexport function X() {}")).toBeNull()
  })

  it("finds 'use client' after a leading 'use strict' directive (multi-directive prologue)", () => {
    expect(detectModuleDirective("'use strict';\n'use client';\nexport function X() {}")).toBe(
      "client",
    )
  })

  it("finds 'use server' after a leading 'use strict' directive", () => {
    expect(detectModuleDirective("'use strict'\n'use server'\nexport async function X() {}")).toBe(
      "server",
    )
  })

  it("stops at the first non-string statement even when unknown directives precede it", () => {
    expect(detectModuleDirective("'unknown-directive'\nconst x = 1\n'use client'")).toBeNull()
  })

  it("transparently skips a leading UTF-8 BOM before the directive", () => {
    // "﻿" is the encoded BOM; editors often paste one in front of otherwise valid
    // sources without the writer noticing.
    expect(detectModuleDirective("﻿'use client'\nexport function X() {}")).toBe("client")
  })

  it("handles BOM + leading comments + directive together", () => {
    expect(detectModuleDirective("﻿// copyright\n'use client'\nexport function X() {}")).toBe(
      "client",
    )
  })
})
