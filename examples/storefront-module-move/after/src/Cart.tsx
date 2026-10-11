import { formatCents, type Line, totalCents } from "./lib/money"

export function Cart({ lines }: { lines: Line[] }) {
  if (lines.length === 0) return <p>Your cart is empty.</p>
  return (
    <section>
      <ul>
        {lines.map((line) => (
          <li key={line.sku}>
            {line.name} × {line.quantity}
          </li>
        ))}
      </ul>
      <p>Total: {formatCents(totalCents(lines))}</p>
    </section>
  )
}
