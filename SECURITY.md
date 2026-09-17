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
codebase — in V1, V2, or V3, and there is no plan to add one. `mail_unsubscribe` (V3, 0.3.0) never
sends a `mailto:` unsubscribe request for exactly this reason: doing so would mean sending mail for
the first time ever from this project. It detects and reports a `mailto:`-only mechanism in
`mail_unsubscribe_preview`, but never executes it — see "External HTTP side effect" below.

## No destructive IMAP commands are ever reachable in 0.4.0

There is no code path that issues EXPUNGE, or permanently removes a message, anywhere this project can
actually be driven from in 0.4.0. V1 opens every mailbox with `readOnly: true`; listing or reading a message
never sets `\Seen`.

V2 (see README.md "Mutation model") adds STORE (flag changes), MOVE, and CREATE — but only through
message tools that take explicit UIDs (max 25, enforced twice), plus folder creation with an explicit name
and optional parent. All default to `dryRun: true` and never accept
a search query or a broad selector as a mutation target. `mail_mark_spam` additionally requires both
`confirm: true` and `acknowledgeFutureFiltering: true` when `dryRun: false`; a missing confirmation is
rejected before a write-mode lock. A dry-run call structurally cannot mutate anything: it never
opens a mailbox in write mode at all (proven directly by the test suite, which spies on every
mutating ImapFlow method and on every lock's `readOnly` flag).

V4 (0.4.0) adds `mail_trash` and `mail_restore_from_trash` — both MOVE-based, following exactly this same
model (explicit UIDs, `dryRun: true` default, confirm/acknowledge gate before any write-mode lock) — and
`mail_delete_permanently`, which is implemented and fully unit-tested but whose live execution is refused
unconditionally; see "Permanent delete is feature-gated off in 0.4.0" below. If a future version adds any
further mutating capability, it must follow the same model, and be documented here and in README.md's "V2
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
of these tools must not either. `mail_trash` and `mail_restore_from_trash` (0.4.0) follow the exact same
reconciliation and write-lock revalidation model — a UID that vanishes between the read-only resolution and
the write lock is dropped from the batch, never mutated, and the rest proceeds. See README.md ("IMAP UID
semantics").

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

No mutation tool, in any version, reads a message's subject, body, or sender name to decide what to
change. `mail_apply_label` / `mail_remove_label` / `mail_trash` / `mail_restore_from_trash` read exactly
one content-derived field — the `Message-ID` header — and only to correlate the same message across
mailboxes (or, for `mail_trash`, to check label membership), never to decide what action to take. The
action is always the explicit UIDs and parameters the caller passed in; see
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

## External HTTP side effect: controlled unsubscribe (0.3.0)

`mail_unsubscribe` is this project's first — and, deliberately, only — code path that makes an outbound
network request to a host this project does not control. Everything in this section exists because of
that one exception to "no network-facing surface beyond `127.0.0.1`" (see "Reporting" below).

**Threat model.** `List-Unsubscribe` / `List-Unsubscribe-Post` are headers inside an email — fully
attacker-controlled, exactly like subject or body (see "Email body is untrusted input"). A malicious sender
could put anything there: a localhost URL, a LAN address, a cloud metadata endpoint, an oversized response, a
slow/hanging server, or a redirect to a second, different host.

**SSRF defenses (`src/unsubscribe/url-safety.ts`, `http-client.ts`).** Every candidate URL is checked
structurally (HTTPS-only, port 443 only, no embedded credentials, no fragment, no `localhost`/`.local`/known
metadata hostnames, no private/loopback/link-local/multicast/unspecified literal IP — IPv4 and IPv6,
including an IPv4-mapped IPv6 bypass attempt like `::ffff:127.0.0.1`) before any DNS lookup happens at all.
After resolution, **every** address the resolver returns must be public (not just the first), and the
specific address validated is the literal address the socket connects to — via a custom DNS `lookup`
override — so nothing can re-resolve the hostname to something private between validation and connection.
No redirect is ever followed (a 3xx is reported as `outcome: "uncertain"`, never a second request). No
cookies, `Authorization`, or `Referer` are ever sent. The response body is read only far enough to enforce a
64 KiB cap and is never returned or logged.

**Authentication trust boundary.** This project does not perform DKIM cryptographic verification. Doing so
correctly would require DNS TXT key lookups, canonicalization, and signature verification — real complexity
and a second class of DNS-based attack surface, for a feature whose whole premise is caution. Instead,
`authenticationStatus` trusts Proton's own receiving-MTA verdict, read from the standard
`Authentication-Results` header, only the **first (topmost)** occurrence. That specific choice is a
deliberate defense: a compliant receiving MTA prepends its own `Authentication-Results` on receipt, so the
topmost occurrence is that MTA's own verdict, not one a sender could forge further down in the raw message
(RFC 7001/8601 warn about exactly this class of spoofing). Only a `dmarc=pass` or a domain-aligned
`dkim=pass` is treated as `verified`; every other state — including a `DKIM-Signature` header with no
resolvable verdict at all — is `evidence-present-but-not-cryptographically-verified` or `unavailable`, and
both **fail closed**: `mail_unsubscribe` refuses to execute unless `authenticationStatus` is exactly
`verified`. This is intentionally conservative rather than complete; see README.md ("Authentication status
— what 'verified' actually means") for the full state table.

**Token/URL leakage.** `mail_unsubscribe_preview`'s output is built field-by-field in
`decision.ts`'s `toPublicPreview()` — never a spread of the internal decision object — specifically so a
full URL, query string, path, or `mailto:` recipient can never leak into a tool result even if a field is
added later. Only a normalized hostname (`targetHost`) is ever returned. `mail_unsubscribe`'s live result
carries the same `targetHost`, an HTTP status code, and a coarse `outcome`; it never returns the response
body, the unsubscribe URL, or any token. Neither tool's Zod schema accepts a URL, header value, or
pre-computed eligibility from the caller — every decision is re-derived from a fresh IMAP fetch on every
call, so a stale or forged "trust me, it's eligible" input from a client is structurally impossible.

**Consent and revalidation.** Live execution requires `dryRun: false`, `confirm: true`, AND
`acknowledgeExternalUnsubscribe: true` together — any one missing is rejected before any header is even
re-read, let alone before any network call. `dryRun: true` (the default) makes zero network requests,
provably: `unsubscribe()` returns before ever calling the SSRF-checking/DNS/HTTP layers. Immediately before
the one HTTP request it is allowed to make, `mail_unsubscribe` re-fetches the message and requires its
identity (Message-ID) and every header the eligibility decision depends on to be byte-identical to the first
fetch — mirroring the write-lock revalidation idiom every IMAP mutation in this project already follows
(see "Stale UIDs are never reused blindly"), adapted here for an external HTTP side effect instead of an
IMAP write. Any drift — the message disappearing, its identity changing, its headers changing — aborts with
zero network requests.

**Why body links and `mailto:` execution are unsupported.** A link found in the message body is even less
standardized and more easily spoofed than a header; trusting it to pick a live network destination is
exactly the class of input this project's threat model exists to resist. `mailto:` execution is unsupported
because it would require this project to send mail, which contradicts "No SMTP, ever" above. Both are
detected and reported by `mail_unsubscribe_preview` — you always know they exist — neither is ever executed.

**Proton's own unsubscribe feature.** Proton's own clients already unsubscribe some senders on your behalf.
This project does not call, wrap, or rely on that feature in any way; `mail_unsubscribe` implements only the
one mechanism (RFC 8058 HTTPS one-click) this project's own security model explicitly supports, independent
of what Proton's client does for the same message.

## Trash lifecycle: labels are measured, never assumed (0.4.0)

Proton labels are separate `Labels/<name>` mailboxes (see README.md "Labels vs. folders"); there is no
single IMAP fetch that reports "all labels a message has," and this project does not assume Trash either
preserves or clears them. `src/mutations/label-membership.ts` enumerates label membership by Message-ID
correlation against every `Labels/<name>` mailbox, read-only (`SEARCH` only, never a write), before and
after a `mail_trash` move, and the result reports the measured diff (`originalLabels`, `labelsAfterTrash`,
`labelsRemovedByTrash`) — never a prediction. `mail_trash` never reapplies a label itself.
`mail_restore_from_trash`'s optional `labelsToRestore` validates each label exists as a real mailbox (never
auto-created) and only reapplies to a UID whose destination identity was confirmed via the same
UIDPLUS-verified-then-Message-ID reconciliation every other transition in this project uses — never to a
UID it isn't sure about. The folder restore and any label reapply are separate IMAP operations; a label
failure never rolls back the folder move, and the result reports the partial outcome explicitly
(`labelsRestored` / `labelsFailed` / `requiresRefresh`) rather than hiding it. This project keeps no
persistent "trash history" of any kind — every label-impact result is recomputed fresh from live IMAP state
on each call, exactly like every other tool here.

## Why permanent delete is feature-gated off in 0.4.0

`mail_delete_permanently` is, by a wide margin, the most dangerous operation this project has ever
implemented — genuinely irreversible, unlike everything else here. It is fully implemented and unit-tested
in 0.4.0 (schema validation, the 5-UID batch cap, the `confirm`/`acknowledgePermanentDeletion`/
`confirmationPhrase` gate, read-only Trash resolution), but **live execution (`dryRun: false`) is refused
unconditionally**, even when every confirmation is exactly correct, before any IMAP mutating command is
issued:

```json
{ "blocked": true, "blockReason": "livePermanentDeleteDisabled" }
```

**Threat model this gate exists for**, and how each is addressed structurally, not just by the gate:

- **Prompt injection asking for a delete.** No tool in this project reads subject/body content to decide
  what to act on (see "Untrusted content cannot drive a mutation" above); `mail_delete_permanently` also
  requires an exact, out-of-band literal string (`confirmationPhrase: "DELETE PERMANENTLY"`) that cannot be
  present in a message an attacker sends.
- **Wildcard/broad UID selection.** The schema accepts only an array of explicit positive integers (max 5);
  there is no search, range, or "everything" selector anywhere in this tool.
- **Batch amplification.** Capped at 5 UIDs per call — stricter than every other mutation's 25-UID limit —
  enforced twice (zod schema, then `assertBatchSize` again in the mutation function).
- **Stale or reused UIDs, and wrong-folder UIDs.** Resolution happens read-only, immediately before any
  action, against exactly the account's Trash folder (`sourceFolder` must equal it exactly — no other
  source is ever accepted); a UID that doesn't currently exist there is reported `missingUids`, never acted
  on.
- **Mailbox-wide EXPUNGE.** Structurally forbidden — see the next point — regardless of whether the feature
  gate above is ever lifted.
- **Accidental deletion of a message another client already flagged `\Deleted`.** Only possible via a
  mailbox-wide EXPUNGE, which this project's primitive refuses to ever issue (next point).

**Why mailbox-wide EXPUNGE is forbidden, structurally.** Reading `imapflow`'s own
`commands/expunge.js` surfaced the exact risk: `ImapFlow`'s own `messageDelete({ uid: true })` silently
falls back to a plain, unscoped `EXPUNGE` — removing **every** `\Deleted`-flagged message in the mailbox,
including ones flagged by another client entirely — whenever the server lacks the `UIDPLUS` capability.
Only with `UIDPLUS` does it issue the UID-scoped `UID EXPUNGE <uids>` (RFC 4315) that touches exactly the
given UIDs. `src/mutations/permanent-delete.ts` exports `expungeExactUids()` — the **only** function in
this project that may ever issue a permanent deletion, not called anywhere in 0.4.0 — which checks
`client.capabilities.get('UIDPLUS')` itself, before issuing any command, and refuses outright (zero
`messageFlagsAdd`/`messageDelete` calls) if `UIDPLUS` is unavailable, rather than ever reaching that unscoped
fallback. There is no code path in this project, gated or not, that can issue a mailbox-wide EXPUNGE — see
`tests/mutations-permanent-delete.test.ts` ("UID-scoped deletion abstraction").

Live permanent deletion ships in a separate, explicitly authorized version after dedicated destructive-action
validation against a real mailbox — not in this task, and not without the person operating this project
turning that gate off deliberately in code, reviewed on its own.

## Reporting

This is a personal, local-only project whose only network-facing surface beyond `127.0.0.1` is the single,
heavily-restricted outbound HTTPS request `mail_unsubscribe` may make — see "External HTTP side effect"
above. If you
fork or extend it and find a security issue, treat it with the same care as the points above:
prefer removing a footgun over rationalizing it.
