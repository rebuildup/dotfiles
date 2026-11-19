import { Model, Plugin, Provider } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { GEMINI_MODEL_ID, GEMINI_PROVIDER_ID, isGeminiQuota429 } from "../gemini-quota.ts";

const PROVIDER_ID = Provider.ID.make(GEMINI_PROVIDER_ID);
const MODEL_ID = Model.ID.make(GEMINI_MODEL_ID);

/**
 * Process-scoped route guard. It removes other selectable models, pins all
 * requests (including subagents) to Hydrogen, and prevents OpenCode's normal
 * bounded retry policy from repeating a request after quota exhaustion.
 */
export default Plugin.define({
  id: "dotfiles.gemini-free-tier",
  effect: (context) =>
    Effect.gen(function* () {
      yield* context.model.transform((editor) => {
        for (const model of editor.list()) {
          if (model.providerID !== PROVIDER_ID || model.id !== MODEL_ID) {
            editor.remove(model.providerID, model.id);
          }
        }
        if (!editor.get(GEMINI_PROVIDER_ID, GEMINI_MODEL_ID)) {
          throw new Error("Gemini Free Tier route model is unavailable");
        }
        editor.default.set(GEMINI_PROVIDER_ID, GEMINI_MODEL_ID);
      });

      yield* context.session.hook("experimental.model.resolve", (event) =>
        Effect.sync(() => {
          // The hook replaces the whole ref; editing event.model's fields in
          // place is silently ignored, and the target must stay on this
          // provider (a foreign provider fails resolution as unavailable).
          event.model = { providerID: PROVIDER_ID, id: MODEL_ID };
        }),
      );

      yield* context.session.hook(
        "retry",
        (event) =>
          Effect.sync(() => {
            if (isGeminiQuota429(event)) event.decision = { retry: false };
          }),
        { providerID: GEMINI_PROVIDER_ID },
      );
    }),
});
