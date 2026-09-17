/**
 * Live feature gates for reply/forward (introduced 0.5.2, "Controlled Reply
 * & Forward"). Mirrors `mutations/permanent-delete.ts`'s hard, hardcoded
 * gate (not env/config-driven) and exactly how 0.5.0 shipped `mail_send`
 * gated off before 0.5.1 live-validated and lifted it.
 *
 * 0.5.3 lifted `LIVE_REPLY_DISABLED`; its live Bridge validation succeeded.
 * 0.5.4 lifts only `LIVE_FORWARD_DISABLED`. Real forward validation remains
 * pending until a full MCP process restart. Consent, receipt verification,
 * source revalidation, and nonce consumption before SMTP remain in place.
 *
 * See `src/smtp/reply-send.ts`/`forward-send.ts` for exactly where each gate
 * is checked (before the replay-guard nonce is consumed, so a gate-blocked
 * call never burns an otherwise-valid receipt) and `deps.liveDisabled` for
 * how tests exercise the closed-gate path.
 */
export const LIVE_REPLY_DISABLED = false;
export const LIVE_FORWARD_DISABLED = false;
