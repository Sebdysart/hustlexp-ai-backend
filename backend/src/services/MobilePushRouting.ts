export type MobileAppVariant = 'poster' | 'business';

/** An action is product-owned only when its canonical path identifies the surface. */
export function mobileVariantsForDestination(destination: string | null | undefined): readonly MobileAppVariant[] {
  if (!destination || !destination.startsWith('/') || destination.startsWith('//') || /[\\\s%#]/.test(destination)) return [];
  const path = destination.split('?')[0];
  if (/^\/provider-os\/invite(?:\/|$)/.test(path)) return [];
  if (path === '/support' || /^\/support\/[0-9a-f-]{36}$/i.test(path) || path === '/settings') return ['poster', 'business'];
  if (path === '/dashboard' || /^\/dashboard\/(?:drafts|tasks)(?:\/|$)/.test(path)) return ['poster'];
  if (path === '/business/dashboard' || /^\/business\/(?:tasks|claims|proposals)(?:\/|$)/.test(path)
      || /^\/provider-os(?:\/|$)/.test(path)) return ['business'];
  return [];
}
