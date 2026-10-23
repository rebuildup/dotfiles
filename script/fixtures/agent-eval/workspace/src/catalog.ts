export interface Item {
  priceCents: number;
  stock: number;
}
export type Inventory = Record<string, Item>;
export function lookup(inventory: Inventory, sku: string): Item | undefined {
  return inventory[sku.trim().toLowerCase()];
}
