# Shared validation of the tracked .infisical.json project binding against
# the non-secret instance metadata in config/infisical.sh. Sourced by
# script/with-secrets and script/secrets-doctor so every Unix entry point
# enforces the same rule: the parsed workspaceId and defaultEnvironment must
# equal the canonical self-host project/environment. Fields are compared as
# parsed JSON (matching script/with-secrets.ps1), never as a substring of
# the raw file, so the wrapper can never fall through to Infisical Cloud or
# another project.
#
# Requires the caller to have sourced config/infisical.sh first and to have
# bun available (a declared project tool via mise).

# Returns 0 when the binding matches; prints the specific mismatch to stderr
# and returns 1 otherwise.
infisical_binding_check() {
  local config_file="$1"

  if [[ ! -f "$config_file" ]]; then
    printf 'missing tracked Infisical project binding: %s\n' "$config_file" >&2
    return 1
  fi

  if ! command -v bun >/dev/null 2>&1; then
    printf 'missing required command: bun (needed to validate %s)\n' "$config_file" >&2
    return 1
  fi

  INFISICAL_BINDING_FILE="$config_file" \
  INFISICAL_BINDING_PROJECT="$INFISICAL_PROJECT_ID" \
  INFISICAL_BINDING_ENVIRONMENT="$INFISICAL_ENVIRONMENT" \
    bun -e '
      import { readFileSync } from "node:fs";
      const file = process.env.INFISICAL_BINDING_FILE;
      const project = process.env.INFISICAL_BINDING_PROJECT;
      const environment = process.env.INFISICAL_BINDING_ENVIRONMENT;
      let binding;
      try {
        binding = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        console.error(`invalid JSON in Infisical binding ${file}: ${error.message}`);
        process.exit(1);
      }
      if (binding?.workspaceId !== project) {
        console.error(`Infisical project binding does not match expected self-host project ${project}`);
        process.exit(1);
      }
      if (binding?.defaultEnvironment !== environment) {
        console.error(`Infisical environment binding does not match expected environment ${environment}`);
        process.exit(1);
      }
    '
}
