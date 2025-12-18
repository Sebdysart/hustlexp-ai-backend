# HustleXP: Seattle Beta Backend Readiness Requirements

## Mission Context
HustleXP is an AI-native gig marketplace for real-world tasks in Seattle. This document defines the non-negotiable readiness criteria for the backend to support real money, real users, and real operational risk.

> [!IMPORTANT]
> **Mantra:** I will not treat this as "probably fine" until we have evidence for each critical system.

## 1. Seattle Beta Backend Readiness Checklist

| # | System | Verification Method | PASS/FAIL Definition |
| :--- | :--- | :--- | :--- |
| 1 | **Money Flow** | Inspect `StripeService`, `EscrowController` | Escrow on task accept, payout on poster approval. No self-payouts. |
| 2 | **Stripe Webhooks** | Test with duplicate payloads | Idempotency confirmed. No double-charges or double-credits. |
| 3 | **Proof Validation** | Inspect GPS logic in `ProofService` | GPS within Seattle bounds enforced. Rejects spoofed/outside coords. |
| 4 | **R2 Storage** | Verify upload limits & signed URLs | Photos < 10MB, metadata stripped, URLs expire < 24h. |
| 5 | **Safety & Disputes**| Audit `DisputeService` | Admin-only resolution, strike system enforcement active. |
| 6 | **Admin Security** | `curl` unauthorized requests | 401/403 on all admin endpoints. No backdoors. |
| 7 | **AI Routing** | Fault injection in `ai/router.ts` | DeepSeek fails -> GPT-4o takes over within service limits. |
| 8 | **Cost Controls** | Inspect `MetricsService` | AI usage logged with tokens and provider costs. Alerts on spikes. |
| 9 | **Database Schema** | `db:check` comparison | Neon schema matches `schema.ts`. No pending destructive migrations. |
| 10 | **Auth/Roles** | JWT claim verification | Poster vs Hustler vs Admin roles strictly enforced in API guards. |
| 11 | **Rate Limiting** | Automated load simulation | Auth, PII, and AI endpoints protected against brute force/spam. |
| 12 | **Error Visibility** | Review log structure | 100% of internal errors logged with stack traces and request IDs. |

## 2. Sequence for validation
The validation will proceed in this order:
1. **Money** (Escrow, Payouts, Ledger)
2. **Proof** (GPS, R2, Validation)
3. **Safety** (Disputes, RBAC, Admin)
4. **AI** (Routing, Fallback, Costs)
5. **Analytics** (Metrics, Visibility)
6. **Ops** (Feature Flags, City Rules)
7. **Abuse** (Rate limits, Spoofing)

## 3. Operational Access
- **Repo:** hustlexp-ai-backend
- **Stack:** Fastify/Hono, Neon (Postgres), Upstash (Redis), Cloudflare (R2), Stripe Connect
- **AI:** Groq, DeepSeek, GPT-4o
