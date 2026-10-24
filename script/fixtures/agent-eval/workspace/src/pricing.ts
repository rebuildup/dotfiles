export function subtotal(
  priceCents: number,
  quantity: number,
  discountPercent = 0,
): number {
  return Math.round((priceCents * quantity * discountPercent) / 100);
}
