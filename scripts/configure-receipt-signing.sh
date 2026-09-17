#!/bin/bash
# Generates and stores this machine's restore-receipt HMAC signing secret
# (0.4.2) in the macOS Keychain. Run this manually, once per machine, before
# relying on mail_restore_from_trash's receipt-based state preservation.
#
# What this script does:
#   - Generates 32 random bytes (openssl rand), hex-encoded.
#   - Stores that hex string in the macOS Keychain, service
#     "proton-mail-mcp-receipt-signing", account "restore-receipt-signing-key".
#
# What this secret is NOT: it is not your Proton account password, not your
# Bridge IMAP password, and not sent anywhere — it exists purely so this
# server can cryptographically sign a restore receipt at mail_trash time and
# verify that same receipt later at mail_restore_from_trash time. See
# src/security/restore-receipt.ts and SECURITY.md ("Restore receipts").
#
# If you skip this script, mail_trash and mail_restore_from_trash keep
# working exactly as they did in 0.4.1 — restore receipts are an additive
# capability, not a required upgrade step.
#
# Re-running this script rotates the secret: any restore receipt issued
# under the old secret will fail signature verification and be rejected
# (fail closed) afterwards. Only rotate between a matched mail_trash /
# mail_restore_from_trash pair you don't have pending.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "proton-mail-mcp 0.6.0 currently supports macOS only." >&2
  exit 1
fi

KEYCHAIN_SERVICE="proton-mail-mcp-receipt-signing"
KEYCHAIN_ACCOUNT="restore-receipt-signing-key"

echo "proton-mail-mcp — restore-receipt signing secret setup"
echo "========================================================"
echo

if security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "A restore-receipt signing secret already exists in the Keychain."
  read -r -p "Regenerate it? Any restore receipt issued under the old one will stop working (y/N): " confirm
  if [[ "${confirm,,}" != "y" ]]; then
    echo "Leaving the existing secret in place."
    exit 0
  fi
fi

secret_hex="$(openssl rand -hex 32)"

security add-generic-password \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$secret_hex" \
  -U >/dev/null
unset secret_hex

echo "Stored a new restore-receipt signing secret in the macOS Keychain (service \"$KEYCHAIN_SERVICE\")."
echo

if security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "Verified: the secret can be read back from the Keychain."
else
  echo "warning: could not read the secret back from the Keychain. Re-run this script." >&2
  exit 1
fi

echo
echo "Setup complete. mail_trash will now issue a signed restoreReceipt on live moves,"
echo "and mail_restore_from_trash will honor one passed back via restoreReceipts."
