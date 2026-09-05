# Agent Browser Studio — Pricing & SKUs (#98 / #100)

> Copy pre-scanned by `npm run check:marketing` — no bypass/evade/undetectable
> claims, no "anti-ban" promises. Positioning: isolated testing environments
> for teams managing their own accounts.

## SKUs

| SKU | Price | Includes |
|---|---|---|
| Trial | Free, 14 days / 10 profiles | Full features, local-only |
| Monthly (anchor, not pushed) | $9/mo | Full features |
| Yearly (hero, default) | $49/yr (~$4/mo) | Full features + updates + support channel |
| Lifetime | $149 (locks v2.x; major upgrades billed separately) | Enthusiasts, cash flow |
| Remote setup | $15–45/session (see #99) | 10 environments + proxy + 4-field alignment, done for you |

## Rules

- Yearly is the default highlight; Monthly is a price anchor.
- Lifetime locks the major version; major upgrades carry an upgrade fee (no
  unbounded "lifetime" support liability).
- Refunds: unactivated codes refundable; activated/downloaded digital goods
  are non-refundable (one-shot acknowledgement at activation, see #93).
  EU buyers: 14-day cooling-off applies to unactivated codes; once you
  activate (explicit consent at purchase), the digital-content exception
  applies — exact wording to be signed off by counsel before the Paddle
  listing goes live.

## Paddle linkage (#100)

- Paddle is the Merchant of Record (tax/VAT handled). Subscription + one-time
  SKUs map to the license plans above.
- Activation codes minted from Paddle orders carry `paddleOrderId` /
  `paddleSubscriptionId` inside the signed payload (display/audit only —
  verified by signature, never trusted for money logic locally).
- Sandbox acceptance: subscribe → webhook → mint → activate → launch works;
  cancel → expiry is honored at next status check (no phone-home).

## Landing checklist (website)

- [ ] Pricing table + feature comparison + FAQ
- [ ] Docs (install / activate / 4-field alignment / FAQ, shared with #94)
- [ ] Payment via Paddle (cards, PayPal, Alipay/WeChat/UnionPay where Paddle supports)
- [ ] 3 demo videos (create → align → 92-point check)
