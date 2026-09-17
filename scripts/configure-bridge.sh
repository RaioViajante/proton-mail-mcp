#!/bin/bash
# Interactively configures proton-mail-mcp to talk to a locally running,
# already-signed-in Proton Mail Bridge. Run this manually, once per machine
# (and again any time you regenerate the Bridge password, or to add SMTP
# settings to an install set up before 0.5.0).
#
# What this script does:
#   - Asks for the Bridge IMAP username, host, port, and TLS certificate path
#     (non-sensitive), plus the Bridge SMTP port and connection mode
#     (0.5.0), and writes them all to
#     ~/.config/proton-mail-mcp/config.json — atomically (temp file + `mv`),
#     and only after the password below has been stored and verified.
#   - Asks for the Bridge IMAP/SMTP password with hidden input (read -s) —
#     Bridge issues one credential pair shared by both protocols — and
#     stores ONLY that value in the macOS Keychain. The password is never
#     echoed, never written to a file, and never appears in shell history.
#
# What this script never asks for or touches: your Proton Account password,
# recovery phrase, recovery codes, or 2FA tokens. Bridge issues its own,
# separate IMAP/SMTP credentials once you're signed in inside the Bridge app
# — that is the only secret this project ever uses. See README.md for why.
# This script also never generates a new Bridge password — only Bridge
# itself does that (Mailbox details > Bridge password).
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This script supports macOS only (it stores the password in the macOS Keychain)." >&2
  exit 1
fi

CONFIG_DIR="$HOME/.config/proton-mail-mcp"
CONFIG_PATH="$CONFIG_DIR/config.json"
KEYCHAIN_SERVICE="proton-mail-mcp"
DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="1143"
DEFAULT_CERT_PATH="$CONFIG_DIR/bridge-cert.pem"
DEFAULT_SMTP_PORT="1025"
DEFAULT_SMTP_SECURITY="starttls"

echo "proton-mail-mcp — Proton Mail Bridge setup"
echo "==========================================="
echo
echo "Before continuing, make sure Proton Mail Bridge is installed, running, and"
echo "you are signed in to your Proton account INSIDE THE BRIDGE APP (this script"
echo "never asks for that password)."
echo
echo "In Proton Mail Bridge, open your account's Mailbox details to find the IMAP"
echo "username, password, and port shown there."
echo

read -r -p "Bridge IMAP username [as shown in Mailbox details]: " bridge_username
if [[ -z "$bridge_username" ]]; then
  echo "Username cannot be empty." >&2
  exit 1
fi

read -r -p "Bridge IMAP host [$DEFAULT_HOST]: " bridge_host
bridge_host="${bridge_host:-$DEFAULT_HOST}"

read -r -p "Bridge IMAP port [$DEFAULT_PORT]: " bridge_port
bridge_port="${bridge_port:-$DEFAULT_PORT}"
if ! [[ "$bridge_port" =~ ^[0-9]+$ ]]; then
  echo "Port must be a number." >&2
  exit 1
fi

read -r -p "Path to the exported Bridge TLS certificate [$DEFAULT_CERT_PATH]: " tls_cert_path
tls_cert_path="${tls_cert_path:-$DEFAULT_CERT_PATH}"
if [[ ! -f "$tls_cert_path" ]]; then
  echo
  echo "warning: no file found at $tls_cert_path yet." >&2
  echo "See README.md ('TLS certificate setup') for the exact steps to export it" >&2
  echo "from the Proton Mail Bridge app. This script will still save the path;" >&2
  echo "put the certificate there before starting the MCP server." >&2
  echo
fi

echo
echo "SMTP (0.5.0) — Bridge exposes SMTP on the same host as IMAP ($bridge_host)," \
  "just a different port. This is used by mail_send / mail_send_preview only."
echo

read -r -p "Bridge SMTP port [$DEFAULT_SMTP_PORT]: " smtp_port
smtp_port="${smtp_port:-$DEFAULT_SMTP_PORT}"
if ! [[ "$smtp_port" =~ ^[0-9]+$ ]]; then
  echo "SMTP port must be a number." >&2
  exit 1
fi

read -r -p "Bridge SMTP connection mode [starttls/tls, default $DEFAULT_SMTP_SECURITY]: " smtp_security
smtp_security="${smtp_security:-$DEFAULT_SMTP_SECURITY}"
if [[ "$smtp_security" != "starttls" && "$smtp_security" != "tls" ]]; then
  echo "SMTP connection mode must be exactly \"starttls\" or \"tls\" — no plaintext option exists." >&2
  exit 1
fi

# Hidden input: the password is never echoed to the terminal. Bridge issues
# ONE credential pair shared by IMAP and SMTP, so this is asked once.
read -r -s -p "Bridge password (input hidden): " bridge_password
echo
if [[ -z "$bridge_password" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# Store and verify the credential BEFORE writing config.json. Historically
# (pre-0.5.0) config.json could end up written with a password that then
# failed to store/verify, leaving a config file that claimed a working setup
# it didn't have. Store-then-verify-then-write closes that gap.
security add-generic-password \
  -a "$bridge_username" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$bridge_password" \
  -U >/dev/null
unset bridge_password

if security find-generic-password -a "$bridge_username" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "Stored and verified the Bridge password in the macOS Keychain (service \"$KEYCHAIN_SERVICE\")."
else
  echo "warning: could not read the password back from the Keychain. Re-run this script." >&2
  exit 1
fi
echo

# Atomic config write: build the full file in a temp file in the SAME
# directory as the destination (so the final `mv` is a same-filesystem
# rename, not a copy), validate its structure, and only then replace the
# real config.json. A crash or Ctrl-C at any point up to the `mv` leaves the
# previous config.json (if any) completely untouched — never a
# partially-written or truncated file.
tmp_config="$(mktemp "$CONFIG_DIR/.config.json.XXXXXX")"
trap 'rm -f "$tmp_config"' EXIT

cat >"$tmp_config" <<EOF
{
  "host": "$bridge_host",
  "port": $bridge_port,
  "username": "$bridge_username",
  "tlsCertPath": "$tls_cert_path",
  "smtp": {
    "host": "$bridge_host",
    "port": $smtp_port,
    "security": "$smtp_security"
  }
}
EOF
chmod 600 "$tmp_config"

if ! node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  const required = ["host", "port", "username", "tlsCertPath"];
  for (const key of required) {
    if (!config[key]) throw new Error(`missing "${key}"`);
  }
  if (!config.smtp || !config.smtp.port || !config.smtp.security) {
    throw new Error("missing smtp.port or smtp.security");
  }
  if (config.smtp.security !== "starttls" && config.smtp.security !== "tls") {
    throw new Error("smtp.security must be starttls or tls");
  }
' "$tmp_config"; then
  echo "error: generated config.json failed validation; not replacing the existing file." >&2
  exit 1
fi

mv -f "$tmp_config" "$CONFIG_PATH"
trap - EXIT
chmod 600 "$CONFIG_PATH"

echo "Wrote configuration (IMAP + SMTP) to $CONFIG_PATH"
echo
echo "Setup complete. Re-run this script whenever you regenerate the Bridge"
echo "password (Mailbox details > Bridge password) or change the IMAP/SMTP ports."
