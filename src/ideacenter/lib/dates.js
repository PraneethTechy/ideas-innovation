import { REPLY_SLA_DAYS } from '../lookups.js';

export const DAY = 86400000;
export const fdate = (t) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
export const daysSince = (t) => Math.floor((Date.now() - t) / DAY);

// Reply-promise badge: replied on a date, due in N days (amber at 3 or fewer), or N days overdue (red).
export function dueInfo(idea) {
  if (idea.firstFeedbackAt) return { kind: 'ok', text: `Replied ${fdate(idea.firstFeedbackAt)}` };
  const left = REPLY_SLA_DAYS - daysSince(idea.createdAt);
  if (left < 0) return { kind: 'late', text: `${-left} ${-left === 1 ? 'day' : 'days'} overdue` };
  if (left <= 3) return { kind: 'soon', text: `Reply due in ${left} ${left === 1 ? 'day' : 'days'}` };
  return { kind: 'ok', text: `Reply due in ${left} days` };
}
