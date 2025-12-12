import { appRouter } from '../trpc/app-router';
import { createContext } from '../trpc/create-context';

export type AIActionName =
  | 'createTask'
  | 'findTasks'
  | 'acceptTask'
  | 'completeTask'
  | 'getUserProfile'
  | 'updateUserProfile'
  | 'getLeaderboard'
  | 'sendMessage'
  | 'translateMessage'
  | 'getWalletSummary'
  | 'navigateTo';

export type ActionResult = {
  name: AIActionName;
  status: 'success' | 'error';
  data?: any;
  error?: string;
};

type ActionParams = {
  userId: string;
  [key: string]: any;
};

async function createCaller(userId: string) {
  const mockReq = new Request('http://localhost:3000', {
    headers: {
      'x-user-id': userId,
    },
  });
  
  const ctx = await createContext({ 
    req: mockReq,
    resHeaders: new Headers(),
    info: {
      accept: 'application/jsonl' as const,
      calls: [],
      connectionParams: null,
      isBatchCall: false,
      type: 'query',
      signal: new AbortController().signal,
      url: new URL('http://localhost:3000')
    }
  });
  
  return appRouter.createCaller(ctx);
}

export const AIFunctions: Record<AIActionName, (params: ActionParams) => Promise<ActionResult>> = {
  createTask: async ({ userId, taskData }) => {
    try {
      console.log('[AIFunction] Creating task:', taskData);
      
      const caller = await createCaller(userId);
      
      const task = await caller.tasks.create({
        title: taskData.title || 'Untitled Task',
        description: taskData.description || '',
        category: taskData.category || 'errands',
        xpReward: taskData.xpReward || 50,
        price: taskData.budget || taskData.price || 30,
        city: taskData.city || 'Unknown',
        deadline: taskData.deadline,
        estimatedDuration: taskData.estimatedDuration,
        difficulty: taskData.difficulty,
      });
      
      return {
        name: 'createTask',
        status: 'success',
        data: {
          taskId: task.id,
          title: task.title,
          price: task.price,
          message: `Task "${task.title}" created successfully`,
        },
      };
    } catch (error) {
      console.error('[AIFunction] createTask error:', error);
      return {
        name: 'createTask',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  },

  findTasks: async ({ userId, filters }) => {
    try {
      console.log('[AIFunction] Finding tasks for user:', userId, 'filters:', filters);
      
      const caller = await createCaller(userId);
      
      const result = await caller.tasks.list({
        category: filters?.category !== 'all' ? filters?.category : undefined,
        city: filters?.city,
        status: filters?.status || 'active',
        limit: filters?.limit || 20,
        offset: filters?.offset || 0,
      });
      
      return {
        name: 'findTasks',
        status: 'success',
        data: {
          tasks: result.tasks,
          total: result.total,
          hasMore: result.hasMore,
          message: `Found ${result.total} available tasks`,
        },
      };
    } catch (error) {
      console.error('[AIFunction] findTasks error:', error);
      return {
        name: 'findTasks',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to find tasks',
      };
    }
  },

  acceptTask: async ({ userId, taskId }) => {
    try {
      console.log('[AIFunction] Accepting task:', taskId, 'for user:', userId);
      
      const caller = await createCaller(userId);
      
      await caller.tasks.accept({ taskId });
      
      return {
        name: 'acceptTask',
        status: 'success',
        data: {
          taskId,
          message: 'Task accepted successfully. Check the details and get started!',
        },
      };
    } catch (error) {
      console.error('[AIFunction] acceptTask error:', error);
      return {
        name: 'acceptTask',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to accept task',
      };
    }
  },

  completeTask: async ({ userId, taskId, proofPhotos }) => {
    try {
      console.log('[AIFunction] Completing task:', taskId, 'for user:', userId);
      
      const caller = await createCaller(userId);
      
      const result = await caller.tasks.complete({
        taskId,
        proofPhotos: proofPhotos || [],
        notes: '',
      });
      
      return {
        name: 'completeTask',
        status: 'success',
        data: {
          taskId,
          status: result.status,
          message: `Task marked as ${result.status}. XP will be awarded after review.`,
        },
      };
    } catch (error) {
      console.error('[AIFunction] completeTask error:', error);
      return {
        name: 'completeTask',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to complete task',
      };
    }
  },

  getUserProfile: async ({ userId }) => {
    try {
      console.log('[AIFunction] Getting profile for user:', userId);
      
      const caller = await createCaller(userId);
      
      const profile = await caller.users.me();
      
      return {
        name: 'getUserProfile',
        status: 'success',
        data: {
          userId,
          profile,
        },
      };
    } catch (error) {
      console.error('[AIFunction] getUserProfile error:', error);
      return {
        name: 'getUserProfile',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to get user profile',
      };
    }
  },

  updateUserProfile: async ({ userId, updates }) => {
    try {
      console.log('[AIFunction] Updating profile for user:', userId, updates);
      
      const caller = await createCaller(userId);
      
      await caller.users.update({
        name: updates.name,
        bio: updates.bio,
        city: updates.city,
      });
      
      return {
        name: 'updateUserProfile',
        status: 'success',
        data: {
          userId,
          message: 'Profile updated successfully',
        },
      };
    } catch (error) {
      console.error('[AIFunction] updateUserProfile error:', error);
      return {
        name: 'updateUserProfile',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to update profile',
      };
    }
  },

  getLeaderboard: async ({ userId, period }) => {
    try {
      console.log('[AIFunction] Getting leaderboard:', period);
      
      const caller = await createCaller(userId);
      
      const leaderboard = period === 'weekly' 
        ? await caller.leaderboard.weekly({ limit: 100 })
        : await caller.leaderboard.allTime({ limit: 100 });
      
      return {
        name: 'getLeaderboard',
        status: 'success',
        data: {
          leaderboard,
        },
      };
    } catch (error) {
      console.error('[AIFunction] getLeaderboard error:', error);
      return {
        name: 'getLeaderboard',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to get leaderboard',
      };
    }
  },

  sendMessage: async ({ userId, taskId, message }) => {
    try {
      console.log('[AIFunction] Sending message for task:', taskId);
      
      const caller = await createCaller(userId);
      
      await caller.chat.send({
        taskId,
        content: message,
      });
      
      return {
        name: 'sendMessage',
        status: 'success',
        data: {
          taskId,
          message: 'Message sent successfully',
        },
      };
    } catch (error) {
      console.error('[AIFunction] sendMessage error:', error);
      return {
        name: 'sendMessage',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to send message',
      };
    }
  },

  translateMessage: async ({ text, targetLanguage, sourceLanguage }) => {
    try {
      console.log('[AIFunction] Translating message to:', targetLanguage);
      
      const { translateText } = await import('./translation');
      
      const result = await translateText(text, targetLanguage, sourceLanguage);
      
      return {
        name: 'translateMessage',
        status: 'success',
        data: {
          originalText: result.originalText,
          translatedText: result.translatedText,
          sourceLanguage: result.sourceLang,
          targetLanguage: result.targetLang,
        },
      };
    } catch (error) {
      console.error('[AIFunction] translateMessage error:', error);
      return {
        name: 'translateMessage',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to translate message',
      };
    }
  },

  getWalletSummary: async ({ userId }) => {
    try {
      console.log('[AIFunction] Getting wallet summary for user:', userId);
      
      const caller = await createCaller(userId);
      
      const balance = await caller.wallet.balance();
      const transactions = await caller.wallet.transactions({ limit: 10 });
      
      return {
        name: 'getWalletSummary',
        status: 'success',
        data: {
          balance,
          recentTransactions: transactions,
        },
      };
    } catch (error) {
      console.error('[AIFunction] getWalletSummary error:', error);
      return {
        name: 'getWalletSummary',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to get wallet summary',
      };
    }
  },

  navigateTo: async ({ route, params }) => {
    try {
      console.log('[AIFunction] Navigating user to route:', route, params);
      return {
        name: 'navigateTo',
        status: 'success',
        data: {
          route,
          params,
        },
      };
    } catch (error) {
      console.error('[AIFunction] navigateTo error:', error);
      return {
        name: 'navigateTo',
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to navigate',
      };
    }
  },
};
