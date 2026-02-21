# PCI DSS SAQ-A Compliance Checklist

**Standard:** PCI DSS v4.0 — Self-Assessment Questionnaire A
**Applicability:** Card-not-present, fully outsourced to Stripe
**Last Updated:** 2025-02-21
**Next Review:** 2025-08-21 (6-month cycle)

---

## Scope Justification

HustleXP uses **Stripe Elements** (client-side) for all payment collection.
- No cardholder data (CHD) enters our servers
- No card numbers stored, processed, or transmitted
- All payment processing delegated to Stripe (PCI Level 1 Service Provider)
- SAQ-A applies per PCI DSS v4.0 §2.1

---

## SAQ-A Requirements

### Requirement 2: Secure Configurations

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 2.1 | Change vendor defaults | ✅ PASS | Custom passwords for all services; no default credentials in production |
| 2.2 | Develop configuration standards | ✅ PASS | Dockerfile pins image versions; non-root user; read-only filesystem |
| 2.3 | Encrypt non-console admin access | ✅ PASS | All admin access via HTTPS (Railway enforces TLS) |

### Requirement 6: Secure Development

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 6.2 | Software development security | ✅ PASS | CI pipeline: lint + typecheck + tests required for merge |
| 6.3 | Security testing | ⚠️ PARTIAL | npm audit in CI; no DAST/penetration test yet |
| 6.4 | Public-facing web app protection | ✅ PASS | HSTS, CSP, X-Frame-Options headers; rate limiting |
| 6.5 | Address common vulnerabilities | ✅ PASS | Input validation (Zod), SQL parameterization, XSS headers |

### Requirement 8: Identify Users

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 8.1 | Unique user identification | ✅ PASS | Firebase Auth (unique UID per user) |
| 8.2 | Multi-factor authentication | ⚠️ PARTIAL | Firebase supports MFA; not enforced for all admin users yet |
| 8.3 | Strong authentication | ✅ PASS | Firebase ID tokens (JWT, RS256, 1h expiry) |

### Requirement 9: Restrict Physical Access

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 9.x | Physical access controls | N/A | Cloud-hosted (Railway); no physical infrastructure |

### Requirement 11: Regular Testing

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 11.2 | Vulnerability scanning | ⚠️ PARTIAL | npm audit (dependency scanning); no infrastructure scanning |
| 11.3 | Penetration testing | ❌ TODO | Not yet performed; schedule before GA launch |

### Requirement 12: Information Security Policy

| # | Control | Status | Evidence |
|---|---------|--------|----------|
| 12.1 | Security policy | ⚠️ PARTIAL | ARCHITECTURE.md documents security; formal policy doc needed |
| 12.8 | Service provider management | ✅ PASS | Stripe is PCI Level 1; Firebase SOC2 compliant |

---

## Stripe Integration Security

| Control | Implementation | File |
|---------|---------------|------|
| Webhook signature verification | `stripe.webhooks.constructEvent()` | server.ts:596-626 |
| Event idempotency | `processed_stripe_events` table | StripeService.ts:98-100 |
| Circuit breaker on Stripe API | `stripeBreaker` wrapper | middleware/circuit-breaker.ts |
| No PAN data in logs | PII detection in ai-guard.ts | middleware/ai-guard.ts |
| API key rotation support | Config from env vars | config.ts |

---

## Action Items

1. **[HIGH]** Schedule penetration test before GA launch (Requirement 11.3)
2. **[MEDIUM]** Enforce MFA for admin users (Requirement 8.2)
3. **[MEDIUM]** Create formal Information Security Policy document (Requirement 12.1)
4. **[LOW]** Add infrastructure vulnerability scanning (Requirement 11.2)
5. **[LOW]** Set up quarterly SAQ-A review cadence
