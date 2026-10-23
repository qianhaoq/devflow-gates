'use strict';
// Source of truth: mirrored verbatim in both workflow scripts; tests enforce sync.
const OVERRIDE_HEADER = '## Test Integrity Override';
const ASSERT_RE = /\b(?:expect\s*\(|assert\s*(?:\(|\.|\s)|assert\w*\s*\(|assert_\w*!?\s*\(|XCTAssert\w*\s*\(|should\.|toBe\(|toEqual\(|toStrictEqual\(|toHaveBeenCalled|toMatchSnapshot|assertThat|pytest\.(?:raises|fail)|self\.assert|fail\s*\()/i;
function isRelevantPath(p) {
  return /(?:^|\/)(?:__tests__|tests|test|spec)(?:\/|$)|\.(?:test|spec)\.[jt]sx?$|_test\.py$|(?:^|\/)test_[^/]*\.py$|(?:^|\/)conftest\.py$|\.feature$|(?:^|\/)scripts\/(?:ci-check|check-|invariants)|invariant/i.test(p) || /monitor/i.test(p.split('/').pop());
}
function isWorkflowPath(p) { return /^\.github\/workflows\/.*\.ya?ml$/.test(p); }
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
function fileHunks(patch, python = false) {
  const groups = hunks(patch);
  const additions = groups.flatMap(h => h.added.map((line, index) => ({ h, line, index, used: false })));
  for (const h of groups) h.removed = h.removed.filter(line => {
    const match = additions.find(a => !a.used && normalized(a.line, python) === normalized(line, python));
    if (!match) return true;
    match.used = true; return false;
  });
  for (const h of groups) h.added = h.added.filter((_, index) => !additions.some(a => a.h === h && a.index === index && a.used));
  return groups;
}
function normalized(s, python = false) {
  const indent = python ? s.match(/^[ \t]*/)[0] : '';
  return indent + s.slice(indent.length).replace(/\s+/g, '');
}
function changed(h, python = false) {
  const added = [...h.added];
  const removed = h.removed.filter(line => {
    const i = added.findIndex(a => normalized(a, python) === normalized(line, python));
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
    if (f.status === 'removed' || (isRelevantPath(f.previous_filename || '') && !isRelevantPath(f.filename))) { out.push(finding(f, 'deleted test/monitor file', f.filename)); continue; }
    for (const raw of fileHunks(f.patch, /\.py$/.test(f.filename))) {
      const h = changed(raw, /\.py$/.test(f.filename)), removed = h.removed.filter(l => ASSERT_RE.test(l)), added = h.added.filter(l => ASSERT_RE.test(l));
      if (removed.length > added.length) out.push(finding(f, 'removed assertion without replacement', removed[0]));
      for (const l of h.added) {
        if (/expect\s*\(\s*true\s*\)|expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)|assert\s*\(\s*true\s*\)|assert\s+True\b|assert\.ok\s*\(\s*true\s*\)|(?:XCTAssertTrue|assertTrue)\s*\(\s*true|#\s*expect nothing/i.test(l) || (removed.length && /pass\s*#\s*noqa/.test(l)) || (removed.some(r => /\.to(?:Be|Equal|BeGreaterThan)\s*\(/.test(r)) && /expect\([^)]*\)\.toBeTruthy\s*\(\s*\)/.test(l))) out.push(finding(f, 'vacuous assertion', l));
      }
      // Compare only a single replacement with an identical expression/matcher.
      if (removed.length === 1 && added.length === 1) {
        const number = /-?\d+(?:\.\d+)?/g;
        const a = removed[0], b = added[0], na = [...a.matchAll(number)], nb = [...b.matchAll(number)];
        const differences = na.map((n, i) => n[0] !== nb[i]?.[0] ? i : -1).filter(i => i >= 0);
        if (na.length === nb.length && differences.length === 1 && normalized(a.replace(number, '#')) === normalized(b.replace(number, '#'))) {
          const comparison = /(?:>=?|<=?)/.exec(a);
          const index = differences[0], numberIndex = na[index].index;
          const numberOnLeft = comparison && numberIndex < comparison.index;
          const lower = /toBeGreaterThan(?:OrEqual)?\s*\(/.test(a) || (comparison && (numberOnLeft ? comparison[0].startsWith('<') : comparison[0].startsWith('>')));
          const upper = /toBeLessThan(?:OrEqual)?\s*\(/.test(a) || (comparison && (numberOnLeft ? comparison[0].startsWith('>') : comparison[0].startsWith('<')));
          if ((lower && +nb[index][0] < +na[index][0]) || (upper && +nb[index][0] > +na[index][0])) out.push(finding(f, 'loosened threshold', `${a.trim()} → ${b.trim()}`));
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
    const relevant = isRelevantPath(f.filename) || isRelevantPath(f.previous_filename || '');
    const workflow = isWorkflowPath(f.filename);
    if (!relevant && !workflow) continue;
    for (const raw of fileHunks(f.patch, /\.py$/.test(f.filename))) {
      const h = changed(raw, /\.py$/.test(f.filename));
      const testContext = [...raw.context, ...raw.added, ...raw.removed].some(s => /\b[\w-]*test[\w-]*["']?\s*:/i.test(s));
      for (const l of h.added) {
        if (workflow && /\bcontinue-on-error\s*:\s*true\b/.test(l) && testContext) out.push(finding(f, 'optional test workflow', l));
        if (relevant && /\.py$/.test(f.filename) && ASSERT_RE.test(l) && h.removed.some(r => normalized(r) === normalized(l) && r.match(/^[ \t]*/)[0].length < l.match(/^[ \t]*/)[0].length) && [...raw.context, ...raw.removed, ...raw.added].some(s => /\bif\s+(?:False|0)\s*:/.test(s))) out.push(finding(f, 'disabled assertion block', l));
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
module.exports = { isRelevantPath, isWorkflowPath, scanAssertionWeaken, scanSkipEvasion, parseOverrideComment, OVERRIDE_HEADER, summarizeFindings };
