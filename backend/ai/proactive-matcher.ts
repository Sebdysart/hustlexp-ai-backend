import { db } from '../database/client';

export interface ProactivePreferences {
  userId: string;
  enabled: boolean;
  preferredCategories: string[];
  minBudget: number;
  maxDistanceMiles: number;
  availabilitySchedule: Record<string, boolean>;
  notificationFrequency: 'real-time' | 'hourly' | 'daily' | 'off';
  quietHoursStart?: string;
  quietHoursEnd?: string;
  autoAcceptEnabled: boolean;
  autoAcceptMinScore: number;
  autoAcceptMaxPerDay: number;
  deviceTokens: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  category: string;
  price: number;
  city: string;
  latitude?: number;
  longitude?: number;
  deadline?: Date;
  difficulty?: string;
  createdAt: Date;
}

export interface TaskScore {
  taskId: string;
  userId: string;
  score: number;
  reasons: string[];
  task: Task;
}

export interface NotificationPayload {
  userId: string;
  taskId: string;
  title: string;
  body: string;
  priority: 'high' | 'medium' | 'low';
  data: Record<string, unknown>;
}

export class ProactiveMatchingEngine {
  private static calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 3959;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private static isInQuietHours(
    quietHoursStart?: string,
    quietHoursEnd?: string
  ): boolean {
    if (!quietHoursStart || !quietHoursEnd) return false;

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    const [startHour, startMin] = quietHoursStart.split(':').map(Number);
    const [endHour, endMin] = quietHoursEnd.split(':').map(Number);

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    if (startMinutes <= endMinutes) {
      return currentTime >= startMinutes && currentTime <= endMinutes;
    } else {
      return currentTime >= startMinutes || currentTime <= endMinutes;
    }
  }

  public static async scoreTaskForUser(
    task: Task,
    preferences: ProactivePreferences,
    userHistory?: { acceptedCategories: Record<string, number> }
  ): Promise<TaskScore> {
    let score = 0;
    const reasons: string[] = [];
    const weights = {
      category: 0.3,
      budget: 0.25,
      availability: 0.2,
      history: 0.15,
      urgency: 0.1,
    };

    const categoryMatch = preferences.preferredCategories.includes(
      task.category
    );
    if (categoryMatch) {
      score += weights.category;
      reasons.push(`Matches preferred category: ${task.category}`);
    }

    if (task.price >= preferences.minBudget) {
      const budgetScore = Math.min(
        (task.price / (preferences.minBudget * 2)) * weights.budget,
        weights.budget
      );
      score += budgetScore;
      reasons.push(`Good pay: $${task.price}`);
    }

    const now = new Date();
    const dayOfWeek = now
      .toLocaleDateString('en-US', { weekday: 'long' })
      .toLowerCase();
    if (preferences.availabilitySchedule[dayOfWeek]) {
      score += weights.availability;
      reasons.push('Matches your availability today');
    }

    if (userHistory?.acceptedCategories[task.category]) {
      const historyScore =
        Math.min(userHistory.acceptedCategories[task.category] / 10, 1) *
        weights.history;
      score += historyScore;
      reasons.push(
        `You've completed ${userHistory.acceptedCategories[task.category]} ${task.category} tasks before`
      );
    }

    if (task.deadline) {
      const hoursUntilDeadline =
        (task.deadline.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntilDeadline < 24) {
        score += weights.urgency;
        reasons.push('Urgent task (deadline within 24 hours)');
      }
    }

    return {
      taskId: task.id,
      userId: preferences.userId,
      score: Math.min(score, 1.0),
      reasons,
      task,
    };
  }

  public static async getRecommendationsForUser(
    userId: string,
    limit: number = 10
  ): Promise<TaskScore[]> {
    console.log(
      `[ProactiveMatcher] Getting recommendations for user: ${userId}`
    );

    const prefsResult = await db.query(
      'SELECT * FROM proactive_preferences WHERE user_id = $1',
      [userId]
    );

    if (prefsResult.rows.length === 0) {
      console.log(`[ProactiveMatcher] No preferences found for user ${userId}`);
      return [];
    }

    const prefs = prefsResult.rows[0] as Record<string, unknown>;
    const preferences: ProactivePreferences = {
      userId,
      enabled: (prefs.enabled as boolean) ?? false,
      preferredCategories: (prefs.preferred_categories as string[]) ?? [],
      minBudget: parseFloat(String(prefs.min_budget ?? '0')),
      maxDistanceMiles: (prefs.max_distance_miles as number) ?? 10,
      availabilitySchedule: (prefs.availability_schedule as Record<string, boolean>) ?? {},
      notificationFrequency: (prefs.notification_frequency as 'real-time' | 'hourly' | 'daily' | 'off') ?? 'real-time',
      quietHoursStart: prefs.quiet_hours_start as string | undefined,
      quietHoursEnd: prefs.quiet_hours_end as string | undefined,
      autoAcceptEnabled: (prefs.auto_accept_enabled as boolean) ?? false,
      autoAcceptMinScore: parseFloat(String(prefs.auto_accept_min_score ?? '0.8')),
      autoAcceptMaxPerDay: (prefs.auto_accept_max_per_day as number) ?? 2,
      deviceTokens: (prefs.device_tokens as string[]) ?? [],
    };

    if (!preferences.enabled) {
      console.log(`[ProactiveMatcher] Proactive matching disabled for user ${userId}`);
      return [];
    }

    const tasksResult = await db.query(
      "SELECT * FROM tasks WHERE status = 'active' AND created_by != $1 ORDER BY created_at DESC LIMIT 50",
      [userId]
    );

    const userHistoryResult = await db.query(
      `SELECT category, COUNT(*) as count 
       FROM task_assignments ta 
       JOIN tasks t ON ta.task_id = t.id 
       WHERE ta.user_id = $1 AND ta.status IN ('completed', 'approved')
       GROUP BY category`,
      [userId]
    );

    const acceptedCategories: Record<string, number> = {};
    for (const row of userHistoryResult.rows) {
      const r = row as Record<string, unknown>;
      acceptedCategories[r.category as string] = parseInt(String(r.count));
    }

    const scoredTasks: TaskScore[] = [];
    for (const taskRow of tasksResult.rows) {
      const t = taskRow as Record<string, unknown>;
      const task: Task = {
        id: t.id as string,
        title: t.title as string,
        description: t.description as string,
        category: t.category as string,
        price: parseFloat(String(t.price ?? '0')),
        city: t.city as string,
        latitude: t.latitude ? parseFloat(String(t.latitude)) : undefined,
        longitude: t.longitude
          ? parseFloat(String(t.longitude))
          : undefined,
        deadline: t.deadline as Date | undefined,
        difficulty: t.difficulty as string | undefined,
        createdAt: t.created_at as Date,
      };

      const scored = await this.scoreTaskForUser(task, preferences, {
        acceptedCategories,
      });
      scoredTasks.push(scored);
    }

    scoredTasks.sort((a, b) => b.score - a.score);

    return scoredTasks.slice(0, limit);
  }

  public static async scanAndNotifyUsers(): Promise<void> {
    console.log('[ProactiveMatcher] Starting user scan...');

    const activeUsersResult = await db.query(
      'SELECT user_id FROM proactive_preferences WHERE enabled = true'
    );

    console.log(
      `[ProactiveMatcher] Found ${activeUsersResult.rows.length} active users`
    );

    for (const row of activeUsersResult.rows) {
      const r = row as Record<string, unknown>;
      const userId = r.user_id as string;
      await this.processUserNotifications(userId);
    }

    console.log('[ProactiveMatcher] Scan complete');
  }

  private static async processUserNotifications(userId: string): Promise<void> {
    console.log(`[ProactiveMatcher] Processing notifications for user ${userId}`);

    const prefsResult = await db.query(
      'SELECT * FROM proactive_preferences WHERE user_id = $1',
      [userId]
    );

    if (prefsResult.rows.length === 0) return;

    const prefs = prefsResult.rows[0] as Record<string, unknown>;

    if (
      this.isInQuietHours(
        prefs.quiet_hours_start as string | undefined,
        prefs.quiet_hours_end as string | undefined
      )
    ) {
      console.log(`[ProactiveMatcher] User ${userId} is in quiet hours, skipping`);
      return;
    }

    const recommendations = await this.getRecommendationsForUser(userId, 5);

    const highQualityMatches = recommendations.filter(
      (rec) => rec.score >= 0.7
    );

    if (highQualityMatches.length === 0) {
      console.log(
        `[ProactiveMatcher] No high-quality matches for user ${userId}`
      );
      return;
    }

    const bestMatch = highQualityMatches[0];

    if (
      (prefs.auto_accept_enabled as boolean) &&
      bestMatch.score >= parseFloat(String(prefs.auto_accept_min_score ?? '0.8'))
    ) {
      const todayAcceptedResult = await db.query(
        `SELECT COUNT(*) as count FROM task_assignments 
         WHERE user_id = $1 AND created_at::date = CURRENT_DATE`,
        [userId]
      );

      const countRow = todayAcceptedResult.rows[0] as Record<string, unknown> | undefined;
      const todayAccepted = parseInt(String(countRow?.count ?? '0'));

      if (todayAccepted < (prefs.auto_accept_max_per_day as number)) {
        await this.autoAcceptTask(userId, bestMatch.taskId);
        console.log(
          `[ProactiveMatcher] Auto-accepted task ${bestMatch.taskId} for user ${userId}`
        );
      } else {
        console.log(
          `[ProactiveMatcher] Auto-accept limit reached for user ${userId}`
        );
      }
    } else {
      await this.sendNotification({
        userId,
        taskId: bestMatch.taskId,
        title: '🎯 Perfect match for you!',
        body: `${bestMatch.task.title} - $${bestMatch.task.price}`,
        priority: bestMatch.score > 0.9 ? 'high' : 'medium',
        data: {
          taskId: bestMatch.taskId,
          score: bestMatch.score,
          reasons: bestMatch.reasons,
        },
      });
    }
  }

  private static async autoAcceptTask(
    userId: string,
    taskId: string
  ): Promise<void> {
    console.log(`[ProactiveMatcher] Auto-accepting task ${taskId} for user ${userId}`);

    await db.query(
      "UPDATE tasks SET status = 'assigned', assigned_to = $1 WHERE id = $2",
      [userId, taskId]
    );

    await db.query(
      "INSERT INTO task_assignments (task_id, user_id, status) VALUES ($1, $2, 'accepted')",
      [taskId, userId]
    );
  }

  private static async sendNotification(
    payload: NotificationPayload
  ): Promise<void> {
    console.log(`[ProactiveMatcher] Sending notification to user ${payload.userId}:`, {
      title: payload.title,
      body: payload.body,
      priority: payload.priority,
    });
  }
}
