# HustleXP Backend

A production-ready tRPC backend for the HustleXP gig marketplace platform. Built with TypeScript, Hono, PostgreSQL, and Redis.

## Quick Start

1. **Install dependencies**
```bash
npm install
```

2. **Configure environment variables**
```bash
cp .env.template .env
# Edit .env with your API keys
```

3. **Run database migrations**
```bash
npm run db:migrate
```

4. **Start development server**
```bash
npm run dev
```

5. **Start background workers** (optional, in separate terminal)
```bash
npm run dev:workers
```

The server will run on `http://localhost:3000` (or `PORT` from `.env`).

## Environment Variables

### Required for Development

| Variable | Description | Where to Get |
|----------|-------------|--------------|
| `DATABASE_URL` | Neon PostgreSQL connection string | [neon.tech](https://neon.tech) |
| `UPSTASH_REDIS_REST_URL` | Redis REST API endpoint | [upstash.com](https://upstash.com) |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST API token | [upstash.com](https://upstash.com) |
| `UPSTASH_REDIS_URL` | Redis TCP connection string | [upstash.com](https://upstash.com) |

### Required for Production

| Variable | Description | Where to Get |
|----------|-------------|--------------|
| `STRIPE_SECRET_KEY` | Stripe API secret key | [stripe.com](https://stripe.com/docs/keys) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | [stripe.com](https://stripe.com/docs/webhooks) |
| `FIREBASE_PROJECT_ID` | Firebase project ID | [console.firebase.google.com](https://console.firebase.google.com) |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK private key | [console.firebase.google.com](https://console.firebase.google.com) |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin SDK client email | [console.firebase.google.com](https://console.firebase.google.com) |

### Optional Services

| Variable | Description | Where to Get |
|----------|-------------|--------------|
| `R2_ACCOUNT_ID` | Cloudflare R2 account ID | [cloudflare.com](https://cloudflare.com) |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 access key | [cloudflare.com](https://cloudflare.com) |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret key | [cloudflare.com](https://cloudflare.com) |
| `R2_BUCKET_NAME` | Cloudflare R2 bucket name | Default: `hustlexp-storage` |
| `SENDGRID_API_KEY` | SendGrid API key for emails | [sendgrid.com](https://sendgrid.com) |
| `SENDGRID_FROM_EMAIL` | Email sender address | Default: `verify@hustlexp.app` |
| `OPENAI_API_KEY` | OpenAI API key for AI features | [platform.openai.com](https://platform.openai.com) |
| `GROQ_API_KEY` | Groq API key (fast AI inference) | [console.groq.com](https://console.groq.com) |
| `DEEPSEEK_API_KEY` | DeepSeek API key (reasoning) | [platform.deepseek.com](https://platform.deepseek.com) |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | [twilio.com](https://twilio.com) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | [twilio.com](https://twilio.com) |
| `TWILIO_VERIFY_SERVICE_SID` | Twilio Verify service SID | [twilio.com](https://twilio.com) |

### Application Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (`development` or `production`) | `development` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | Empty (allow all) |

## API Routes

The backend exposes a tRPC API at `/api/trpc` with the following routers:

### Tasks
- `tasks.list` - List available tasks
- `tasks.get` - Get task details
- `tasks.create` - Create a new task
- `tasks.accept` - Accept a task
- `tasks.arrived` - Mark arrival at task location
- `tasks.complete` - Complete a task
- `tasks.listHistory` - Get task history
- `tasks.getState` - Get task state machine status
- `tasks.messages.list` - List task messages
- `tasks.messages.send` - Send a task message
- `tasks.messages.getConversation` - Get full conversation

### Users
- `users.me` - Get current user profile
- `users.update` - Update user profile
- `users.onboard` - Complete user onboarding

### Gamification
- `xp.addXP` - Award XP to user
- `badges.award` - Award badge to user
- `quests.list` - List available quests
- `quests.claim` - Claim quest reward

### Wallet & Payments
- `wallet.balance` - Get wallet balance
- `wallet.transactions` - List transactions
- `boosts.list` - List available boosts
- `boosts.activate` - Activate a boost

### Leaderboard
- `leaderboard.weekly` - Get weekly leaderboard
- `leaderboard.allTime` - Get all-time leaderboard

### Verification
- `verification.submitLicense` - Submit driver's license
- `verification.submitInsurance` - Submit insurance
- `verification.initiateBackgroundCheck` - Start background check
- `verification.resolveLicense` - Admin: resolve license verification
- `verification.resolveInsurance` - Admin: resolve insurance verification
- `verification.resolveBackgroundCheck` - Admin: resolve background check

### Additional Routers
- `ai` - AI orchestration and decision-making
- `escrow` - Escrow management
- `analytics` - Analytics and metrics
- `fraud` - Fraud detection
- `gdpr` - GDPR data export/deletion
- `moderation` - Content moderation
- `notification` - Push notifications
- `rating` - User ratings and reviews
- `taskDiscovery` - Task recommendation engine
- `instant` - Instant matching mode
- `live` - Real-time updates via SSE
- `messaging` - Direct messaging
- `health` - Health check endpoint

### REST Endpoints
- `GET /` - API status
- `GET /api/health` - Detailed health check
- `POST /api/auth/signup` - User signup
- `GET /api/auth/me` - Get current user
- `POST /api/webhooks/stripe` - Stripe webhook handler

## Database

PostgreSQL with PostGIS extension. Schema is versioned and migrations are located in `migrations/`.

### Running Migrations

```bash
npm run db:migrate
```

### Database Schema

The schema includes:
- User accounts and profiles
- Task management (state machine)
- Escrow and payment ledgers
- XP and gamification
- Verification submissions
- Job queues (BullMQ)
- Append-only audit logs

All financial operations are protected by database triggers that enforce invariants (no negative balances, double-spending prevention, etc.).

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run invariant tests (database integrity)
npm run test:invariants
```

## Scripts

```bash
# Development
npm run dev              # Start dev server with hot reload
npm run dev:workers      # Start background job workers
npm run build            # Build for production
npm start                # Start production server
npm run start:workers    # Start production workers

# Database
npm run db:check         # Check database connection
npm run db:migrate       # Run migrations

# Testing
npm test                 # Run all tests
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage
npm run test:invariants  # Run database invariant tests

# Health Check
npm run health           # Check server health
```

## Production Deployment

1. Set `NODE_ENV=production`
2. Configure all required environment variables
3. Run migrations: `npm run db:migrate`
4. Build: `npm run build`
5. Start server: `npm start`
6. Start workers: `npm run start:workers` (in separate process)

### Health Checks

The `/api/health` endpoint returns service status:
- Database connectivity
- Schema version
- Trigger count (17+ required)
- Service availability (Firebase, Redis, Stripe)

## Architecture

- **Layer 0**: PostgreSQL triggers enforce financial invariants
- **Layer 1**: Services handle business logic and state machines
- **Layer 2**: tRPC routers expose typed API endpoints
- **Layer 3**: AI services provide intelligent decision-making

All financial operations use a state machine pattern with escrow accounts to ensure atomic, append-only money movement.

## Support

For issues or questions, check the code or create an issue in the repository.
