/**
 * AI Orchestrator - Constitutional Alignment
 * 
 * CONSTITUTIONAL: This orchestrator enforces AI authority levels from HUSTLEXP-DOCS/AI_INFRASTRUCTURE.md
 * 
 * Authority Model:
 * - A0: Forbidden (XP, trust, payments, bans)
 * - A1: Read-Only (summaries, display)
 * - A2: Proposal-Only (validated by deterministic rules)
 * - A3: Restricted Execution (reversible actions with consent)
 * 
 * Reference: /Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/AI_INFRASTRUCTURE.md
 * 
 * @see AI_INFRASTRUCTURE.md §3.1-3.2 (Authority Model)
 * @see AI_INFRASTRUCTURE.md §4 (Canonical AI Execution Flow)
 */

import { AIFunctions, type AIActionName, type ActionResult } from './functions';
import { generateSystemResponse } from './router';
import { handleOnboardingFlow } from './onboarding';
import { translateText, detectLanguage } from './translation';
import { validateAuthority, getAuthorityLevel, isAIAllowed, CONSTITUTIONAL_REFERENCES } from './authority';

export type OrchestratorContext = {
  userId: string; // Database user.id (numeric, converted to string)
  firebaseUid?: string; // Optional Firebase UID for reference
  username?: string; // Optional username from database
  input: string;
  context?: {
    screen?: string;
    locale?: string;
    taskId?: string;
    conversationHistory?: { role: string; content: string }[];
    onboardingState?: any;
    userLanguage?: string;
  };
};

export type OrchestratorResponse = {
  messages: { role: 'assistant' | 'user'; content: string }[];
  actions?: ActionResult[];
  nextSteps?: string[];
};

type Intent = 
  | 'onboarding'
  | 'earn_money'
  | 'find_help'
  | 'translate'
  | 'explain_feature'
  | 'manage_task'
  | 'profile_overview'
  | 'wallet_overview'
  | 'leaderboard_view'
  | 'navigation'
  | 'chat'
  | 'unknown';

type NavigationTarget = {
  route: string;
  params?: Record<string, string | number | boolean>;
};

const NAVIGATION_VERBS = ['open', 'go to', 'take me', 'navigate', 'show me', 'bring me', 'jump to', 'head to'];

function detectNavigationTarget(lowerInput: string): NavigationTarget | null {
  const hasVerb = NAVIGATION_VERBS.some((verb) => lowerInput.includes(verb));
  if (!hasVerb) {
    return null;
  }

  if (lowerInput.includes('wallet')) {
    return { route: '/(tabs)/wallet' };
  }

  if (lowerInput.includes('leaderboard') || lowerInput.includes('rank')) {
    return { route: '/(tabs)/leaderboard' };
  }

  if (lowerInput.includes('profile') || lowerInput.includes('stats') || lowerInput.includes('account')) {
    return { route: '/(tabs)/profile' };
  }

  if (lowerInput.includes('task') || lowerInput.includes('jobs') || lowerInput.includes('work') || lowerInput.includes('earn')) {
    return { route: '/(tabs)/(tasks)' };
  }

  if (lowerInput.includes('explore')) {
    return { route: '/(tabs)/explore' };
  }

  if (lowerInput.includes('home') || lowerInput.includes('dashboard')) {
    return { route: '/(tabs)/home' };
  }

  if (lowerInput.includes('proactive')) {
    return { route: '/(tabs)/proactive-settings' };
  }

  return null;
}

type PlanStep = {
  action: AIActionName | 'ask_question';
  params?: Record<string, any>;
  question?: string;
};

const createNavigationStep = (userId: string, target: NavigationTarget): PlanStep => ({
  action: 'navigateTo',
  params: {
    userId,
    route: target.route,
    params: target.params,
  },
});

async function classifyIntent(input: string, context?: OrchestratorContext['context']): Promise<Intent> {
  const lowerInput = input.toLowerCase();
  
  if (context?.screen === 'onboarding' || lowerInput.includes('why are you here') || lowerInput.includes('get started')) {
    return 'onboarding';
  }
  
  if (lowerInput.includes('profile') || lowerInput.includes('stats') || lowerInput.includes('xp') || lowerInput.includes('level')) {
    return 'profile_overview';
  }
  
  if (lowerInput.includes('wallet') || lowerInput.includes('balance') || lowerInput.includes('payout') || lowerInput.includes('earnings')) {
    return 'wallet_overview';
  }
  
  if (lowerInput.includes('leaderboard') || lowerInput.includes('ranking') || lowerInput.includes('top players')) {
    return 'leaderboard_view';
  }
  
  if (lowerInput.includes('earn') || lowerInput.includes('money') || lowerInput.includes('work') || lowerInput.includes('job')) {
    return 'earn_money';
  }
  
  if (lowerInput.includes('need help') || lowerInput.includes('find someone') || lowerInput.includes('hire') || lowerInput.includes('post')) {
    return 'find_help';
  }
  
  if (lowerInput.includes('translate') || lowerInput.includes('spanish') || lowerInput.includes('language')) {
    return 'translate';
  }
  
  if (lowerInput.includes('create task') || lowerInput.includes('post task')) {
    return 'manage_task';
  }
  
  if (lowerInput.includes('how') || lowerInput.includes('what is') || lowerInput.includes('explain')) {
    return 'explain_feature';
  }
  
  const navTarget = detectNavigationTarget(lowerInput);
  if (navTarget) {
    return 'navigation';
  }
  
  return 'chat';
}

async function generatePlan(intent: Intent, input: string, userId: string, context?: OrchestratorContext['context']): Promise<{
  steps: PlanStep[];
}> {
  const lowerInput = input.toLowerCase();
  const navTarget = detectNavigationTarget(lowerInput);
  const appendNavigation = (steps: PlanStep[], targetRoute: string | null) => {
    if (navTarget && navTarget.route === targetRoute) {
      steps.push(createNavigationStep(userId, navTarget));
    }
    return steps;
  };
  
  switch (intent) {
    case 'onboarding':
      return {
        steps: [
          { action: 'ask_question', question: 'What brings you to HustleXP? Are you looking to earn money, get help with tasks, or both?' },
        ],
      };
    
    case 'earn_money': {
      let category = 'all';
      if (lowerInput.includes('mov')) category = 'moving';
      else if (lowerInput.includes('clean')) category = 'cleaning';
      else if (lowerInput.includes('deliver')) category = 'delivery';
      else if (lowerInput.includes('tech')) category = 'tech';
      else if (lowerInput.includes('tutor')) category = 'tutoring';
      
      const steps: PlanStep[] = [
        { action: 'findTasks', params: { userId, filters: { category, status: 'active', limit: 10 } } },
      ];
      appendNavigation(steps, '/(tabs)/(tasks)');
      return { steps };
    }
    
    case 'find_help': {
      const hasDetails = lowerInput.length > 20 && (lowerInput.includes('need') || lowerInput.includes('help with'));
      
      if (hasDetails) {
        const estimatedBudget = extractBudgetFromInput(input) || 30;
        return {
          steps: [
            { 
              action: 'createTask', 
              params: { 
                userId, 
                taskData: { 
                  title: extractTitleFromInput(input),
                  description: input, 
                  category: 'errands', 
                  budget: estimatedBudget 
                } 
              } 
            },
          ],
        };
      }
      
      return {
        steps: [
          { action: 'ask_question', question: 'What kind of help do you need? Please describe the task, your budget, and when you need it done.' },
        ],
      };
    }
    
    case 'manage_task':
      return {
        steps: [
          { action: 'createTask', params: { userId, taskData: { title: input, description: input, category: 'errands', budget: 30 } } },
        ],
      };
    
    case 'translate':
      return {
        steps: [
          { action: 'translateMessage', params: { text: input, targetLanguage: 'es' } },
        ],
      };
    
    case 'profile_overview': {
      const steps: PlanStep[] = [{ action: 'getUserProfile', params: { userId } }];
      appendNavigation(steps, '/(tabs)/profile');
      return { steps };
    }
    
    case 'wallet_overview': {
      const steps: PlanStep[] = [{ action: 'getWalletSummary', params: { userId } }];
      appendNavigation(steps, '/(tabs)/wallet');
      return { steps };
    }
    
    case 'leaderboard_view': {
      const period = lowerInput.includes('week') ? 'weekly' : 'allTime';
      const steps: PlanStep[] = [{ action: 'getLeaderboard', params: { userId, period } }];
      appendNavigation(steps, '/(tabs)/leaderboard');
      return { steps };
    }
    
    case 'navigation':
      if (navTarget) {
        return {
          steps: [createNavigationStep(userId, navTarget)],
        };
      }
      return {
        steps: [
          { action: 'ask_question', question: 'Where should I take you? Say wallet, leaderboard, profile, or tasks.' },
        ],
      };
    
    case 'explain_feature':
      return {
        steps: [],
      };
    
    default:
      return {
        steps: [],
      };
  }
}

function extractBudgetFromInput(input: string): number | null {
  const budgetMatch = input.match(/\$(\d+)/);  
  if (budgetMatch) {
    return parseInt(budgetMatch[1], 10);
  }
  return null;
}

function extractTitleFromInput(input: string): string {
  const first50 = input.substring(0, 50);
  return first50.length < input.length ? first50 + '...' : first50;
}

/**
 * Map AI action to subsystem for authority checking
 * 
 * CONSTITUTIONAL: Maps actions to subsystems defined in AI_INFRASTRUCTURE.md §3.2
 */
function mapActionToSubsystem(action: AIActionName | 'ask_question'): string {
  // Map actions to subsystems from AI_INFRASTRUCTURE.md authority allocation table
  const actionMap: Record<string, string> = {
    'createTask': 'task.classification',
    'findTasks': 'task.matching_ranking',
    'getUserProfile': 'support.drafting', // A1 - read-only
    'getWalletSummary': 'support.drafting', // A1 - read-only
    'getLeaderboard': 'support.drafting', // A1 - read-only
    'translateMessage': 'support.drafting', // A1 - read-only
    'navigateTo': 'support.drafting', // A1 - read-only
  };
  
  return actionMap[action] || 'unknown';
}

export async function orchestrate(request: OrchestratorContext): Promise<OrchestratorResponse> {
  console.log('[Orchestrator] Processing request:', { userId: request.userId, input: request.input.substring(0, 100) });
  console.log('[Orchestrator] Constitutional alignment: HUSTLEXP-DOCS at', CONSTITUTIONAL_REFERENCES.AI_INFRASTRUCTURE);
  
  try {
    const detectedLanguage = await detectLanguage(request.input);
    const userLanguage = request.context?.userLanguage || detectedLanguage;
    
    let processedInput = request.input;
    if (detectedLanguage !== 'en') {
      console.log('[Orchestrator] Translating input from', detectedLanguage, 'to en');
      const translation = await translateText(request.input, 'en', detectedLanguage);
      processedInput = translation.translatedText;
    }
    
    if (request.context?.screen === 'onboarding' || request.context?.onboardingState) {
      const onboardingState = request.context.onboardingState || { step: 0 };
      const onboardingResult = await handleOnboardingFlow(
        request.userId,
        processedInput,
        onboardingState
      );
      
      let message = onboardingResult.message;
      if (userLanguage !== 'en') {
        const translation = await translateText(message, userLanguage, 'en');
        message = translation.translatedText;
      }
      
      return {
        messages: [{ role: 'assistant', content: message }],
        actions: onboardingResult.actions?.map(a => ({
          name: a.name as AIActionName,
          status: 'success' as const,
          data: a.params
        })),
        nextSteps: onboardingResult.completed ? ['Browse tasks', 'Create a task'] : undefined,
      };
    }
    
    const intent = await classifyIntent(processedInput, request.context);
    console.log('[Orchestrator] Classified intent:', intent);
    
    const plan = await generatePlan(intent, processedInput, request.userId, request.context);
    console.log('[Orchestrator] Generated plan:', plan.steps.length, 'steps');
    
    const actionResults: ActionResult[] = [];
    let finalMessage = '';
    
    for (const step of plan.steps) {
      if (step.action === 'ask_question') {
        finalMessage = step.question || '';
      } else {
        // CONSTITUTIONAL: Validate authority before executing action
        const subsystem = mapActionToSubsystem(step.action);
        const authorityCheck = validateAuthority(step.action, subsystem);
        
        if (!authorityCheck.allowed) {
          console.error('[Orchestrator] Authority violation blocked:', {
            action: step.action,
            subsystem,
            reason: authorityCheck.reason,
            requiredLevel: authorityCheck.requiredLevel,
          });
          
          actionResults.push({
            name: step.action,
            status: 'error',
            error: authorityCheck.reason || 'Action forbidden by constitutional authority model',
          });
          continue;
        }
        
        const authorityLevel = getAuthorityLevel(subsystem);
        console.log('[Orchestrator] Executing action with authority:', {
          action: step.action,
          subsystem,
          authorityLevel,
        });
        
        const actionFn = AIFunctions[step.action];
        if (actionFn) {
          const result = await actionFn({ userId: request.userId, ...step.params });
          actionResults.push(result);
        }
      }
    }
    
    if (!finalMessage) {
      const conversationMessages = request.context?.conversationHistory?.map(msg => ({
        role: msg.role,
        content: msg.content
      })) || [];
      
      finalMessage = await generateSystemResponse({
        intent,
        userInput: processedInput,
        actionResults,
        userName: request.username,
        conversationHistory: conversationMessages,
      });
    }
    
    if (userLanguage !== 'en') {
      const translation = await translateText(finalMessage, userLanguage, 'en');
      finalMessage = translation.translatedText;
    }
    
    return {
      messages: [
        { role: 'assistant', content: finalMessage },
      ],
      actions: actionResults,
      nextSteps: actionResults.length > 0 ? ['View results', 'Ask another question'] : undefined,
    };
  } catch (error) {
    console.error('[Orchestrator] Error:', error);
    
    return {
      messages: [
        { role: 'assistant', content: 'I ran into an issue processing your request. Could you try rephrasing that?' },
      ],
    };
  }
}
