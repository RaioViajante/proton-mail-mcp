# Security

This document is the condensed set of rules this project is built to. See README.md for the full
setup, architecture, and threat-model write-up.

## Credentials never belong in Git

- The Proton Mail Bridge password is stored **only** in the macOS Keychain (service
  `proton-mail-mcp`), written there by `scripts/configure-bridge.sh`, and read back at runtime via
  `security find-generic-password ... -w`. Bridge issues one credential pair shared by IMAP and SMTP
  — `mail_send`/`mail_send_preview` (0.5.0) reuse this exact reader, never a second copy of the
  password.
- Two more Keychain secrets exist for this project's own self-signed receipts, each its own service,
  never reused for anything else and never each other: `proton-mail-mcp-receipt-signing` (restore
  receipts, `scripts/configure-receipt-signing.sh`) and `proton-mail-mcp-send-signing` (send-intent
  receipts, `scripts/configure-send-signing.sh`, 0.5.0). Neither is a credential to any external
  system — see "Restore receipts" and "Send-intent receipts" below.
- None of the above is ever written to a file, never placed in source code, never placed in the
  Claude Code MCP configuration, and never placed in a committed `.env` file. `.gitignore` also
  excludes `.env*`, `*.pem`, `*.crt`, `*.key`, `*.p12`, and `*.pfx` as a backstop.
- This project never uses, asks for, or stores the Proton Account password, recovery phrase,
  recovery codes, or 2FA tokens. Only the Bridge-issued IMAP/SMTP password is used — see README.md
  ("Why the Bridge password, not your Proton Account password").
- Errors are constructed to omit secret values, even when the underlying failure (e.g. a Keychain
  lookup or an IMAP/SMTP connection) might otherwise carry one; see `src/bridge/config.ts` and
  `src/bridge/client.ts`.
- Non-secret connection settings (host, port, username, TLS certificate path, and — as of 0.5.0 — SMTP
  port/security mode) live outside the repository, in `~/.config/proton-mail-mcp/config.json`.

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

## SMTP host is loopback-only

As of 0.5.0 ("SMTP Send Foundation"), this project has an SMTP capability for the first time —
`mail_send_preview` and `mail_send`, both plain-text-only, both scoped to a single mailbox identity.
Through 0.4.2 there was none at all (`mail_unsubscribe`, V3/0.3.0, never sends a `mailto:`
unsubscribe request for exactly the reason this project had no send capability to use — it detects
and reports a `mailto:`-only mechanism in `mail_unsubscribe_preview` but never executes it; see
"External HTTP side effect" below).

`mail_send`/`mail_send_preview` are a client for exactly one thing: a locally running Proton Mail
Bridge instance, never a general-purpose SMTP client:

- The configured SMTP host must resolve to loopback — a loopback IP literal (`127.0.0.0/8`, `::1`)
  or `localhost`/`*.localhost`. Before transport creation, every DNS answer for a hostname must be
  loopback. Nodemailer receives one validated IP, so it cannot resolve the hostname again after
  validation; the original hostname remains the TLS verification name. IP literals omit SNI.
  `smtp.gmail.com`, `smtp.office365.com`, any other public hostname, any LAN IP, and any
  non-loopback IP literal are rejected at config-load time (`SmtpConfigSchema`) and again at
  transport-creation time (`createSmtpTransport`).
- No plaintext SMTP, ever. `SmtpSecurity` (`starttls` | `tls`) has no plaintext member at all — a
  config that omits security, or names an unrecognized mode, fails validation rather than falling
  back to anything insecure. STARTTLS mode sets nodemailer's `requireTLS`, so a Bridge that
  unexpectedly doesn't advertise STARTTLS fails the connection outright instead of silently sending
  in the clear.
- TLS certificate validation is never disabled (`rejectUnauthorized` stays at its secure default;
  trust comes from the same exported Bridge certificate IMAP already uses, via `tls.ca` — reused, not
  duplicated).
- Reuses the existing Bridge password from the Keychain (service `proton-mail-mcp`) — Bridge issues
  one credential pair shared by IMAP and SMTP. No new credential, no Proton Account password, ever.

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
unconditionally; see "Permanent delete is feature-gated off" below. If a future version adds any
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
because `mail_unsubscribe` has no code path that derives a `mail_send` target from a message's content at
all — the SMTP capability this project has (0.5.0+, see "SMTP host is loopback-only" below) is a narrow,
explicit-recipients-only tool `mail_unsubscribe` never calls into, not a general send capability an
unsubscribe flow could reach for. Both `mailto:` and body links are detected and reported by
`mail_unsubscribe_preview` — you always know they exist — neither is ever executed.

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

## Live finding (0.4.0) and state-preserving restore hardening (0.4.1)

A live validation of 0.4.0 moved one real message Archive -> Trash -> Archive to test the trash lifecycle
end to end. The Archive -> Trash leg behaved exactly as documented: identity reconciled, flags preserved,
labels preserved, nothing removed. The Trash -> Archive restore did not: **two labels the message had
carried intact through Trash disappeared, and its unread state flipped to read — and
`mail_restore_from_trash` reported a clean success throughout**, because 0.4.0's implementation only ever
measured/reapplied what the caller's `labelsToRestore` explicitly asked for. It had no mechanism to notice
that Bridge's plain folder MOVE out of Trash, on its own, silently mutated state the caller never asked it
to touch.

**Root cause.** Proton Bridge does not guarantee a mailbox transition is a pure, structural relocation —
labels and flags can be mutated as a side effect, in either direction (into Trash, or out of it), and this
project's 0.4.0 code only checked for it on the way in. Post-move state was trusted by omission rather than
verified.

**The fix, applied to `mail_restore_from_trash` (0.4.1):**

- **Snapshot before trusting anything.** Preservable flags (`\Seen`, `\Flagged` — an explicit whitelist,
  see `src/mutations/flags.ts`; never an arbitrary flag copied blindly) and full label membership are
  captured while the message is still in Trash, before any move.
- **Post-move state is untrusted until re-verified.** After a live move, both are re-measured in the
  destination folder — never assumed equal to the snapshot just because the move command succeeded.
- **Identity must be proven before repair.** A label or flag is only ever reapplied to a UID whose
  destination identity was confirmed via the same UIDPLUS-verified-then-Message-ID reconciliation every
  other transition in this project uses (`mutations/transitions.ts`) — an unconfirmed or vanished UID is
  never guessed at; that repair attempt is reported as failed / `requiresRefresh` instead of acting on a UID
  this project isn't sure about.
- **Repair is limited to known pre-move state.** Only a label/flag present in the snapshot and now missing
  is reapplied; a label present after the move that was NOT in the snapshot is reported
  (`labelsUnexpected`) but never removed automatically — there is no reliable way to prove it was this
  operation's doing rather than something else's, and removing an unrelated label would be a new, unrelated
  mutation this call was never authorized to make. No flag outside the fixed whitelist is ever touched.
- **`labelsToRestore` is no longer a substitute for preservation.** It now means EXTRA labels the caller
  explicitly wants, unioned with the automatically-preserved set, never instead of it — and each extra is
  validated to exist and **rejected before any move** if it doesn't, rather than deferred to a post-hoc
  failure.
- **The folder move and any repair remain non-atomic**, exactly as in 0.4.0: a repair failure never rolls
  back the move; the result reports `moveRestored` / `flagsRestored` / `flagsFailed` / `labelsRestored` /
  `labelsFailed` / `requiresRefresh` / `partialSuccess` explicitly.
- **`mail_trash`'s `sourceFolder` no longer accepts a `Labels/<name>` mailbox** (`assertTrashSourceAllowed`
  in `src/mutations/policy.ts`) — a label mailbox is a view of a message, not its physical location, and
  was never a meaningful origin for a destructive relocation to begin with.
- **A `messageMove` that throws is never assumed to be a clean failure or a clean success.** The connection
  or response may have been lost at any point relative to the server processing the command.
  `src/mutations/uncertain-move.ts` performs read-only-only reconciliation via Message-ID correlation (the
  same primitive the happy path already uses) to classify each affected UID as confirmed moved, confirmed
  not moved, or genuinely uncertain — never guessed, never automatically retried, and never a second `MOVE`
  issued for a UID whose fate is unknown (no double-move risk). This applies to both `mail_trash` and
  `mail_restore_from_trash`, and to a reconnect at any point in `mail_restore_from_trash`'s pipeline
  (post-move verification, label repair, flag repair) — an already-successful move is never swallowed by a
  later failure; `moveRestored` still reflects it, and the uncertainty is surfaced via `requiresRefresh` /
  `errors` instead.

This project keeps no persistent "trash history" of any kind — every label/flag-impact result is
recomputed fresh from live IMAP state on each call, exactly like every other tool here. No detail of the
specific message used in the live validation is recorded anywhere in this repository; only the structural
bug and the fix are.

## Restore receipts: why Trash is not an authoritative source, and how 0.4.2 fixes it

**The TOCTOU this addresses.** A second live validation — specifically designed to check 0.4.1's fix — found
it insufficient. `mail_trash`'s own immediate post-move check reported a message's two labels intact in
Trash. Sometime after that call returned, **asynchronously**, Proton Bridge dropped both labels while the
message sat in Trash — outside any window this project's own code executes in. A later
`mail_restore_from_trash` call measured Trash's "before" state as its repair baseline (0.4.1's entire
mechanism) and found zero labels — because they were already gone by then. 0.4.1 had nothing to reapply, and
reported a clean result while two labels were permanently lost. This is a time-of-check-to-time-of-use
problem across two separate tool calls, potentially minutes or longer apart, with no code of this project's
running in between to observe the loss happening.

**Why Trash can never be fully authoritative for this.** No read-only measurement taken _at restore time_ can
recover information that was already lost _before_ restore time began, no matter how carefully it's
implemented. The only way to have a trustworthy "original state" baseline is to capture it earlier — at
`mail_trash` time, before any possible async decay — and carry it forward.

**The fix: a signed, stateless restore receipt.** `mail_trash` optionally issues one per identity-confirmed,
live-moved UID (`src/security/restore-receipt.ts`), built from the pre-move snapshot it already captures
(`originalLabels`/`originalFlags` — never from `labelsAfterTrash`/`flagsAfterTrash`). The caller carries it to
`mail_restore_from_trash`, which — after full verification — treats it as authoritative in place of Trash's
current state.

**Statelessness preserved.** This project still keeps no server-side history of trashed messages. The receipt
is the caller's responsibility to hold between the two calls; the server that issued it does not remember it
existed. This is safe specifically because the receipt is authenticated end-to-end (next point) — a caller
(or a model relaying tool output) cannot fabricate or silently alter one without detection. We evaluated
adding a local persistence layer (a small on-disk "pending trash operations" store) as an alternative and
rejected it: it would reintroduce exactly the kind of server-side mailbox history this project has
deliberately avoided since 0.4.0, for a benefit (surviving a caller that discards the receipt) that a
clearly-documented, fail-closed "no receipt -> weaker fallback" behavior already covers without it.

**Identity binding — no raw Message-ID, ever.** A receipt is bound to one specific message via `identity`: a
**keyed** HMAC-SHA256 fingerprint of that message's `Message-ID` header, derived with a subkey used for no
other purpose. It is not a bare `sha256(Message-ID)` hash — without the install's signing secret, `identity`
cannot be dictionary-attacked or correlated across receipts. The raw `Message-ID` itself is never included in
a receipt, never logged, and never returned by any tool in this project. `mail_restore_from_trash` re-derives
the same fingerprint from the _live_ Trash message's current `Message-ID` and compares it, constant-time,
against the receipt's `identity` before trusting anything else in it — a receipt issued for message A can
never be used to repair message B; see `tests/mutations-restore-receipt.test.ts` ("receipt for message A used
on message B").

**Tampering / integrity model.** Every receipt field is covered by an HMAC-SHA256 signature (`signature`),
computed with a second subkey, domain-separated from the identity subkey, both derived from one per-install
secret via a minimal HKDF-like construction (`node:crypto` only — no added dependency). Any modification to
any field — `sourceFolder`, `originalLabels`, `originalFlags`, `identity`, `issuedAt` — invalidates the
signature and the receipt is rejected outright (`signatureInvalid`). This matters specifically because a
receipt is untrusted-by-default output that round-trips through the calling model: nothing about this
project's threat model assumes a model, or anything reading a model's tool output, cannot be induced (by
prompt injection or otherwise) to alter a JSON blob before passing it back. An unauthenticated receipt would
let exactly that alter which labels/flags get silently reapplied to a real mailbox; a receipt that fails
verification is fully rejected instead (`preservationSource: "unavailable"`) and **no** label or flag is
applied from it, or from the (also-untrusted-for-this-purpose) `trashSnapshot` fallback — see "Fail-closed
receipt rejection" below. **Security boundary this does NOT need to defend, and doesn't claim to:** a caller
who already has the ability to invoke `mail_restore_from_trash` live (`confirm`, `acknowledge...`, and a
verified receipt) can already choose which labels/flags to preserve — that is the tool's normal authorized
function, identical in kind to what `labelsToRestore` already lets an authorized caller do. Receipt
authentication exists to stop an _unauthorized modification of a specific receipt's content_ (e.g., a
prompt-injected label swap, or reuse against the wrong message), not to add a permission model beyond what
calling the tool already grants.

**Fail-closed receipt rejection.** Any of the following rejects a supplied receipt outright, reported via
`receiptRejections` with a stable reason code (never receipt content): malformed structure or missing field
(`malformedReceipt`), an unsupported `v` (`malformedReceipt` — schema-level, since only version `1` is
accepted), no signing secret available on this install (`signingSecretUnavailable`), a signature that doesn't
verify (`signatureInvalid` — covers every tampered-field case above), no `Message-ID` on the live Trash
message to compare against (`noMessageIdToVerify`), or an `identity` fingerprint mismatch
(`identityMismatch`). In every case, `preservationSource` is `"unavailable"` for that UID and **neither** the
rejected receipt **nor** a `trashSnapshot` fallback is used for repair — this project would rather visibly do
nothing than guess. The underlying folder move (an operation the caller separately, explicitly authorized via
`confirm`/`acknowledgeRestoreFromTrash` and the exact UID) still proceeds; only the state-preservation repair
is withheld. See `tests/mutations-restore-receipt.test.ts` for the full matrix (malformed, missing fields,
unsupported version, every tampered field, cross-message reuse, stale UID, receipt replay after restore, no/
malformed Message-ID).

**Scope note (documented limitation, not a security hole): receipts don't expire and can be replayed across
multiple trash/restore cycles of the same message.** A receipt's `identity` binds it to a specific message
(via `Message-ID`), never to a specific _trash event_ — there is no nonce or timestamp check beyond the
informational `issuedAt`. If a message is trashed, restored, and trashed again, and the caller supplies the
_original_ receipt for the second restore, verification still succeeds (it genuinely is the same message) and
repairs towards that older label/flag snapshot — potentially discarding a label the user added in between the
two trash cycles. This is a data-freshness/correctness edge case, not an unauthorized-access one: the caller
already has to be separately authorized to call `mail_restore_from_trash` live, and the repaired state is
still a real state that message legitimately had at some point, never a forged or cross-message one. Treat a
receipt as valid for one specific trash/restore round-trip, not as a durable, reusable snapshot; this project
does not enforce that usage pattern.

**No body, no attachments, no Bridge credentials.** A receipt carries exactly: `v`, `sourceFolder`,
`originalLabels` (names only — not secrets), `originalFlags` (from the fixed `\Seen`/`\Flagged` whitelist),
`identity` (keyed fingerprint, not raw), `issuedAt`, and `signature`. It never carries message body,
attachment content or metadata, the raw `Message-ID`, the signing secret, or the Bridge IMAP password.

**Signing secret storage.** The HMAC signing secret lives only in the macOS Keychain, under a service
(`proton-mail-mcp-receipt-signing`) **distinct** from the Bridge password's own Keychain service
(`proton-mail-mcp`) — see `src/bridge/config.ts`. It is never the Bridge password reused as key material
(that would tie two unrelated secrets together for no benefit, and leak receipt-signing capability to
anything with Bridge access already), never written to `config.json`, never committed. Provisioned by
`scripts/configure-receipt-signing.sh`, generated via `openssl rand -hex 32` (32 bytes, hex-encoded),
following the exact same "generate locally, store in Keychain, verify readback, never echo" shape
`scripts/configure-bridge.sh` already uses for the Bridge password.

**Restart survival, deliberately.** Because the secret is Keychain-resident rather than held only in this
server process's memory, a receipt issued before an MCP server restart is still verifiable after one — the
whole point of a receipt is to survive an arbitrary gap between `mail_trash` and `mail_restore_from_trash`,
and an in-process-only ephemeral key would silently defeat that for the common case of a restart in between.
Re-running `scripts/configure-receipt-signing.sh` deliberately rotates the secret and invalidates every
receipt issued under the old one (reported as `signatureInvalid`, fail-closed, never silently accepted) — this
is an explicit, documented operator action, not automatic, and not something this project ever does on its
own.

**Fully additive; no upgrade required.** An install that has not run `scripts/configure-receipt-signing.sh`
gets `signingSecret: undefined` at the tool layer; `mail_trash` then issues no `restoreReceipts` at all, and
any receipt a caller nonetheless supplies to `mail_restore_from_trash` is rejected
(`signingSecretUnavailable`) rather than trusted unverified. Both tools otherwise behave exactly as they did
in 0.4.1.

## Why permanent delete is feature-gated off

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

## Sender identity is never caller-chosen

`mail_send`/`mail_send_preview`'s `from` is never taken at face value. If supplied, it must
case-insensitively equal the one mailbox identity this Bridge account's `config.json` already
resolves to (`src/smtp/policy.ts`, `validateSender`); if omitted, that identity is the default. There
is no reliable, simple way for this project to enumerate additional Bridge-authorized send-as
aliases, so 0.5.0 takes the most conservative option: exactly the configured identity, never
anything else. A caller supplying `from: "ceo@google.com"` (or any other address) is rejected before
an intent is ever built — see `tests/smtp-policy.test.ts` ("rejects an unauthorized sender (spoofing
attempt)").

## Recipient, subject, and body policy (0.5.0 scope, unchanged in 0.5.1)

- **Recipients**: explicit `to`/`cc` only — never derived from a message body or any other content.
  Each address is validated (a deliberately narrow RFC 5322 subset — see `ADDRESS_PATTERN` in
  `src/smtp/policy.ts`) and rejected outright if it contains any control character, including CR/LF
  (the concrete header-injection defense: an address like `"a@example.com\r\nBcc: victim@example.com"`
  fails validation, full stop, before it can ever reach anything that builds a header). Duplicates
  across `to`+`cc` (case-insensitive) are silently deduplicated, mirroring `dedupeUids`'s precedent
  for mutation UIDs — not treated as a hard failure. Combined `to`+`cc` is capped at 5 recipients
  total (`MAX_SEND_RECIPIENTS`); there is no Bcc in this version and no automatic recipient expansion
  of any kind.
- **Subject**: non-empty, ≤500 characters, and the same control-character rejection as recipients —
  no CR/LF, no header injection.
- **Body**: plain text only, non-empty, ≤50,000 characters, UTF-8 (an unpaired UTF-16 surrogate is
  rejected rather than silently corrupted on the wire). Exactly like every message body this project
  reads (see "Email body is untrusted input" above), a body this project _sends_ is data, never
  interpreted as an instruction, executed, or evaluated — the difference is only that here the
  content is caller-supplied (trusted input to this call), not attacker-supplied email content; the
  non-interpretation rule is symmetric regardless of which side of the wire it's on.
- No HTML, attachments, inline images, calendar invites, arbitrary custom headers, raw MIME, custom
  Reply-To, arbitrary Message-ID, References, or In-Reply-To — deliberately: each adds attack surface
  beyond what 0.5.1 validates against a real Bridge instance. Reply/forward remain out of scope for
  0.5.1 too (0.5.0 anticipated building them "once the transport exists"; 0.5.1 uses that transport
  only to lift the live-send gate under the existing plain-text/explicit-recipients policy, not to add
  reply/forward) — a future version, built on top of this now-live transport, not part of this one.

## Send-intent receipts

`mail_send_preview` computes exactly what would be sent and reports it; `mail_send` actually submits.
Nothing structurally ties those two calls together without a receipt: a caller (or a compromised
intermediate step) could preview message A and then call `mail_send` with message B, and this project
would have no way to tell the two apart. This is the same problem `restoreReceipt` solves for the
Trash/restore round-trip (see "Restore receipts" above), applied to the preview/send round-trip
instead — `src/security/send-intent-receipt.ts`.

- `mail_send_preview` signs exactly what it validated — normalized `from`, `to`, `cc`, `subject`, and
  a SHA-256 hash of the body (never the body itself) — with a per-install HMAC-SHA256 secret that
  lives only in the macOS Keychain (service `proton-mail-mcp-send-signing`, distinct from both the
  Bridge password and the restore-receipt secret — signing key material is never reused across
  unrelated purposes in this project, see "Restore receipts" for the identical reasoning).
- `mail_send` refuses to submit unless the payload it was given re-derives, field for field, to that
  exact signed intent: structure → signature → expiry (15 minutes, `SEND_INTENT_RECEIPT_TTL_MS`) →
  exact match, fail-closed at the first failing check — a changed body, subject, sender, or recipient
  set between preview and send is rejected (`intentMismatch`), never silently accepted.
- Recipient **order** is normalized (case-insensitively sorted) before signing and before comparison,
  so re-listing the same recipient _set_ in a different order never causes a spurious mismatch; adding,
  removing, or moving an address between `to` and `cc` always does.
- The secret is provisioned by `scripts/configure-send-signing.sh`, never run automatically. Without
  it, `mail_send_preview` issues no receipt at all (and says so in `reasons`); a live `mail_send` call
  with no receipt, or a receipt that fails any check, is rejected (`outcome: "rejected"`).
- **0.5.1**: every receipt also carries a random 16-byte `id` (hex), signed like every other field, so
  it can't be stripped or swapped without invalidating the signature. This `id` is the replay-guard's
  single-use key — see "Send-intent receipt replay" below for what it does and its accepted limits.

## Live SMTP submission (0.5.1)

Through 0.5.0, `mail_send` was fully implemented and unit-tested (consent gating, intent validation,
full `sendIntentReceipt` verification) but a fully-confirmed live call was still refused unconditionally
by a hard feature gate (`blocked: true, blockReason: "liveSendDisabled"`), mirroring
`mail_delete_permanently`'s gate — see "Why permanent delete is feature-gated off" above, which is
still active and unaffected by this section.

**0.5.1 removes that one gate and only that gate.** `src/smtp/transport.ts`'s `submitSmtp` — the one
function in this project that may ever open a real SMTP connection — is now actually reachable from
`mail_send`'s registered tool path, but only after every one of the following passes, in this exact
order, fail-closed at the first failing check:

1. `dryRun=false`, `confirm=true`, and `acknowledgeExternalSend=true` (unchanged from 0.5.0).
2. Full intent validation — sender, recipients, subject, body (unchanged from 0.5.0,
   `src/smtp/policy.ts`).
3. Full `sendIntentReceipt` verification — structure, signature, 15-minute expiry, exact field match
   against the intent (unchanged from 0.5.0, `src/security/send-intent-receipt.ts`).
4. **New in 0.5.1**: the receipt's nonce is consumed by the replay guard
   (`src/security/send-intent-replay-guard.ts`) — see "Send-intent receipt replay" below. A receipt
   presented a second time, by any caller, is refused here with zero further SMTP attempt.
5. Only once all four pass does this project ever request the Bridge password from the Keychain or
   open a socket — via `submitSmtp`, unchanged from 0.5.0: loopback-only host (enforced twice, see
   "SMTP host is loopback-only"), `requireTLS`/`rejectUnauthorized` always on, one-shot (`pool: false`)
   connection, and never more than one `sendMail` call per `submitSmtp` invocation, ever (see "Duplicate
   sends are worse than an uncertain result" below).

`mail_send_preview` and a `dryRun: true` `mail_send` call remain, unchanged, zero-SMTP-connection paths
— a dry run may now also check a supplied `sendIntentReceipt` for validity (informational, `receiptValid`
in the result) but this NEVER consumes the replay-guard nonce, so a dry-run check never costs the
caller their one live attempt with that receipt.

**Live send was not exercised against a real Bridge instance as part of this change** — see the
project's own task tracking for the separate, explicit live-validation step that must run before this
capability is used for a real send. This implementation task itself made zero live SMTP connections
(every test uses an injectable fake transport, `src/smtp/transport.ts`'s `SmtpSendFn`, exactly like
0.5.0's already-unit-tested `submitSmtp`).

## Send-intent receipt replay

A `sendIntentReceipt` is valid for its full 15-minute TTL and, without something to stop it, could be
presented to `mail_send` more than once within that window — a caller (or a buggy/compromised client)
calling `mail_send` twice with the same still-valid receipt could otherwise submit the same message
twice over SMTP. This project's MCP server has no persistent database and this section is an explicit,
narrow exception to that, not a quiet contradiction of it — see the decision below.

**0.6.0 decision:** `src/security/send-intent-replay-guard.ts` persists one marker per verified
send, reply, or forward receipt under `~/.config/proton-mail-mcp/replay/`. Its filename is SHA-256 of
the purpose, a NUL separator, and the random receipt nonce. It contains only a format version,
purpose, consumption timestamp and expiry timestamp. It never stores a receipt, HMAC, recipient,
subject, body, Message-ID, Bridge credential, or signing key. The config and replay directories must
be owner-only (0700); marker files are 0600.

The decision is one `O_CREAT|O_EXCL` file creation, not a raceable exists-then-create sequence.
Two independent MCP processes, including one launched by Codex and one by Claude Code, cannot
consume the same marker. Namespace separation prevents identical random nonces in send, reply and
forward from colliding. A non-collision filesystem error fails closed before credential lookup or
SMTP. A partially written marker still counts as consumed.

This is **at-most-once authorization, not exactly-once delivery**. If a process crashes after
exclusive creation but before SMTP, the receipt stays spent; it is never rolled back. That can lose
one authorized attempt, but avoids a duplicate send. The guard does not automatically retry any
outcome. Lazy cleanup examines at most 64 marker entries per consumption and deletes only valid,
private markers whose signed receipt expiry passed at least one additional hour ago. Malformed or
partial markers remain. Cleanup failure cannot authorize a replay or block a successful new
consumption. This protection applies only to outbound receipts; unrelated IMAP mutations are not
globally serialized or transactional.

The guarantee assumes every participating MCP process runs 0.6.0 and uses the same local config
directory. During upgrade, restart both Codex and Claude Code MCP processes. A receipt consumed by
the old in-memory guard before upgrade has no file marker; let its 15-minute TTL expire before
relying on the new cross-process guarantee. `mail_system_status` confirms the loaded version in
each process.

## Operational recovery and diagnostics (0.6.0)

0.6.0 officially supports macOS only. Runtime startup, bootstrap, and doctor reject unsupported
platforms clearly; Linux and Windows credential stores or setup flows have not been implemented.
The bootstrap trust boundary is local: `scripts/bootstrap.sh` reuses the existing setup scripts,
which accept only Bridge-generated credentials, local connection settings and the exported public
certificate. It never asks for a Proton account password, recovery phrase, or recovery codes.
Bridge credentials and signing secrets stay in macOS Keychain, not Git, agent configuration or
`config.json`. Bootstrap prints Codex and Claude Code registration commands but never runs them
or overwrites an existing agent registration. `--check` makes no configuration changes.

`pnpm doctor` is read-only. It checks config, file permissions, Keychain availability and a
read-only IMAP connection. It deliberately does not verify SMTP: no SMTP connection, DATA, recipient
or message is sent. Errors are converted to fixed status text so raw Keychain output, parser input,
paths and protocol transcripts are not printed. `mail_system_status` exposes the loaded server
name/version, process start and uptime, coarse configuration and gate status. It never reads
Keychain values or message content, and makes no Bridge connection. A reported capability means
its code gate is open; doctor supplies the separate environment health checks.

## Duplicate sends are worse than an uncertain result

The transport layer (`src/smtp/outcome.ts`) is built around one rule this project will not compromise
on: an SMTP failure with no definitive server response is classified `uncertain` (with
`deliveryUncertain: true`), never silently treated as either a clean success or a clean failure — and
**nothing in this codebase retries an SMTP submission automatically**, on any outcome, ever. A 4xx
"temporary failure" response explicitly invites a retry; this project reports it as `uncertain` instead
of retrying, for the same reason. Sending the same message twice because a response was ambiguous is a
strictly worse failure mode than returning "I don't know" and letting the caller decide — see
`tests/smtp-outcome.test.ts`, `tests/smtp-transport.test.ts` ("never retries automatically"), and
`tests/smtp-send.test.ts` ("at-most-once and replay") for this enforced at every layer: the SMTP
library is never configured with pooling/retry, `submitSmtp` calls the send function exactly once per
invocation, and `mail_send`'s replay guard means even the caller cannot cause a second SMTP attempt
with the same receipt.

## Sent-folder placement is not modeled yet

0.5.1 still does not perform a manual IMAP `APPEND` into Sent after an SMTP submission, and does not yet
know whether/how Proton Bridge places a locally-submitted message into Sent on its own. Guessing here
risks a duplicate copy (SMTP submission _and_ a manual append) worse than not modeling it at all. The
result shape reserves `sentFolderObserved` (always `null` in 0.5.1) for a future, explicitly
live-validated version to fill in once that behavior has actually been observed against a real Bridge
instance — not invented in advance. Discovering this behavior is exactly the kind of thing the separate
live-validation task (see "Live SMTP submission (0.5.1)" above) exists to do, with no polling loop or
guess coded in ahead of that observation.

## Controlled Reply & Forward (0.5.2) — threat models

`mail_reply_preview`/`mail_reply` and `mail_forward_preview`/`mail_forward` reuse `mail_send`'s
loopback-only transport and every 0.5.0/0.5.1 protection, plus the additional threat surface reply
and forward introduce by deriving parts of the outbound message from an attacker-controlled source
message. Live submission for both was feature-gated off in 0.5.2. Controlled live reply was enabled
and separately validated in 0.5.3; controlled live forward was enabled in 0.5.4 and separately
validated after a full MCP process restart. The threat models below apply to both.

**Malicious `Reply-To`.** A sender fully controls their own `Reply-To` header. The threat: an
attacker sets `Reply-To` to a third party, or to multiple addresses, hoping a reply silently goes
somewhere the human user didn't intend. Defense: at most one address is ever accepted — a `Reply-To`
header that is present but resolves to zero or more than one usable address makes the reply
**ineligible**, never a silent fallback or an expansion to multiple recipients (`src/smtp/reply-
intent.ts`'s `deriveRecipient`). Because some IMAP servers copy `From` into a parsed `Reply-To` slot
when the header doesn't actually exist (RFC 3501), the raw header's **presence** is checked
independently via a direct header fetch (`src/mail/source-message.ts`), not inferred from whether
the parsed address list happens to be non-empty — this is exactly what stops a "header technically
absent" case from being silently treated as "header present, use it."

**Reply-all amplification.** There is no mechanism, gated or otherwise, that expands a reply to
more than one recipient — `ReplyIntent.to` and `ReplyIntentReceiptEnvelope.to` are both typed as a
single string, never an array, so accepting more than one address is a schema-level impossibility,
not a runtime check that could regress. `tests/smtp-reply-intent.test.ts` and `tests/tool-
registration.test.ts` both pin this down structurally.

**Threading header injection.** The threat: a malicious source message's `Message-ID`/`References`
headers could be crafted to inject additional headers, oversized data, or misleading thread
correlation into the outbound reply. Defense: `In-Reply-To`/`References` are never caller-suppliable
(no such field exists in `mail_reply`'s input schema) and are derived exclusively from the source's
own headers through a strict validator (`MESSAGE_ID_PATTERN`, a conservative `<local@domain>` shape,
plus `MAX_MESSAGE_ID_LENGTH`); the raw `References` header is additionally bounded by byte length
(`MAX_REFERENCES_HEADER_BYTES`, checked before any parsing) and, once parsed, by count
(`MAX_REFERENCES_COUNT`, oldest ids dropped first). Any id or chain that doesn't pass validation is
discarded wholesale (never partially trusted), and a missing/malformed `Message-ID` simply disables
threading rather than fabricating one. The raw values never appear in any tool's JSON output — only a
content hash (`threadingHash`) is bound in the receipt.

**Malicious forwarded body.** The threat: the source message's body contains prompt-injection text
("ignore previous instructions...") or fabricated header-like lines intended to manipulate the
assistant or forge additional visible headers in the forwarded block. Defenses, layered: (1) the
model itself never derives recipients, subject, or any control-flow decision from body content — it
is only ever copied byte-for-byte into a fixed template; (2) `From`/`Date`/`Subject`/`To` shown
inside that template are passed through `sanitizeForwardedHeaderField` (control characters including
CR/LF collapsed, whitespace normalized, length-capped), so a header value can never forge an
additional line inside the visible forwarded block; (3) the forwarded body is plain-text only — HTML
sources are converted, never forwarded as HTML, closing the classic HTML/rich-content injection
vector. See `tests/tool-forward.test.ts`'s "prompt-injection regression" suite and
`tests/smtp-forward-intent.test.ts`'s header-normalization tests.

**Attachment omission.** No attachment is ever included in a forward — there is no code path that
reads attachment content at all (`fetchForwardSourceContent` uses `BODYSTRUCTURE` purely to detect
_presence_, never to download attachment bytes). The risk this section actually guards against is
different: a caller (human or automated) not realizing attachments were silently dropped, and
mistakenly believing a complete message was forwarded. `mail_forward_preview` surfaces
`sourceHasAttachments`/`attachmentsWillBeOmitted` explicitly, and a live `mail_forward` call requires
`acknowledgeAttachmentsWillBeOmitted: true` whenever the **cryptographically verified receipt**
(not an unverified caller-supplied flag) says the source has attachments — see
`tests/smtp-forward-send.test.ts` ("attachment ack is checked against the VERIFIED receipt").

**Source changes after preview.** The threat: the message a caller previewed differs from the
message actually present at send time (edited, replaced, or a different message entirely reachable
at the same folder/UID after some other operation) — an "intent substitution" via the source rather
than via the caller's own payload. Defense: `sendReply`/`sendForward` are never handed a
cached/reused source — the tool handler performs a **fresh** read-only fetch immediately before
calling them, and the core function re-derives the entire intent (recipient, subject, threading/
content, and the keyed `sourceFingerprint` binding `folder`+`UIDVALIDITY`+`uid`+`From`+`Subject`+
`Date`, with `Message-ID` folded in only when present) from that fresh fetch, comparing it against
the receipt's bound values. Any drift — a different fingerprint, a different derived recipient/
subject, a different content hash — fails closed before any credential is requested or any SMTP
connection opens. `tests/smtp-reply-send.test.ts`/`smtp-forward-send.test.ts` ("source
revalidation") exercise this directly, including a Reply-To that changed since preview and a
forwarded body that changed since preview.

**Intent substitution (preview A, submit B).** Structurally the same class of attack
`send-intent-receipt.ts` already closes for `mail_send`: the receipt binds a signed, exact snapshot
of what was previewed (recipient/subject/text-hash/threading-hash or content-hashes/source
fingerprint), and live submission re-derives the current intent and requires a byte-for-byte match
before proceeding — a caller cannot preview one message and submit a different one under the same
receipt, whether the difference originates from tampered call arguments or a changed source message.

**Receipt cross-purpose attacks.** The threat: a valid `sendIntentReceipt` (or a `forwardIntentReceipt`)
being presented to `mail_reply`, hoping shared signing infrastructure lets it verify. Defense,
layered: (1) each receipt type has its own Zod schema with a distinct required field set (a reply
receipt's `to` is a single string; a send/forward receipt's is an array — an immediate structural
mismatch); (2) even a hypothetically shape-compatible payload fails signature verification, because
each receipt type derives its HMAC signing key from the same underlying Keychain secret
(`SEND_SIGNING_KEYCHAIN_SERVICE`) via its **own** domain-separated `SIGNING_KEY_INFO` string
(`send-intent-receipt:signature:v1` / `reply-intent-receipt:signature:v1` /
`forward-intent-receipt:signature:v1`) — a signature produced under one derived key never verifies
under another; (3) the replay guard's nonces are prefixed per type (`reply:`/`forward:`, bare for
send) at the call site, so even an id collision (astronomically unlikely given 128-bit random ids)
could never let one type's consumption record satisfy another's. See
`tests/security-reply-intent-receipt.test.ts` and `tests/security-forward-intent-receipt.test.ts`'s
"cross-purpose receipt rejection" suites, and `tests/security-send-intent-replay-guard.test.ts`'s
"purpose-prefixed nonces" suite.

## Controlled live forward is enabled as of 0.5.4

`LIVE_REPLY_DISABLED`/`LIVE_FORWARD_DISABLED` (`src/smtp/feature-gates.ts`) started 0.5.2 both
unconditionally `true` — no config flag or environment variable. 0.5.3 flipped only the reply gate;
separate real Bridge validation later confirmed one accepted reply, one Sent copy, one Inbox copy,
and matching threading headers. **0.5.4 flips only the forward gate.** A later controlled validation
after a full restart confirmed one accepted forward and one copy each in Sent and INBOX.
No 0.5.2 forward protection was relaxed: consent, HMAC and TTL verification, exact source
fingerprint/recipient/subject/intro hash/forwarded-content hash/attachment-state match, fresh source
re-fetch and re-derivation, attachment-omission acknowledgement when needed, and nonce consumption
before SMTP remain in place. Reply behavior is unchanged.

One deliberate, still-true difference from `mail_send`'s replay-guard ordering: the feature-gate
check runs **before** the replay guard consumes the receipt's one-time nonce
(`src/smtp/reply-send.ts`/`forward-send.ts`), so a gate-blocked call — which causes no external side
effect — never burns an otherwise-valid receipt. This ordering remains true for both open gates;
their tests exercise the closed-gate path with an injectable `deps.liveDisabled: true` override.

## Reporting

This is a personal, local-only project whose only network-facing surface beyond `127.0.0.1` is a small,
heavily-restricted set: the single outbound HTTPS request `mail_unsubscribe` may make (see "External HTTP
side effect" above), and — as of 0.5.1 — the loopback-only, receipt-gated, at-most-once-per-attempt SMTP
connection `mail_send` makes on a fully-confirmed live call (see "Live SMTP submission (0.5.1)"). As of
0.5.3, `mail_reply` shares that same connection path and has been live-validated. As of 0.5.4,
`mail_forward` is enabled and was separately live-validated after restart (see
"Controlled live forward is enabled as of 0.5.4" above). If you fork or extend it and find a
security issue, treat it with the same care as the points above: prefer removing a footgun over
rationalizing it.
