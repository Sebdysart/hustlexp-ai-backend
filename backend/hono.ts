// backend/hono.ts
import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { cors } from "hono/cors";
import { appRouter } from "./trpc/app-router";
import { createContext } from "./trpc/create-context";
import { orchestrate } from "./ai/orchestrator";
import { composeTaskWithAI } from "./ai/compose";
import { authenticateRequest } from "./auth/middleware";
import { db } from "./database/client";
import { config } from "./config";

const app = new Hono();

const allowedOrigins = config.app.allowedOrigins.length
  ? config.app.allowedOrigins
  : ["*"];

// 🔥 CORS for Expo / Web / Mobile (tightened to configured origins when provided)
app.use("*", cors({
  origin: allowedOrigins.length === 1 && allowedOrigins[0] === "*" ? "*" : allowedOrigins,
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

// 🔥 tRPC mounted at correct URL
app.use(
  "/api/trpc/*",
  trpcServer({
    router: appRouter,
    createContext,
  })
);

// Health check
app.get("/", (c) => {
  return c.json({ status: "ok", message: "API is running" });
});

app.get("/api/health", async (c) => {
  const services = {
    database: false,
    redis: false,
    r2: false,
    firebase: false,
    google_ai: false,
    deepseek: false,
    stripe: false,
  };

  try {
    const result = await db.query("SELECT 1 as test");
    services.database = result.rows.length > 0;
  } catch (err) {
    console.error('[Health] Database check failed:', err);
  }

  services.redis = !!config.redis.url;
  services.r2 = !!config.cloudflare.r2.accessKeyId;
  services.firebase = !!config.firebase.projectId && !!config.firebase.privateKey;
  services.google_ai = !!config.ai.google.apiKey;
  services.deepseek = !!config.ai.deepseek.apiKey;
  services.stripe = !!config.stripe.secretKey;

  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    beta: {
      location: "Seattle",
      zipCodes: "98101-98199",
      categories: ["Cleaning", "Errands", "Delivery"],
    },
    services,
  });
});

// ------------------------------------------------------
// AUTH SIGNUP
// ------------------------------------------------------
app.post("/api/auth/signup", async (c) => {
  try {
    console.log('[Hono] Signup request received');

    const authUser = await authenticateRequest(c);
    if (!authUser) {
      console.error('[Hono] Authentication failed - no valid token');
      return c.json({ error: "Not authenticated" }, 401);
    }

    console.log('[Hono] Authenticated user:', authUser.uid, authUser.email);

    // Check existing user
    const existingUser = await db.query(
      "SELECT id, username FROM users WHERE firebase_uid = $1",
      [authUser.uid]
    );

    if (existingUser.rows.length > 0) {
      console.log('[Hono] User already exists:', existingUser.rows[0].id);
      return c.json({
        success: true,
        userId: existingUser.rows[0].id,
        user: existingUser.rows[0],
        message: "User already exists",
      });
    }

    const body = await c.req.json();
    const username =
      body.username || authUser.email?.split("@")[0] || `user_${Date.now()}`;

    const zip = body.zipCode || "00000";

    console.log('[Hono] Creating new user:', { username, email: authUser.email, zip });

    const created = await db.query(
      `INSERT INTO users (firebase_uid, username, email, zip_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, username, email`,
      [authUser.uid, username, authUser.email, zip]
    );

    console.log('[Hono] ✅ User created successfully:', created.rows[0].id);

    return c.json({
      success: true,
      user: created.rows[0],
      message: "Signup complete",
    });
  } catch (error) {
    console.error('[Hono] ❌ Signup error:', error);
    if (error instanceof Error) {
      console.error('[Hono] Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      });
    }
    return c.json({
      error: "Signup failed",
      details: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

// ------------------------------------------------------
// AI ORCHESTRATOR ENDPOINT
// ------------------------------------------------------
app.post("/api/ai/orchestrate", async (c) => {
  try {
    const authUser = await authenticateRequest(c);
    if (!authUser) {
      return c.json(
        { error: "Not authenticated", messages: [{ role: 'assistant', content: "Please sign in to continue." }] },
        401
      );
    }

    let userResult = await db.query(
      "SELECT id, username FROM users WHERE firebase_uid = $1",
      [authUser.uid]
    );

    if (userResult.rows.length === 0) {
      console.log('[Hono] User not found in DB, creating automatically');
      const username = authUser.email?.split('@')[0] || `user_${Date.now()}`;

      try {
        const created = await db.query(
          `INSERT INTO users (firebase_uid, username, email, zip_code, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           RETURNING id, username, email`,
          [authUser.uid, username, authUser.email, '00000']
        );

        userResult = created;
        console.log('[Hono] User created:', created.rows[0].id);
      } catch (dbError) {
        console.error('[Hono] Failed to create user:', dbError);
        return c.json({
          error: "Database error",
          messages: [{ role: 'assistant', content: "Sorry, I couldn't set up your account. Please try signing in again." }],
        }, 500);
      }
    }

    const dbUser = userResult.rows[0] as { id: number; username: string };
    const body = await c.req.json();

    const response = await orchestrate({
      ...body,
      userId: dbUser.id.toString(),
      firebaseUid: authUser.uid,
      username: dbUser.username,
    });

    return c.json(response);
  } catch (error) {
    console.error('[Hono] AI orchestrate error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      error: "AI request failed",
      messages: [{ role: 'assistant', content: `Sorry, something went wrong: ${errorMessage}` }]
    }, 500);
  }
});

// ------------------------------------------------------
// AI TASK COMPOSER ENDPOINT
// ------------------------------------------------------
app.post("/api/ai/compose", async (c) => {
  try {
    const authUser = await authenticateRequest(c);
    if (!authUser) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json();
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const result = await composeTaskWithAI({
      prompt,
      category: typeof body.category === 'string' ? body.category : undefined,
      budget: typeof body.budget === 'number' ? body.budget : undefined,
    });

    return c.json(result);
  } catch (error) {
    console.error('[Hono] AI compose error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: `Failed to compose task: ${message}` }, 500);
  }
});

// ------------------------------------------------------
// HEALTH CHECK (PUBLIC - No Auth Required)
// ------------------------------------------------------
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ------------------------------------------------------
// GAMIFICATION REST ENDPOINTS
// These provide AI-driven gamification features
// ------------------------------------------------------

// Growth Coach - Get User's Growth Plan
app.get("/api/coach/:userId/plan", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Coach plan requested for:', userId);

  // Generate dynamic plan based on time of day and user
  const hour = new Date().getHours();
  const isGoldenHour = hour >= 17 && hour <= 20;

  return c.json({
    level: {
      currentLevel: 3,
      currentXP: 275,
      xpToNextLevel: 300,
      progressPercent: 91,
    },
    earnings: {
      today: 45,
      thisWeek: 340,
      thisMonth: 1250,
      allTime: 3420,
      pendingPayout: 85,
    },
    projection: {
      daily: { min: 40, max: 120, likely: 75 },
      weekly: { min: 300, max: 600, likely: 425 },
      monthly: { min: 1200, max: 2400, likely: 1800 },
    },
    streak: {
      current: 7,
      longest: 12,
      nextMilestone: 14,
      nextMilestoneBonus: 200,
    },
    nextBestActions: [
      {
        id: "action-1",
        action: isGoldenHour ? "Accept a delivery task now" : "Check new tasks in Capitol Hill",
        reason: isGoldenHour ? "Peak demand with 1.5x earnings boost!" : "High demand in your area",
        priority: isGoldenHour ? "high" : "medium",
        xpGain: 100,
        earningsGain: 35,
      }
    ],
    suggestedTasks: [],
    coachingTip: isGoldenHour
      ? "🔥 It's Golden Hour! Earn 50% more on completed tasks right now."
      : "💡 Complete 2 more tasks today to maintain your streak!",
    profileStrength: 70,
    upcomingUnlocks: [
      {
        type: "badge",
        name: "Weekly Warrior",
        progress: 5,
        target: 7,
        progressPercent: 71,
      }
    ],
  });
});

// Growth Coach - Get Earnings
app.get("/api/coach/:userId/earnings", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Earnings requested for:', userId);

  return c.json({
    today: 45,
    thisWeek: 340,
    thisMonth: 1250,
    allTime: 3420,
    pendingPayout: 85,
    trend: "up",
    percentChange: 25,
  });
});

// Growth Coach - Get Next Best Action
app.get("/api/coach/:userId/next-action", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Next action requested for:', userId);

  const hour = new Date().getHours();
  const isGoldenHour = hour >= 17 && hour <= 20;

  return c.json({
    id: "action-1",
    action: isGoldenHour ? "Accept a delivery task now" : "Browse tasks in your area",
    reason: isGoldenHour ? "Peak demand with 1.5x earnings boost!" : "Several new tasks match your skills",
    priority: isGoldenHour ? "high" : "medium",
    xpGain: 100,
    earningsGain: 35,
  });
});

// Growth Coach - Get Optimal Tasks
app.get("/api/coach/:userId/optimal-tasks", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Optimal tasks requested for:', userId);

  return c.json([
    {
      taskId: "task-1",
      title: "Grocery Pickup from Whole Foods",
      price: 35,
      xp: 100,
      matchScore: 95,
      matchReason: "Perfect for your delivery skills",
    },
    {
      taskId: "task-2",
      title: "Dog Walking in Capitol Hill",
      price: 25,
      xp: 75,
      matchScore: 88,
      matchReason: "Close to your location",
    },
  ]);
});

// Growth Coach - Get Tip
app.get("/api/coach/:userId/tip", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Coach tip requested for:', userId);

  const tips = [
    "Complete 2 more tasks to hit your weekly goal!",
    "Capitol Hill has high demand right now 🔥",
    "You're on a 7-day streak! Don't break it.",
    "Add a profile photo to get 40% more matches",
  ];

  return c.json({ tip: tips[Math.floor(Math.random() * tips.length)] });
});

// Badges - Get User Badges
app.get("/api/badges/:userId", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Badges requested for:', userId);

  return c.json([
    { id: "badge-1", name: "Seattle Pioneer", icon: "🗺️", rarity: "rare", category: "location", unlocked: true, unlockedAt: new Date().toISOString() },
    { id: "badge-2", name: "First Hustle", icon: "⭐", rarity: "common", category: "special", unlocked: true },
    { id: "badge-3", name: "Streak Starter", icon: "🔥", rarity: "common", category: "consistency", unlocked: true },
  ]);
});

// Badges - Get Recent Badges
app.get("/api/badges/:userId/recent", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Recent badges requested for:', userId);

  return c.json([
    { id: "badge-3", name: "Streak Starter", icon: "🔥", rarity: "common", category: "consistency", unlocked: true },
  ]);
});

// Badges - Get Showcase Badges
app.get("/api/badges/:userId/showcase", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Badge showcase requested for:', userId);

  return c.json({
    badges: [
      { id: "badge-1", name: "Seattle Pioneer", icon: "🗺️", rarity: "rare" },
      { id: "badge-2", name: "First Hustle", icon: "⭐", rarity: "common" },
      { id: "badge-3", name: "Streak Starter", icon: "🔥", rarity: "common" },
    ],
    totalUnlocked: 3,
    totalAvailable: 37,
  });
});

// Badges - Evaluate (check for new badges)
app.post("/api/badges/:userId/evaluate", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Badge evaluation for:', userId);

  return c.json({ newBadges: [] });
});

// Quests - Get Daily Quests
app.get("/api/quests/:userId/daily", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Daily quests requested for:', userId);

  return c.json([
    { id: "quest-1", title: "First Task of the Day", description: "Complete any task", type: "daily", progress: 0, target: 1, xpReward: 25, completed: false, claimed: false },
    { id: "quest-2", title: "Earn $50", description: "Earn at least $50 today", type: "daily", progress: 45, target: 50, xpReward: 50, completed: false, claimed: false },
    { id: "quest-3", title: "Triple Threat", description: "Complete 3 tasks", type: "daily", progress: 1, target: 3, xpReward: 75, completed: false, claimed: false },
  ]);
});

// Quests - Get Weekly Quests
app.get("/api/quests/:userId/weekly", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Weekly quests requested for:', userId);

  return c.json([
    { id: "quest-w1", title: "Weekly Warrior", description: "Complete 15 tasks this week", type: "weekly", progress: 7, target: 15, xpReward: 200, completed: false, claimed: false },
    { id: "quest-w2", title: "Big Earner", description: "Earn $500 this week", type: "weekly", progress: 340, target: 500, xpReward: 350, completed: false, claimed: false },
  ]);
});

// Quests - Get All Quests
app.get("/api/quests/:userId/all", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] All quests requested for:', userId);

  const daily = [
    { id: "quest-1", title: "First Task of the Day", type: "daily", progress: 0, target: 1, xpReward: 25, completed: false },
  ];
  const weekly = [
    { id: "quest-w1", title: "Weekly Warrior", type: "weekly", progress: 7, target: 15, xpReward: 200, completed: false },
  ];

  return c.json({ daily, weekly, seasonal: [] });
});

// Quests - Claim Reward
app.post("/api/quests/:userId/:questId/claim", async (c) => {
  const userId = c.req.param("userId");
  const questId = c.req.param("questId");
  console.log('[Hono] Quest claim:', questId, 'for:', userId);

  return c.json({ xpAwarded: 50, success: true });
});

// Quests - Generate AI Quest
app.post("/api/quests/:userId/generate", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Generate AI quest for:', userId);

  return c.json({
    id: "ai-quest-1",
    title: "Personal Challenge",
    description: "Complete a task in a new category",
    type: "ai_generated",
    progress: 0,
    target: 1,
    xpReward: 150,
    completed: false,
  });
});

// Contextual Tips - Get Screen Tip
app.get("/api/tips/:userId/screen/:screen", async (c) => {
  const userId = c.req.param("userId");
  const screen = c.req.param("screen");
  console.log('[Hono] Screen tip for:', screen, 'user:', userId);

  const tips: Record<string, string> = {
    home: "🎯 Complete 2 more tasks to hit your daily goal!",
    feed: "💡 Filter by category to find tasks matching your skills",
    profile: "📸 Add a photo to get 40% more matches",
    earnings: "📈 You're up 25% this week. Keep it going!",
    task_detail: "👀 This task is 0.5mi away—perfect for a quick earn",
    accept_task: "⚡ Fast response time leads to more repeat clients",
  };

  return c.json({
    id: `tip-${screen}`,
    message: tips[screen] || "Keep hustling! Every task gets you closer to your goals.",
    type: "info",
    priority: 5,
  });
});

// Contextual Tips - Get Contextual Tip
app.get("/api/tips/:userId/contextual", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Contextual tip for:', userId);

  const hour = new Date().getHours();
  let tip = "Keep hustling! You're doing great.";
  let type = "info";

  if (hour < 9) {
    tip = "🌅 Early tasks pay best before 9 AM!";
    type = "opportunity";
  } else if (hour >= 17 && hour <= 20) {
    tip = "⚡ Peak demand right now! Tasks are paying 25% more.";
    type = "opportunity";
  } else if (hour >= 21) {
    tip = "🌙 Late-night errands often pay 20% more";
    type = "info";
  }

  return c.json({ id: "contextual-tip", message: tip, type, priority: 7 });
});

// Contextual Tips - Get Time Sensitive Tip
app.get("/api/tips/:userId/time-sensitive", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Time sensitive tip for:', userId);

  const hour = new Date().getHours();

  if (hour >= 17 && hour <= 20) {
    return c.json({
      id: "golden-hour",
      message: "🔥 Golden Hour is NOW! Earn 50% bonus XP on all tasks.",
      type: "opportunity",
      actionUrl: "/tasks",
      actionLabel: "View Tasks",
      priority: 10,
    });
  }

  return c.json({
    id: "time-tip",
    message: "Stay active to maintain your streak!",
    type: "info",
    priority: 3,
  });
});

// Contextual Tips - Get Streak Nudge
app.get("/api/tips/:userId/streak", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Streak nudge for:', userId);

  const hour = new Date().getHours();
  const hoursLeft = 24 - hour;

  if (hoursLeft < 6) {
    return c.json({
      id: "streak-warning",
      message: `⚠️ Only ${hoursLeft} hours left to maintain your 7-day streak!`,
      type: "warning",
      priority: 9,
      actionUrl: "/tasks",
    });
  }

  return c.json({
    id: "streak-info",
    message: "🔥 You're on a 7-day streak! Keep it going.",
    type: "success",
    priority: 5,
  });
});

// Profile Optimizer - Get Score
app.get("/api/profile/:userId/score", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Profile score for:', userId);

  return c.json({
    overall: 70,
    grade: "B",
    components: {
      photo: { score: 15, maxScore: 20 },
      bio: { score: 10, maxScore: 20 },
      skills: { score: 18, maxScore: 20 },
      availability: { score: 12, maxScore: 15 },
      verification: { score: 10, maxScore: 15 },
      reputation: { score: 5, maxScore: 10 },
    },
    matchRateIncrease: 25,
    earningsIncrease: 15,
  });
});

// Profile Optimizer - Get Suggestions
app.get("/api/profile/:userId/suggestions", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Profile suggestions for:', userId);

  return c.json([
    { id: "sug-1", category: "photo", suggestion: "Add a professional profile photo to increase matches by 40%", impact: "high", effort: "easy" },
    { id: "sug-2", category: "bio", suggestion: "Write a compelling bio highlighting your top skills", impact: "medium", effort: "easy" },
    { id: "sug-3", category: "verification", suggestion: "Verify your phone number for a trust badge", impact: "high", effort: "easy" },
  ]);
});

// AI Onboarding Endpoint
app.post("/api/onboarding/:userId/start", async (c) => {
  const userId = c.req.param("userId");
  console.log('[Hono] Onboarding start for:', userId);

  return c.json({
    step: 1,
    totalSteps: 5,
    greeting: "Welcome to HustleXP! 🎉 I'm your AI coach. Ready to start earning?",
    question: "What brings you to HustleXP?",
    options: ["Earn Money", "Get Help", "Both"],
  });
});

app.post("/api/onboarding/:userId/step", async (c) => {
  const userId = c.req.param("userId");
  const body = await c.req.json();
  console.log('[Hono] Onboarding step for:', userId, 'response:', body);

  return c.json({
    nextStep: (body.currentStep || 1) + 1,
    message: "Great choice! Let's set up your profile.",
    complete: body.currentStep >= 4,
    xpAwarded: body.currentStep >= 4 ? 175 : 0,
  });
});

// Social Cards - Generate
app.post("/api/cards/:userId/generate", async (c) => {
  const userId = c.req.param("userId");
  const body = await c.req.json();
  console.log('[Hono] Generate social card for:', userId, 'type:', body.cardType);

  return c.json({
    id: `card-${Date.now()}`,
    type: body.cardType || "task_completed",
    title: "Achievement Unlocked!",
    imageUrl: null,
    shareText: {
      twitter: "Just completed another task on @HustleXP! 🚀 #SeattleHustler",
      instagram: "Another day, another hustle! 💪",
      tiktok: "Making moves on HustleXP 🔥",
    },
  });
});

export default app;
