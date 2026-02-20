import { z } from 'zod';

const username = z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/);
const displayName = z.string().min(1).max(100);
const bio = z.string().max(500);
const taskTitle = z.string().min(5).max(200);
const taskDescription = z.string().min(20).max(5000);
const message = z.string().min(1).max(2000);
const reviewText = z.string().max(1000);
const email = z.string().email().max(254);
const url = z.string().url().max(2048);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export const idSchema = z.string().uuid();

export const monetaryAmountSchema = z.number().positive().multipleOf(0.01).max(999999.99);

export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export const userProfileSchema = z.object({
  username,
  displayName: displayName.optional(),
  bio: bio.optional(),
  avatarUrl: url.optional(),
});

export const taskCreateSchema = z.object({
  title: taskTitle,
  description: taskDescription,
  category: z.enum(['cleaning', 'delivery', 'moving', 'assembly', 'errands', 'other']),
  budgetMin: monetaryAmountSchema,
  budgetMax: monetaryAmountSchema,
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    address: z.string().min(1).max(500),
    city: z.string().min(1).max(100),
    state: z.string().min(1).max(100),
    zip: z.string().min(1).max(20),
  }),
  deadline: z.string().datetime().refine((val) => new Date(val) > new Date(), {
    message: 'Deadline must be in the future',
  }),
}).refine((data) => data.budgetMax >= data.budgetMin, {
  message: 'budgetMax must be greater than or equal to budgetMin',
  path: ['budgetMax'],
});

export const messageCreateSchema = z.object({
  conversationId: idSchema,
  content: message,
});

export const reviewCreateSchema = z.object({
  taskId: idSchema,
  rating: z.number().int().min(1).max(5),
  comment: reviewText.optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(8),
});

export const registerSchema = z.object({
  email,
  password: z.string().min(8).max(128),
  username,
  displayName: displayName.optional(),
});
