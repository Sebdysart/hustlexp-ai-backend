/**
 * Instant Task Completeness Gate v1.0.0
 * 
 * AI gatekeeper that prevents ambiguous tasks from entering Instant Execution Mode.
 * 
 * Principle: Instant execution requires deterministic instructions.
 * If a human could reasonably ask a clarifying question, the task is not Instant-eligible.
 * 
 * @see IEM_AI_GATE_SPEC.md
 */

import { db } from '../db';
import { AIClient } from './AIClient';
import { logger } from '../logger';

const log = logger.child({ service: 'InstantTaskGate' });

// ============================================================================
// TYPES
// ============================================================================

export interface InstantGateResult {
  instantEligible: boolean;
  blockReason?: string;
  questions: string[];
}

interface TaskDraft {
  title: string;
  description: string;
  location?: string;
  requirements?: string;
  deadline?: Date;
  category?: string;
}

// ============================================================================
// AI GATE SERVICE
// ============================================================================

/**
 * Check if task is eligible for Instant Execution Mode
 * 
 * Returns structured result indicating eligibility and blocking reason.
 * 
 * Principle: A task is Instant-eligible UNLESS a missing detail would
 * force a hustler to ask a question before starting.
 */
export async function checkInstantEligibility(
  task: TaskDraft
): Promise<InstantGateResult> {
  const questions: string[] = [];
  let blockReason: string | undefined;
  
  // Initialize early for use in checks
  const locationLower = (task.location || '').toLowerCase();
  const descriptionLower = (task.description || '').toLowerCase();
  
  // ============================================================================
  // HARD BLOCKERS (Execution-stopping - must block Instant)
  // ============================================================================
  
  // 1. No actionable location (HARD BLOCKER)
  // Location is required - no exceptions for Instant Mode
  if (!task.location || task.location.trim().length === 0) {
    blockReason = 'missing_location';
    questions.push('Where exactly should this task be completed?');
    return {
      instantEligible: false,
      blockReason,
      questions,
    };
  }
  
  // Check if location is actionable (not vague)
  const vagueLocationPatterns = [
    'somewhere', 'near', 'around', 'in the area', 'downtown', 'campus',
    'nearby', 'close to', 'around here'
  ];
  const isVagueLocation = vagueLocationPatterns.some(pattern => 
    locationLower.includes(pattern) && locationLower.length < 30
  );
  
  // Also check description for vague location references
  const hasVagueLocationInDesc = vagueLocationPatterns.some(pattern => 
    descriptionLower.includes(pattern) && descriptionLower.includes('around') && descriptionLower.length < 80
  );
  
  if (isVagueLocation || hasVagueLocationInDesc) {
    blockReason = 'vague_location';
    questions.push('Please provide a specific address or location where the task should be completed.');
    return {
      instantEligible: false,
      blockReason,
      questions,
    };
  }
  
  // 2. No way to start work - access required for private spaces (HARD BLOCKER)
  // Check if task involves private space access
  const mentionsPrivateSpace = 
    locationLower.includes('apartment') ||
    locationLower.includes('home') ||
    locationLower.includes('house') ||
    locationLower.includes('building') ||
    locationLower.includes('unit') ||
    locationLower.includes('room') ||
    descriptionLower.includes('apartment') ||
    descriptionLower.includes('home') ||
    descriptionLower.includes('house') ||
    descriptionLower.includes('building') ||
    descriptionLower.includes('unit') ||
    descriptionLower.includes('room');
  
  // Check if task requires indoor access (not just exterior)
  const requiresIndoorAccess = 
    descriptionLower.includes('inside') ||
    descriptionLower.includes('indoor') ||
    descriptionLower.includes('in the apartment') ||
    descriptionLower.includes('in the house') ||
    descriptionLower.includes('in the building') ||
    descriptionLower.includes('in my apartment') ||
    descriptionLower.includes('in my house') ||
    descriptionLower.includes('from my apartment') ||
    descriptionLower.includes('from my house') ||
    descriptionLower.includes('from my place') ||
    descriptionLower.includes('floor') || // "3rd floor" implies indoor access needed
    (mentionsPrivateSpace && !descriptionLower.includes('porch') && !descriptionLower.includes('outside') && !descriptionLower.includes('exterior') && !descriptionLower.includes('will be on'));
  
  const isPrivateSpace = mentionsPrivateSpace && requiresIndoorAccess;
  
  if (isPrivateSpace) {
    // Check if task involves public/exterior access (no access info needed)
    const isPublicAccess = 
      descriptionLower.includes('porch') ||
      descriptionLower.includes('front door') ||
      descriptionLower.includes('back door') ||
      descriptionLower.includes('outside') ||
      descriptionLower.includes('exterior') ||
      descriptionLower.includes('driveway') ||
      descriptionLower.includes('curb') ||
      descriptionLower.includes('mailbox') ||
      descriptionLower.includes('will be on') ||
      descriptionLower.includes('left on') ||
      descriptionLower.includes('waiting on') ||
      descriptionLower.includes('pick up from') ||
      descriptionLower.includes('deliver to door');
    
    // If public access clearly stated (porch, outside, etc.), that IS access info
    // "will be on porch" = public access info provided
    // But "from my house" requires property access even if porch mentioned
    const requiresPropertyAccess = 
      descriptionLower.includes('from my house') ||
      descriptionLower.includes('from my apartment') ||
      descriptionLower.includes('from my home');
    
    const hasClearPublicAccess = isPublicAccess && (
      descriptionLower.includes('will be on') ||
      descriptionLower.includes('left on') ||
      descriptionLower.includes('waiting on') ||
      descriptionLower.includes('pick up from porch') ||
      descriptionLower.includes('deliver to door') ||
      descriptionLower.includes('outside') ||
      descriptionLower.includes('exterior')
    ) && !requiresPropertyAccess; // Don't allow if requires property access
    
    if (hasClearPublicAccess) {
      // Public access clearly stated and no property access needed - this IS access info, skip access check
    } else {
      // Private space requires access info
      const hasAccessInfo = 
        task.requirements?.toLowerCase().includes('access') ||
        task.requirements?.toLowerCase().includes('key') ||
        task.requirements?.toLowerCase().includes('code') ||
        task.requirements?.toLowerCase().includes('door') ||
        task.requirements?.toLowerCase().includes('buzz') ||
        task.requirements?.toLowerCase().includes('buzzer') ||
        descriptionLower.includes('access') ||
        descriptionLower.includes('key') ||
        descriptionLower.includes('code') ||
        descriptionLower.includes('buzz') ||
        descriptionLower.includes('buzzer') ||
        descriptionLower.includes('let in') ||
        descriptionLower.includes('meet at') ||
        descriptionLower.includes('i will be');
      
      // Allow if task has "from X to Y" structure (moving/delivery) - access might not be needed if exterior
      const isMovingOrDelivery = descriptionLower.includes('move') || 
                                 descriptionLower.includes('deliver') ||
                                 descriptionLower.includes('pick up') ||
                                 descriptionLower.includes('transport');
      const hasFromToStructure = descriptionLower.includes('from') && descriptionLower.includes('to');
      // If moving from private space but has "to storage unit" or similar, might be exterior-only
      const hasExteriorDestination = descriptionLower.includes('to storage') ||
                                     descriptionLower.includes('to truck') ||
                                     descriptionLower.includes('to vehicle');
      
      // For moving tasks with "from X to Y" structure, allow if destination is clearly exterior
      // "from my apartment to storage unit" - storage unit might be exterior access
      const isMovingTask = descriptionLower.includes('move') || descriptionLower.includes('moving');
      const allowsExteriorMoving = isMovingTask && hasFromToStructure && (hasExteriorDestination || descriptionLower.includes('storage'));
      
      if (!hasAccessInfo && !allowsExteriorMoving) {
        blockReason = 'missing_access';
        questions.push('How will the hustler access the location? (door code, key location, buzzer number, etc.)');
        return {
          instantEligible: false,
          blockReason,
          questions,
        };
      }
    }
  }
  
  // 3. No definition of "done" for complex tasks (HARD BLOCKER)
  // Only block if task is EXTREMELY vague (single verb, < 20 chars, no detail)
  const complexTaskTypes = ['cleaning', 'organizing', 'assembly', 'repair', 'setup', 'organize'];
  const taskType = task.category?.toLowerCase() || '';
  const isComplexTask = complexTaskTypes.some(type => 
    taskType.includes(type) ||
    descriptionLower.includes(type) ||
    task.title.toLowerCase().includes(type)
  );
  
  if (isComplexTask) {
    // Extremely short descriptions (< 20 chars) of complex tasks need explicit outcome
    // Longer descriptions are assumed executable
    if (descriptionLower.length < 20) {
      const hasClearOutcome = 
        descriptionLower.includes('done') ||
        descriptionLower.includes('complete') ||
        descriptionLower.includes('finish') ||
        descriptionLower.includes('finished') ||
        descriptionLower.includes('until') ||
        descriptionLower.includes('when') ||
        descriptionLower.includes('all') ||
        descriptionLower.includes('everything') ||
        task.requirements?.toLowerCase().includes('done') ||
        task.requirements?.toLowerCase().includes('complete');
      
      if (!hasClearOutcome) {
        blockReason = 'missing_success_criteria';
        questions.push('What does "done" look like? How will you know the task is complete?');
        return {
          instantEligible: false,
          blockReason,
          questions,
        };
      }
    }
    // If description is 20+ chars, assume it has enough detail for Instant Mode
  }
  
  // ============================================================================
  // SEMANTIC CHECK: Would a hustler need to ask a question before starting?
  // ============================================================================
  
  // Check for semantic ambiguity that would force a question
  const description = (task.description || '').toLowerCase();
  const title = (task.title || '').toLowerCase();
  const fullText = `${title} ${description}`;
  
  // Patterns that indicate semantic ambiguity requiring clarification
  const ambiguousPatterns = [
    /\b(help|assist|do something|some stuff|things|items)\b/i,
    /\b(move|deliver|pick up)\b.*\b(things|stuff|items|some)\b/i,
    /\b(organize|clean|fix)\b.*\b(it|this|that|stuff)\b/i,
  ];
  
  // Special case: "several packages" or "few items" or just "boxes/items" without number - vague quantity
  const hasVagueQuantity = /\b(several|few|some|multiple)\b.*\b(packages|items|boxes|things)\b/i.test(fullText) ||
                           /\b(boxes|items|packages|things)\b/i.test(fullText) && !fullText.match(/\d+\s*(box|item|package|thing)/i);
  const hasSpecificDestination = /\b(to|at|from)\b.*\b(specific|exact|address|location|place)\b/i.test(fullText) ||
                                 fullText.match(/\d+\s+(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard)/i) ||
                                 (task.location && task.location.length > 20); // Has specific location
  
  // Allow vague quantity if there's a clear route, multiple destinations, or task has enough detail
  const hasClearRoute = fullText.match(/\b(to|from|at)\b.*\b(and|then|next|after)\b/i) ||
                       fullText.match(/\d+\s*(stops?|locations?|addresses?)/i);
  
  // Allow tasks with specific location + clear task type + reasonable description
  // But for moving/delivery tasks, still require quantity clarity even with "from X to Y"
  const hasEnoughDetail = task.location && task.location.length > 15 && 
                          description.length > 50 && 
                          (description.includes('from') || description.includes('to') || description.includes('at') || description.includes('storage') || description.includes('unit'));
  
  // For moving tasks, "from X to Y" is not enough if quantity is vague
  // "moving boxes from apartment to storage" - still needs quantity
  // Even with time estimate, vague quantity for moving tasks needs clarification
  const isMovingWithVagueQuantity = (descriptionLower.includes('move') || descriptionLower.includes('moving')) &&
                                     hasVagueQuantity &&
                                     hasEnoughDetail &&
                                     !description.match(/\d+\s*(box|item|package|piece)/i); // No specific number mentioned
  
  // Allow tasks with time estimates or duration - indicates enough planning
  const hasTimeEstimate = description.match(/\b(take|takes|should take|will take|about|approximately|roughly)\b.*\b(hour|minute|hr|min)\b/i);
  
  // STRONG semantic ambiguity check - catch false negatives
  const isSemanticallyAmbiguous = ambiguousPatterns.some(pattern => {
    const match = pattern.test(fullText);
    // Block if vague AND short
    return match && fullText.length < 30;
  }) || (hasVagueQuantity && !hasSpecificDestination && !hasClearRoute && !hasEnoughDetail && !hasTimeEstimate && fullText.length < 60) ||
       isMovingWithVagueQuantity; // Moving tasks with vague quantity need clarification
  
  // Additional check: extremely vague descriptions (very short)
  const veryVagueDescriptions = [
    'help me',
    'need help',
    'help needed',
    'some help',
    'do it',
    'get it done',
  ];
  
  const isVeryVague = veryVagueDescriptions.some(vague => 
    fullText.includes(vague) && fullText.length < 40
  );
  
  if (isSemanticallyAmbiguous || isVeryVague) {
    blockReason = 'semantic_ambiguity';
    questions.push('Please provide more specific details about what needs to be done.');
    return {
      instantEligible: false,
      blockReason,
      questions,
    };
  }
  
  // ============================================================================
  // SOFT SIGNALS (Do NOT block alone - these are informational only)
  // ============================================================================
  // Note: We don't block on these, but they could be used for suggestions later
  
  // All checks passed - task is Instant-eligible
  return {
    instantEligible: true,
    questions: [],
  };
}

/**
 * Call AI model to check instant eligibility
 * Temperature = 0 for determinism
 * Falls back to heuristic if AI unavailable
 */
async function callAIGate(task: TaskDraft): Promise<InstantGateResult> {
  // Always run heuristic first (it's fast and catches hard blockers)
  const heuristicResult = await checkInstantEligibility(task);

  // If heuristic blocks it, trust the heuristic — no need for AI
  if (!heuristicResult.instantEligible) {
    return heuristicResult;
  }

  // If heuristic passes, optionally validate with AI for edge cases
  if (AIClient.isConfigured()) {
    try {
      const aiResult = await AIClient.callJSON<InstantGateResult>({
        route: 'primary',
        temperature: 0,
        timeoutMs: 10000,
        maxTokens: 512,
        systemPrompt: `You are HustleXP's Instant Task Gate (A2 authority).
Determine if a task has ALL execution-critical fields for Instant Mode.
A task is Instant-eligible UNLESS a missing detail would force a worker to ask a question before starting.

Return JSON with EXACTLY these fields:
- instantEligible: boolean
- blockReason: string | null (one of: "missing_location", "vague_location", "missing_access", "missing_success_criteria", "semantic_ambiguity", or null)
- questions: string[] (clarifying questions the worker would need to ask, empty if eligible)`,
        prompt: `Check if this task is ready for Instant Execution Mode:

Title: ${task.title}
Description: ${task.description}
Location: ${task.location || 'Not provided'}
Requirements: ${task.requirements || 'None specified'}
Category: ${task.category || 'Not specified'}
Deadline: ${task.deadline || 'Not specified'}`,
      });

      const aiGateResult = aiResult.data;

      // If AI disagrees with heuristic, log for monitoring but trust AI
      if (!aiGateResult.instantEligible && heuristicResult.instantEligible) {
        log.info({ blockReason: aiGateResult.blockReason, questions: aiGateResult.questions }, 'AI blocked task that heuristic passed');
        return aiGateResult;
      }

      return aiGateResult;
    } catch (aiError) {
      log.warn({ err: aiError instanceof Error ? aiError.message : String(aiError) }, 'AI call failed, using heuristic result');
    }
  }

  // Fallback: trust heuristic result
  return heuristicResult;
}

// Export for use in TaskService
export const InstantTaskGate = {
  check: callAIGate,
};
