// Every permission decision lives here. The interface only HIDES things; the server enforces the rules.
// `user` is null for a public visitor (not signed in).
import { hasRole } from './roles.js';

export const isSignedIn = (user) => !!user;

// Browse the shared idea feed: signed-in associates and above. A public visitor can never browse.
export function canBrowse(user) {
  return hasRole(user, 'associate');
}

// May this user open this idea's details?
// TBC: should ideas flagged sensitive be hidden from ordinary associates? Not decided.
// If it is decided, change ONLY this function (e.g. return false when idea.sensitive === 'Yes' and
// the user is not staff and not the submitter).
export function canView(user, idea) {
  if (!user || !idea) return false;
  return hasRole(user, 'associate');
}

export const canVote = (user) => hasRole(user, 'associate');
export const isOwner = (user, idea) => !!user && !!idea && idea.submitterId === user.id;
export const canSeeReviewQueue = (user) => hasRole(user, 'reviewer');
export const canSeeDashboard = (user) => hasRole(user, 'admin');
export const canAssign = (user) => hasRole(user, 'admin');

// Reviewer who is assigned to the idea, or an admin.
export function canReview(user, idea) {
  if (!user || !idea) return false;
  if (hasRole(user, 'admin')) return true;
  return hasRole(user, 'reviewer') && idea.assigneeId === user.id;
}
export const canDecide = canReview;

// Contact details are shown only to staff on the idea and to the submitter.
export function canSeeContact(user, idea) {
  return canReview(user, idea) || isOwner(user, idea);
}

// Submitter replies to a "Needs info" question (signed-in path).
export function canReply(user, idea) {
  return isOwner(user, idea) && idea.status === 'Needs info';
}
