import { type ActionResult } from './functions';

type ModelRoute = {
  name: string;
  provider: 'google';
  apiEndpoint: string;
  temperature: number;
};

const MODEL_ROUTES: Record<string, ModelRoute> = {
  'gemini-app': {
    name: 'gemini-1.5-pro',
    provider: 'google',
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
    temperature: 0.55,
  },
};

const SYSTEM_PROMPT = `You are HustleXP AI, an in-app guide for the HustleXP marketplace.
- Only discuss HustleXP features: finding tasks, posting tasks, wallet, leaderboard, user stats, proactive matching, onboarding, AI helpers.
- Pull real data from provided action results. If you do not have data, ask clarifying questions instead of making things up.
- Be concise (max 3 sentences) and proactive about next steps.
- When users request anything outside HustleXP, politely decline and redirect back to app capabilities.`;

function getApiKey(provider: string): string | null {
  if (provider === 'google') {
    return process.env.GOOGLE_AI_API_KEY || null;
  }
  return null;
}



async function callAIModel(
  route: ModelRoute,
  messages: { role: string; content: string }[],
  maxTokens: number = 1000
): Promise<string> {
  const apiKey = getApiKey(route.provider);

  if (!apiKey) {
    console.warn(`[AI Router] No API key for ${route.provider}, using fallback`);
    return generateFallbackResponse(messages[messages.length - 1]?.content || '');
  }

  try {
    console.log(`[AI Router] Calling ${route.provider}/${route.name}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const geminiMessages = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const endpoint = `${route.apiEndpoint}?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: geminiMessages,
        systemInstruction: {
          role: 'system',
          parts: [{ text: SYSTEM_PROMPT }],
        },
        generationConfig: {
          temperature: route.temperature,
          maxOutputTokens: maxTokens,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      console.error(`[AI Router] ${route.provider} error:`, response.status, error);
      return generateFallbackResponse(messages[messages.length - 1]?.content || '');
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log(`[AI Router] ✅ Got response from ${route.provider}`);
    return content;
  } catch (error) {
    console.error(`[AI Router] Error calling ${route.provider}:`, error);
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(`[AI Router] Request to ${route.provider} timed out`);
    }
    return generateFallbackResponse(messages[messages.length - 1]?.content || '');
  }
}

function generateFallbackResponse(input: string): string {
  const lowerInput = input.toLowerCase();

  console.log('[AI Router] Using fallback response (no AI provider configured)');

  if (lowerInput.includes('earn') || lowerInput.includes('money') || lowerInput.includes('work') || lowerInput.includes('job')) {
    return "I can help you find tasks to earn money! Check out the available tasks in your area. What type of work are you interested in - delivery, cleaning, moving, or errands?";
  }

  if (lowerInput.includes('help') || lowerInput.includes('post') || lowerInput.includes('need')) {
    return "I can help you post a task! Tell me what you need help with, your budget, and when you need it done. I'll help you create it.";
  }

  if (lowerInput.includes('how') || lowerInput.includes('what is') || lowerInput.includes('explain')) {
    return "HustleXP connects people who need tasks done with people ready to do them. You can earn XP, level up, and make money by completing tasks in your area. Start by browsing available tasks or posting your own!";
  }

  if (lowerInput.includes('both')) {
    return "Great! You can both earn money by completing tasks AND post tasks when you need help. Let's get you set up. Would you like to browse available tasks first, or learn how to post a task?";
  }

  return "I'm here to help you with HustleXP! I can help you find tasks to earn money, post tasks when you need help, manage your profile, and answer questions. What would you like to do?";
}

export type TaskType = 'chat' | 'reason' | 'translate' | 'critical';

export async function routeModel(
  task: TaskType,
  prompt: string,
  conversationHistory?: { role: string; content: string }[]
): Promise<{ text: string; modelUsed: string }> {
  const route = MODEL_ROUTES['gemini-app'];
  console.log(`[AI Router] Routing ${task} → ${route.name}`);

  const messages = [
    ...(conversationHistory || []),
    { role: 'user' as const, content: prompt },
  ];

  const text = await callAIModel(route, messages, task === 'reason' ? 2000 : 1000);

  return {
    text,
    modelUsed: route.name,
  };
}

export async function generateAIResponse(params: {
  prompt: string;
  model?: string;
  temperature?: number;
  conversationHistory?: { role: string; content: string }[];
}): Promise<{ text: string; modelUsed: string }> {
  console.log('[AI Router] Generating response:', { model: params.model, promptLength: params.prompt.length });

  const route = MODEL_ROUTES['gemini-app'];

  const messages = [
    ...(params.conversationHistory || []),
    { role: 'user' as const, content: params.prompt },
  ];

  const text = await callAIModel(route, messages);

  return {
    text,
    modelUsed: route.name,
  };
}

export const ai = {
  categorizeTask: async (description: string) => {
    const prompt = `Categorize this task into ONE of these categories: delivery, moving, cleaning, assembly, tech, tutoring, pet_care, errands.
Task: "${description}"
Return only the category name, nothing else.`;

    const response = await routeModel('reason', prompt);
    const category = response.text.toLowerCase().trim();

    const validCategories = ['delivery', 'moving', 'cleaning', 'assembly', 'tech', 'tutoring', 'pet_care', 'errands'];
    return validCategories.includes(category) ? category : 'errands';
  },

  validatePrice: async (description: string, price: number) => {
    const prompt = `Analyze if this price is reasonable for the task:
Task: "${description}"
Proposed Price: ${price}

Respond with JSON: { "isReasonable": boolean, "suggestedPrice": number, "reasoning": "brief explanation" }`;

    const response = await routeModel('reason', prompt);

    try {
      const parsed = JSON.parse(response.text);
      return {
        isReasonable: parsed.isReasonable ?? true,
        suggestedPrice: parsed.suggestedPrice ?? price,
        reasoning: parsed.reasoning ?? 'Price looks reasonable',
      };
    } catch {
      return {
        isReasonable: true,
        suggestedPrice: price,
        reasoning: 'Price looks reasonable',
      };
    }
  },

  generateSmartResponse: async (
    userInput: string,
    context: { userName?: string; previousActions?: string[] },
    conversationHistory?: { role: string; content: string }[]
  ) => {
    const systemContext = `You are the HustleXP AI assistant. You help users:
- Find tasks to earn money
- Post tasks to get help
- Manage their profile and progress
- Answer questions about the platform

Be friendly, concise, and action-oriented. Keep responses under 2-3 sentences unless explaining something complex.${context.userName ? `

User's name: ${context.userName}` : ''}${context.previousActions?.length ? `

Recent actions: ${context.previousActions.join(', ')}` : ''}`;

    const prompt = `${systemContext}

User: ${userInput}`;

    const response = await routeModel('chat', prompt, conversationHistory);
    return response.text;
  },
};

const formatCurrency = (value: number | string | undefined): string => {
  const parsed = typeof value === 'string' ? parseFloat(value) : value;
  const resolved = typeof parsed === 'number' && !Number.isNaN(parsed) ? parsed : 0;
  return `$${resolved.toFixed(2)}`;
};

function summarizeActionResult(action: ActionResult): string | null {
  if (!action) {
    return null;
  }

  if (action.status !== 'success') {
    return `${action.name} failed: ${action.error ?? 'unknown error'}`;
  }

  switch (action.name) {
    case 'findTasks': {
      const tasks = Array.isArray(action.data?.tasks) ? action.data.tasks : [];
      const highlight = tasks[0]
        ? `${tasks[0].title} for ${formatCurrency(tasks[0].price)} in ${tasks[0].city ?? 'your area'}`
        : 'No active tasks matched yet';
      return `Tasks loaded (${tasks.length}). ${highlight}`;
    }
    case 'getWalletSummary': {
      const balance = action.data?.balance;
      const available = balance?.available ?? balance?.balance;
      const pending = balance?.pending ?? 0;
      const transactions = action.data?.recentTransactions;
      const transactionCount = Array.isArray(transactions?.transactions)
        ? transactions.transactions.length
        : Array.isArray(transactions)
          ? transactions.length
          : transactions?.total ?? 0;
      return `Wallet → ${formatCurrency(available)} available, ${formatCurrency(pending)} pending, ${transactionCount} recent transactions.`;
    }
    case 'getUserProfile': {
      const profile = action.data?.profile;
      if (!profile) {
        return 'Profile data unavailable.';
      }
      return `Profile → Level ${profile.level ?? 'n/a'}, ${profile.xp ?? 0} XP, ${profile.streak ?? 0}-day streak.`;
    }
    case 'getLeaderboard': {
      const leaderboard = action.data?.leaderboard;
      const entries = leaderboard?.entries ?? [];
      const rank = leaderboard?.myRank ?? 'unranked';
      return `Leaderboard → ${entries.length} entries loaded, your rank: ${rank}.`;
    }
    case 'createTask':
      return `Task created: ${action.data?.title ?? 'Untitled'} for ${formatCurrency(action.data?.price)}.`;
    case 'navigateTo':
      return action.data?.route ? `Navigating to ${action.data.route}.` : null;
    default:
      if (action.data) {
        const serialized = JSON.stringify(action.data).slice(0, 200);
        return `${action.name}: ${serialized}`;
      }
      return `${action.name}: success`;
  }
}

export async function generateSystemResponse(params: {
  intent: string;
  userInput: string;
  actionResults?: ActionResult[];
  userName?: string;
  conversationHistory?: { role: string; content: string }[];
}): Promise<string> {
  const { intent, userInput, actionResults, userName, conversationHistory } = params;

  let systemPrompt = `You are the HustleXP AI assistant - confident, helpful, action-oriented.
${userName ? `User's name: ${userName}` : ''}
User said: "${userInput}"
Detected intent: ${intent}`;

  if (actionResults && actionResults.length > 0) {
    const summaries = actionResults
      .map(summarizeActionResult)
      .filter((summary): summary is string => Boolean(summary));
    if (summaries.length > 0) {
      systemPrompt += `\n\nApp data:\n${summaries.join('\n')}`;
    }
  }

  systemPrompt += `\n\nRespond naturally in 1-2 sentences. Be clear, keep everything inside HustleXP context, and offer a next step if possible. If data is missing, ask for clarification instead of guessing.`;

  const navigationAction = actionResults?.find((action) => action.name === 'navigateTo' && action.status === 'success');
  if (navigationAction?.data?.route) {
    systemPrompt += `\n\nLet the user know you are opening ${navigationAction.data.route}.`;
  }

  const response = await routeModel('chat', systemPrompt, conversationHistory);
  return response.text;
}
