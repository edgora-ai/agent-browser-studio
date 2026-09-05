# Privacy Policy & Terms of Service (#102)

> Draft for counsel review — DO NOT publish as-is. GDPR/data-deletion paths
> below map to real in-app features; verify each before launch.

## Privacy Policy (GDPR)

1. **Local-first.** Profiles (cookies, sessions, localStorage), credentials
   and audit logs live on your device. We operate no account cloud; Paddle
   (Merchant of Record) processes payments under its own policy.
2. **What leaves the device.** Only what YOU configure: (a) S3-compatible
   sync to YOUR bucket after separate in-app custody consent (purpose:
   backup/sync; duration: while sync stays enabled); (b) proxy/detection
   traffic you trigger (ping0 checks, proxy health probes).
3. **Deletion.** In-app, no ticket needed: profile 🗑 Trash (7-day recovery)
   → purge; per-profile 📦 export then delete; disable sync + delete remote
   objects; activation/license file is local (`license.json`, delete to
   return to trial). Email support for Paddle-side invoice data.
4. **Logs.** Local structured logs under the app data dir (0600), no upload
   path. Retention: rotate/delete with the app data dir; no remote retention.
5. **Minors / lawful use.** Lawful, authorized use only (see Terms). EU
   14-day cooling-off: unactivated codes; activation = explicit consent to
   immediate digital delivery.

## Terms of Service

1. **Authorized use only.** Only accounts and sites you are authorized for;
   respect each site's ToS. Prohibited: fraud, gambling, money laundering,
   fake orders/reviews, credential stuffing, bulk fake registration, evading
   real-name verification.
2. **No anti-ban promise.** Isolation is not immunity: platforms may still
   restrict accounts. No pass/block guarantee, no "undetectable" claim.
3. **License.** One device per code; transfers via seller re-mint (send your
   in-app Device ID). Tampering (clock rollback, file edits) voids the trial.
4. **Refunds.** Unactivated codes refundable; activated/downloaded goods are
   not (acknowledged at each activation). Chargebacks on delivered codes =
   license revocation + dispute evidence (signed payload + activation record).
5. **Disputes.** Governing law / venue TBD by counsel; contact email TBD.
6. **KYB/AUP evidence file (for payment review).** Keep: business license,
   authorization chain (engine provenance: independently patched Chromium 152
   + Firefox 154, build attestations in engine-verify.yml), this policy, the
   marketing-copy scan log (`npm run check:marketing -- --strict`), and the
   prohibition list above. Payment reviewers ask for exactly this bundle.

## Affiliate policy (#101)

- 20% recurring TBD; no coupon stacking without approval.
- Affiliates repeat the same copy rules: no bypass/evade/undetectable,
  no anti-ban promises, lawful-use disclaimer on every review.
- Violation = commission hold + link termination. Review rights reserved.
