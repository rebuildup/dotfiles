Implement an atomic inventory reservation operation in this TypeScript library.
Read the existing modules and run `bun test public.test.ts` first. Fix the existing pricing regression, then implement reserve(inventory, lines, discountPercent=0) in src/reserve.ts.

A reservation accepts an array of {sku, quantity}. Normalize SKUs by trimming and lowercasing; repeated SKUs combine quantities. Each quantity must be a positive safe integer. Reject unknown SKUs, insufficient combined stock, invalid quantities, and discounts outside integer 0..100. Return {inventory, totalCents}: a fresh inventory with decremented stock and the discounted total price in integer cents rounded once after summing the full order. Never mutate the input inventory or input lines, including when validation fails. Empty lines are valid with zero total. Preserve existing lookup and subtotal exports.

You may edit only src/catalog.ts, src/pricing.ts, src/reserve.ts. Do not edit tests, this task, or add files. Use the tools to inspect modules, debug test failures, and run final tests before completing. No dependencies or network operations are necessary.
