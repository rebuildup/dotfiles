# Open Code Review — MiniMax M Plan (default) / OpenCode Go (opt-in)

`pc-setup` installs the `ocr` binary (official GitHub Release via mise). `dotfiles` owns only the user configuration and the credential bridge.

- Config: `home/.opencodereview/config.json` → `~/.opencodereview/config.json` via `script/link` (POSIX) or `script/link.ps1 -Apply` (Windows).
- Default provider: built-in `minimax`, model `MiniMax-M3.1-Flash`. Auth and model selection follow `config/agents.toml` `[providers.minimax]` (`MINIMAX_M_PLAN_KEY` secret, `MiniMax-M3.1-Flash` default). The built-in preset targets `https://api.minimax.io/v1` with the OpenAI protocol; the M Plan key was verified live against it on 2026-11-26.
- OpenCode Go stays selectable: `custom_providers.opencode-go` keeps the `https://opencode.ai/inference/go/v1` endpoint, `mimo-v2.6-flash`, and the `x-opencode-session: {ocr_session_key}` header (OpenCode Go rejects requests without that header, HTTP 400 `MissingSessionID`). Switch with `ocr config set provider opencode-go`. There is no automatic fallback between providers; a failed default fails closed.
- Credential: `api_key_cmd` runs `ocr-key <provider>` (`minimax` or `opencode-go`), resolved by OCR's shell from `PATH`. POSIX and Windows launchers in `home/.local/bin/` run `script/ocr-key.ts` with Bun. That script maps the provider to its Infisical secret (`MINIMAX_M_PLAN_KEY` / `OPENCODE_API_KEY`), strips an ambient copy of that variable, then invokes the existing self-hosted Infisical `script/with-secrets` / `script/with-secrets.ps1` boundary and prints only the freshly injected key. Unknown provider names fail before any lookup. No secret value is stored in Git or OCR config.

## Apply and verify

Make sure `~/.local/bin` is on `PATH`, Bun and Infisical are installed by `pc-setup`, and the Infisical login/project binding works.

On macOS / WSL / Linux:

```sh
cd ~/.dotfiles
./script/link
./script/check
ocr llm test
```

On Windows native (PowerShell):

```powershell
cd ~/.dotfiles
pwsh -NoProfile -File script/link.ps1          # review the plan
pwsh -NoProfile -File script/link.ps1 -Apply   # only links absent targets
ocr llm test
```

The managed config is an ordinary file in Git and a symlink at the live path; do not run `ocr config set ...api_key` or paste a key in the TUI. That would write plaintext into a tracked file. For settings changes, modify the Git source and review its diff. The key command intentionally emits a secret to stdout **when called**; never print or capture its output in logs. Only use `ocr llm test` to verify connectivity.

If an existing `~/.opencodereview/config.json` conflicts, the linking scripts fail/report a conflict instead of overwriting it. Back it up outside the repository and manually migrate desired non-secret settings before linking. OCR sessions and other files within `~/.opencodereview/` remain untouched. When upgrading from the `ocr-go-key` bridge, delete the stale `ocr-go-key` / `ocr-go-key.cmd` launchers under `~/.local/bin`; the link scripts never remove files.

OpenCode Go and Zen may share an `OPENCODE_API_KEY`, but only this `/inference/go/v1` endpoint is configured for OCR. Keep Extra Usage disabled in the OpenCode console if you need to prevent pay-as-you-go overflow; the endpoint alone cannot enforce billing controls. Missing/invalid credentials fail closed; no fallback model or provider is configured.

References: https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/configuration.md and https://opencode.ai/docs/go/
