// Web-only projection. Preserve stored/native deep links and financial producers.
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const legacyTask = new RegExp(`^/(?:tasks|task)/(${uuid})(?:/(?:proof|applicants|accept|messages))?$`);
const detail = new RegExp(`^/(?:(?:dashboard/(?:tasks|drafts)|business/(?:tasks|claims|proposals)|ops/(?:tasks|drafts|posters|businesses|support)|support)/${uuid}|dashboard/drafts/${uuid}/quote)$`);
const pages = new Set(['/dashboard', '/business/dashboard', '/business/proposals', '/ops', '/ops/tasks', '/ops/drafts', '/ops/posters', '/ops/businesses', '/ops/support', '/ops/analytics', '/support', '/support/new', '/settings']);

function pathOnly(value: unknown): string | null {
  if (typeof value !== 'string' || /[\\\s%#]/.test(value)) return null;
  // The digest's week filter has no web equivalent; use its existing dashboard.
  if (/^\/business\/[0-9a-f-]+\/operations\?week=[0-9-]+$/i.test(value)) value = value.split('?')[0];
  if (typeof value !== 'string' || value.includes('?')) return null;
  const path = value.replace(/^(?:app|hustlexp):\/\//, '/');
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

export function notificationTaskId(value: unknown): string | null {
  const path = pathOnly(value);
  return path ? legacyTask.exec(path)?.[1] ?? null : null;
}

export function webNotificationDestination(value: unknown, taskViewer?: 'poster' | 'provider'): string | null {
  if (typeof value === 'string' && new RegExp(`^/provider-os/quotes/${uuid}\\?organizationId=${uuid}$`).test(value)) return value;
  const path = pathOnly(value);
  if (!path) return null;
  const taskId = notificationTaskId(path);
  if (taskId) return taskViewer === 'poster' ? `/dashboard/tasks/${taskId}` : taskViewer === 'provider' ? `/business/tasks/${taskId}` : null;
  if (pages.has(path) || detail.test(path)) return path;
  if (path === '/earnings' || /^\/(?:wallet\/|settings\/(?:payouts|payments|xp-tax))/.test(path)) return '/support';
  if (/^\/admin\/(?:escrows|stripe-events)\//.test(path)) return '/ops/tasks';
  if (new RegExp(`^/business/${uuid}/operations$`).test(path)) return '/business/dashboard';
  // Unsupported native-only features have no web action; never invent a page.
  return null;
}
