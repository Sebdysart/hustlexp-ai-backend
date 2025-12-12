import { AIFunctions } from './functions';

type OnboardingState = {
  step: number;
  goal?: 'earn' | 'hire' | 'both';
  availability?: string;
  categories?: string[];
  language?: string;
};

export async function handleOnboardingFlow(
  userId: string,
  userMessage: string,
  state: OnboardingState
): Promise<{
  message: string;
  state: OnboardingState;
  completed: boolean;
  actions?: Array<{ name: string; params: any }>;
}> {
  const lowerMessage = userMessage.toLowerCase();

  if (state.step === 0) {
    let goal: 'earn' | 'hire' | 'both' = 'earn';
    
    if (lowerMessage.includes('earn') || lowerMessage.includes('money') || lowerMessage.includes('work')) {
      goal = 'earn';
    } else if (lowerMessage.includes('help') || lowerMessage.includes('hire') || lowerMessage.includes('find someone')) {
      goal = 'hire';
    } else if (lowerMessage.includes('both')) {
      goal = 'both';
    }
    
    return {
      message: 'Got it! What days and times are you usually available?',
      state: { ...state, step: 1, goal },
      completed: false,
    };
  }

  if (state.step === 1) {
    return {
      message: 'Perfect! What type of tasks are you interested in? (delivery, moving, cleaning, tech help, tutoring, etc.)',
      state: { ...state, step: 2, availability: userMessage },
      completed: false,
    };
  }

  if (state.step === 2) {
    const categories: string[] = [];
    
    if (lowerMessage.includes('delivery')) categories.push('delivery');
    if (lowerMessage.includes('moving')) categories.push('moving');
    if (lowerMessage.includes('clean')) categories.push('cleaning');
    if (lowerMessage.includes('tech')) categories.push('tech');
    if (lowerMessage.includes('tutor')) categories.push('tutoring');
    if (lowerMessage.includes('pet')) categories.push('pet_care');
    if (lowerMessage.includes('errand')) categories.push('errands');
    if (lowerMessage.includes('assembly')) categories.push('assembly');
    
    return {
      message: 'Last question: What\'s your preferred language for communication?',
      state: { ...state, step: 3, categories: categories.length > 0 ? categories : ['errands'] },
      completed: false,
    };
  }

  if (state.step === 3) {
    let language = 'en';
    
    if (lowerMessage.includes('spanish') || lowerMessage.includes('español')) {
      language = 'es';
    } else if (lowerMessage.includes('chinese') || lowerMessage.includes('mandarin')) {
      language = 'zh';
    }
    
    await AIFunctions.updateUserProfile({
      userId,
      updates: {
        onboardingCompleted: true,
        goal: state.goal,
        availability: state.availability,
        preferredCategories: state.categories,
        primaryLanguage: language,
      },
    });
    
    const goalMessage = state.goal === 'earn' 
      ? 'I\'ve set up your profile for earning. I\'ll show you opportunities as they pop up.'
      : state.goal === 'hire'
      ? 'I\'ve set up your profile for posting tasks. Ready to create your first task?'
      : 'I\'ve set up your profile for both earning and posting tasks. You\'re all set!';
    
    return {
      message: `All set! ${goalMessage} Want to see nearby tasks now?`,
      state: { ...state, step: 4, language },
      completed: true,
      actions: [
        { name: 'updateUserProfile', params: { onboardingCompleted: true } },
        { name: 'completeOnboarding', params: {} },
      ],
    };
  }

  return {
    message: 'Welcome to HustleXP! What brings you here today?',
    state: { step: 0 },
    completed: false,
  };
}
