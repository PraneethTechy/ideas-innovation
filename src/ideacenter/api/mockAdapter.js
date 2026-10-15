// In-memory adapter standing in for the real API. Seeded with sample data, resets on reload.
// It also plays the SERVER's part (checks, permissions, ID generation) so the front end can be tried end to end.
// Rules mirror the brief; the real server must enforce them again.
import { ID_PREFIX, SCORING_CRITERIA, STATUSES, NEXT_STAGES, REJECTION_REASONS } from '../lookups.js';
import { canReview, canAssign, canVote, canBrowse, canSeeContact, canSeeDashboard, canSeeReviewQueue, isOwner } from '../permissions.js';
import { allScored, weightedScore } from '../lib/scoring.js';
import { validateIdea, isEmail } from '../lib/validate.js';
import { computeStats } from '../lib/stats.js';
import { ApiError } from './errors.js';
import { USERS, NAMES, REVIEWERS, buildSeed } from './seed.js';

export const MOCK_CODE = '123456'; // the mock accepts this email code
const MOCK_BOT_TOKEN = 'mock-bot-ok';

const STORAGE_KEY = 'spark_ideas_data_v2';

function loadStoredIdeas() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    }
  } catch (e) {
    console.warn('Could not read ideas from localStorage:', e);
  }
  return buildSeed();
}

function saveIdeas(list) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      window.dispatchEvent(new CustomEvent('spark:data_updated'));
    }
  } catch (e) {
    console.warn('Could not save ideas to localStorage:', e);
  }
}

let ideas = loadStoredIdeas();
let currentUserId = null; // null = public visitor
let failNext = 0; // dev tool: make the next N calls fail (to try error states and vote roll-back)

const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms + Math.random() * 140));
const me = () => (currentUserId ? USERS[currentUserId] : null);
const nameOf = (id) => NAMES[id] || '';

async function call(fn) {
  await delay();
  if (failNext > 0) {
    failNext -= 1;
    throw new ApiError('mock_failure', 'The mock server was told to fail this call.', 500);
  }
  return fn();
}
function requireUser() {
  const u = me();
  if (!u) throw new ApiError('unauthorized', 'Please sign in to do this.', 401);
  return u;
}
const getRaw = (id) => {
  const i = ideas.find((x) => x.id === id);
  if (!i) throw new ApiError('not_found', 'We could not find that idea.', 404);
  return i;
};
const nextId = () => {
  const max = ideas.reduce((m, i) => Math.max(m, parseInt(i.id.split('-')[1], 10)), 0);
  return `${ID_PREFIX}-${String(max + 1).padStart(4, '0')}`;
};
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// What the caller is allowed to see of an idea (never other people's votes, tokens or contact details).
function present(i, viewer) {
  const rest = { ...i };
  delete rest.votes;
  delete rest.trackingToken; // the private link is only ever returned once, when a guest submits
  return {
    ...rest,
    submitterEmail: canSeeContact(viewer, i) ? i.submitterEmail : undefined,
    assigneeName: nameOf(i.assigneeId),
    voteCount: i.votes.length,
    votedByMe: !!viewer && i.votes.includes(viewer.id),
    history: i.history.map((h) => ({ ...h })),
    scores: { ...i.scores },
  };
}

function applyQuery(list, q = {}) {
  const t = (q.q || '').trim().toLowerCase();
  const out = list.filter((i) => {
    if (q.status && i.status !== q.status) return false;
    if (q.category && i.category !== q.category) return false;
    if (q.technology && i.technology !== q.technology) return false;
    if (t && !`${i.title} ${i.id} ${i.submitterName} ${i.solution}`.toLowerCase().includes(t)) return false;
    return true;
  });
  return out.sort((a, b) => {
    if (q.sort === 'votes') return b.votes.length - a.votes.length || b.createdAt - a.createdAt;
    if (q.sort === 'score') return weightedScore(b.scores) - weightedScore(a.scores) || b.createdAt - a.createdAt;
    return b.createdAt - a.createdAt;
  });
}

function buildIdea(p, who, extra) {
  const now = Date.now();
  const domainVal = p.domain === 'Other' ? (p.otherDomain || 'Other') : (p.domain || '');
  const techVal = p.technology === 'Other' ? (p.otherTechnology || 'Other') : (p.technology || '');
  const timelineVal = p.timeline === 'Other' ? (p.otherTimeline || 'Other') : (p.timeline || '');
  const benefitVal = p.benefitType === 'Other' ? (p.otherBenefitType || 'Other') : (p.benefitType || '');
  const targetDeptVal = p.targetDept === 'Other' ? (p.otherTargetDept || 'Other') : (p.targetDept || '');
  return {
    id: nextId(),
    title: p.title.trim(), problem: p.problem.trim(), solution: p.solution.trim(),
    category: p.category || 'Process improvement',
    technology: techVal,
    domain: domainVal,
    timeline: timelineVal,
    targetDept: targetDeptVal,
    files: p.files || [],
    submitterType: who.submitterType, submitterId: who.id || null, submitterName: who.name, submitterEmail: who.email,
    dept: who.dept || targetDeptVal || '', manager: who.manager || '',
    benefitType: benefitVal, benefitDescription: p.benefitDescription.trim(),
    investment: p.investment === '' || p.investment == null ? null : Number(p.investment),
    financialBenefit: p.financialBenefit === '' || p.financialBenefit == null ? null : Number(p.financialBenefit),
    benefitPeriod: p.benefitPeriod || 'Annual', roiConfidence: p.roiConfidence || 'Rough',
    effort: p.effort || '', stack: (p.stack || '').trim(), plan: (p.plan || '').trim(),
    consent: !!p.consent, sensitive: p.sensitive || 'Not sure',
    createdAt: now, status: 'Submitted', assigneeId: '', votes: [], scores: {}, stage: '', reason: '', firstFeedbackAt: null,
    trackingToken: extra?.trackingToken || null,
    history: [{ t: now, who: who.name, text: 'Submitted' }],
  };
}

export const mockAdapter = {
  name: 'mock',

  // ---- dev-only helpers (not part of the interface) ----
  _setCurrentUser(id) { currentUserId = id && USERS[id] ? id : null; },
  _failNext(n = 1) { failNext = n; },
  _resetSeed() {
    ideas = buildSeed();
    saveIdeas(ideas);
    return ideas;
  },
  _reloadFromStorage() {
    ideas = loadStoredIdeas();
    return ideas;
  },

  // ---- signed in ----
  async getMe() { return call(() => (me() ? { ...me() } : null)); },

  async listIdeas(q = {}) {
    return call(() => {
      const u = me();
      let list = ideas;
      if (q.scope === 'mine') {
        requireUser();
        list = ideas.filter((i) => i.submitterId === u.id);
      } else if (q.scope === 'assigned') {
        if (!canSeeReviewQueue(u)) throw new ApiError('forbidden', 'You do not have access to the review queue.', 403);
        list = u.role === 'admin' ? ideas : ideas.filter((i) => i.assigneeId === u.id);
      } else if (!canBrowse(u)) {
        throw new ApiError('forbidden', 'Sign in to browse ideas.', 403);
      }
      return applyQuery(list, q).map((i) => present(i, u));
    });
  },

  async getIdea(id) {
    return call(() => {
      const u = requireUser();
      const i = getRaw(id);
      if (!canBrowse(u) && !isOwner(u, i)) throw new ApiError('forbidden', 'You cannot view this idea.', 403);
      return present(i, u);
    });
  },

  async createIdea(p) {
    return call(() => {
      const u = requireUser();
      const errors = validateIdea(p, { needsContact: false });
      if (Object.keys(errors).length) throw new ApiError('invalid', 'Some fields need attention.', 422);
      const idea = buildIdea(p, { ...u, submitterType: 'Employee' });
      ideas.unshift(idea);
      saveIdeas(ideas);
      return { id: idea.id };
    });
  },

  async toggleVote(id) {
    return call(() => {
      const u = requireUser();
      if (!canVote(u)) throw new ApiError('forbidden', 'You cannot vote.', 403);
      const i = getRaw(id);
      const k = i.votes.indexOf(u.id);
      if (k > -1) i.votes.splice(k, 1); else i.votes.push(u.id);
      saveIdeas(ideas);
      return { voteCount: i.votes.length, votedByMe: k === -1 };
    });
  },

  async assignReviewer(id, reviewerId) {
    return call(() => {
      const u = requireUser();
      if (!canAssign(u)) throw new ApiError('forbidden', 'Only an admin can assign a reviewer.', 403);
      const i = getRaw(id);
      if (reviewerId && !REVIEWERS.some((r) => r.id === reviewerId)) throw new ApiError('invalid', 'Choose a reviewer from the list.', 422);
      i.assigneeId = reviewerId || '';
      i.history.push({ t: Date.now(), who: u.name, text: reviewerId ? `Assigned to ${nameOf(reviewerId)}` : 'Unassigned' });
      saveIdeas(ideas);
      return present(i, u);
    });
  },

  async scoreIdea(id, criterion, value) {
    return call(() => {
      const u = requireUser();
      const i = getRaw(id);
      if (!canReview(u, i)) throw new ApiError('forbidden', 'Only the assigned reviewer or an admin can score.', 403);
      if (!SCORING_CRITERIA.some((c) => c.key === criterion) || ![1, 2, 3, 4, 5].includes(value)) {
        throw new ApiError('invalid', 'Scores run from 1 to 5.', 422);
      }
      i.scores[criterion] = value;
      saveIdeas(ideas);
      return present(i, u);
    });
  },

  async decide(id, { status, note = '', stage = '', reason = '' }) {
    return call(() => {
      const u = requireUser();
      const i = getRaw(id);
      if (!canReview(u, i)) throw new ApiError('forbidden', 'Only the assigned reviewer or an admin can decide.', 403);
      const n = note.trim();
      const bad = (m) => { throw new ApiError('invalid', m, 422); };
      if (!STATUSES.includes(status)) bad('Unknown status.');
      if (status === 'Approved') {
        if (!allScored(i.scores)) bad('Score every criterion before approving.');
        if (!NEXT_STAGES.includes(stage)) bad('Choose the next stage for this idea.');
      }
      if (status === 'Rejected') {
        if (!REJECTION_REASONS.includes(reason)) bad('Choose a reason for rejecting.');
        if (!n) bad('Add a short note so the submitter understands the decision.');
      }
      if (status === 'Needs info' && !n) bad('Write the question you need answered.');
      if (status === 'In build' && i.status !== 'Approved') bad('Only an approved idea can move to build.');
      if (status === 'Delivered' && i.status !== 'In build') bad('Only an idea in build can be marked delivered.');

      let text = {
        Approved: `Approved → ${stage}`, Rejected: `Rejected: ${reason}`, 'Needs info': `Needs info: ${n}`, Parked: 'Parked',
        'Under review': 'Started review', 'In build': 'Moved to In build', Delivered: 'Marked delivered',
      }[status];
      if (n && status !== 'Needs info') text += `. ${n}`;
      i.status = status;
      if (status === 'Approved') i.stage = stage;
      if (status === 'Rejected') i.reason = reason;
      if (!i.assigneeId && u.role !== 'admin') i.assigneeId = u.id; // a reviewer who decides on an unassigned idea becomes its reviewer
      if (!i.firstFeedbackAt) i.firstFeedbackAt = Date.now(); // the first decision or reply sets "first feedback"
      i.history.push({ t: Date.now(), who: u.name, text });
      saveIdeas(ideas);
      return present(i, u);
    });
  },

  async submitterReply(id, text) {
    return call(() => {
      const u = requireUser();
      const i = getRaw(id);
      if (!isOwner(u, i) || i.status !== 'Needs info') throw new ApiError('forbidden', 'You can only reply to your own idea when we have asked a question.', 403);
      const t = (text || '').trim();
      if (!t) throw new ApiError('invalid', 'Write a reply before sending.', 422);
      i.history.push({ t: Date.now(), who: u.name, text: `Submitter reply: ${t}` });
      i.status = 'Under review';
      i.history.push({ t: Date.now(), who: u.name, text: 'Returned to review after submitter response' });
      saveIdeas(ideas);
      return present(i, u);
    });
  },

  async listReviewers() { return call(() => REVIEWERS.map((r) => ({ ...r }))); },

  async getStats() {
    return call(() => {
      if (!canSeeDashboard(me())) throw new ApiError('forbidden', 'Only an admin can see the dashboard.', 403);
      return computeStats(ideas);
    });
  },

  // ---- public (no sign-in) ----
  async publicVerifyEmail(email) {
    return call(() => {
      if (!isEmail(email)) throw new ApiError('invalid', 'Enter a valid email address.', 422);
      return { sent: true }; // the real server emails a six-digit code
    });
  },
  // Added to the draft contract: the brief lists verify-email and a "verification token" but no step that swaps the code for the token.
  async publicVerifyCode(email, code) {
    return call(() => {
      if (String(code).trim() !== MOCK_CODE) throw new ApiError('invalid_code', 'That code is not right. Check your email and try again.', 422);
      return { verificationToken: `mock-verified:${String(email).trim().toLowerCase()}` };
    });
  },
  async publicCreateIdea(p) {
    return call(() => {
      if (p.verificationToken !== `mock-verified:${String(p.email || '').trim().toLowerCase()}`) {
        throw new ApiError('not_verified', 'Please verify your email first.', 400);
      }
      if (p.botToken !== MOCK_BOT_TOKEN) throw new ApiError('bot_check', 'Please complete the check to show you are a person.', 400);
      const errors = validateIdea(p, { needsContact: true });
      if (Object.keys(errors).length) throw new ApiError('invalid', 'Some fields need attention.', 422);
      const t = token();
      const idea = buildIdea(p, { id: null, name: p.name.trim(), email: p.email.trim(), submitterType: p.submitterType }, { trackingToken: t });
      ideas.unshift(idea);
      saveIdeas(ideas);
      return { id: idea.id, trackingUrl: `/ideas/track/${t}` };
    });
  },
  async publicTrack(tok) {
    return call(() => {
      const i = ideas.find((x) => x.trackingToken && x.trackingToken === tok);
      if (!i) throw new ApiError('not_found', 'We could not find an idea for that link. Check the link and try again.', 404);
      const lastQuestion = [...i.history].reverse().find((h) => h.text.startsWith('Needs info:'));
      return {
        id: i.id, title: i.title, status: i.status, createdAt: i.createdAt, firstFeedbackAt: i.firstFeedbackAt,
        stage: i.stage, reason: i.reason, question: i.status === 'Needs info' && lastQuestion ? lastQuestion.text.replace(/^Needs info:\s*/, '') : '',
        history: i.history.map((h) => ({ ...h })),
      };
    });
  },
  async publicTrackReply(tok, text) {
    return call(() => {
      const i = ideas.find((x) => x.trackingToken && x.trackingToken === tok);
      if (!i) throw new ApiError('not_found', 'We could not find an idea for that link.', 404);
      if (i.status !== 'Needs info') throw new ApiError('invalid', 'We are not waiting for a reply on this idea.', 422);
      const t = (text || '').trim();
      if (!t) throw new ApiError('invalid', 'Write a reply before sending.', 422);
      i.history.push({ t: Date.now(), who: i.submitterName, text: `Submitter reply: ${t}` });
      i.status = 'Under review';
      i.history.push({ t: Date.now(), who: i.submitterName, text: 'Returned to review after submitter response' });
      saveIdeas(ideas);
      return { ok: true };
    });
  },
  MOCK_BOT_TOKEN,
};
