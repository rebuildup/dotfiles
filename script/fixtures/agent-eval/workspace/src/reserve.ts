import type { Inventory } from "./catalog";
export interface Line {
  sku: string;
  quantity: number;
}
export function reserve(
  _inventory: Inventory,
  _lines: Line[],
  _discountPercent = 0,
): { inventory: Inventory; totalCents: number } {
  throw new Error("not implemented");
}
