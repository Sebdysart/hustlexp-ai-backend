# HustleXP Trust Signals (Beta)

Read-only, task-derived trust signals for public profiles. No social graph, no client-side mutation paths.

## Data & SQL
- Source of truth: `users`, `hustler_profiles`, `completions`, `identity_verification`.
- New index: `CREATE INDEX IF NOT EXISTS idx_completions_client ON completions(client_id);`
- All queries parameterized via Neon; requests fail with 5xx when the database is unavailable.

## Endpoints
Base prefix: `/api/trust`

| Route | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/profile/:userId` | GET | Public | Public profile with derived stats only; never returns email or payment data. |
| `/profile/:userId/history` | GET | Public | Paginated completed task history (DESC). Query: `limit?`, `offset?`. |
| `/mutual/:userId` | GET | Auth required | Mutual task connections between viewer (token) and `userId`. |
| `/profile/:userId/summary` | GET | Optional Auth | Aggregated trust view; `mutual_task_connections` is `null` when unauthenticated. |

## Response Shapes (examples)

**GET `/profile/:userId`**
```json
{
  "user_id": "8f1c...e12",
  "name": "Alex Doe",
  "handle": "alex-doe-8f1c0e",
  "city": "Seattle",
  "xp": 2450,
  "level": 6,
  "tasks_completed": 18,
  "categories_worked_in": ["moving", "errands", "cleaning"],
  "avg_rating": 4.8,
  "last_active_at": "2024-09-18T03:12:11.000Z",
  "verification": { "email": true, "phone": false }
}
```

**GET `/profile/:userId/history?limit=5&offset=0`**
```json
{
  "user_id": "8f1c...e12",
  "total": 18,
  "limit": 5,
  "offset": 0,
  "has_more": true,
  "tasks": [
    { "task_id": "t1", "category": "moving", "price": 120.0, "completed_at": "2024-09-18T03:12:11.000Z", "role": "worker", "approved_by_poster": true }
  ]
}
```

**GET `/mutual/:userId`** (auth)
```json
{
  "user_id": "target-id",
  "viewer_id": "viewer-id",
  "mutual_task_connections": 3,
  "explanation": "You and this user have both worked with 3 of the same people"
}
```

**GET `/profile/:userId/summary`**
```json
{
  "profile": { "...public profile fields..." },
  "task_stats": {
    "completed_total": 18,
    "completed_as_worker": 14,
    "completed_as_poster": 4,
    "avg_rating": 4.8,
    "last_active_at": "2024-09-18T03:12:11.000Z"
  },
  "mutual_task_connections": 3,
  "trust_score": {
    "score": 155,
    "cap": 500,
    "breakdown": { "task_points": 90, "five_star_points": 50, "mutual_points": 15 }
  }
}
```

## Trust Score (deterministic)
- `+5` per completed task (any role).
- `+10` per 5-star rating.
- `+5` per mutual task connection with the viewer.
- Capped at `500` to prevent runaway values.

## Safety Notes
- All signals are derived from completed tasks only; no social actions or self-reporting.
- Mutual connections computed at request time via SQL joins (no new tables or cache).
- If Neon/Postgres is unavailable, endpoints return `503 Trust data unavailable` instead of falling back to in-memory data.
