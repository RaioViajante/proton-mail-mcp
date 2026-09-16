# Security

This document is the condensed set of rules this project is built to. See README.md for the full
setup, architecture, and threat-model write-up.

## Credentials never belong in Git

- The Proton Mail Bridge password is stored **only** in the macOS Keychain (service
  `proton-mail-mcp`), written there by `scripts/configure-bridge.sh`, and read back at runtime via
  `security find-generic-password ... -w`.
- It is never written to a file, never placed in source code, never placed in the Claude Code MCP
  configuration, and never placed in a committed `.env` file. `.gitignore` also excludes `.env*`,
  `*.pem`, `*.crt`, `*.key`, `*.p12`, and `*.pfx` as a backstop.
- This project never uses, asks for, or stores the Proton Account password, recovery phrase,
  recovery codes, or 2FA tokens. Only the Bridge-issued IMAP password is used — see README.md
  ("Why the Bridge password, not your Proton Account password").
- Errors are constructed to omit secret values, even when the underlying failure (e.g. a Keychain
  lookup or an IMAP connection) might otherwise carry one; see `src/bridge/config.ts` and
  `src/bridge/client.ts`.
- Non-secret connection settings (host, port, username, TLS certificate path) live outside the
  repository, in `~/.config/proton-mail-mcp/config.json`.

## Email body is untrusted input

Every value that comes from a message (subject, sender name, body) is attacker-controlled. This
server:

- never executes, evaluates, or acts on text found in an email;
- labels every returned message body with an explicit untrusted-content warning
  (`src/security/untrusted-content.ts`);
- never returns raw HTML — HTML-only bodies are converted to inert plain text;
- bounds body size (20,000 characters) so a single message can't flood the model's context.

The real defense is structural, not the warning text: see the next two points.

## Bridge must bind locally

This project only ever connects to Proton Mail Bridge's IMAP server on `127.0.0.1` (the default
Bridge binds to). It never connects to a remote IMAP host, and TLS certificate validation is never
disabled (`rejectUnauthorized` stays at its secure default; trust comes from Bridge's own exported
certificate, supplied via `tls.ca`).

## No SMTP in V1

There is no SMTP client, no send capability, and no reply capability anywhere in this codebase.

## No destructive IMAP commands in V1

Every mailbox is opened with `readOnly: true`. There is no code path that issues STORE (flag
changes), MOVE, COPY-then-EXPUNGE, DELETE, CREATE, RENAME, or APPEND. Listing or reading a message
never sets `\Seen`. If a future version adds any mutating capability, it must be opt-in, clearly
separated from V1's read-only tools, and documented here and in README.md's "V1 read-only
limitations" before it ships.

## Reporting

This is a personal, local-only project with no network-facing surface beyond `127.0.0.1`. If you
fork or extend it and find a security issue, treat it with the same care as the points above:
prefer removing a footgun over rationalizing it.
