#!/bin/bash
# Generates and stores this machine's send-intent-receipt HMAC signing secret
# (0.5.0) in the macOS Keychain. Run this manually, once per machine, before
# mail_send_preview will issue a sendIntentReceipt.
#
# What this script does:
#   - Generates 32 random bytes (openssl rand), hex-encoded.
#   - Stores that hex string in the macOS Keychain, service
#     "proton-mail-mcp-send-signing", account "send-intent-signing-key".
#
# What this secret is NOT: it is not your Proton account password, not your
# Bridge IMAP/SMTP password, not the restore-receipt signing secret, and not
# sent anywhere — it exists purely so this server can cryptographically sign
# a send-intent receipt at mail_send_preview time and verify that same
# receipt later at mail_send time. See src/security/send-intent-receipt.ts
# and SECURITY.md ("Send-intent receipts").
#
# If you skip this script, mail_send_preview issues no sendIntentReceipt,
# and a live mail_send call fails closed (it has no receipt to verify against
# — this is on top of, not instead of, the 0.5.0 live-send feature gate,
# which blocks live submission unconditionally regardless of this secret).
#
# Re-running this script rotates the secret: any sendIntentReceipt issued
# under the old secret will fail signature verification and be rejected
# (fail closed) afterwards. Only rotate between a matched mail_send_preview /
# mail_send pair you don't have pending.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This script supports macOS only (it stores the secret in the macOS Keychain)." >&2
  exit 1
fi

KEYCHAIN_SERVICE="proton-mail-mcp-send-signing"
KEYCHAIN_ACCOUNT="send-intent-signing-key"

echo "proton-mail-mcp — send-intent signing secret setup"
echo "===================================================="
echo

if security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "A send-intent signing secret already exists in the Keychain."
  read -r -p "Regenerate it? Any sendIntentReceipt issued under the old one will stop working (y/N): " confirm
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

echo "Stored a new send-intent signing secret in the macOS Keychain (service \"$KEYCHAIN_SERVICE\")."
echo

if security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "Verified: the secret can be read back from the Keychain."
else
  echo "warning: could not read the secret back from the Keychain. Re-run this script." >&2
  exit 1
fi

echo
echo "Setup complete. mail_send_preview will now issue a signed sendIntentReceipt for"
echo "an eligible intent. Live mail_send submission remains disabled by a separate"
echo "feature gate regardless (see SECURITY.md, \"Live SMTP submission is"
echo "feature-gated off\") until a future, explicitly authorized version."
