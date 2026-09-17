#!/bin/bash
# Interactive, non-destructive macOS setup. --check performs no writes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="$HOME/.config/proton-mail-mcp"
CONFIG_FILE="$CONFIG_DIR/config.json"
CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: ./scripts/bootstrap.sh [--check]" >&2
  exit 2
fi

if [[ "$(uname -s)" != Darwin ]]; then
  echo "proton-mail-mcp 0.6.0 currently supports macOS only." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node >=24 is required." >&2
  exit 1
fi
NODE_PATH="$(command -v node)"
NODE_MAJOR="$("$NODE_PATH" -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Node >=24 is required." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm 12 is required." >&2
  exit 1
fi
PNPM_VERSION="$(pnpm --version)"
if [[ "${PNPM_VERSION%%.*}" -ne 12 ]]; then
  echo "pnpm 12 is required (found $PNPM_VERSION)." >&2
  exit 1
fi

echo "proton-mail-mcp 0.6.0 bootstrap"
echo "Node and pnpm: available"
if [[ "$CHECK_ONLY" == false ]]; then
  (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile && pnpm build)
fi
if pgrep -f 'Proton Mail Bridge' >/dev/null 2>&1; then
  echo "Proton Mail Bridge: process detected"
else
  echo "Proton Mail Bridge: not detected; open Bridge and sign in before setup/doctor."
fi
if [[ ! -d "$CONFIG_DIR" ]]; then
  echo "Config directory: missing"
  if [[ "$CHECK_ONLY" == false ]]; then mkdir -p -m 700 "$CONFIG_DIR"; fi
fi
if [[ -d "$CONFIG_DIR" ]]; then
  mode="$(stat -f '%Lp' "$CONFIG_DIR")"
  if [[ "$mode" != 700 ]]; then
    echo "Config directory permissions: expected 0700 (found $mode)."
    if [[ "$CHECK_ONLY" == false ]]; then chmod 700 "$CONFIG_DIR"; fi
  fi
fi

config_valid=false
if [[ -f "$CONFIG_FILE" ]] && "$NODE_PATH" -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const local = h => /^127\./.test(h) || h === "::1" || h === "localhost" || h.endsWith(".localhost");
  if (!c.username || !local(c.host) || !Number.isInteger(c.port) || c.port < 1 ||
      !c.tlsCertPath || !c.smtp || !local(c.smtp.host) ||
      !Number.isInteger(c.smtp.port) || c.smtp.port < 1 ||
      !["starttls", "tls"].includes(c.smtp.security) ||
      !fs.existsSync(c.tlsCertPath)) process.exit(1);
  try { fs.accessSync(c.tlsCertPath, fs.constants.R_OK); } catch { process.exit(1); }
' "$CONFIG_FILE" >/dev/null 2>&1; then
  config_valid=true
  echo "Bridge config and TLS certificate: present"
fi

credential_valid=false
if [[ "$config_valid" == true ]]; then
  username="$("$NODE_PATH" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).username)' "$CONFIG_FILE")"
  credential="$(security find-generic-password -a "$username" -s proton-mail-mcp -w 2>/dev/null)" || credential=""
  if [[ -n "$credential" ]]; then
    credential_valid=true
    echo "Bridge credential: available in Keychain"
  fi
  unset username credential
fi
if [[ "$config_valid" == false || "$credential_valid" == false ]]; then
  echo "Bridge setup: needed (asks only for Bridge-generated credentials and local settings)."
  if [[ "$CHECK_ONLY" == false ]]; then
    "$SCRIPT_DIR/configure-bridge.sh"
  fi
fi

check_signing_secret() {
  local account="$1" service="$2" value
  value="$(security find-generic-password -a "$account" -s "$service" -w 2>/dev/null)" || return 1
  if [[ ! "$value" =~ ^[0-9a-fA-F]{64}$ ]]; then
    unset value
    return 1
  fi
  unset value
  return 0
}
if check_signing_secret restore-receipt-signing-key proton-mail-mcp-receipt-signing; then
  echo "Restore signing secret: valid in Keychain"
else
  echo "Restore signing secret: missing or invalid"
  if [[ "$CHECK_ONLY" == false ]]; then "$SCRIPT_DIR/configure-receipt-signing.sh"; fi
fi
if check_signing_secret send-intent-signing-key proton-mail-mcp-send-signing; then
  echo "Send signing secret: valid in Keychain"
else
  echo "Send signing secret: missing or invalid"
  if [[ "$CHECK_ONLY" == false ]]; then "$SCRIPT_DIR/configure-send-signing.sh"; fi
fi

if [[ ! -d "$CONFIG_DIR/replay" ]]; then
  echo "Replay state directory: missing"
  if [[ "$CHECK_ONLY" == false ]]; then mkdir -m 700 "$CONFIG_DIR/replay"; fi
fi
if [[ -d "$CONFIG_DIR/replay" ]]; then
  mode="$(stat -f '%Lp' "$CONFIG_DIR/replay")"
  if [[ "$mode" != 700 ]]; then
    echo "Replay state permissions: expected 0700 (found $mode)."
    if [[ "$CHECK_ONLY" == false ]]; then chmod 700 "$CONFIG_DIR/replay"; fi
  fi
fi
if [[ -f "$CONFIG_FILE" ]]; then
  mode="$(stat -f '%Lp' "$CONFIG_FILE")"
  if [[ "$mode" != 600 ]]; then
    echo "Config file permissions: expected 0600 (found $mode)."
    if [[ "$CHECK_ONLY" == false ]]; then chmod 600 "$CONFIG_FILE"; fi
  fi
fi

if [[ -f "$PROJECT_DIR/dist/doctor.js" ]]; then
  "$NODE_PATH" "$PROJECT_DIR/dist/doctor.js" || true
else
  echo "Doctor: build first to run node dist/doctor.js"
fi

quoted_node="$(printf '%q' "$NODE_PATH")"
quoted_entry="$(printf '%q' "$PROJECT_DIR/dist/index.js")"
if command -v codex >/dev/null 2>&1 && codex mcp add --help 2>/dev/null | grep -q 'Usage: codex mcp add'; then
  echo "Codex registration command (review before running):"
  echo "codex mcp add proton-mail-mcp -- $quoted_node $quoted_entry"
else
  echo "Codex CLI unavailable or registration syntax could not be verified."
fi
if command -v claude >/dev/null 2>&1 && claude mcp add --help 2>/dev/null | grep -q 'Usage: claude mcp add'; then
  echo "Claude Code registration command (review before running):"
  echo "claude mcp add -s user proton-mail-mcp -- $quoted_node $quoted_entry"
else
  echo "Claude Code CLI unavailable or registration syntax could not be verified."
fi
echo "Existing MCP registrations are not changed. Review the commands before running them."
