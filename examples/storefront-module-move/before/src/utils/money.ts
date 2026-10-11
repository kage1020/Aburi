export type Line = { sku: string; name: string; quantity: number; unitCents: number }

export function totalCents(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0)
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100)
}
