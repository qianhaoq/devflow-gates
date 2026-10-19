'use strict';
// Pure helpers for Diff Quiz Gate. Mirrored inline in
// .github/workflows/understand-gate.yml (no checkout in the gate).
// Keep both in sync; tests require this file.

const QUIZ_MARKER = '<!-- diff-quiz-gate:quiz -->';
const ANSWER_HEADER = '## Diff Quiz Answer';
const OVERRIDE_HEADER = '## Diff Quiz Override';
const META_RE = /<!--\s*diff-quiz-meta:([\s\S]*?)-->/;

const DOC_RE = /(?:^|\/)(?:README[^/]*|LICENSE[^/]*|CHANGELOG[^/]*|.*\.mdx?)$/i;
const DOCS_DIR_RE = /(?:^|\/)docs\//;
const LOCK_RE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock|Pipfile\.lock|composer\.lock)$/;
const PROMO_RE = /(?:^|\/)(?:promo|marketing)(?:\/|$)/i;
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

function isDocPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return DOC_RE.test(s) || DOCS_DIR_RE.test(s);
}

function isLockPath(p) {
  return LOCK_RE.test(String(p || '').replace(/\\/g, '/'));
}

function isPromoPath(p) {
  return PROMO_RE.test(String(p || '').replace(/\\/g, '/'));
}

function isWorkflowPath(p) {
  return WORKFLOW_RE.test(String(p || '').replace(/\\/g, '/'));
}

/** Heuristic: workflow file patch only bumps action pin SHAs / tags. */
function isPinBumpPatch(patch) {
  if (!patch) return false;
  const lines = String(patch).split('\n').filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
  if (lines.length === 0) return false;
  return lines.every((l) => /uses:\s*\S+@[\w./-]+/.test(l) || /^\+\+\+|^---/.test(l));
}

/**
 * Light diff → 1 question; otherwise 2.
 * Light = all files are docs OR all locks OR all promo OR all workflow pin bumps.
 */
function isLightDiff(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return true;
  const paths = list.map((f) => f.filename || f.path || '');
  if (paths.every(isDocPath)) return true;
  if (paths.every(isPromoPath)) return true;
  if (paths.every(isLockPath)) return true;
  if (paths.every((p, i) => isWorkflowPath(p) && isPinBumpPatch(list[i].patch || ''))) return true;
  // Mixed only-docs+promo+locks+pin also light if every file fits one bucket
  return paths.every((p, i) =>
    isDocPath(p) || isPromoPath(p) || isLockPath(p) ||
    (isWorkflowPath(p) && isPinBumpPatch(list[i].patch || '')));
}

function nQuestionsFor(files) {
  return isLightDiff(files) ? 1 : 2;
}

function normalizeChoice(s) {
  return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseAnswerComment(body) {
  const text = String(body || '');
  if (!text.includes(ANSWER_HEADER)) return null;
  const after = text.split(ANSWER_HEADER).slice(1).join(ANSWER_HEADER);
  const answers = {};
  const re = /^\s*(\d+)\s*[.):、]\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(after)) !== null) {
    answers[Number(m[1])] = m[2].trim();
  }
  return Object.keys(answers).length ? answers : null;
}

function parseOverrideComment(body) {
  const text = String(body || '');
  if (!text.includes(OVERRIDE_HEADER)) return null;
  const after = text.split(OVERRIDE_HEADER).slice(1).join(OVERRIDE_HEADER).trim();
  // Require a non-empty reason (not just whitespace / dashes)
  const reason = after.replace(/^#+\s*/gm, '').trim();
  if (!reason || reason.length < 3) return null;
  return reason;
}

function extractQuizMeta(body) {
  const m = META_RE.exec(String(body || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

function gradeChoice(expected, given) {
  return normalizeChoice(expected) === normalizeChoice(given);
}

/**
 * Build visible quiz markdown + hidden meta.
 * meta: { sha, n, questions: [{ id, type, answer, rubric?, choices? }] }
 */
function formatQuizComment({ sha, questions, shortSha }) {
  const n = questions.length;
  const lines = [
    QUIZ_MARKER,
    `## Diff Quiz — 推送前理解门禁`,
    '',
    `Head: \`${shortSha || String(sha).slice(0, 7)}\` · 共 **${n}** 题`,
    '',
    '请确认你理解「这次改了什么 / 可能影响或破坏什么（含可能受影响的模块）」。',
    '在本 PR 评论按下列格式作答（作者或评审人均可）：',
    '',
    '```',
    ANSWER_HEADER,
    ...questions.map((q, i) => `${i + 1}. ${q.type === 'choice' ? 'A' : '…'}`),
    '```',
    '',
    '试验期逃生（必须留痕，禁止 skip label）：',
    '```',
    OVERRIDE_HEADER,
    '理由：…',
    '```',
    '',
  ];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    lines.push(`### ${i + 1}. ${q.prompt}`);
    if (q.type === 'choice' && Array.isArray(q.choices)) {
      for (const c of q.choices) {
        const letter = c.id || c.label || '';
        const text = c.text || c.body || '';
        lines.push(`- **${letter}**. ${text}`);
      }
    } else {
      lines.push('_（短答）_');
    }
    lines.push('');
  }
  const meta = {
    sha,
    n,
    questions: questions.map((q, i) => ({
      id: i + 1,
      type: q.type,
      answer: q.answer,
      rubric: q.rubric || '',
      choices: q.choices || undefined,
    })),
  };
  lines.push(`<!-- diff-quiz-meta:${JSON.stringify(meta)} -->`);
  return lines.join('\n');
}

function truncateDiff(text, maxChars) {
  const s = String(text || '');
  const lim = maxChars || 80000;
  if (s.length <= lim) return s;
  return s.slice(0, lim) + `\n\n…[diff truncated at ${lim} chars]`;
}

function buildDiffText(files) {
  const parts = [];
  for (const f of files || []) {
    const name = f.filename || f.path || 'unknown';
    parts.push(`--- a/${name}\n+++ b/${name}`);
    if (f.patch) parts.push(f.patch);
    else parts.push(`(no patch; status=${f.status || 'unknown'} additions=${f.additions || 0} deletions=${f.deletions || 0})`);
    parts.push('');
  }
  return truncateDiff(parts.join('\n'));
}

module.exports = {
  QUIZ_MARKER,
  ANSWER_HEADER,
  OVERRIDE_HEADER,
  isDocPath,
  isLockPath,
  isPromoPath,
  isWorkflowPath,
  isPinBumpPatch,
  isLightDiff,
  nQuestionsFor,
  normalizeChoice,
  parseAnswerComment,
  parseOverrideComment,
  extractQuizMeta,
  gradeChoice,
  formatQuizComment,
  truncateDiff,
  buildDiffText,
};
