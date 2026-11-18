#!/usr/bin/env bash
# Resolve one Infisical secret and print ONLY its value on stdout.
#
# Used as an OMP models.yml `apiKey: "!…"` command: OMP runs the command and
# uses the trimmed stdout as the provider credential, so the secret travels
# Infisical -> OMP directly and never enters process argv, pane environment,
# or the Herdr server. stderr carries CLI notices; stdout is the value only.
#
# Requires an Infisical login session (human workstation) or equivalent auth
# for the calling user — the same boundary script/with-secrets relies on.
set -euo pipefail

secret_name="${1:?usage: infisical-key.sh SECRET_NAME}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck source=config/infisical.sh
source "$repo_root/config/infisical.sh"

if ! command -v infisical >/dev/null 2>&1; then
  printf 'infisical-key.sh: missing required command: infisical\n' >&2
  exit 1
fi

# --domain pins the self-host instance explicitly: without it the CLI
# defaults to Infisical Cloud, which must never be a silent fallback.
exec infisical secrets get "$secret_name" \
  "--domain=$INFISICAL_SITE_URL" \
  "--projectId=$INFISICAL_PROJECT_ID" \
  "--env=$INFISICAL_ENVIRONMENT" \
  --plain
