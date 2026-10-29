/**
 * All user-facing dates are in India time.
 *
 * Why: Render and Supabase run in UTC. Before this, an entry made at 2 AM IST
 * showed the previous day's date in the Khata PDF.
 */
export const BUSINESS_TZ = 'Asia/Kolkata';

export function formatDateIST(d: Date | string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(d));
}

export function formatDateTimeIST(d: Date | string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(d));
}
