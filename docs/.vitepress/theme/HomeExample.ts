import { h } from "vue"

/**
 * The comparison that sits under the home hero: the same commit as `git diff`
 * renders it, and as Aburi reports it.
 *
 * Built with render functions rather than a single-file component for two
 * reasons. Biome reads a `.vue` script block without its template, so every
 * binding in one looks unused to the linter. And inside a `pre`, the newlines
 * an SFC template puts between sibling elements survive as text nodes, so each
 * rendered line arrives with a blank one under it.
 */

type Line = { kind: string; text: string }

const GIT_LINES: Line[] = [
  { kind: "ctx", text: "export async function POST(req: Request) {" },
  { kind: "ctx", text: "  const session = await auth()" },
  { kind: "del", text: "-   if (session.user.role !== 'admin') {" },
  { kind: "del", text: "-     return forbidden()" },
  { kind: "del", text: "-   }" },
  { kind: "ctx", text: "  const body = await req.json()" },
  { kind: "del", text: "-   const order = await prisma.order.create(body)" },
  { kind: "add", text: "+   const order = await prisma.order.create({" },
  { kind: "add", text: "+     data: { ...body, source: 'api' }," },
  { kind: "add", text: "+   })" },
  { kind: "add", text: "+   await prisma.auditLog.create({ data: { action: 'order.create' } })" },
  { kind: "ctx", text: "  return Response.json(order)" },
]

const REPORT_LINES: Line[] = [
  { kind: "dim", text: "Summary: +2 added · -1 removed · ~3 changed" },
  { kind: "blank", text: "" },
  { kind: "head", text: "⚠ API changes" },
  { kind: "sym", text: "submitOrder  (function)  actions.ts:18" },
  { kind: "dim", text: "  signature.throws added: PaymentDeclined" },
  { kind: "blank", text: "" },
  { kind: "head", text: "🔧 Logic changes" },
  { kind: "sym", text: "POST  (function)  route.ts:9" },
  { kind: "dim", text: "  rules removed:" },
  { kind: "del", text: "    guard: session.user.role !== 'admin'" },
  { kind: "dim", text: "  effects added:" },
  { kind: "add", text: "    db.write: prisma.auditLog.create" },
]

const pane = (opts: {
  label: string
  file: string
  lines: Line[]
  foot: string
  accent?: boolean
}) =>
  h("figure", { class: ["pane", opts.accent ? "pane-accent" : ""] }, [
    h("figcaption", { class: "pane-head" }, [
      h("span", { class: "pane-label" }, opts.label),
      h("span", { class: "pane-file" }, opts.file),
    ]),
    h(
      "pre",
      { class: "pane-body" },
      h(
        "code",
        null,
        opts.lines.map((line, i) => h("span", { key: i, class: line.kind }, line.text)),
      ),
    ),
    h("p", { class: "pane-foot" }, opts.foot),
  ])

export default () =>
  h("section", { class: "home-example" }, [
    h("div", { class: "panes" }, [
      pane({
        label: "git diff",
        file: "src/app/api/orders/route.ts",
        lines: GIT_LINES,
        foot: "1,997 more lines across 34 files",
      }),
      pane({
        label: "aburi diff main..HEAD",
        file: "out/diff.md",
        lines: REPORT_LINES,
        foot: "Ready to paste into a pull request",
        accent: true,
      }),
    ]),
    h(
      "p",
      { class: "caption" },
      "Both panes describe the same commit. The guard somebody deleted sits three lines into two thousand on the left, and carries its own heading on the right.",
    ),
  ])
