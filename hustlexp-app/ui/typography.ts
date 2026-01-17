/**
 * Design Tokens: Typography
 * 
 * MAX-tier typography constants.
 * Hard values only. No responsive system yet.
 */

export const typography = {
  header: {
    fontSize: 28,
    fontWeight: '700' as const,
  },
  body: {
    fontSize: 14,
  },
} as const;
