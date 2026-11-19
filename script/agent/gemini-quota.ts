/** Fixed model and provider identity for the zero-cost Gemini route. */
export const GEMINI_PROVIDER_ID = "gemini";
export const GEMINI_MODEL_ID = "gemini-4-hydrogen";

export interface OpenCodeRetryEvent {
  model: { providerID: string; id: string; variant?: string };
  error: { status?: number };
  decision: { retry: false } | { retry: true; delay: number };
}

/** Google quota/rate-limit responses must terminate this route immediately. */
export function isGeminiQuota429(event: OpenCodeRetryEvent): boolean {
  return (
    event.model.providerID === GEMINI_PROVIDER_ID &&
    event.model.id === GEMINI_MODEL_ID &&
    event.error.status === 429
  );
}
