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

## No SMTP, ever

There is no SMTP client, no send capability, and no reply/forward capability anywhere in this
codebase — in V1 or V2, and there is no plan to add one.

## No destructive IMAP commands, ever

There is no code path that issues DELETE, EXPUNGE, or permanent removal of a message, in V1 or
V2. V1 opens every mailbox with `readOnly: true`; listing or reading a message never sets `\Seen`.

V2 (see README.md "Mutation model") adds STORE (flag changes), MOVE, and CREATE — but only through
message tools that take explicit UIDs (max 25, enforced twice), plus folder creation with an explicit name
and optional parent. All default to `dryRun: true` and never accept
a search query or a broad selector as a mutation target. `mail_mark_spam` additionally requires both
`confirm: true` and `acknowledgeFutureFiltering: true` when `dryRun: false`; a missing confirmation is
rejected before a write-mode lock. A dry-run call structurally cannot mutate anything: it never
opens a mailbox in write mode at all (proven directly by the test suite, which spies on every
mutating ImapFlow method and on every lock's `readOnly` flag). If a future version adds any further
mutating capability, it must follow the same model, and be documented here and in README.md's "V2
mutation limitations" before it ships.

## Stale UIDs are never reused blindly

IMAP UIDs are unique only within one mailbox. Confirmed live across `mail_archive`, `mail_move`, and
`mail_remove_label`: relocating a message routinely assigns it a new UID in the destination — including,
for `mail_remove_label`, a new UID in the _same_ folder the message was already in (observed: INBOX UID
705 became UID 706 after its label was removed). Every affected mutation result reports this via
`transitions` (`resultingUid`, or `requiresRefresh: true` when it genuinely cannot be determined), and
resolving it never guesses: a UIDPLUS mapping is first verified against the destination Message-ID, then
exact-match `Message-ID` correlation is used as fallback, nothing else — never subject, sender, or mailbox
position. A live 25-message INBOX-to-Social batch showed inconsistent raw per-message UID associations;
the MCP therefore treats every mapping as untrusted until verified. This project's own code never reuses a
pre-mutation UID for a follow-up mutation without going through that reconciliation; anything built on top
of these tools must not either. See README.md ("IMAP UID semantics").

## Custom folders are namespace-confined by construction

Proton Mail Bridge only exposes custom folders under `Folders/...` and labels under `Labels/...` —
confirmed live, not just from documentation: `CREATE "MCP Test"` at the true IMAP root was correctly
rejected by Bridge ("invalid mailbox name [...]: operation not allowed"). This is expected Proton
Bridge behavior, not a bug. `src/mutations/policy.ts` is the only place that builds a custom-folder
path, and it always prepends the `Folders` namespace from logical segments — there is no code path
in `mail_create_folder` or `mail_move` that accepts a caller-supplied full path and uses it verbatim,
so neither tool can create or target a mailbox at IMAP root, under `Labels`, or via a path-traversal
style empty segment. See README.md ("Proton Bridge namespace: `Folders/` and `Labels/`").

Proton also enforces one shared name per account across folders and labels, even though they are
physically distinct Bridge mailboxes — confirmed live: an existing label made Bridge reject
`CREATE "Folders/MCP Test"` with `409 Label or folder with this name already exists`.
`mail_create_folder` and `mail_create_label` check this locally, via `findNameConflict()` in `src/mutations/policy.ts`,
before ever issuing IMAP CREATE — a known collision is reported as a structured local result
(`conflictType`, `conflictingPath`), never sent to Bridge to fail there. See README.md
("Cross-namespace name collisions: folders and labels share one name per account").
`mail_create_label` accepts one flat logical name, never a raw mailbox path. It lists mailboxes but opens
none for writing; only an explicit `dryRun: false` with no conflict issues IMAP CREATE for `Labels/<name>`.
It never applies the new label to a message. A controlled live CREATE validated a temporary empty label;
no message was changed.

## Spam filtering is a persistent Proton effect

Archive and Move organize messages. `mail_mark_spam` issues a Bridge IMAP MOVE of explicit UIDs to Spam.
In a live test, **INBOX UID 708 → Spam UID 3**; subsequent manual inspection of Proton Mail showed the
sender in the account-level Spam List. Proton may therefore route future messages from that sender to
Spam. The project does not call a Spam List API or manage that list directly. Both dry-run and live
results carry `spamFilteringNotice` with `futureFilteringEffect: true`; the warning contains no sender
address.

Proton Block is a different, stronger feature. This project does not implement Block List or Allow List
management. Automatic unsubscribe is also absent; a future version may address legitimate newsletters
the user no longer wants. See README.md ("Spam vs. Archive/Move vs. Block").

## Untrusted content cannot drive a mutation

No V2 mutation tool reads a message's subject, body, or sender name to decide what to change.
`mail_apply_label` / `mail_remove_label` read exactly one content-derived field — the `Message-ID`
header — and only to correlate the same message across two mailboxes, never to decide what action
to take. The action is always the explicit UIDs and parameters the caller passed in; see
`tests/prompt-injection-mutations.test.ts`.

## V2.5 analysis is read-only and ephemeral

The five V2.5 tools open one mailbox with `readOnly: true` and fetch at most 500 selected message metadata
rows (300 for the snapshot). They request only ENVELOPE, flags, MIME structure, and named mailing-list
headers; never full bodies, attachment bytes, or arbitrary authentication headers. No V2.5 module imports
or calls a V2 mutation. No analysis result or sender list is persisted or sent to telemetry.

From names/addresses, subjects, Reply-To, List-ID, List-Unsubscribe, List-Unsubscribe-Post, Precedence, and
attachment metadata are all untrusted data. The tools do not interpret their text as commands or decide a
semantic action. Unsubscribe URLs can contain tokens: only mechanism types (`http`, `mailto`, `other`) are
returned. A one-click header is reported as capability metadata; no GET, POST, mailto, URL opening, browser
automation, or unsubscribe execution occurs. See README.md ("V2.5 — Triage intelligence and rule
proposals").

## Reporting

This is a personal, local-only project with no network-facing surface beyond `127.0.0.1`. If you
fork or extend it and find a security issue, treat it with the same care as the points above:
prefer removing a footgun over rationalizing it.
