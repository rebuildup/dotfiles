// This external grader is never copied to the agent workspace or prompt.
import { expect } from "bun:test";
const root = process.argv[2];
import { createContext, Script } from "node:vm";
import { dirname, resolve } from "node:path";
const allowed = new Set(
  ["catalog.ts", "pricing.ts", "reserve.ts"].map((file) =>
    resolve(root, "src", file),
  ),
);
function literal(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value))
    return Number.isNaN(value) ? "NaN" : value < 0 ? "-Infinity" : "Infinity";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "[" + value.map(literal).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + ":" + literal(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function isolatedModule(file: string) {
  const built = await Bun.build({
    entrypoints: [resolve(root, "src", file)],
    target: "browser",
    format: "cjs",
    write: false,
    plugins: [
      {
        name: "local-source-only",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const path = resolve(
              args.resolveDir || dirname(args.importer),
              args.path,
            );
            const actual = path.endsWith(".ts") ? path : path + ".ts";
            if (!allowed.has(actual))
              return {
                errors: [
                  {
                    text: "only allowlisted local source imports are permitted",
                  },
                ],
              };
            return { path: actual };
          });
        },
      },
    ],
  });
  if (!built.success || built.outputs.length !== 1)
    throw Error("source build failed");
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  new Script(
    "globalThis.module={exports:{}};globalThis.exports=module.exports;",
  ).runInContext(context, { timeout: 1000 });
  new Script(await built.outputs[0].text()).runInContext(context, {
    timeout: 1000,
  });
  return (name: string, args: unknown[]) => {
    const serialized = literal(args);
    const script = new Script(
      `(()=>{const args=${serialized};const before=JSON.stringify(args);const freeze=(value)=>{if(value&&typeof value==='object'){Object.freeze(value);for(const nested of Object.values(value))freeze(nested);}};freeze(args);let value,error;try{value=module.exports[${JSON.stringify(name)}](...args);}catch(e){error=String(e);}return JSON.stringify({value,error,unchanged:JSON.stringify(args)===before,sameInventory:value?.inventory===args[0]});})()`,
    );
    const result = JSON.parse(script.runInContext(context, { timeout: 1000 }));
    expect(result.unchanged).toBe(true);
    if (name === "reserve" && !result.error)
      expect(result.sameInventory).toBe(false);
    if (result.error) throw Error(result.error);
    return result.value;
  };
}
const reservation = await isolatedModule("reserve.ts");
const pricing = await isolatedModule("pricing.ts");
const catalog = await isolatedModule("catalog.ts");
const reserve = (...args: unknown[]) => reservation("reserve", args);
const subtotal = (...args: unknown[]) => pricing("subtotal", args);
const lookup = (...args: unknown[]) => catalog("lookup", args);
const base = {
  tea: { priceCents: 101, stock: 5 },
  coffee: { priceCents: 203, stock: 3 },
};
const frozen = () =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(base).map(([key, value]) => [
        key,
        Object.freeze({ ...value }),
      ]),
    ),
  );
expect(subtotal(101, 3, 17)).toBe(251);
expect(lookup(base, " COFFEE ")).toEqual(base.coffee);
for (const discount of [0, 17, 100]) {
  const inventory = frozen();
  const lines = Object.freeze(
    [
      { sku: " TEA ", quantity: 1 },
      { sku: "tea", quantity: 2 },
      { sku: "Coffee", quantity: 1 },
    ].map(Object.freeze),
  );
  const result = reserve(inventory, lines, discount);
  expect(result.totalCents).toBe(Math.round((506 * (100 - discount)) / 100));
  expect(result.inventory.tea.stock).toBe(2);
  expect(result.inventory.coffee.stock).toBe(2);
  expect(result.inventory).not.toBe(inventory);
  expect(inventory).toEqual(base);
}
for (const lines of [
  [
    { sku: "tea", quantity: 3 },
    { sku: " TEA ", quantity: 3 },
  ],
  [{ sku: "unknown", quantity: 1 }],
  [{ sku: "tea", quantity: 0 }],
  [{ sku: "tea", quantity: -1 }],
  [{ sku: "tea", quantity: 1.5 }],
  [{ sku: "tea", quantity: NaN }],
  [{ sku: "tea", quantity: Number.MAX_SAFE_INTEGER + 1 }],
  [
    { sku: "tea", quantity: 1 },
    { sku: "coffee", quantity: 4 },
  ],
]) {
  const inventory = frozen();
  expect(() => reserve(inventory, lines)).toThrow();
  expect(inventory).toEqual(base);
}
for (const discount of [-1, 101, 0.5, NaN, Infinity])
  expect(() => reserve(frozen(), [], discount)).toThrow();
const empty = reserve(frozen(), []);
expect(empty.totalCents).toBe(0);
expect(empty.inventory).toEqual(base);
if (!process.env.AGENT_EVAL_GRADE_NONCE)
  throw Error("missing grader completion nonce");
console.log(process.env.AGENT_EVAL_GRADE_NONCE + ":external-checks-passed");
