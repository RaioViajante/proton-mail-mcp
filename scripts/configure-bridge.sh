#!/bin/bash
# Interactively configures proton-mail-mcp to talk to a locally running,
# already-signed-in Proton Mail Bridge. Run this manually, once per machine
# (and again any time you regenerate the Bridge password).
#
# What this script does:
#   - Asks for the Bridge IMAP username, port, and TLS certificate path
#     (non-sensitive) and writes them to ~/.config/proton-mail-mcp/config.json.
#   - Asks for the Bridge IMAP password with hidden input (read -s) and
#     stores ONLY that value in the macOS Keychain. The password is never
#     echoed, never written to a file, and never appears in shell history.
#
# What this script never asks for or touches: your Proton Account password,
# recovery phrase, recovery codes, or 2FA tokens. Bridge issues its own,
# separate IMAP credentials once you're signed in inside the Bridge app —
# that is the only secret this project ever uses. See README.md for why.
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

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# Non-sensitive connection settings only. The password never goes here.
cat >"$CONFIG_PATH" <<EOF
{
  "host": "$bridge_host",
  "port": $bridge_port,
  "username": "$bridge_username",
  "tlsCertPath": "$tls_cert_path"
}
EOF
chmod 600 "$CONFIG_PATH"

echo "Wrote non-sensitive configuration to $CONFIG_PATH"
echo

# Hidden input: the password is never echoed to the terminal.
read -r -s -p "Bridge IMAP password (input hidden): " bridge_password
echo
if [[ -z "$bridge_password" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi

# Stored only in the macOS Keychain — never on disk, never logged, never
# passed on a command line a shell would record in history (it's read via
# `read -s` into a variable, not typed as a literal argument).
security add-generic-password \
  -a "$bridge_username" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$bridge_password" \
  -U >/dev/null
unset bridge_password

echo "Stored the Bridge password in the macOS Keychain (service \"$KEYCHAIN_SERVICE\")."
echo

if security find-generic-password -a "$bridge_username" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "Verified: the password can be read back from the Keychain."
else
  echo "warning: could not read the password back from the Keychain. Re-run this script." >&2
  exit 1
fi

echo
echo "Setup complete. Re-run this script whenever you regenerate the Bridge"
echo "password (Mailbox details > Bridge password) or change the IMAP port."
