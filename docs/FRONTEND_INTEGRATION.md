# HustleXP Frontend-Backend Integration Guide

Complete API documentation for connecting the Rork frontend to the HustleXP Railway backend.

## Backend URL

```
https://hustlexp-ai-backend-production.up.railway.app
```

## Health Check

```bash
GET /health
→ {"status":"ok","timestamp":"2025-12-08T..."}
```

---

## 1. User Onboarding Flow

### Start Onboarding
```javascript
POST /api/onboarding/{userId}/start
Body: { "referralCode": "OPTIONAL" }

Response: {
  "sessionId": "uuid",
  "greeting": "I'm your HustleAI...",
  "yourReferralCode": "HUSTLEXXXXXX",
  "nextAction": "choose_role",
  "xpAwarded": 10,
  "badges": ["first_step"]
}
```

### Choose Role
```javascript
POST /api/onboarding/{userId}/role
Body: { "sessionId": "uuid", "role": "hustler" | "client" }

Response: {
  "nextAction": "answer_questions",
  "questions": [...]
}
```

### Answer Questions
```javascript
POST /api/onboarding/{userId}/answer
Body: {
  "sessionId": "uuid",
  "questionKey": "skills",
  "answer": "delivery, moving"
}

Response: {
  "nextAction": "next_question" | "complete",
  "xpAwarded": 5
}
```

### Check Status
```javascript
GET /api/onboarding/{userId}/status

// For new users (never started onboarding):
Response: {
  "userId": "...",
  "onboardingComplete": false,
  "message": "Start your journey with HustleXP!"
}

// For users in progress:
Response: {
  "userId": "...",
  "onboardingComplete": false,
  "currentStep": 2,
  "totalSteps": 5,
  "role": "hustler",
  "message": "Continue your onboarding to unlock all features!"
}

// For completed users:
Response: {
  "userId": "...",
  "onboardingComplete": true,
  "message": "Welcome to HustleXP!"
}
```

---

## 2. AI Growth Coach

### Get Growth Plan
```javascript
GET /api/coach/{userId}/plan

Response: {
  "level": {
    "currentLevel": 1,
    "currentXP": 0,
    "xpToNextLevel": 100,
    "levelProgress": 0
  },
  "streak": {
    "current": 0,
    "longest": 0,
    "daysToNextMilestone": 3
  },
  "projection": {
    "weekly": { "min": 0, "max": 0, "likely": 0 }
  }
}
```

### Get Next Best Action
```javascript
GET /api/coach/{userId}/next-action

Response: {
  "action": "complete_first_task",
  "description": "Complete your first task to start earning",
  "xpReward": 50,
  "priority": "high"
}
```

### Get Personalized Tip
```javascript
GET /api/coach/{userId}/tip

Response: {
  "tip": "🎯 Build a 3-day streak to earn bonus XP",
  "category": "motivation"
}
```

---

## 3. Contextual Tips (Screen-Specific)

### Get Tips for Current Screen
```javascript
GET /api/tips/{userId}/contextual?screen=home

// Valid screens: home, tasks, profile, earnings, quests, badges, 
//                task_detail, onboarding, settings, notifications, wallet, help
```

### Get Screen-Specific Tip
```javascript
GET /api/tips/{userId}/screen/{screenName}

Response: {
  "tip": {
    "id": "home_morning",
    "category": "opportunity",
    "priority": "low",
    "icon": "☀️",
    "title": "Good Morning!",
    "message": "Early birds catch the best tasks.",
    "actionText": "Browse Tasks",
    "dismissible": true
  }
}
```

---

## 4. Badges System

### Get All Badges
```javascript
GET /api/badges/{userId}

Response: {
  "badges": [
    {
      "badge": {
        "id": "first_task",
        "name": "First Hustle",
        "icon": "🎯",
        "rarity": "common",
        "xpReward": 25
      },
      "currentProgress": 0,
      "maxProgress": 1,
      "isUnlocked": false
    }
  ],
  "stats": { "total": 0, "byRarity": {...} },
  "totalAvailable": 37
}
```

### Get Recent Badges
```javascript
GET /api/badges/{userId}/recent

Response: {
  "badges": [...],
  "count": 5
}
```

### Get Showcase Badges
```javascript
GET /api/badges/{userId}/showcase

Response: {
  "showcase": [...],  // Top 3 badges for display
  "totalUnlocked": 0
}
```

---

## 5. Quest System

### Get Daily Quests
```javascript
GET /api/quests/{userId}/daily

Response: {
  "quests": [
    {
      "id": "daily_first_task",
      "title": "Complete 1 Task",
      "progress": 0,
      "target": 1,
      "xpReward": 25,
      "expiresAt": "..."
    }
  ]
}
```

### Get Weekly Quests
```javascript
GET /api/quests/{userId}/weekly

Response: {
  "quests": [...]
}
```

### Claim Quest Reward
```javascript
POST /api/quests/{userId}/claim
Body: { "questId": "daily_first_task" }

Response: {
  "claimed": true,
  "xpAwarded": 25
}
```

---

## 6. Tasks API

### List Available Tasks
```javascript
GET /api/tasks

Response: {
  "tasks": [
    {
      "id": "uuid",
      "title": "Grocery delivery from Whole Foods",
      "category": "delivery",
      "minPrice": 28,
      "recommendedPrice": 35,
      "locationText": "Capitol Hill, Seattle",
      "status": "open"
    }
  ],
  "count": 2
}
```

### Get Task Eligibility
```javascript
GET /api/tasks/{taskId}/eligibility

Response: {
  "eligible": true,
  "reasons": []
}
```

### Complete Task
```javascript
POST /api/tasks/{taskId}/complete
Body: {
  "hustlerId": "user-uuid",
  "rating": 5,
  "tip": 5.00
}

Response: {
  "xpAwarded": 50,
  "newBadges": [...],
  "streakUpdated": true
}
```

---

## 7. Pricing API

### Calculate Pricing
```javascript
GET /api/pricing/calculate/{price}

Response: {
  "basePrice": 35,
  "platformFee": 4.03,
  "hustlerPayout": 28.72,
  "takeRate": 11.5
}
```

### Get Earnings Estimate
```javascript
GET /api/pricing/earnings/{price}

Response: {
  "hustlerPayout": 28.72,
  "bonuses": { "streak": 0, "rush": 0 }
}
```

---

## 8. AI Orchestrator (Chat)

### Send Message to AI
```javascript
POST /ai/orchestrate
Body: {
  "userId": "user-uuid",
  "message": "I want to find work"
}

Response: {
  "reply": "Great! Let me help you find tasks...",
  "actions": [...],
  "suggestions": [...]
}
```

---

## Common Issues & Fixes

### 1. "Connection Test Failed" / JSON Parse Error
**Cause**: Frontend might be calling wrong endpoint or expecting different response format.
**Fix**: Use exact endpoints above. All responses are JSON.

### 2. 404 Errors
**Cause**: Endpoint path does not match.
**Fix**: Double-check paths - note `/api/` vs `/ai/` prefixes.

### 3. Empty User Data
**Cause**: User hasn't completed any actions yet.
**Fix**: This is expected for new users. Show default/empty state UI.

---

## Frontend Code Example

```typescript
// lib/railway-api.ts

const API_URL = 'https://hustlexp-ai-backend-production.up.railway.app';

export const railwayApi = {
  // Health check
  async checkHealth() {
    const res = await fetch(`${API_URL}/health`);
    return res.json();
  },

  // Get growth plan
  async getGrowthPlan(userId: string) {
    const res = await fetch(`${API_URL}/api/coach/${userId}/plan`);
    return res.json();
  },

  // Get contextual tip for screen
  async getTipForScreen(userId: string, screen: string) {
    const res = await fetch(`${API_URL}/api/tips/${userId}/screen/${screen}`);
    return res.json();
  },

  // Get badges
  async getBadges(userId: string) {
    const res = await fetch(`${API_URL}/api/badges/${userId}`);
    return res.json();
  },

  // Get quests
  async getDailyQuests(userId: string) {
    const res = await fetch(`${API_URL}/api/quests/${userId}/daily`);
    return res.json();
  },

  // Get tasks
  async getTasks() {
    const res = await fetch(`${API_URL}/api/tasks`);
    return res.json();
  },

  // Start onboarding
  async startOnboarding(userId: string) {
    const res = await fetch(`${API_URL}/api/onboarding/${userId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    return res.json();
  }
};
```

---

## User Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     APP START                                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Check /health → Verify backend online                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  2. GET /api/onboarding/{userId}/status                     │
│     → If not complete, start onboarding flow                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  3. HOME SCREEN: Load in parallel:                          │
│     - GET /api/coach/{userId}/plan       → Level/XP/Streak  │
│     - GET /api/tips/{userId}/screen/home → Contextual tip   │
│     - GET /api/badges/{userId}/showcase  → Top badges       │
│     - GET /api/quests/{userId}/daily     → Active quests    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  4. TASKS SCREEN:                                           │
│     - GET /api/tasks                     → Available tasks  │
│     - GET /api/tips/{userId}/screen/tasks → Task tips       │
└─────────────────────────────────────────────────────────────┘
```

---

## Error Handling

All errors return:
```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

Common error codes:
- `MISSING_TOKEN` - Auth required (shouldn't happen for public endpoints)
- `NOT_FOUND` - Resource doesn't exist
- `VALIDATION_ERROR` - Invalid request body

---

## Testing Endpoints

You can test any endpoint with curl:

```bash
# Health
curl https://hustlexp-ai-backend-production.up.railway.app/health

# Get badges for demo user
curl https://hustlexp-ai-backend-production.up.railway.app/api/badges/demo-user

# Get growth plan
curl https://hustlexp-ai-backend-production.up.railway.app/api/coach/demo-user/plan

# Get tips for home screen
curl https://hustlexp-ai-backend-production.up.railway.app/api/tips/demo-user/screen/home

# Start onboarding
curl -X POST https://hustlexp-ai-backend-production.up.railway.app/api/onboarding/demo-user/start
```

All endpoints work immediately - no authentication required for demo/initial load.
