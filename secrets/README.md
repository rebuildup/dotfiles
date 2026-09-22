# Secrets

This directory contains only SOPS-encrypted portable secret payloads and documentation.

## Environment secrets

Use a flat JSON object so `sops exec-env` can expose each top-level key as one environment variable:

```json
{
  "EXAMPLE_TOKEN": "plaintext exists only while editing before SOPS saves it"
}
```

Create/edit the real encrypted file after `.sops.yaml` has been initialized:

```bash
sops secrets/global.sops.json
```

Run a command with those variables without writing a decrypted env file:

```bash
./script/with-secrets 'your-command'
```

The default file is `secrets/global.sops.json`. Override it with `DOTFILES_SECRET_FILE`.

## File secrets

Do not place plaintext private files under `home/`. If a portable file secret is later required, add an explicit SOPS-encrypted source plus a restore command that fixes ownership/permissions and never makes the encrypted source itself the live file.

SSH private keys are device-local by default and are not automatically restored.

## Root identity

The age private identity is outside this repository. Helpers default to:

```text
~/.config/sops/age/keys.txt
```

or `SOPS_AGE_KEY_FILE` when set.

Never commit that file, an `AGE-SECRET-KEY-` value, a PEM private key, or plaintext credentials.
