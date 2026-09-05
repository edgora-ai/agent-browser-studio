# Marketing copy review record (#101/#102)

Date: 2026-09-05T09:43Z
Command: node scripts/check-marketing-copy.mjs --strict
Result: PASS (exit 0, zero hits after allowlist)

```
✓ marketing-copy check passed
```

Allowlist rationale: every entry in scripts/check-marketing-copy.mjs names WHY
the hit is technical (proxy bypass-list = Chromium --proxy-bypass-list term),
ordinal ("first profile"), or a compliance negation (anti-detection ≠ anti-ban
disclaimer, ban-evasion in Do-NOT lists) — not a sales promise.

Keep this file with the KYB/AUP evidence bundle for payment review.
