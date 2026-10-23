/** Shared availability gate for ordinary launches and explicit evaluations. */
const EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CatalogModel {
  id: string;
  context_length: number;
  pricing: Record<string, string>;
  supported_parameters: string[];
  input_modalities: string[];
  output_modalities: string[];
  expiration_date: string | null;
}

export function normalizeCatalog(data: unknown): CatalogModel[] {
  if (!Array.isArray(data)) throw new Error("catalog has no data array");
  const models: CatalogModel[] = [];
  for (const entry of data) {
    if (!isPlainObject(entry) || typeof entry["id"] !== "string") continue;
    const pricing = isPlainObject(entry["pricing"]) ? entry["pricing"] : {};
    const arch = isPlainObject(entry["architecture"])
      ? entry["architecture"]
      : {};
    const strings = (value: unknown): string[] =>
      Array.isArray(value) && value.every((v) => typeof v === "string")
        ? (value as string[])
        : [];
    models.push({
      id: entry["id"],
      context_length:
        typeof entry["context_length"] === "number"
          ? entry["context_length"]
          : 0,
      pricing: Object.fromEntries(
        Object.entries(pricing).map(([k, v]) => [k, String(v)]),
      ),
      supported_parameters: strings(entry["supported_parameters"]),
      // raw API rows nest modalities under `architecture`; cached rows are flat
      input_modalities: strings(
        arch["input_modalities"] ?? entry["input_modalities"],
      ),
      output_modalities: strings(
        arch["output_modalities"] ?? entry["output_modalities"],
      ),
      expiration_date:
        entry["expiration_date"] == null
          ? null
          : typeof entry["expiration_date"] === "string"
            ? entry["expiration_date"]
            : "invalid expiration_date type",
    });
  }
  if (models.length === 0) throw new Error("catalog is empty");
  return models;
}

/** Why a catalog entry may not be used on a free route; null = eligible. */
export function freeIneligibleReason(
  model: CatalogModel,
  provider: { min_context: number },
  now: number,
): string | null {
  const prices = Object.entries(model.pricing);
  if (!("prompt" in model.pricing) || !("completion" in model.pricing))
    return "no pricing information";
  const paid = prices.find(([, v]) => v !== "0");
  if (paid) return `not free (pricing.${paid[0]} = ${paid[1]})`;
  if (!model.id.endsWith(":free"))
    return "not a :free variant with a stable model identity";
  if (!model.supported_parameters.includes("tools"))
    return "no tool calling support";
  if (
    !Number.isFinite(model.context_length) ||
    model.context_length < provider.min_context
  ) {
    return `context ${model.context_length} < required ${provider.min_context}`;
  }
  if (!model.input_modalities.includes("text")) return "no text input";
  if (
    model.output_modalities.length === 0 ||
    model.output_modalities.some((m) => m !== "text")
  ) {
    return "non-text output";
  }
  if (model.expiration_date !== null) {
    const expires = Date.parse(model.expiration_date);
    const calendarDate = model.expiration_date.match(
      /^\d{4}-\d{2}-\d{2}(?=$|T)/,
    )?.[0];
    const midnight = calendarDate
      ? Date.parse(calendarDate + "T00:00:00Z")
      : NaN;
    if (
      !Number.isFinite(expires) ||
      !Number.isFinite(midnight) ||
      new Date(midnight).toISOString().slice(0, 10) !== calendarDate
    )
      return `unparseable expiration_date ${model.expiration_date}`;
    if (expires - now < EXPIRY_MARGIN_MS) {
      return `retired or retiring (expiration_date ${model.expiration_date})`;
    }
  }
  return null;
}
