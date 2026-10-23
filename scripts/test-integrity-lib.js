'use strict';
// Source of truth: mirrored verbatim in both workflow scripts; tests enforce sync.
const OVERRIDE_HEADER = '## Test Integrity Override';
const ASSERT_RE = /\b(?:expect\s*\(|assert\s*(?:\(|\.|\s)|assert\w*\s*\(|assert_\w*!?\s*\(|XCTAssert\w*\s*\(|should\.|toBe\(|toEqual\(|toStrictEqual\(|toHaveBeenCalled|toMatchSnapshot|assertThat|pytest\.(?:raises|fail)|self\.assert|fail\s*\()/i;
function isRelevantPath(p) {
  return /(?:^|\/)(?:__tests__|tests|test|spec)(?:\/|$)|\.(?:test|spec)\.[jt]sx?$|_test\.py$|(?:^|\/)test_[^/]*\.py$|(?:^|\/)conftest\.py$|\.feature$|(?:^|\/)scripts\/(?:ci-check|check-|invariants)|invariant/i.test(p) || /monitor/i.test(p.split('/').pop());
}
function hunks(patch) {
  const result = []; let h;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('@@') || !h) { h = { removed: [], added: [], context: [] }; result.push(h); }
    if (/^(---|\+\+\+)/.test(line)) continue;
    if (line.startsWith('-')) h.removed.push(line.slice(1));
    else if (line.startsWith('+')) h.added.push(line.slice(1));
    else if (line.startsWith(' ')) h.context.push(line.slice(1));
  }
  return result;
}
// Cancel exact/whitespace-only moves across hunks, not just within one hunk.
function fileHunks(patch) {
  const groups = hunks(patch);
  const additions = groups.flatMap(h => h.added.map((line, index) => ({ h, line, index, used: false })));
  for (const h of groups) h.removed = h.removed.filter(line => {
    const match = additions.find(a => !a.used && normalized(a.line) === normalized(line));
    if (!match) return true;
    match.used = true; return false;
  });
  for (const h of groups) h.added = h.added.filter((_, index) => !additions.some(a => a.h === h && a.index === index && a.used));
  return groups;
}
function normalized(s) { return s.replace(/\s+/g, ''); }
function changed(h) {
  const added = [...h.added];
  const removed = h.removed.filter(line => {
    const i = added.findIndex(a => normalized(a) === normalized(line));
    if (i < 0) return true;
    added.splice(i, 1); return false;
  });
  return { removed, added, context: h.context };
}
function finding(file, rule, detail, confidence = 'high') { return { path: file.filename, rule, detail: detail.trim().slice(0, 240), confidence }; }
function scanAssertionWeaken(files) {
  const out = [];
  for (const f of files) {
    if (!isRelevantPath(f.filename) && !isRelevantPath(f.previous_filename || '')) continue;
    if (f.status === 'removed') { out.push(finding(f, 'deleted test/monitor file', f.filename)); continue; }
    for (const raw of fileHunks(f.patch)) {
      const h = changed(raw), removed = h.removed.filter(l => ASSERT_RE.test(l)), added = h.added.filter(l => ASSERT_RE.test(l));
      if (removed.length > added.length) out.push(finding(f, 'removed assertion without replacement', removed[0]));
      for (const l of h.added) {
        if (/expect\s*\(\s*true\s*\)|expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)|assert\s*\(\s*true\s*\)|assert\s+True\b|assert\.ok\s*\(\s*true\s*\)|(?:XCTAssertTrue|assertTrue)\s*\(\s*true|#\s*expect nothing/i.test(l) || (removed.length && /pass\s*#\s*noqa/.test(l)) || (removed.some(r => /\.to(?:Be|Equal|BeGreaterThan)\s*\(/.test(r)) && /expect\([^)]*\)\.toBeTruthy\s*\(\s*\)/.test(l))) out.push(finding(f, 'vacuous assertion', l));
      }
      // Compare only a single replacement with an identical expression/matcher.
      if (removed.length === 1 && added.length === 1) {
        const number = /-?\d+(?:\.\d+)?/g;
        const a = removed[0], b = added[0], na = a.match(number), nb = b.match(number);
        if (na?.length === 1 && nb?.length === 1 && normalized(a.replace(number, '#')) === normalized(b.replace(number, '#'))) {
          const lower = /(?:>=?|toBeGreaterThan(?:OrEqual)?\s*\()/.test(a);
          const upper = /(?:<=?|toBeLessThan(?:OrEqual)?\s*\()/.test(a);
          if ((lower && +nb[0] < +na[0]) || (upper && +nb[0] > +na[0])) out.push(finding(f, 'loosened threshold', `${a.trim()} → ${b.trim()}`));
        }
        if (/\.toBe\s*\(/.test(a) && /\.toBeGreaterThan\s*\(\s*0\s*\)/.test(b)) out.push(finding(f, 'weaker matcher', b));
      }
    }
  }
  return out;
}
const SKIP_RE = /\b(?:test|it|describe|context|suite)\.(?:skip|todo)\b|\b(?:xit|xdescribe|xtest|pending)\s*\(|\bpytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.skip|@Ignore\b|\bfdescribe\b|\bfit\s*\(|\.only\b/;
function scanSkipEvasion(files) {
  const out = [];
  for (const f of files) {
    const relevant = isRelevantPath(f.filename);
    const workflow = /^\.github\/workflows\/.*\.ya?ml$/.test(f.filename);
    if (!relevant && !workflow) continue;
    for (const raw of fileHunks(f.patch)) {
      const h = changed(raw);
      for (const l of h.added) {
        if (relevant && SKIP_RE.test(l)) out.push(finding(f, 'skip/focus introduced', l));
        if (/\.(?:ya?ml|json)$/i.test(f.filename) && /["']?(?:optional|require[d])["']?\s*:\s*(?:true|false)/.test(l) && /(?:optional["']?\s*:\s*true|required["']?\s*:\s*false)/.test(l) && (relevant || [...raw.context, ...raw.added, ...raw.removed].some(s => /\btest[\w-]*["\']?\s*:/i.test(s)))) out.push(finding(f, 'optional test config', l));
        if (relevant && /\.py$/.test(f.filename) && /\bif\s+(?:False|0)\s*:/.test(l) && [...h.removed, ...h.context, ...h.added].some(s => ASSERT_RE.test(s))) out.push(finding(f, 'disabled assertion block', l));
      }
    }
  }
  return out;
}
function parseOverrideComment(body) {
  const match = String(body || '').match(/^## Test Integrity Override\s*\r?\n(?:理由|Reason)\s*[:：]\s*([^]*?)(?=\n## |$)/im);
  const reason = match?.[1].trim();
  return reason && reason.length >= 3 ? reason : null;
}
function summarizeFindings(findings) {
  return findings.slice(0, 10).map(f => `- [${f.confidence}] ${f.path}: ${f.rule} — ${f.detail}`).join('\n') + (findings.length > 10 ? `\n… ${findings.length - 10} more` : '');
}
module.exports = { isRelevantPath, scanAssertionWeaken, scanSkipEvasion, parseOverrideComment, OVERRIDE_HEADER, summarizeFindings };
