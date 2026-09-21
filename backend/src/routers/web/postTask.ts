import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../../trpc.js';
import { classifyTask } from '../../services/taskClassification/classifyTask.js';
import { extractIntakePrefill } from '../../services/taskIntake/extractPrefill.js';
import { buildTaskFacts } from '../../services/taskIntake/buildTaskFacts.js';
import { resolveIntakeProfile } from '../../services/taskIntake/resolveIntakeProfile.js';
import {
  CanonicalTaskDraftInputSchema,
  createCanonicalTaskDraft,
} from '../../services/CanonicalTaskDraftService.js';

const ClassifyIntakeSchema = z.object({
  raw: z.string().trim().min(3).max(2000),
});

export const webPostTaskRouter = router({
  classifyIntake: publicProcedure
    .input(ClassifyIntakeSchema)
    .mutation(async ({ input }) => {
      const result = await classifyTask(input.raw);
      const profileResolution = result.category
        ? resolveIntakeProfile({ category: result.category, raw: input.raw, facts: buildTaskFacts(input.raw) })
        : null;
      const routedCategory = profileResolution?.category ?? result.category;
      const routedSecondaryIntents = result.secondaryIntents.filter(
        (intent) => intent !== routedCategory,
      );
      const prefill = routedCategory
        ? extractIntakePrefill(
            input.raw,
            routedCategory,
            routedSecondaryIntents,
            profileResolution?.profile ?? null,
          )
        : { answers: {}, evidence: [] };
      return {
        category: routedCategory,
        primaryCategory: routedCategory,
        classifierCategory: result.category,
        secondaryIntents: routedSecondaryIntents,
        intakeProfile: profileResolution?.profile ?? null,
        needsProfileClarification: profileResolution?.needsProfileClarification ?? false,
        profileEvidence: profileResolution?.evidence ?? [],
        needsClarification: result.needsClarification,
        margin: result.margin,
        threshold: result.threshold,
        source: result.source,
        overrideReason: result.overrideReason ?? null,
        candidates: result.candidates.slice(0, 3).map((candidate) => ({
          category: candidate.category,
          score: candidate.score,
        })),
        prefilledAnswers: prefill.answers,
        prefillEvidence: prefill.evidence,
      };
    }),
  start: protectedProcedure
    .input(CanonicalTaskDraftInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await createCanonicalTaskDraft({
          input,
          posterUserId: ctx.user.id,
          actorUserId: ctx.user.id,
        });
        return { ok: true, ...result };
      } catch (error) {
        console.error('[webPostTask.start] DB/transaction failure:', error);
        throw error;
      }
    }),
});

export type WebPostTaskRouter = typeof webPostTaskRouter;
