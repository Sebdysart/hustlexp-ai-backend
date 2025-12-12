import { z } from 'zod';
import { protectedProcedure } from '../../create-context';
import { db } from '../../../database/client';
import { ProactiveMatchingEngine } from '../../../ai/proactive-matcher';

const availabilityScheduleSchema = z.record(z.string(), z.boolean());

const proactivePreferencesInputSchema = z.object({
  enabled: z.boolean().optional(),
  preferredCategories: z.array(z.string()).optional(),
  minBudget: z.number().min(0).optional(),
  maxDistanceMiles: z.number().min(1).optional(),
  availabilitySchedule: availabilityScheduleSchema.optional(),
  notificationFrequency: z.enum(['real-time', 'hourly', 'daily', 'off']).optional(),
  quietHoursStart: z.string().optional(),
  quietHoursEnd: z.string().optional(),
  autoAcceptEnabled: z.boolean().optional(),
  autoAcceptMinScore: z.number().min(0).max(1).optional(),
  autoAcceptMaxPerDay: z.number().min(1).optional(),
  deviceTokens: z.array(z.string()).optional(),
});

export const proactiveGetPreferencesProcedure = protectedProcedure
  .input(z.object({ userId: z.string() }))
  .query(async ({ input }) => {
    console.log('[Proactive] Getting preferences for user:', input.userId);

    const result = await db.query(
      'SELECT * FROM proactive_preferences WHERE user_id = $1',
      [input.userId]
    );

    if (result.rows.length === 0) {
      return {
        userId: input.userId,
        enabled: false,
        preferredCategories: [],
        minBudget: 0,
        maxDistanceMiles: 10,
        availabilitySchedule: {},
        notificationFrequency: 'real-time' as const,
        quietHoursStart: null,
        quietHoursEnd: null,
        autoAcceptEnabled: false,
        autoAcceptMinScore: 0.8,
        autoAcceptMaxPerDay: 2,
        deviceTokens: [],
      };
    }

    const row = result.rows[0] as Record<string, unknown>;
    return {
      userId: input.userId,
      enabled: row.enabled as boolean,
      preferredCategories: (row.preferred_categories as string[]) ?? [],
      minBudget: parseFloat(String(row.min_budget ?? '0')),
      maxDistanceMiles: (row.max_distance_miles as number) ?? 10,
      availabilitySchedule: (row.availability_schedule as Record<string, boolean>) ?? {},
      notificationFrequency: (row.notification_frequency as 'real-time' | 'hourly' | 'daily' | 'off') ?? 'real-time',
      quietHoursStart: row.quiet_hours_start as string | null,
      quietHoursEnd: row.quiet_hours_end as string | null,
      autoAcceptEnabled: (row.auto_accept_enabled as boolean) ?? false,
      autoAcceptMinScore: parseFloat(String(row.auto_accept_min_score ?? '0.8')),
      autoAcceptMaxPerDay: (row.auto_accept_max_per_day as number) ?? 2,
      deviceTokens: (row.device_tokens as string[]) ?? [],
    };
  });

export const proactiveUpdatePreferencesProcedure = protectedProcedure
  .input(
    z.object({
      userId: z.string(),
      preferences: proactivePreferencesInputSchema,
    })
  )
  .mutation(async ({ input }) => {
    console.log('[Proactive] Updating preferences for user:', input.userId);

    const existingResult = await db.query(
      'SELECT * FROM proactive_preferences WHERE user_id = $1',
      [input.userId]
    );

    const updates: string[] = [];
    const values: unknown[] = [input.userId];
    let paramIndex = 2;

    if (input.preferences.enabled !== undefined) {
      updates.push(`enabled = $${paramIndex++}`);
      values.push(input.preferences.enabled);
    }
    if (input.preferences.preferredCategories !== undefined) {
      updates.push(`preferred_categories = $${paramIndex++}`);
      values.push(input.preferences.preferredCategories);
    }
    if (input.preferences.minBudget !== undefined) {
      updates.push(`min_budget = $${paramIndex++}`);
      values.push(input.preferences.minBudget);
    }
    if (input.preferences.maxDistanceMiles !== undefined) {
      updates.push(`max_distance_miles = $${paramIndex++}`);
      values.push(input.preferences.maxDistanceMiles);
    }
    if (input.preferences.availabilitySchedule !== undefined) {
      updates.push(`availability_schedule = $${paramIndex++}`);
      values.push(JSON.stringify(input.preferences.availabilitySchedule));
    }
    if (input.preferences.notificationFrequency !== undefined) {
      updates.push(`notification_frequency = $${paramIndex++}`);
      values.push(input.preferences.notificationFrequency);
    }
    if (input.preferences.quietHoursStart !== undefined) {
      updates.push(`quiet_hours_start = $${paramIndex++}`);
      values.push(input.preferences.quietHoursStart);
    }
    if (input.preferences.quietHoursEnd !== undefined) {
      updates.push(`quiet_hours_end = $${paramIndex++}`);
      values.push(input.preferences.quietHoursEnd);
    }
    if (input.preferences.autoAcceptEnabled !== undefined) {
      updates.push(`auto_accept_enabled = $${paramIndex++}`);
      values.push(input.preferences.autoAcceptEnabled);
    }
    if (input.preferences.autoAcceptMinScore !== undefined) {
      updates.push(`auto_accept_min_score = $${paramIndex++}`);
      values.push(input.preferences.autoAcceptMinScore);
    }
    if (input.preferences.autoAcceptMaxPerDay !== undefined) {
      updates.push(`auto_accept_max_per_day = $${paramIndex++}`);
      values.push(input.preferences.autoAcceptMaxPerDay);
    }
    if (input.preferences.deviceTokens !== undefined) {
      updates.push(`device_tokens = $${paramIndex++}`);
      values.push(input.preferences.deviceTokens);
    }

    if (existingResult.rows.length === 0) {
      await db.query(
        `INSERT INTO proactive_preferences (
          user_id, enabled, preferred_categories, min_budget, 
          max_distance_miles, availability_schedule, notification_frequency,
          quiet_hours_start, quiet_hours_end, auto_accept_enabled,
          auto_accept_min_score, auto_accept_max_per_day, device_tokens
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )`,
        [
          input.userId,
          input.preferences.enabled ?? false,
          input.preferences.preferredCategories ?? [],
          input.preferences.minBudget ?? 0,
          input.preferences.maxDistanceMiles ?? 10,
          JSON.stringify(input.preferences.availabilitySchedule ?? {}),
          input.preferences.notificationFrequency ?? 'real-time',
          input.preferences.quietHoursStart ?? null,
          input.preferences.quietHoursEnd ?? null,
          input.preferences.autoAcceptEnabled ?? false,
          input.preferences.autoAcceptMinScore ?? 0.8,
          input.preferences.autoAcceptMaxPerDay ?? 2,
          input.preferences.deviceTokens ?? [],
        ]
      );
    } else if (updates.length > 0) {
      await db.query(
        `UPDATE proactive_preferences SET ${updates.join(', ')} WHERE user_id = $1`,
        values
      );
    }

    return { success: true };
  });

export const proactiveGetRecommendationsProcedure = protectedProcedure
  .input(
    z.object({
      userId: z.string(),
      limit: z.number().min(1).max(50).optional(),
    })
  )
  .query(async ({ input }) => {
    console.log('[Proactive] Getting recommendations for user:', input.userId);

    const recommendations = await ProactiveMatchingEngine.getRecommendationsForUser(
      input.userId,
      input.limit ?? 10
    );

    return {
      recommendations: recommendations.map((rec) => ({
        taskId: rec.taskId,
        score: rec.score,
        reasons: rec.reasons,
        task: {
          id: rec.task.id,
          title: rec.task.title,
          description: rec.task.description,
          category: rec.task.category,
          price: rec.task.price,
          city: rec.task.city,
          difficulty: rec.task.difficulty,
          deadline: rec.task.deadline?.toISOString(),
        },
      })),
    };
  });

export const proactiveScanProcedure = protectedProcedure
  .input(z.object({ userId: z.string() }))
  .mutation(async ({ input }) => {
    console.log('[Proactive] Manual scan triggered by user:', input.userId);

    await ProactiveMatchingEngine.scanAndNotifyUsers();

    return { success: true, message: 'Scan completed successfully' };
  });

export const proactiveRegisterDeviceProcedure = protectedProcedure
  .input(
    z.object({
      userId: z.string(),
      deviceToken: z.string(),
    })
  )
  .mutation(async ({ input }) => {
    console.log('[Proactive] Registering device token for user:', input.userId);

    const existingResult = await db.query(
      'SELECT device_tokens FROM proactive_preferences WHERE user_id = $1',
      [input.userId]
    );

    if (existingResult.rows.length === 0) {
      await db.query(
        'INSERT INTO proactive_preferences (user_id, device_tokens) VALUES ($1, $2)',
        [input.userId, [input.deviceToken]]
      );
    } else {
      const row = existingResult.rows[0] as Record<string, unknown>;
      const existingTokens = (row.device_tokens as string[]) ?? [];

      if (!existingTokens.includes(input.deviceToken)) {
        const updatedTokens = [...existingTokens, input.deviceToken];
        await db.query(
          'UPDATE proactive_preferences SET device_tokens = $1 WHERE user_id = $2',
          [updatedTokens, input.userId]
        );
      }
    }

    return { success: true };
  });
