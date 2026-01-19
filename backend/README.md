# HustleXP Backend (Constitutional Architecture)

## Overview

This backend implements the constitutional architecture defined in HUSTLEXP-DOCS:
- **Layer 0 (Database)**: Enforces all invariants via triggers
- **Layer 1 (Services)**: Orchestration only, relies on DB triggers
- **Layer 2 (API)**: tRPC endpoints with Zod validation
- **Layer 3 (AI)**: A2 authority - proposals only, never final decisions

## Setup

1. **Install dependencies**: `npm install`

2. **Configure environment**: 
   ```bash
   cp env.backend.template env.backend
   # Fill in all required secrets (Postgres, Redis, Stripe, Firebase, R2, AI keys)
   ```

3. **Apply constitutional schema**:
   ```bash
   # Option 1: Using migration script
   tsx backend/database/migrate-constitutional-schema.ts
   
   # Option 2: Direct SQL
   psql "$DATABASE_URL" -f backend/database/constitutional-schema.sql
   ```

4. **Verify schema**:
   ```bash
   tsx backend/database/verify-constitutional-schema.ts
   ```

5. **Run server**: 
   ```bash
   PORT=5000 bunx tsx backend/server.ts
   ```

## Architecture

### Database Layer (Layer 0)
- **Constitutional Schema**: `backend/database/constitutional-schema.sql`
- **Invariants Enforced**:
  - INV-1: XP requires RELEASED escrow (HX101)
  - INV-2: RELEASED requires COMPLETED task (HX201)
  - INV-3: COMPLETED requires ACCEPTED proof (HX301)
  - INV-4: Escrow amount immutable (HX004)
  - INV-5: XP idempotent per escrow (unique constraint)
- **Terminal States**: COMPLETED, CANCELLED, EXPIRED (tasks); RELEASED, REFUNDED, REFUND_PARTIAL (escrows)

### Service Layer (Layer 1)
All services in `backend/src/services/`:
- **Core**: TaskService, EscrowService, XPService, ProofService
- **Trust & Badges**: TrustService, BadgeService
- **Disputes**: DisputeService
- **AI Infrastructure**: AIEventService, AIJobService, AIProposalService, AIDecisionService, EvidenceService, OnboardingAIService
- **Live Mode**: LiveSessionService, LiveBroadcastService
- **Human Systems**: FatigueService, PauseService, PosterReputationService, PercentileService, SessionForecastService, MoneyTimelineService
- **Payments**: StripeService, StripeWebhookHandler

### API Layer (Layer 2)
tRPC routers in `backend/src/routers/`:
- `task`: Task lifecycle (create, accept, complete, cancel)
- `escrow`: Escrow management (fund, release, refund)
- `user`: User profile and XP
- `ai`: AI onboarding endpoints
- `live`: Live Mode endpoints
- `health`: Health checks

## Testing

### Invariant Tests
```bash
# Run all invariant tests
npm test backend/tests/invariants/

# Specific invariant
npm test backend/tests/invariants/inv-1.test.ts
```

### Integration Tests
```bash
npm test backend/tests/integration/
```

### Service Tests
```bash
npm test backend/tests/services/
```

## Error Codes

All HX error codes are defined in `backend/src/db.ts`:
- **HX001-HX002**: Terminal state violations
- **HX004**: Escrow amount immutability
- **HX101-HX102**: XP system violations
- **HX201**: Escrow release violations
- **HX301**: Task completion violations
- **HX401**: Badge system violations
- **HX601-HX604**: Human Systems violations
- **HX801**: Admin action violations
- **HX901-HX905**: Live Mode violations

## Key Principles

1. **Database is Layer 0**: All invariants enforced at DB level
2. **Services are Layer 1**: Orchestration only, no business logic that bypasses DB
3. **AI is Layer 3**: Proposals only, never final decisions
4. **No Smart Clients**: Frontend never caches for decision-making
5. **Append-Only Ledgers**: XP, trust, badges, admin actions never deleted
6. **Terminal States Immutable**: COMPLETED, CANCELLED, EXPIRED, RELEASED, REFUNDED frozen

## Documentation

- **Constitutional Specs**: See `HUSTLEXP-DOCS/` repository
- **Schema**: `backend/database/constitutional-schema.sql`
- **Types**: `backend/src/types.ts` (matches schema exactly)
- **Error Handling**: `backend/src/db.ts` (all HX codes)

## Notes

- CORS honors `ALLOWED_ORIGINS` (comma-separated); defaults to `*` if unset.
- Stripe platform fee: 15% (PRODUCT_SPEC §9)
- Minimum task value: $5.00 (500 cents)
- Live Mode minimum: $15.00 (1500 cents)
- Avoid logging secrets; Firebase verification uses Admin credentials only.
