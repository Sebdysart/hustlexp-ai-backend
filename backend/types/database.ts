export type TaskStatus = 'active' | 'assigned' | 'in_progress' | 'pending_review' | 'completed' | 'cancelled' | 'expired';
export type TaskCategory = 'delivery' | 'moving' | 'cleaning' | 'yardwork' | 'tech' | 'creative' | 'errands' | 'other';
export type TransactionType = 'task_escrow' | 'task_payout' | 'platform_fee' | 'refund' | 'bonus' | 'withdrawal';
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
export type BadgeType = 'first_task' | 'speed_demon' | 'perfect_week' | 'five_star' | 'big_earner' | 'social_butterfly' | 'marathon' | 'early_bird' | 'night_owl';

export interface User {
  id: string;
  handle: string;
  name: string;
  email: string;
  city: string;
  xp: number;
  level: number;
  streak: number;
  badges: BadgeType[];
  avatarUrl?: string;
  bio?: string;
  createdAt: Date;
  lastActiveAt: Date;
  stripeAccountId?: string;
  emailVerified: boolean;
}

export interface Task {
  id: string;
  createdBy: string;
  title: string;
  description: string;
  category: TaskCategory;
  xpReward: number;
  price: number;
  status: TaskStatus;
  location: {
    city: string;
    latitude?: number;
    longitude?: number;
    address?: string;
  };
  posterName?: string;
  posterAvatar?: string;
  deadline?: Date;
  estimatedDuration?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  imageUrls?: string[];
  assignedTo?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface TaskAssignment {
  id: string;
  taskId: string;
  userId: string;
  status: 'accepted' | 'in_progress' | 'submitted' | 'approved' | 'rejected';
  proofPhotos: string[];
  beforePhotos?: string[];
  afterPhotos?: string[];
  submittedAt?: Date;
  completedAt?: Date;
  rating?: number;
  feedback?: string;
  createdAt: Date;
}

export interface Transaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  taskId?: string;
  status: TransactionStatus;
  stripePaymentIntentId?: string;
  stripeTransferId?: string;
  description: string;
  createdAt: Date;
  processedAt?: Date;
}

export interface LeaderboardEntry {
  userId: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  weeklyXp: number;
  allTimeXp: number;
  level: number;
  weeklyRank: number;
  allTimeRank: number;
  tasksCompleted: number;
}

export interface Message {
  id: string;
  taskId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  content: string;
  imageUrl?: string;
  createdAt: Date;
  readAt?: Date;
}

export interface UserStats {
  userId: string;
  tasksCompleted: number;
  tasksPosted: number;
  totalEarned: number;
  totalSpent: number;
  avgRating: number;
  reviewsReceived: number;
  successRate: number;
  responseTimeMinutes: number;
}

export interface Quest {
  id: string;
  type: 'daily' | 'weekly' | 'special';
  title: string;
  description: string;
  xpReward: number;
  cashReward?: number;
  progress: number;
  target: number;
  expiresAt: Date;
  claimed: boolean;
}

export interface Boost {
  id: string;
  name: string;
  description: string;
  type: 'double_xp' | 'streak_saver' | 'priority_listing' | 'fee_reducer';
  cost: number;
  duration?: number;
  discountPercent?: number;
  iconName: string;
  color: string;
}

export interface UserBoost {
  id: string;
  userId: string;
  boostId: string;
  activatedAt: Date;
  expiresAt?: Date;
  usesRemaining?: number;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  category: TaskCategory;
  xpReward: number;
  price: number;
  location: {
    city: string;
    latitude?: number;
    longitude?: number;
    address?: string;
  };
  deadline?: Date;
  estimatedDuration?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  imageUrls?: string[];
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  price?: number;
  deadline?: Date;
  status?: TaskStatus;
}

export interface TaskFilters {
  category?: TaskCategory;
  city?: string;
  minPrice?: number;
  maxPrice?: number;
  minXp?: number;
  maxXp?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  status?: TaskStatus;
}

export interface PaginationInput {
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}
