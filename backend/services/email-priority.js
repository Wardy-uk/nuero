'use strict';

const vaultCache = require('./vault-cache');

// Derived from People/ frontmatter (#13) rather than typed here. This list had
// Arman Shazad on it three days after he left the business — which meant mail
// from a departed colleague still scored as a direct report.
const teamRoster = require('./team-roster');

const LEADERSHIP_SENDERS = [
  'Chris Middleton',
];

const URGENT_KEYWORDS = [
  'urgent',
  'escalation',
  'complaint',
  'legal',
  'outage',
  // Never bare 'down' (30 Oct 2026): Rab's down-jacket marketing went urgent on it.
  'is down',
  'are down',
  'went down',
  'gone down',
  'site down',
  'system down',
  'server down',
  'incident',
  'major incident',
  'sev1',
  'sev 1',
  'p1',
  'critical',
  'sla',
  'breach',
  'churn',
  'cancel',
  'cancellation',
  'terminate',
  'termination',
  'ombudsman',
  'ceo',
  'director complaint',
];

const DISTRESS_KEYWORDS = [
  'no response',
  'still waiting',
  'chasing',
  'angry',
  'frustrated',
  'upset',
  'disappointed',
  'unhappy',
  'not working',
  'broken',
  'breached',
  'missed deadline',
  'customer threatening',
];

const BLOCKER_KEYWORDS = [
  'need your decision',
  'need your input',
  'need approval',
  'please approve',
  'can you approve',
  'blocked',
  'stuck',
  'cannot proceed',
  'can\'t proceed',
  'need sign off',
  'need sign-off',
  'what do you want me to do',
];

const REPLY_SIGNAL_KEYWORDS = [
  'please reply',
  'please respond',
  'please confirm',
  'can you',
  'could you',
  'would you',
  'are you able',
  'let me know',
  'what do you think',
  'do you agree',
  'can we',
  'shall we',
  'when can',
  'when will',
  'need your response',
  'need your view',
  'waiting on you',
];

const NOISE_KEYWORDS = [
  'newsletter',
  'unsubscribe',
  'digest',
  'daily report',
  'weekly report',
  'grafana',
  'jira notification',
  'n8n',
  'automated',
  'system alert',
  'do not reply',
  'donotreply',
  'no-reply',
  'noreply',
  'market update',
  'property news',
  'register free',
  'view in browser',
  'last seats',
  'copilot chat',
  'introducing ',
];

const BATCHABLE_KEYWORDS = [
  'approval',
  'approve',
  'review request',
  'for approval',
];

function words(value) {
  return String(value || '').toLowerCase();
}

function csvEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

// Whole words, not substrings (30 Oct 2026): 'sla' matched "translate" and
// "Slack", 'legal' matched "illegal", 'p1' matched "p100". A boundary is only
// required where the needle itself starts/ends on a word character, so
// 'introducing ' and 'no-reply' keep meaning what they meant.
function needleRe(needle) {
  const n = String(needle).toLowerCase();
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${/^\w/.test(n) ? '\\b' : ''}${esc}${/\w$/.test(n) ? '\\b' : ''}`);
}

function includesAny(haystack, needles) {
  return needles.some((needle) => needleRe(needle).test(haystack));
}

const OWN_DOMAINS = String(process.env.WATCHED_OWN_DOMAINS || 'nurtur.tech')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function isInternal(fromEmail) {
  const m = /@([^@\s>]+)$/.exec(String(fromEmail || '').trim().toLowerCase());
  return !!m && OWN_DOMAINS.some((d) => m[1] === d || m[1].endsWith(`.${d}`));
}

function hasQuestionRequest(subject, preview) {
  const text = `${String(subject || '')} ${String(preview || '')}`;
  return /\b(can|could|would|will|should|how|what|when|where|why|who|please)\b[^.?!\n]{0,140}\?/i.test(text);
}

function isKnownPerson(fromName) {
  try {
    const people = vaultCache.getPeopleIndex();
    const low = words(fromName);
    return people.some((person) => low.includes(words(person)));
  } catch {
    return false;
  }
}

function isDirectReport(fromName) {
  const low = words(fromName);
  // Matched on the full name, as before — `words()` normalises both sides, and
  // a bare first name is not an identifier (mistakes.md, 15 Aug).
  return teamRoster.directReports().some((p) => low.includes(words(p.name)));
}

function isLeadershipSender(fromName) {
  const low = words(fromName);
  return [...LEADERSHIP_SENDERS, ...csvEnv('EMAIL_LEADERSHIP_SENDERS')]
    .some((name) => low.includes(words(name)));
}

function isUrgentSender(fromName, fromEmail) {
  const lowName = words(fromName);
  const lowEmail = words(fromEmail);
  return csvEnv('EMAIL_URGENT_SENDERS').some((sender) => lowName.includes(words(sender)) || lowEmail.includes(words(sender)));
}

function isAutomated(fromName, fromEmail, subject, preview) {
  const sender = `${words(fromName)} ${words(fromEmail)}`;
  const text = `${words(subject)} ${words(preview)}`;
  return (
    sender.includes('no-reply') ||
    sender.includes('noreply') ||
    sender.includes('donotreply') ||
    sender.includes('mailer-daemon') ||
    includesAny(text, NOISE_KEYWORDS) ||
    includesAny(sender, ['jira', 'grafana', 'mailer', 'notification', 'alerts'])
  );
}

function ageHours(email) {
  const received = email?.received || email?.created_at;
  if (!received) return null;
  const parsed = new Date(received).getTime();
  if (!Number.isFinite(parsed)) return null;
  return (Date.now() - parsed) / 3600000;
}

function describeSenderBucket(fromName, fromEmail) {
  if (isUrgentSender(fromName, fromEmail)) return 'priority sender';
  if (isLeadershipSender(fromName)) return 'leadership sender';
  if (isDirectReport(fromName)) return 'direct report';
  if (isKnownPerson(fromName)) return 'known person';
  return null;
}

function judge(email) {
  const fromName = email?.from || '';
  const fromEmail = email?.fromEmail || '';
  const subject = email?.subject || '';
  const preview = email?.preview || '';
  const subjectText = words(subject);
  const bodyText = words(`${subject} ${preview}`);
  const age = ageHours(email);
  const reasons = [];

  const automated = isAutomated(fromName, fromEmail, subject, preview);
  if (automated) {
    return {
      lane: 'ignore',
      category: 'IGNORE',
      urgency: 'low',
      forced: true,
      reasons: ['Automated noise'],
    };
  }

  const senderBucket = describeSenderBucket(fromName, fromEmail);
  const urgentSender = isUrgentSender(fromName, fromEmail);
  const leadership = isLeadershipSender(fromName);
  const directReport = isDirectReport(fromName);
  const keywordUrgent = includesAny(bodyText, URGENT_KEYWORDS);
  const distress = includesAny(bodyText, DISTRESS_KEYWORDS);
  const blocker = includesAny(bodyText, BLOCKER_KEYWORDS);
  const explicitReplySignal = includesAny(bodyText, REPLY_SIGNAL_KEYWORDS) || hasQuestionRequest(subject, preview);
  const batchable = includesAny(bodyText, BATCHABLE_KEYWORDS);

  let score = 0;

  if (senderBucket) {
    reasons.push(senderBucket);
    if (urgentSender) score += 45;
    else if (leadership) score += 28;
    else if (directReport) score += 18;
    else score += 8;
  }

  if (keywordUrgent) {
    reasons.push('urgent language');
    score += 34;
  }
  if (distress) {
    reasons.push('customer distress');
    score += 30;
  }
  if (blocker) {
    reasons.push('needs decision');
    score += 22;
  }
  if (explicitReplySignal) {
    reasons.push('reply requested');
    score += 16;
  }
  if (email?.importance === 'high') {
    reasons.push('flagged important');
    score += 18;
  }
  if (email?.isFlagged) {
    reasons.push('flagged');
    score += 12;
  }
  if (email?.isRead === false) {
    reasons.push('unread');
    score += 8;
  }
  if (age != null && email?.isRead === false) {
    if (age >= 12) {
      reasons.push('stale unread');
      score += 18;
    } else if (age >= 4) {
      reasons.push('aging unread');
      score += 10;
    }
  }
  if (batchable) {
    reasons.push('batchable approval');
    score -= 14;
  }

  const actionable = keywordUrgent || distress || blocker || leadership || directReport || urgentSender || explicitReplySignal || email?.importance === 'high' || email?.isFlagged;
  if (!actionable && score < 14) {
    return {
      lane: 'fyi',
      category: 'FYI',
      urgency: 'low',
      forced: false,
      reasons: reasons.length ? reasons : ['Informational'],
    };
  }

  // URGENT needs two independent signals (30 Oct 2026). One keyword alone used
  // to force it, so a ticket thread titled "Forms not working" read as customer
  // distress and went urgent over a colleague asking a follow-up — work that
  // needs attention, not an interruption. One signal now lands in `reply`.
  const urgencySignals = [keywordUrgent, distress, leadership, email?.importance === 'high', email?.isFlagged]
    .filter(Boolean).length;
  const urgent = urgentSender || urgencySignals >= 2 || score >= 60;
  if (urgent) {
    return {
      lane: 'urgent',
      category: 'ACTION',
      urgency: 'high',
      forced: true,
      reasons: reasons.length ? reasons.slice(0, 4) : ['Needs action'],
    };
  }

  if (directReport && (blocker || explicitReplySignal || email?.importance === 'high' || email?.isFlagged)) {
    return {
      lane: 'reply',
      category: 'ACTION',
      urgency: 'medium',
      forced: true,
      reasons: reasons.length ? reasons.slice(0, 4) : ['Direct report needs reply'],
    };
  }

  if (leadership || blocker || explicitReplySignal || email?.isFlagged || email?.importance === 'high'
    || keywordUrgent || distress) {
    return {
      lane: 'reply',
      category: 'ACTION',
      urgency: 'medium',
      forced: true,
      reasons: reasons.length ? reasons.slice(0, 4) : ['Needs reply'],
    };
  }

  if (batchable) {
    return {
      lane: 'delegate',
      category: 'DELEGATE',
      urgency: 'low',
      forced: true,
      reasons: reasons.length ? reasons.slice(0, 4) : ['Batch later'],
    };
  }

  return {
    lane: 'fyi',
    category: 'FYI',
    urgency: 'low',
    forced: false,
    reasons: reasons.length ? reasons.slice(0, 4) : ['Informational'],
  };
}

// `internal` and `senderKnown` let the blend in email-triage trust the model's
// IGNORE for marketing from an unknown outside sender — the rules here only see
// subject + preview, and a newsletter's opening line can say anything.
function evaluateEmail(email) {
  const fromName = email?.from || '';
  const fromEmail = email?.fromEmail || '';
  return {
    ...judge(email),
    internal: isInternal(fromEmail),
    senderKnown: !!describeSenderBucket(fromName, fromEmail),
  };
}

module.exports = {
  evaluateEmail,
  _internals: { includesAny, isInternal },
};
