import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { MOCK_TASKS } from '@/mocks/tasks';
import type { Task } from '@/types';

const STATUS_MAP: Record<string, Task['status'][]> = {
  active: ['open', 'accepted', 'in_progress'],
  open: ['open'],
  pending: ['accepted', 'in_progress'],
  completed: ['completed'],
  cancelled: ['cancelled'],
};

function matchesStatus(taskStatus: Task['status'], filter?: string) {
  if (!filter) {
    return true;
  }
  const normalized = filter.toLowerCase();
  const allowed = STATUS_MAP[normalized] || [normalized as Task['status']];
  return allowed.includes(taskStatus);
}

export const tasksListProcedure = protectedProcedure
  .input(
    z.object({
      category: z.string().optional(),
      city: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().default(20),
      offset: z.number().default(0),
    })
  )
  .query(({ input }) => {
    const normalizedCategory = input.category?.toLowerCase();
    const normalizedCity = input.city?.toLowerCase();

    const filtered = MOCK_TASKS.filter((task) => {
      const categoryMatch = !normalizedCategory || task.category.toLowerCase() === normalizedCategory;
      const cityMatch = !normalizedCity || task.location.address.toLowerCase().includes(normalizedCity);
      const statusMatch = matchesStatus(task.status, input.status);
      return categoryMatch && cityMatch && statusMatch;
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const start = input.offset;
    const end = start + input.limit;
    const paginated = filtered.slice(start, end);

    return {
      tasks: paginated,
      total: filtered.length,
      hasMore: end < filtered.length,
    };
  });
