// Dry-run tests for the inline github-script gate logic.
// Extracts each `script: |` block from the reusable workflows and runs it
// in an AsyncFunction with mocked github/context/core. No network.
// Run: node tests/gates.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function scripts(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', '.github/workflows', file), 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)script: \|\s*$/);
    if (!m) continue;
    const ind = m[1].length;
    const body = [];
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() !== '' && l.match(/^\s*/)[0].length <= ind) { i--; break; }
      body.push(l);
    }
    const strip = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    out.push(body.map((l) => l.slice(strip)).join('\n'));
  }
  return out;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Pull the pure classifier functions out of a script (everything before
// the first top-level `const prNumber`/`async function`) and expose them.
function classifier(file, env) {
  const src = scripts(file)[0];
  const flag = src.match(/^const BLOCK_UNLABELED = .*$/m);
  assert.ok(flag, `${file}: BLOCK_UNLABELED not found`);
  const start = src.indexOf('function severityMarker');
  const end = src.indexOf('async function count', start);
  assert.ok(start >= 0 && end > start, `${file}: classifier region not found`);
  const head = flag[0] + '\n' + src.slice(start, end);
  const fn = new Function('context', 'process', 'github', 'core',
    head + '\nreturn { severityMarker, isBlockingSeverity, isBlockingThreadBodies,' +
    " isBlockingNonCodexThread: typeof isBlockingNonCodexThread === 'function' ? isBlockingNonCodexThread : null };");
  return fn({ repo: { owner: 'o', repo: 'r' }, payload: {} }, { env }, {}, {});
}

let failures = 0;
function t(name, f) {
  return Promise.resolve().then(f).then(
    () => console.log('ok   ' + name),
    (e) => { failures++; console.log('FAIL ' + name + '\n     ' + e.message); });
}

const P1 = '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Fix it**';
const P2 = '**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Nit**';
const UNL = 'This handles the edge case wrongly when the list is empty.';
const UNL_KW = 'This is a security problem.';

(async () => {
  for (const file of ['codex-gate.yml', 'auto-merge.yml']) {
    const def = classifier(file, {});
    const on = classifier(file, { BLOCK_UNLABELED: 'true' });
    const off = classifier(file, { BLOCK_UNLABELED: 'false' });
    await t(`${file}: unlabeled blocks by default`, () => {
      assert.strictEqual(def.isBlockingThreadBodies([UNL]), true);
      assert.strictEqual(on.isBlockingThreadBodies([UNL]), true);
    });
    await t(`${file}: opt-out → keyword-only`, () => {
      assert.strictEqual(off.isBlockingThreadBodies([UNL]), false);
      assert.strictEqual(off.isBlockingThreadBodies([UNL_KW]), true);
    });
    await t(`${file}: P0/P1 always block`, () => {
      for (const c of [def, off]) {
        assert.strictEqual(c.isBlockingThreadBodies([P1]), true);
        assert.strictEqual(c.isBlockingThreadBodies(['[P0] boom']), true);
        assert.strictEqual(c.isBlockingThreadBodies([P2, 'P1: escalated']), true);
      }
    });
    await t(`${file}: explicit P2 never blocks (incl. unlabeled follow-ups)`, () => {
      for (const c of [def, off]) {
        assert.strictEqual(c.isBlockingThreadBodies([P2]), false);
        assert.strictEqual(c.isBlockingThreadBodies([P2 + ' security token leak']), false);
        assert.strictEqual(c.isBlockingThreadBodies([P2, 'thanks, fixed']), false);
      }
    });
    await t(`${file}: later P2 cannot downgrade unlabeled opener`, () => {
      assert.strictEqual(def.isBlockingThreadBodies([UNL, P2]), true);
    });
  }
  const am = classifier('auto-merge.yml', { BLOCK_UNLABELED: 'false' });
  await t('auto-merge: Copilot/human P2 threads do not block', () => {
    assert.strictEqual(am.isBlockingNonCodexThread(['P2: optional nit']), false);
    assert.strictEqual(am.isBlockingNonCodexThread(['[P2] optional']), false);
    assert.strictEqual(am.isBlockingNonCodexThread(['**P2** human note', 'ack']), false);
  });
  await t('auto-merge: Copilot/human P1 or unlabeled threads block', () => {
    assert.strictEqual(am.isBlockingNonCodexThread(['P1: bug']), true);
    assert.strictEqual(am.isBlockingNonCodexThread(['please rename this']), true);
    assert.strictEqual(am.isBlockingNonCodexThread(['P2: nit', '[P1] actually this breaks prod']), true);
  });

  // Copilot gate: 'head' (strict, default) vs 'any' (reviewed once, any commit).
  const copilot = (() => {
    const src = scripts('auto-merge.yml')[0];
    const logins = src.match(/const COPILOT_LOGINS = new Set\(\[[\s\S]*?\]\);/);
    const start = src.indexOf('function copilotReviewAllowsMerge');
    const end = src.indexOf('async function candidatePrNumbers', start);
    assert.ok(logins && start >= 0 && end > start, 'auto-merge.yml: copilot region not found');
    return new Function(logins[0] + '\n' + src.slice(start, end) + '\nreturn copilotGateDecision;')();
  })();
  const CH = 'c0ffee0000000000000000000000000000000000';
  const OLD = 'babe000000000000000000000000000000000000';
  const crev = (state, commit_id, submitted_at, login = 'copilot-pull-request-reviewer[bot]') => ({ state, commit_id, submitted_at, user: { login } });
  const cchk = (status, conclusion) => ({ name: 'copilot-pull-request-reviewer', status, conclusion });
  await t('auto-merge copilot head: review only on an older commit stalls (strict default)', () => {
    const d = copilot([crev('COMMENTED', OLD, '2026-10-17T01:00:00Z')], [], CH, 1, 'head');
    assert.strictEqual(d.ok, false);
    assert.match(d.msg, /missing on head SHA/);
    assert.strictEqual(copilot([crev('COMMENTED', CH, '2026-10-17T01:00:00Z')], [], CH, 1, 'head').ok, true);
    assert.strictEqual(copilot([crev('COMMENTED', CH, '2026-10-17T01:00:00Z')], [cchk('completed', 'failure')], CH, 1, 'head').ok, false);
  });
  await t('auto-merge copilot any: one review on an older commit satisfies', () => {
    const d = copilot([crev('COMMENTED', OLD, '2026-10-17T01:00:00Z')], [], CH, 1, 'any');
    assert.strictEqual(d.ok, true, d.msg);
    // A failed (quota) head check does not block in 'any' scope.
    assert.strictEqual(copilot([crev('APPROVED', OLD, '2026-10-17T01:00:00Z')], [cchk('completed', 'failure')], CH, 1, 'any').ok, true);
  });
  await t('auto-merge copilot any: no review / dismissed / other user → blocks', () => {
    assert.match(copilot([], [], CH, 1, 'any').msg, /no Copilot review on any commit/);
    assert.strictEqual(copilot([crev('DISMISSED', OLD, '2026-10-17T01:00:00Z')], [], CH, 1, 'any').ok, false);
    assert.strictEqual(copilot([crev('APPROVED', CH, '2026-10-17T01:00:00Z', 'someone')], [], CH, 1, 'any').ok, false);
  });
  await t('auto-merge copilot any: latest CHANGES_REQUESTED vetoes; a later COMMENTED clears it', () => {
    const cr = crev('CHANGES_REQUESTED', OLD, '2026-10-17T02:00:00Z');
    assert.match(copilot([crev('COMMENTED', OLD, '2026-10-17T01:00:00Z'), cr], [], CH, 1, 'any').msg, /CHANGES_REQUESTED/);
    assert.strictEqual(copilot([cr, crev('COMMENTED', CH, '2026-10-17T03:00:00Z')], [], CH, 1, 'any').ok, true);
  });
  await t('auto-merge copilot any: a running head Copilot check does not stall (no re-trigger when it ends)', () => {
    assert.strictEqual(copilot([crev('COMMENTED', OLD, '2026-10-17T01:00:00Z')], [cchk('in_progress', null)], CH, 1, 'any').ok, true);
    assert.strictEqual(copilot([], [cchk('in_progress', null)], CH, 1, 'any').ok, false);
    // 'head' scope keeps waiting on a pending check (unchanged behaviour).
    assert.strictEqual(copilot([crev('COMMENTED', CH, '2026-10-17T01:00:00Z')], [cchk('in_progress', null)], CH, 1, 'head').ok, false);
  });

  // Required-check classification (A2: a cancelled LATEST run heals + skips —
  // never a pass, never a final red; missing/expected skip; only success passes).
  const required = (() => {
    const src = scripts('auto-merge.yml')[0];
    const start = src.indexOf('function workflowRunIdFromCheck');
    const end = src.indexOf('async function candidatePrNumbers', start);
    assert.ok(start >= 0 && end > start, 'auto-merge.yml: required-check region not found');
    return new Function(src.slice(start, end) + '\nreturn { classifyRequiredCheck, workflowRunIdFromCheck };')();
  })();
  await t('auto-merge: classifyRequiredCheck — cancelled heals, missing/expected skip, only success passes', () => {
    assert.strictEqual(required.classifyRequiredCheck(null).state, 'missing');
    assert.strictEqual(required.classifyRequiredCheck({ status: 'queued', conclusion: null }).state, 'expected');
    assert.strictEqual(required.classifyRequiredCheck({ status: 'in_progress' }).state, 'expected');
    assert.strictEqual(required.classifyRequiredCheck({ status: 'completed', conclusion: 'success' }).state, 'success');
    // A cancelled latest run is NOT treated as a permanent failure (heal+skip)…
    assert.strictEqual(required.classifyRequiredCheck({ status: 'completed', conclusion: 'cancelled' }).state, 'cancelled');
    // …and not as success either — Codex/QA are never bypassed by a cancel.
    assert.notStrictEqual(required.classifyRequiredCheck({ status: 'completed', conclusion: 'cancelled' }).state, 'success');
    for (const c of ['failure', 'timed_out', 'skipped', 'startup_failure']) {
      assert.strictEqual(required.classifyRequiredCheck({ status: 'completed', conclusion: c }).state, 'bad');
    }
  });
  await t('auto-merge: workflowRunIdFromCheck parses the run id from details/html URL', () => {
    assert.strictEqual(required.workflowRunIdFromCheck({ details_url: 'https://github.com/o/r/actions/runs/1111/job/2222', html_url: 'https://github.com/o/r/actions/runs/1111' }), 1111);
    assert.strictEqual(required.workflowRunIdFromCheck({ html_url: 'https://github.com/o/r/actions/runs/98765' }), 98765);
    assert.strictEqual(required.workflowRunIdFromCheck({ html_url: 'https://example.com/no-run-id' }), null);
    assert.strictEqual(required.workflowRunIdFromCheck({}), null);
    assert.strictEqual(required.workflowRunIdFromCheck(null), null);
  });

  // QA gate dry-run.
  const qa = scripts('qa-gate.yml')[0];
  const HEAD = 'abcdef1234567abcdef1234567abcdef12345678';
  const PREV = '1111111111111111111111111111111111111111';
  // Default head observations: HEAD's run long before any label below.
  const RUNS0 = [[HEAD, '2026-01-15T00:00:00Z']];
  async function runQa({ draft, action, labels, events = [], allowed = '', updatedAt, runs = RUNS0, timeline = [], headRepo = 'o/r', runPrs = [1], dispatch = [], eventsLater }) {
    let evCalls = 0;
    const calls = { removed: [], failed: null, info: [] };
    const mkRun = (event) => ([sha, at, extra = {}], i) => ({ id: i + 1, event, head_sha: sha, head_branch: 'feat', head_repository: { full_name: headRepo }, pull_requests: runPrs.map((number) => ({ number })), created_at: at, ...extra });
    const github = {
      rest: {
        pulls: { get: async () => ({ data: { number: 1, state: 'open', merged: false, draft, head: { sha: HEAD, ref: 'feat', repo: { full_name: headRepo } }, base: { ref: 'main' }, labels: labels.map((name) => ({ name })) } }) },
        issues: { removeLabel: async (a) => { calls.removed.push(a.name); }, listEvents: async () => ({}), listEventsForTimeline: async () => ({}) },
        actions: { getWorkflowRun: async () => ({ data: { workflow_id: 7 } }), listWorkflowRuns: async () => ({}) },
        repos: { getCommit: async () => { throw new Error('committer dates must not be consulted'); } },
      },
      paginate: async (fn, args) => {
        if (fn === github.rest.issues.listEvents) return (evCalls++ > 0 && eventsLater) ? eventsLater : events;
        if (fn === github.rest.issues.listEventsForTimeline) return timeline;
        if (fn === github.rest.actions.listWorkflowRuns) {
          if (runs === null) throw new Error('Resource not accessible by integration');
          return args.event === 'pull_request_target' ? runs.map(mkRun('pull_request_target'))
            : dispatch.map(mkRun('workflow_dispatch')).map((r) => ({ ...r, pull_requests: [], head_repository: { full_name: 'o/r' } }));
        }
        return [];
      },
    };
    const core = { info: (m) => calls.info.push(m), warning() {}, setFailed: (m) => { calls.failed = m; }, summary: { addRaw() { return this; }, async write() {} } };
    const context = { eventName: 'pull_request_target', runId: 99, payload: { action, pull_request: { number: 1, head: { sha: HEAD }, updated_at: updatedAt } }, repo: { owner: 'o', repo: 'r' } };
    await new AsyncFunction('github', 'context', 'core', 'process', qa)(github, context, core, { env: { QA_LABEL: 'qa-passed', ALLOWED_LABELERS: allowed } });
    return calls;
  }
  await t('qa-gate: push to draft PR removes qa-passed and fails', async () => {
    const c = await runQa({ draft: true, action: 'synchronize', labels: ['qa-passed'] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /new push invalidated QA/.test(c.failed), c.failed);
  });
  await t('qa-gate: label re-applied while the run evaluated is not stripped (fresh re-read)', async () => {
    const old = { id: 1, event: 'labeled', label: { name: 'qa-passed' }, actor: { login: 'qianhaoq' }, created_at: '2026-01-01T00:00:00Z' };
    const un = { id: 2, event: 'unlabeled', label: { name: 'qa-passed' }, actor: { login: 'qianhaoq' }, created_at: '2026-01-20T00:00:00Z' };
    const again = { id: 3, event: 'labeled', label: { name: 'qa-passed' }, actor: { login: 'qianhaoq' }, created_at: '2026-01-20T00:00:05Z' };
    const c = await runQa({ draft: true, action: 'synchronize', labels: ['qa-passed'], events: [old], eventsLater: [old, un, again] });
    assert.deepStrictEqual(c.removed, []);
    assert.ok(c.failed, 'run still fails');
  });
  await t('qa-gate: draft without push still fails as draft', async () => {
    const c = await runQa({ draft: true, action: 'labeled', labels: ['qa-passed'] });
    assert.deepStrictEqual(c.removed, []);
    assert.ok(c.failed && /draft/.test(c.failed));
  });

  const ev = (login) => ({ event: 'labeled', label: { name: 'qa-passed' }, actor: { login }, created_at: '2026-02-01T00:00:00Z' });
  await t('qa-gate: allowlisted labeler passes', async () => {
    const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], events: [ev('QianHaoQ')], allowed: 'qianhaoq, other' });
    assert.strictEqual(c.failed, null, c.failed);
  });
  await t('qa-gate: non-allowlisted labeler (e.g. PR author) fails', async () => {
    const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], events: [ev('pr-author')], allowed: 'qianhaoq' });
    assert.ok(c.failed && /not an allowed labeler/.test(c.failed), c.failed);
  });
  await t('qa-gate: empty allowlist keeps legacy behaviour', async () => {
    const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], events: [ev('anyone')] });
    assert.strictEqual(c.failed, null, c.failed);
  });

  const at = (event, login, ts) => ({ event, label: { name: 'qa-passed' }, actor: { login }, created_at: ts });
  for (const bad of [' ', ',', ' , ']) {
    await t(`qa-gate: allowed_labelers set but empty (${JSON.stringify(bad)}) fails`, async () => {
      const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], events: [ev('qianhaoq')], allowed: bad });
      assert.ok(c.failed && /contains no logins/.test(c.failed), c.failed);
    });
  }
  await t('qa-gate: last labeled event decides (allowed then non-allowed) fails', async () => {
    const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], allowed: 'qianhaoq',
      events: [at('labeled', 'qianhaoq', '2026-02-01T00:00:00Z'), at('unlabeled', 'x', '2026-02-02T00:00:00Z'), at('labeled', 'author', '2026-02-03T00:00:00Z')] });
    assert.ok(c.failed && /last applied by "author"/.test(c.failed), c.failed);
  });
  await t('qa-gate: later unlabeled counts as no label', async () => {
    const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], allowed: 'qianhaoq',
      events: [at('labeled', 'qianhaoq', '2026-02-01T00:00:00Z'), at('unlabeled', 'qianhaoq', '2026-02-02T00:00:00Z')] });
    assert.ok(c.failed && /removed after/.test(c.failed), c.failed);
  });
  await t('qa-gate: last labeled by allowlisted user passes', async () => {
    const c = await runQa({ draft: false, action: 'labeled', labels: ['qa-passed'], allowed: 'qianhaoq',
      events: [at('labeled', 'author', '2026-02-01T00:00:00Z'), at('unlabeled', 'qianhaoq', '2026-02-02T00:00:00Z'), at('labeled', 'qianhaoq', '2026-02-03T00:00:00Z')] });
    assert.strictEqual(c.failed, null, c.failed);
  });

  await t('qa-gate: label applied after the push survives synchronize (race)', async () => {
    // The synchronize payload itself observes HEAD at the push (16:57:25);
    // its run may not even be listed yet.
    const c = await runQa({ draft: false, action: 'synchronize', labels: ['qa-passed'], allowed: 'qianhaoq',
      runs: [[PREV, '2026-02-01T16:40:00Z']],
      updatedAt: '2026-02-01T16:57:25Z', events: [at('labeled', 'qianhaoq', '2026-02-01T16:57:34Z')] });
    assert.deepStrictEqual(c.removed, []);
    assert.strictEqual(c.failed, null, c.failed);
  });
  await t('qa-gate: label applied before the push is stripped on synchronize', async () => {
    const c = await runQa({ draft: false, action: 'synchronize', labels: ['qa-passed'],
      runs: [[PREV, '2026-02-01T16:40:00Z'], [HEAD, '2026-02-01T16:57:26Z']],
      updatedAt: '2026-02-01T16:57:25Z', events: [at('labeled', 'qianhaoq', '2026-02-01T16:50:00Z')] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /new push invalidated QA/.test(c.failed), c.failed);
  });

  // ---- P1 regression: backdated committer date + label event that
  // cancels the synchronize run (qa-gate-sandbox-91 PR #17). QA signed
  // off PREV at 17:00; the author pushes HEAD (committer date backdated,
  // irrelevant now) at 17:10 and adds "wip" 0.3s later; the synchronize
  // run is cancelled, the labeled run evaluates.
  const exploit = { draft: false, labels: ['qa-passed', 'wip'], allowed: 'qianhaoq',
    events: [at('labeled', 'qianhaoq', '2026-02-01T17:00:00Z')],
    runs: [[PREV, '2026-02-01T16:55:00Z'], [HEAD, '2026-02-01T17:10:01Z', { conclusion: 'cancelled' }], [HEAD, '2026-02-01T17:10:01Z']],
    updatedAt: '2026-02-01T17:10:01Z' };
  await t('qa-gate: backdated push + label event cancelling the synchronize run → stripped, fails', async () => {
    const c = await runQa({ ...exploit, action: 'labeled' });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /predates the latest push/.test(c.failed) && /head was 1111111 at sign-off/.test(c.failed), c.failed);
  });
  await t('qa-gate: same exploit, label added BEFORE the push (labeled run sees the old head) → later run strips', async () => {
    const c = await runQa({ ...exploit, action: 'unlabeled', runs: [[PREV, '2026-02-01T16:55:00Z'], [PREV, '2026-02-01T17:10:00Z'], [HEAD, '2026-02-01T17:10:00Z', { conclusion: 'cancelled' }]] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed, 'gate must fail');
  });
  await t('qa-gate: same exploit even when no run for the new head is listed (payload only) → stripped', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runs: [[PREV, '2026-02-01T16:55:00Z']] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed);
  });
  await t('qa-gate: no head observation before the label at all → stripped (fail closed)', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runs: [], updatedAt: '2026-02-01T17:10:01Z' });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /no head observation before the label/.test(c.failed), c.failed);
  });
  await t('qa-gate: control — label applied on the tested head stays green on later events', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runs: [[HEAD, '2026-02-01T16:55:00Z'], [HEAD, '2026-02-01T17:10:01Z']] });
    assert.deepStrictEqual(c.removed, []);
    assert.strictEqual(c.failed, null, c.failed);
  });
  await t('qa-gate: a run in the same second as the label does not count (strictly before)', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runs: [[PREV, '2026-02-01T16:55:00Z'], [HEAD, '2026-02-01T17:00:00Z']] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
  });
  await t('qa-gate: force push TO the head before the label is fine; to another SHA rejects', async () => {
    const runs = [[HEAD, '2026-02-01T16:55:00Z']];
    const ok = await runQa({ ...exploit, action: 'labeled', runs,
      timeline: [{ event: 'head_ref_force_pushed', commit_id: HEAD, created_at: '2026-02-01T16:55:00Z' }] });
    assert.strictEqual(ok.failed, null, ok.failed);
    const bad = await runQa({ ...exploit, action: 'labeled', runs,
      timeline: [{ event: 'head_ref_force_pushed', commit_id: PREV, created_at: '2026-02-01T16:58:00Z' }] });
    assert.deepStrictEqual(bad.removed, ['qa-passed']);
    assert.ok(/force push/.test(bad.failed), bad.failed);
  });
  await t('qa-gate: fork PR (runs carry no PR association) binds on head repo + branch', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', headRepo: 'fork/r', runPrs: [], runs: [[HEAD, '2026-02-01T16:55:00Z']] });
    assert.strictEqual(c.failed, null, c.failed);
    const c2 = await runQa({ ...exploit, action: 'labeled', headRepo: 'fork/r', runPrs: [] });
    assert.deepStrictEqual(c2.removed, ['qa-passed']);
  });
  await t('qa-gate: same-repo run without PR association / of another PR does not count', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runPrs: [], runs: [[HEAD, '2026-02-01T16:55:00Z']] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    const c2 = await runQa({ ...exploit, action: 'labeled', runPrs: [2], runs: [[HEAD, '2026-02-01T16:55:00Z']] });
    assert.deepStrictEqual(c2.removed, ['qa-passed']);
  });
  await t('qa-gate: run listing error (e.g. no actions: read) strips and fails closed', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runs: null });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /could not verify/.test(c.failed), c.failed);
  });
  await t('qa-gate: cancelled push then converted_to_draft → stale label stripped, fails', async () => {
    const c = await runQa({ ...exploit, draft: true, action: 'converted_to_draft' });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /predates the latest push/.test(c.failed), c.failed);
  });
  await t('qa-gate: draft without label fails as draft', async () => {
    const c = await runQa({ draft: true, action: 'converted_to_draft', labels: [] });
    assert.ok(c.failed && /draft/.test(c.failed), c.failed);
  });
  await t('qa-gate: workflow_dispatch run on the PR branch counts as a head observation', async () => {
    const c = await runQa({ ...exploit, action: 'labeled', runs: [], dispatch: [[HEAD, '2026-02-01T16:55:00Z']] });
    assert.strictEqual(c.failed, null, c.failed);
  });

  // ---- keep_qa_on_clean_main_update: real git in temp repos ----------
  // The script's `exec.getExecOutput('git', …)` runs real git; the fetch
  // URL https://github.com/o/r.git is mapped to a local bare "remote".
  {
    const cp = require('child_process');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-keep-test-'));
    const T0 = Date.parse('2026-03-01T00:00:00Z');
    const iso = (h) => new Date(T0 + h * 3600e3).toISOString();
    let n = 0;
    // Fresh remote + work clone per scenario. g(args, hour) runs git in the
    // work tree with author/committer date T0+hour.
    function fixture() {
      const dir = path.join(tmp, `s${++n}`);
      const remote = `${dir}/remote.git`;
      const work = `${dir}/work`;
      fs.mkdirSync(work, { recursive: true });
      const g = (args, hour = 0, opts = {}) => {
        const r = cp.spawnSync('git', args, { cwd: work, encoding: 'utf8', env: { ...process.env,
          GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
          GIT_AUTHOR_DATE: iso(hour), GIT_COMMITTER_DATE: iso(hour), GIT_CONFIG_NOSYSTEM: '1', HOME: dir } });
        if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
      };
      const write = (f, txt) => fs.writeFileSync(path.join(work, f), txt);
      const commit = (msg, hour) => { g(['add', '-A']); g(['commit', '-q', '-m', msg], hour); return g(['rev-parse', 'HEAD']); };
      cp.spawnSync('git', ['init', '-q', '--bare', remote]);
      g(['init', '-q', '-b', 'main']);
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
      write('shared.txt', lines.join('\n') + '\n');
      write('pr.txt', 'pr v0\n');
      write('app.txt', 'app v0\n');
      const m0 = commit('m0', 0);
      g(['checkout', '-q', '-b', 'feat']);
      return { dir, remote, work, g, write, commit, lines, m0 };
    }
    // QA tested B (pushed at +1h, labeled at +2h); `build` creates the new
    // head H (and main commits) at +3h/+4h and returns { H, before? }.
    async function scenario(build, { keep = true, action = 'synchronize', labeledAt = 2, labeler = 'qa-bot', runAt = 1.1, runPr = 1, extraRuns = [], forcePushAt = null } = {}) {
      const f = fixture();
      f.write('pr.txt', 'pr v1\n');
      const B = f.commit('feat: B', 1);
      const res = build(f, B);
      const H = res.H;
      f.g(['push', '-q', '-f', f.remote, 'main:refs/heads/main', `${H}:refs/pull/1/head`]);
      const before = res.before !== undefined ? res.before : B;
      const pushed = [H, ...(res.pushed || []), ...(res.before ? [res.before] : [])];
      const calls = { removed: [], failed: null, comments: [], summary: '', info: [] };
      const github = {
        rest: {
          pulls: { get: async () => ({ data: { number: 1, state: 'open', merged: false, draft: false, head: { sha: H, ref: 'feat', repo: { full_name: 'o/r' } }, base: { ref: 'main' }, labels: [{ name: 'qa-passed' }] } }) },
          issues: {
            removeLabel: async (a) => { calls.removed.push(a.name); },
            listEvents: async () => ({}), listEventsForTimeline: async () => ({}), listComments: async () => ({}),
            createComment: async (a) => { calls.comments.push(a.body); },
            updateComment: async (a) => { calls.comments.push(a.body); },
          },
          actions: {
            getWorkflowRun: async () => ({ data: { workflow_id: 7 } }),
            listWorkflowRuns: async () => ({}),
          },
          repos: { getCommit: async ({ ref }) => ({ data: { commit: { committer: { date: f.g(['log', '-1', '--format=%cI', ref]) } } } }) },
        },
        // One pull_request_target run per pushed PR head: B at runAt
        // (default just after its push), other heads at +4h.
        paginate: async (fn, args) => {
          if (fn === github.rest.issues.listEvents) return [{ event: 'labeled', label: { name: 'qa-passed' }, actor: { login: labeler }, created_at: iso(labeledAt) }];
          if (fn === github.rest.actions.listWorkflowRuns) {
            if (args.event !== 'pull_request_target') return [];
            const mk = (sha, at, i) => ({ id: i, event: 'pull_request_target', head_sha: sha, head_branch: 'feat', head_repository: { full_name: 'o/r' }, pull_requests: runPr ? [{ number: runPr }] : [], created_at: iso(at) });
            const list = [[B, runAt], ...extraRuns.map(([sha, at]) => [sha === 'A' ? f.m0 : sha, at]), ...pushed.map((sha) => [sha, 4])];
            return list.map(([sha, at], i) => mk(sha, at, i + 1));
          }
          if (fn === github.rest.issues.listEventsForTimeline) {
            return forcePushAt === null ? [] : [{ event: 'head_ref_force_pushed', created_at: iso(forcePushAt) }];
          }
          return [];
        },
      };
      const sum = { addRaw(s) { calls.summary += s; return sum; }, async write() { return sum; } };
      const core = { info: (m) => calls.info.push(m), warning() {}, setSecret() {}, summary: sum, setFailed: (m) => { calls.failed = m; } };
      const exec = {
        getExecOutput: async (cmd, args, opts) => {
          const mapped = args.map((a) => (a === 'https://github.com/o/r.git' ? f.remote : a));
          const r = cp.spawnSync(cmd, mapped, { encoding: 'utf8', env: opts.env });
          return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
        },
      };
      const context = { eventName: 'pull_request_target', repo: { owner: 'o', repo: 'r' },
        payload: { action, before, pull_request: { number: 1, head: { sha: H }, updated_at: iso(4) } } };
      const env = { ...process.env, QA_LABEL: 'qa-passed', ALLOWED_LABELERS: 'qa-bot', KEEP_QA_ON_CLEAN_MAIN_UPDATE: keep ? 'true' : 'false',
        QA_GIT_TOKEN: keep ? 'dummy-token' : '', RUNNER_TEMP: f.dir, GITHUB_SERVER_URL: 'https://github.com' };
      await new AsyncFunction('github', 'context', 'core', 'process', 'exec', 'require', qa)(github, context, core, { env }, exec, require);
      const all = JSON.stringify(calls);
      assert.ok(!all.includes('dummy-token') && !all.includes(Buffer.from('x-access-token:dummy-token').toString('base64')), 'token leaked into output');
      return { ...calls, H, B };
    }
    // main gets an unrelated change, then merge main into feat (clean).
    const mergeMain = (f, hourMain = 3, hourMerge = 4) => {
      f.g(['checkout', '-q', 'main']);
      f.write('app.txt', 'app v1\n');
      f.commit('main: app', hourMain);
      f.g(['checkout', '-q', 'feat']);
      f.g(['merge', '-q', '--no-edit', '--no-ff', 'main'], hourMerge);
      return f.g(['rev-parse', 'HEAD']);
    };
    const kept = (c) => {
      assert.deepStrictEqual(c.removed, [], `label removed; failed=${c.failed}`);
      assert.strictEqual(c.failed, null, c.failed);
    };
    const stripped = (c, re) => {
      assert.deepStrictEqual(c.removed, ['qa-passed']);
      assert.ok(c.failed && /new push invalidated QA/.test(c.failed), c.failed);
      assert.ok(re.test(c.failed), `reason ${re} not in: ${c.failed}`);
      assert.ok(/stripped on push/.test(c.summary), 'reason missing from job summary');
      assert.strictEqual(c.comments.length, 0);
    };

    await t('qa-gate keep: clean merge of main keeps qa-passed, passes, posts sticky comment', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }));
      kept(c);
      assert.strictEqual(c.comments.length, 1);
      assert.ok(c.comments[0].includes(`仅干净合入 main（无冲突、无与本 PR 重叠的文件），qa-passed 保留；QA 测试基于 ${c.B.slice(0, 7)}`), c.comments[0]);
    });
    await t('qa-gate keep: feature off → clean merge still strips (default behaviour)', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }), { keep: false });
      assert.deepStrictEqual(c.removed, ['qa-passed']);
      assert.ok(c.failed && /new push invalidated QA/.test(c.failed), c.failed);
      assert.strictEqual(c.comments.length, 0);
    });
    await t('qa-gate keep: later non-sync run on the kept head passes (label older than push)', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }), { action: 'labeled' });
      kept(c);
    });
    await t('qa-gate keep: two consecutive clean main merges keep (chain back to QA head)', async () => {
      const c = await scenario((f) => {
        const H1 = mergeMain(f, 3, 4);
        f.g(['checkout', '-q', 'main']);
        f.write('app2.txt', 'more\n');
        f.commit('main: app2', 5);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', '--no-ff', 'main'], 6);
        return { H: f.g(['rev-parse', 'HEAD']), before: H1 };
      });
      kept(c);
      assert.ok(c.comments[0].includes(`QA 测试基于 ${c.B.slice(0, 7)}`), c.comments[0]);
    });
    await t('qa-gate keep: conflict hand-resolved in the merge → stripped', async () => {
      const c = await scenario((f) => {
        f.g(['checkout', '-q', 'main']);
        f.write('pr.txt', 'main v1\n');
        f.commit('main: touches pr.txt', 3);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', 'main'], 4, { allowFail: true });
        f.write('pr.txt', 'resolved\n');
        return { H: f.commit('Merge branch main (resolved)', 4) };
      });
      stripped(c, /conflicts/);
    });
    await t('qa-gate keep: change smuggled into a clean merge commit → stripped', async () => {
      const c = await scenario((f) => {
        mergeMain(f);
        f.write('evil.txt', 'surprise\n');
        f.g(['add', '-A']);
        f.g(['commit', '-q', '--amend', '--no-edit'], 4);
        return { H: f.g(['rev-parse', 'HEAD']) };
      });
      stripped(c, /differs from a clean re-merge/);
    });
    await t('qa-gate keep: main changed a file the PR also changed (no conflict) → stripped', async () => {
      const c = await scenario((f, B) => {
        // PR also edits shared.txt line 18 (on top of B: amend B → new B').
        f.g(['checkout', '-q', 'main']);
        const l = f.lines.slice(); l[1] = 'main edit';
        f.write('shared.txt', l.join('\n') + '\n');
        f.commit('main: shared top', 3);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', '--no-ff', 'main'], 4);
        return { H: f.g(['rev-parse', 'HEAD']) };
      }, {});
      // B only touched pr.txt, so that variant must be KEPT; the overlap
      // variant is below.
      kept(c);
      const c2 = await scenario((f) => {
        const lp = f.lines.slice(); lp[18] = 'pr edit';
        f.write('shared.txt', lp.join('\n') + '\n');
        const B2 = f.commit('feat: shared bottom', 1);
        f.g(['checkout', '-q', 'main']);
        const lm = f.lines.slice(); lm[1] = 'main edit';
        f.write('shared.txt', lm.join('\n') + '\n');
        f.commit('main: shared top', 3);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', '--no-ff', 'main'], 4);
        return { H: f.g(['rev-parse', 'HEAD']), before: B2 };
      });
      stripped(c2, /also changes: shared\.txt/);
    });
    await t("qa-gate keep: author's normal commit → stripped", async () => {
      const c = await scenario((f) => {
        f.write('pr.txt', 'pr v2\n');
        return { H: f.commit('feat: more', 4) };
      });
      stripped(c, /not a merge commit/);
    });
    await t('qa-gate keep: rebase-style update (force push onto main) → stripped', async () => {
      const c = await scenario((f, B) => {
        f.g(['checkout', '-q', 'main']);
        f.write('app.txt', 'app v1\n');
        f.commit('main: app', 3);
        f.g(['checkout', '-q', 'feat']);
        f.g(['rebase', '-q', 'main'], 4);
        return { H: f.g(['rev-parse', 'HEAD']) };
      });
      stripped(c, /not a merge commit|not fetchable/);
    });
    await t('qa-gate keep: merge on top of a commit other than `before` → stripped', async () => {
      const c = await scenario((f, B) => {
        f.write('pr.txt', 'pr v2\n');
        f.commit('feat: unreviewed', 3);
        return { H: mergeMain(f, 3, 4), before: B };
      });
      stripped(c, /first parent .* not the previous head/);
    });
    await t('qa-gate keep: second parent not on the base branch → stripped', async () => {
      const c = await scenario((f) => {
        f.g(['checkout', '-q', '-b', 'side', f.m0]);
        f.write('side.txt', 'x\n');
        f.commit('side', 3);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', '--no-ff', 'side'], 4);
        return { H: f.g(['rev-parse', 'HEAD']) };
      });
      stripped(c, /not on main/);
    });
    await t('qa-gate keep: missing / unfetchable `before` → stripped', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f), before: '' }));
      stripped(c, /no usable `before`/);
      const c2 = await scenario((f) => ({ H: mergeMain(f), before: '1'.repeat(40) }));
      stripped(c2, /first parent|not fetchable/);
    });
    await t('qa-gate keep: label applied before B was pushed (stale on B) → stripped', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }), { labeledAt: 0.5 });
      stripped(c, /does not cover the previous head/);
    });
    await t('qa-gate keep: label from a non-allowed labeler is not kept', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }), { labeler: 'pr-author' });
      stripped(c, /not an allowed labeler/);
    });
    await t('qa-gate keep: B committed before the label but pushed after it (no run proof) → stripped', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }), { runAt: 2.5 });
      stripped(c, /no gate run proves/);
    });
    await t('qa-gate keep: non-sync run with a stale label on an unreviewed commit strips it', async () => {
      const c = await scenario((f) => {
        f.write('pr.txt', 'pr v2\n');
        return { H: f.commit('feat: more', 4) };
      }, { action: 'labeled' });
      assert.deepStrictEqual(c.removed, ['qa-passed']);
      assert.ok(c.failed && /predates the latest push/.test(c.failed), c.failed);
      assert.ok(/stripped/.test(c.summary));
    });
    await t('qa-gate keep: whitespace-leading path overlap is detected (verbatim -z)', async () => {
      // base changes only " shared" (top line); PR changes "\tx" and
      // " shared" (bottom line) → clean merge, but the files overlap.
      const c = await scenario((f) => {
        const ws = f.lines.join('\n') + '\n';
        f.write(' shared', ws);
        f.g(['checkout', '-q', 'main']);
        f.write(' shared', ws);
        f.commit('main: add " shared"', 0.1);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', 'main'], 0.2);
        const lp = f.lines.slice(); lp[18] = 'pr edit';
        f.write(' shared', lp.join('\n') + '\n');
        f.write('\tx', 'tab\n');
        const B2 = f.commit('feat: tab + " shared"', 1);
        f.g(['checkout', '-q', 'main']);
        const lm = f.lines.slice(); lm[1] = 'main edit';
        f.write(' shared', lm.join('\n') + '\n');
        f.commit('main: " shared" top', 3);
        f.g(['checkout', '-q', 'feat']);
        f.g(['merge', '-q', '--no-edit', '--no-ff', 'main'], 4);
        return { H: f.g(['rev-parse', 'HEAD']), before: B2 };
      });
      stripped(c, /also changes:  shared/);
    });
    await t('qa-gate keep: run proof from another PR (same branch/SHA) or no PR association → stripped', async () => {
      const c = await scenario((f) => ({ H: mergeMain(f) }), { runPr: 2 });
      stripped(c, /no gate run proves/);
      const c2 = await scenario((f) => ({ H: mergeMain(f) }), { runPr: 0 });
      stripped(c2, /no gate run proves/);
    });
    await t('qa-gate keep: SHA replayed after sign-off (B → reset to A, QA on A, fast-forward to B) → stripped', async () => {
      // B ran at 1.1, then a run for A at 1.5 (head moved back), label at 2.
      const c = await scenario((f) => ({ H: mergeMain(f) }), { extraRuns: [['A', 1.5]] });
      stripped(c, /no gate run proves/);
      // Same, but the reset produced no run: the force-push event alone rejects.
      const c2 = await scenario((f) => ({ H: mergeMain(f) }), { forcePushAt: 1.5 });
      stripped(c2, /no gate run proves/);
    });
    await t('qa-gate keep: race guard still keeps a label applied after the push', async () => {
      const c = await scenario((f) => {
        f.write('pr.txt', 'pr v2\n');
        return { H: f.commit('feat: more', 3) };
      }, { labeledAt: 5 });
      kept(c);
      assert.strictEqual(c.comments.length, 0);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Refresh (both gates): never blind re-runs; one re-run per PR; cap.
  const RH = 'feedfacefeedfacefeedfacefeedfacefeedface';
  const SUMMARY_DONE = { user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-10-16T03:00:00Z', body: `<!-- codex-pull-request-review-summary -->\n**Completed** — reviewed ${RH}` };
  const SUMMARY_RUNNING = { ...SUMMARY_DONE, body: '<!-- codex-pull-request-review-summary -->\n**Running**' };
  async function runRefresh(file, runsByEvent, { summary = SUMMARY_DONE, labels = [], labelEvents = [], eventName = 'schedule', payload = {}, prs, mode = 'refresh', failed = [], runById, allRuns, env = {} } = {}) {
    const reran = [];
    const prList = prs || [{ number: 9, state: 'open', draft: false, head: { sha: RH, ref: 'crawl/auto' }, labels: labels.map((name) => ({ name })) }];
    const github = {
      rest: {
        actions: {
          // Branches by run_id: context.runId (=1) and any id not in runById
          // keep the default caller-workflow answer.
          getWorkflowRun: async (a) => ({ data: (runById && runById[a.run_id]) || { workflow_id: eventName === 'workflow_run' && a.run_id === 1 ? 999 : 7, name: 'Gate' } }),
          listWorkflowRuns: async (a) => ({ data: { workflow_runs: runsByEvent[a.event] || [] } }),
          reRunWorkflowFailedJobs: async (a) => { reran.push(a.run_id); },
          reRunWorkflow: async (a) => { reran.push(`all:${a.run_id}`); },
        },
        pulls: {
          list: async () => ({}),
          get: async (a) => ({ data: { ...prList.find((p) => p.number === a.pull_number), merged: false } }),
          listReviewComments: async () => ({}),
        },
        issues: { listComments: async () => ({}), listEvents: async () => ({}) },
        repos: { getCommit: async () => ({ data: { commit: { committer: { date: '2026-10-16T00:00:00Z' } } } }) },
      },
      graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
      paginate: async (fn, args = {}) => {
        if (fn === github.rest.issues.listComments) { const sm = typeof summary === 'function' ? summary() : summary; return sm ? [sm] : []; }
        if (fn === github.rest.issues.listEvents) return labelEvents;
        if (fn === github.rest.pulls.list) return prList;
        if (fn === github.rest.actions.listWorkflowRuns) {
          assert.strictEqual(args.workflow_id, 7, 'heal must query source workflow, not companion');
          // The cancel-heal fallback sweeps workflow-wide: no event/head_sha.
          if (!args.event && !args.head_sha) return allRuns || [];
          return runsByEvent[args.event] || [];
        }
        return [];
      },
    };
    const core = { info(m) { if (process.env.DEBUG_T) console.log('  info:', m); }, warning() {}, setFailed(m) { if (mode !== 'refresh') { failed.push(m); return; } throw new Error(m); }, summary: { addRaw() { return this; }, write: async () => {} } };
    const context = { runId: 1, eventName, repo: { owner: 'o', repo: 'r' }, payload };
    const src = scripts(file)[mode === 'refresh' ? 1 : 0];
    await new AsyncFunction('github', 'context', 'core', 'process', 'exec', src)(github, context, core, { env: { GATE_MODE: mode, QA_LABEL: 'qa-passed', REFRESH_POLL_MS: '0', RUNNING_POLL_MS: '0', RUNNING_MAX_POLLS: '0', ...env } }, {});
    return reran;
  }
  const run = (id, event, conclusion, created_at, extra = {}) => ({ id, event, head_sha: RH, head_branch: 'crawl/auto', status: 'completed', conclusion, created_at, run_started_at: created_at, run_attempt: 1, ...extra });

  await t('codex-gate: evaluator and refresh jobs run the IDENTICAL script', () => {
    const [a, b] = scripts('codex-gate.yml');
    assert.ok(a && b);
    assert.strictEqual(a, b);
  });
  await t('codex-gate evaluate mode: verdict decides the job conclusion', async () => {
    const pass = [];
    const p = { eventName: 'pull_request_target', payload: { pull_request: { number: 9 } }, mode: 'evaluate' };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', {}, { ...p, failed: pass }), []);
    assert.deepStrictEqual(pass, []);
    const fail = [];
    await runRefresh('codex-gate.yml', {}, { ...p, summary: SUMMARY_RUNNING, failed: fail });
    assert.strictEqual(fail.length, 1);
    assert.match(fail[0], /still Running/);
    const fail2 = [];
    await runRefresh('codex-gate.yml', {}, { eventName: 'workflow_dispatch', payload: { inputs: { pr_number: 'x' } }, mode: 'evaluate', failed: fail2 });
    assert.match(fail2[0] || '', /pr_number is invalid/);
  });
  await t('codex-gate evaluate: Running summary stays in_progress and passes once Completed', async () => {
    const p = { eventName: 'pull_request_target', payload: { pull_request: { number: 9 } }, mode: 'evaluate' };
    let n = 0;
    const failed = [];
    await runRefresh('codex-gate.yml', {}, { ...p, failed, env: { RUNNING_MAX_POLLS: '5' }, summary: () => (++n < 3 ? SUMMARY_RUNNING : SUMMARY_DONE) });
    assert.deepStrictEqual(failed, []);
    assert.strictEqual(n, 3);
    const still = [];
    let m = 0;
    await runRefresh('codex-gate.yml', {}, { ...p, failed: still, env: { RUNNING_MAX_POLLS: '2' }, summary: () => { m++; return SUMMARY_RUNNING; } });
    assert.strictEqual(m, 3, 'bounded polling');
    assert.match(still[0] || '', /still Running/);
  });
  await t('codex-gate evaluate (jobs#14): no summary yet for head ⇒ stays pending/polls, passes once posted', async () => {
    const p = { eventName: 'pull_request_target', payload: { pull_request: { number: 9 } }, mode: 'evaluate' };
    let n = 0; const failed = [];
    const recent = { ...SUMMARY_DONE };
    await runRefresh('codex-gate.yml', {}, { ...p, failed, env: { RUNNING_MAX_POLLS: '5', WAIT_MINUTES: '9999999' }, summary: () => (++n < 3 ? null : recent) });
    assert.deepStrictEqual(failed, []);
    assert.strictEqual(n, 3, 'polled instead of failing');
  });
  await t('codex-gate refresh: failed head run re-run only when the gate would now pass', async () => {
    const runs = { workflow_dispatch: [run(5, 'workflow_dispatch', 'failure', '2026-10-16T01:20:00Z')] };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs), [5]);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { summary: SUMMARY_RUNNING }), []);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { summary: null }), []);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { labels: ['skip-codex-gate'] }), []);
  });
  await t('codex-gate refresh: run_attempt cap (3) stops red→green re-runs', async () => {
    const r = await runRefresh('codex-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z', { run_attempt: 3 })] });
    assert.deepStrictEqual(r, []);
  });
  await t('codex-gate refresh: caller-skipped newest run is ignored', async () => {
    const r = await runRefresh('codex-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z')], pull_request_review: [run(6, 'pull_request_review', 'skipped', '2026-10-16T02:00:00Z')] });
    assert.deepStrictEqual(r, [5]);
  });
  await t('codex-gate refresh: at most one re-run per PR (failed-would-pass wins over cancelled)', async () => {
    const r = await runRefresh('codex-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T02:00:00Z'), run(4, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z'), run(3, 'pull_request_target', 'cancelled', '2026-10-16T00:30:00Z')] });
    assert.deepStrictEqual(r, [5]);
  });
  await t('codex-gate refresh: issue_comment refreshes only that PR; non-PR comment does nothing', async () => {
    const prs = [{ number: 9, state: 'open', draft: false, head: { sha: RH, ref: 'crawl/auto' }, labels: [] }];
    const runs = { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z')] };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { eventName: 'issue_comment', payload: { issue: { number: 9, pull_request: {} } }, prs }), [5]);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { eventName: 'issue_comment', payload: { issue: { number: 9 } }, prs }), []);
  });
  await t('codex-gate refresh: green head check is re-run when the verdict turned false (fail closed)', async () => {
    const runs = { pull_request_target: [run(5, 'pull_request_target', 'success', '2026-10-16T01:20:00Z', { run_attempt: 3 })] };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { summary: SUMMARY_RUNNING }), ['all:5']);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs), []);
  });
  await t('codex-gate refresh (P1-c): clean Codex summary re-runs the older failed head run (once; not while Running)', async () => {
    // weekly #18: PRT failed (Codex Running), review-event run later green, red check stayed.
    const runs = { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:00:00Z')],
      pull_request_review: [run(6, 'pull_request_review', 'success', '2026-10-16T01:10:00Z')] };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs), [5]);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { summary: SUMMARY_RUNNING }), ['all:6']);
    const once = { ...runs, pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:00:00Z', { run_attempt: 2 })] };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', once), [], 'bounded: once per run');
  });
  await t('codex-gate refresh (P1-c): failed PRT run carrying the BASE sha is found via PR head association', async () => {
    const prt = { ...run(5, 'pull_request_target', 'failure', '2026-10-16T01:00:00Z'), head_sha: 'base000', pull_requests: [{ number: 9, head: { sha: RH } }] };
    const other = { ...run(4, 'pull_request_target', 'failure', '2026-10-16T00:50:00Z'), head_sha: 'base000', pull_requests: [{ number: 9, head: { sha: 'oldhead' } }] };
    const runs = { pull_request_review: [run(6, 'pull_request_review', 'success', '2026-10-16T01:10:00Z')] };
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { allRuns: [prt, other] }), [5]);
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', runs, { allRuns: [other] }), [], 'other-head failure ignored');
  });
  for (const file of ['codex-gate.yml', 'qa-gate.yml']) {
    await t(`${file} refresh: newest = latest ATTEMPT start (a re-run older run beats a later-created success)`, async () => {
      const r = await runRefresh(file, { pull_request_target: [
        run(8, 'pull_request_target', 'success', '2026-10-16T02:00:00Z'),
        run(4, 'pull_request_target', 'failure', '2026-10-16T01:00:00Z', { run_started_at: '2026-10-16T03:00:00Z', run_attempt: 2 })] },
        { labels: ['qa-passed'], labelEvents: [{ event: 'labeled', label: { name: 'qa-passed' }, created_at: '2026-10-16T03:10:00Z' }] });
      assert.deepStrictEqual(r, [4]);
    });
  }
  await t('codex-gate refresh: red→green and cancelled re-runs capped at attempt 3; timed_out retried', async () => {
    const r = await runRefresh('codex-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z', { run_attempt: 3 })] });
    assert.deepStrictEqual(r, []);
    const to = await runRefresh('codex-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'timed_out', '2026-10-16T01:20:00Z')] });
    assert.deepStrictEqual(to, [5]);
    const c = await runRefresh('codex-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'cancelled', '2026-10-16T01:20:00Z', { run_attempt: 3 })] });
    assert.deepStrictEqual(c, []);
  });
  await t('codex-gate refresh: runs beyond the first page are considered (paginated)', async () => {
    const many = Array.from({ length: 30 }, (_, i) => run(100 + i, 'pull_request_target', 'success', `2026-10-16T01:${String(i).padStart(2, '0')}:00Z`));
    many.push(run(7, 'pull_request_target', 'failure', '2026-10-15T00:00:00Z', { run_started_at: '2026-10-16T05:00:00Z', run_attempt: 2 }));
    assert.deepStrictEqual(await runRefresh('codex-gate.yml', { pull_request_target: many }), [7]);
  });
  await t('qa-gate refresh: legitimately red gate (no label) is NEVER re-run', async () => {
    const r = await runRefresh('qa-gate.yml', { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z')] });
    assert.deepStrictEqual(r, []);
  });
  await t('qa-gate refresh: re-runs a failed run only when the label was applied after it evaluated', async () => {
    const runs = { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z')] };
    const after = [{ event: 'labeled', label: { name: 'qa-passed' }, created_at: '2026-10-16T01:30:00Z' }];
    const before = [{ event: 'labeled', label: { name: 'qa-passed' }, created_at: '2026-10-16T01:10:00Z' }];
    assert.deepStrictEqual(await runRefresh('qa-gate.yml', runs, { labels: ['qa-passed'], labelEvents: after }), [5]);
    assert.deepStrictEqual(await runRefresh('qa-gate.yml', runs, { labels: ['qa-passed'], labelEvents: before }), []);
    assert.deepStrictEqual(await runRefresh('qa-gate.yml', runs, { labels: [], labelEvents: after }), []);
    // Label applied while the run was still evaluating (before completion) is NOT new input.
    const during = { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z', { updated_at: '2026-10-16T01:35:00Z' })] };
    assert.deepStrictEqual(await runRefresh('qa-gate.yml', during, { labels: ['qa-passed'], labelEvents: after }), []);
    const capped = { pull_request_target: [run(5, 'pull_request_target', 'failure', '2026-10-16T01:20:00Z', { run_attempt: 3 })] };
    assert.deepStrictEqual(await runRefresh('qa-gate.yml', capped, { labels: ['qa-passed'], labelEvents: after }), []);
  });
  for (const file of ['codex-gate.yml', 'qa-gate.yml']) {
    await t(`${file} refresh: re-runs failed workflow_dispatch run on the PR branch (when input changed)`, async () => {
      const r = await runRefresh(file, { workflow_dispatch: [run(5, 'workflow_dispatch', 'failure', '2026-10-16T01:20:00Z')] },
        { labels: ['qa-passed'], labelEvents: [{ event: 'labeled', label: { name: 'qa-passed' }, created_at: '2026-10-16T01:30:00Z' }] });
      assert.deepStrictEqual(r, [5]);
    });
    await t(`${file} refresh: ignores dispatch on another branch`, async () => {
      const r = await runRefresh(file, { workflow_dispatch: [run(6, 'workflow_dispatch', 'failure', '2026-10-16T01:20:00Z', { head_branch: 'main' })] });
      assert.deepStrictEqual(r, []);
    });
    await t(`${file} refresh: the newest cancelled run on the head is re-run even if a later run succeeded`, async () => {
      const ev = file === 'qa-gate.yml' ? 'pull_request_target' : 'pull_request_review';
      const r = await runRefresh(file, {
        [ev]: [run(11, ev, 'cancelled', '2026-10-16T01:00:00Z'), run(10, ev, 'cancelled', '2026-10-16T00:50:00Z')],
        workflow_dispatch: [run(12, 'workflow_dispatch', 'success', '2026-10-16T02:00:00Z')] });
      assert.deepStrictEqual(r, ['all:11']);
    });
    await t(`${file} refresh: nothing is re-run while a run on the head is still in progress`, async () => {
      const r = await runRefresh(file, {
        pull_request_target: [run(13, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z'),
          run(14, 'pull_request_target', null, '2026-10-16T02:00:00Z', { status: 'in_progress' })] });
      assert.deepStrictEqual(r, []);
    });
    await t(`${file} refresh: later success, older failure → ${file === 'codex-gate.yml' ? 'clean Codex re-runs the failed run once' : 'nothing'}`, async () => {
      const r = await runRefresh(file, {
        workflow_dispatch: [run(5, 'workflow_dispatch', 'failure', '2026-10-16T01:20:00Z')],
        pull_request_target: [run(8, 'pull_request_target', 'success', '2026-10-16T02:00:00Z')] });
      assert.deepStrictEqual(r, file === 'codex-gate.yml' ? [5] : []);
    });
    await t(`${file} refresh: workflow_run(cancelled) heal re-runs the TRIGGERING run for that PR only`, async () => {
      const wr = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: RH, head_branch: 'crawl/auto', pull_requests: [{ number: 9 }] } } };
      const runs = { pull_request_target: [run(21, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z'), run(10, 'pull_request_target', 'cancelled', '2026-10-16T00:30:00Z')] };
      // The triggering run takes priority over the older cancelled one…
      assert.deepStrictEqual(await runRefresh(file, runs, wr), ['all:21']);
      // …but never past the attempt cap: falls back to the newest uncapped cancelled.
      const capped = { pull_request_target: [run(21, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z', { run_attempt: 3 }), run(10, 'pull_request_target', 'cancelled', '2026-10-16T00:30:00Z')] };
      assert.deepStrictEqual(await runRefresh(file, capped, wr), ['all:10']);
    });
    await t(`${file} refresh: heal keys off the ASSOCIATED PR, not wr.head_sha (base SHA for pull_request_target)`, async () => {
      // The production bug: workflow_run.head_sha of a pull_request_target
      // run is the BASE SHA — requiring candPr.head.sha === wr.head_sha
      // never matched, so a cancelled run was never healed.
      const base = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: 'base000000000000000000000000000000000000', pull_requests: [{ number: 9 }] } } };
      const cancelled = { pull_request_target: [run(21, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z')] };
      assert.deepStrictEqual(await runRefresh(file, cancelled, base), ['all:21']);
      // The head-SHA fallback stays valid for `pull_request` runs (the one
      // event whose head_sha IS the PR head) when the association is
      // unindexed right after the cancel.
      const unindexed = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request', head_sha: RH, pull_requests: [] } } };
      assert.deepStrictEqual(await runRefresh(file, cancelled, unindexed), ['all:21']);
    });
    await t(`${file} refresh: heal fetches the triggering run BY ID when headRuns cannot list it`, async () => {
      // A pull_request_target run's own head_sha is the BASE SHA, so
      // headRuns (indexed by PR head SHA) never lists it: runsByEvent has
      // no trace of the triggered run 21. The heal must still get it via
      // getWorkflowRun(triggeredId) and re-run it. Timestamped NEWER than
      // the listed success so the newer-peer guard does not yield.
      const wr = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: 'base000000000000000000000000000000000000', pull_requests: [{ number: 9 }] } } };
      const runs = { pull_request_target: [run(12, 'pull_request_target', 'success', '2026-10-16T02:00:00Z')] };
      const byId = { 21: { id: 21, workflow_id: 7, conclusion: 'cancelled', event: 'pull_request_target', run_attempt: 1, created_at: '2026-10-16T03:00:00Z', run_started_at: '2026-10-16T03:00:00Z', pull_requests: [{ number: 9 }] } };
      assert.deepStrictEqual(await runRefresh(file, runs, { ...wr, runById: byId }), ['all:21']);
      // The triggering run can be the PR's ONLY gate run: runsByEvent empty →
      // `evaluated` empty. The heal must not be short-circuited by the
      // `!latest` guard — the BY-ID fetch still has to re-run it.
      assert.deepStrictEqual(await runRefresh(file, {}, { ...wr, runById: byId }), ['all:21']);
    });
    await t(`${file} refresh: cancel-heal yields to a NEWER success on the PR (no re-run)`, async () => {
      // A delayed heal must never knock a green required check back to
      // pending/red: the trigger is re-run ONLY when nothing newer and
      // green/in-flight supersedes it.
      const wr = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: 'base000000000000000000000000000000000000', pull_requests: [{ number: 9 }] } } };
      const newerGreen = { pull_request_target: [run(21, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z'), run(22, 'pull_request_target', 'success', '2026-10-16T02:00:00Z')] };
      assert.deepStrictEqual(await runRefresh(file, newerGreen, wr), []);
      // Same, with the trigger visible ONLY via the BY-ID fetch (a newer
      // success sits in `evaluated`, the cancelled trigger does not).
      const byId = { 21: { id: 21, workflow_id: 7, conclusion: 'cancelled', event: 'pull_request_target', run_attempt: 1, created_at: '2026-10-16T01:00:00Z', run_started_at: '2026-10-16T01:00:00Z', pull_requests: [{ number: 9 }] } };
      assert.deepStrictEqual(await runRefresh(file, { pull_request_target: [run(22, 'pull_request_target', 'success', '2026-10-16T02:00:00Z')] }, { ...wr, runById: byId }), []);
    });
    await t(`${file} refresh: cancel-heal sweep (headRuns blind) yields to a newer PR-associated run`, async () => {
      // headRuns indexes by PR head SHA, so pull_request_target runs (own
      // head_sha = BASE SHA) can be invisible to it: with `evaluated` EMPTY,
      // the workflow-wide sweep (no head_sha) must still find the newer
      // PR-associated success / in-flight run and skip the heal.
      const wr = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: 'base000000000000000000000000000000000000', pull_requests: [{ number: 9 }] } } };
      const byId = { 21: { id: 21, workflow_id: 7, conclusion: 'cancelled', event: 'pull_request_target', run_attempt: 1, created_at: '2026-10-16T01:00:00Z', run_started_at: '2026-10-16T01:00:00Z', pull_requests: [{ number: 9 }] } };
      const sweepRun = (id, at, extra = {}) => ({ id, event: 'pull_request_target', head_sha: 'base000000000000000000000000000000000000', head_branch: 'crawl/auto', status: 'completed', conclusion: 'success', created_at: at, run_started_at: at, run_attempt: 1, pull_requests: [{ number: 9 }], ...extra });
      assert.deepStrictEqual(await runRefresh(file, {}, { ...wr, runById: byId, allRuns: [sweepRun(22, '2026-10-16T02:00:00Z')] }), []);
      assert.deepStrictEqual(await runRefresh(file, {}, { ...wr, runById: byId, allRuns: [sweepRun(22, '2026-10-16T02:00:00Z', { conclusion: null, status: 'in_progress' })] }), []);
      // An OLDER success does not supersede the cancel → still heals…
      assert.deepStrictEqual(await runRefresh(file, {}, { ...wr, runById: byId, allRuns: [sweepRun(22, '2026-10-16T00:30:00Z')] }), ['all:21']);
      // …nor does a newer success associated with a DIFFERENT PR.
      assert.deepStrictEqual(await runRefresh(file, {}, { ...wr, runById: byId, allRuns: [sweepRun(22, '2026-10-16T02:00:00Z', { pull_requests: [{ number: 8 }] })] }), ['all:21']);
    });
    await t(`${file} refresh: workflow_run(cancelled) with no open PR / healed head → nothing`, async () => {
      // The cancelled run was already re-run to success elsewhere: latest is
      // success and verdict ok → no re-run at all.
      const healed = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: RH, pull_requests: [{ number: 9 }] } } };
      assert.deepStrictEqual(await runRefresh(file, { pull_request_target: [run(12, 'pull_request_target', 'success', '2026-10-16T02:00:00Z')] }, healed), []);
      // No associated PR: a pull_request_target run's head_sha is the BASE
      // SHA and must NOT be matched against PR heads → nothing to heal.
      const cancelled = { pull_request_target: [run(21, 'pull_request_target', 'cancelled', '2026-10-16T01:00:00Z')] };
      const stray = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request_target', head_sha: 'dead000000000000000000000000000000000000', pull_requests: [] } } };
      assert.deepStrictEqual(await runRefresh(file, cancelled, stray), []);
      // Same head SHA but a `pull_request` run: the head-SHA fallback runs
      // yet finds no open PR with that head → still nothing.
      const strayPr = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'cancelled', event: 'pull_request', head_sha: 'dead000000000000000000000000000000000000', pull_requests: [] } } };
      assert.deepStrictEqual(await runRefresh(file, cancelled, strayPr), []);
      // Associated PR exists but is CLOSED → nothing to heal.
      assert.deepStrictEqual(await runRefresh(file, cancelled, { ...healed, prs: [{ number: 9, state: 'closed', draft: false, head: { sha: RH, ref: 'crawl/auto' }, labels: [] }] }), []);
      // A non-cancelled workflow_run trigger heals nothing.
      const success = { eventName: 'workflow_run', payload: { workflow_run: { id: 21, conclusion: 'success', event: 'pull_request_target', head_sha: RH, pull_requests: [{ number: 9 }] } } };
      assert.deepStrictEqual(await runRefresh(file, cancelled, success), []);
    });
  }


  await t('understand cancel-heal: PR-associated base-SHA peers supersede cancelled trigger', async () => {
    const at = hour => `2026-10-20T0${hour}:00:00Z`;
    const cases = [
      { trigger: { created_at: at(1) }, peer: { created_at: at(2) }, newer: true },
      // An older run's new attempt supersedes the trigger.
      { trigger: { created_at: at(2) }, peer: { created_at: at(1), run_started_at: at(3) }, newer: true },
      // The trigger's new attempt supersedes a peer created later.
      { trigger: { created_at: at(1), run_started_at: at(3) }, peer: { created_at: at(2) }, newer: false },
      // Both attempts must be compared, regardless of creation order.
      { trigger: { created_at: at(2), run_started_at: at(3) }, peer: { created_at: at(1), run_started_at: at(4) }, newer: true },
      { trigger: { created_at: at(1), run_started_at: at(4) }, peer: { created_at: at(2), run_started_at: at(3) }, newer: false },
    ];
    for (const times of cases) {
      for (const status of ['in_progress', 'queued', 'waiting', 'requested', 'pending', 'completed']) {
        for (const number of [9, 10]) {
          const trigger = { id: 100, workflow_id: 7, status: 'completed', conclusion: 'cancelled', ...times.trigger };
          const reruns = [];
          const github = {
            paginate: async () => [{ id: 101, head_sha: 'base', pull_requests: [{ number }], status, conclusion: status === 'completed' ? 'success' : null, ...times.peer }],
            rest: {
              actions: {
                getWorkflowRun: async () => ({ data: trigger }),
                listWorkflowRuns: {},
                reRunWorkflow: async args => reruns.push(args.run_id),
              },
              pulls: { get: async () => ({ data: { number: 9, state: 'open', head: { sha: 'head' } } }) },
            },
          };
          const context = { repo: { owner: 'o', repo: 'r' }, runId: 200, eventName: 'workflow_run', payload: { workflow_run: { ...trigger, pull_requests: [{ number: 9 }] } } };
          await new AsyncFunction('github', 'context', 'core', scripts('understand-gate.yml').at(-1))(
            github, context, { info() {}, warning(m) { throw new Error(m); } });
          assert.deepStrictEqual(reruns, number === 9 && times.newer ? [] : [100]);
        }
      }
    }
  });

  // ---------- Diff Quiz / understand-gate pure helpers ----------
  {
    const lib = require('../scripts/understand-gate-lib.js');
    await t('understand: light diff docs/promo/lock → 1 question', async () => {
      assert.strictEqual(lib.nQuestionsFor([{ filename: 'README.md' }]), 1);
      assert.strictEqual(lib.nQuestionsFor([{ filename: 'docs/guide.md' }]), 1);
      assert.strictEqual(lib.nQuestionsFor([{ filename: 'promo/banner.tsx' }]), 1);
      assert.strictEqual(lib.nQuestionsFor([{ filename: 'package-lock.json' }]), 1);
      assert.strictEqual(lib.nQuestionsFor([
        { filename: '.github/workflows/ci.yml', patch: '-    uses: actions/checkout@v3\n+    uses: actions/checkout@v4\n' },
      ]), 1);
    });
    await t('understand: code change → 2 questions', async () => {
      assert.strictEqual(lib.nQuestionsFor([{ filename: 'src/app.ts' }]), 2);
      assert.strictEqual(lib.nQuestionsFor([
        { filename: 'README.md' },
        { filename: 'src/app.ts' },
      ]), 2);
    });
    await t('understand: parse Answer / Override', async () => {
      assert.deepStrictEqual(lib.parseAnswerComment('## Diff Quiz Answer\n1. A\n2. hello world\n'), { 1: 'A', 2: 'hello world' });
      assert.strictEqual(lib.parseOverrideComment('## Diff Quiz Override\n理由：试验误判，已人工确认无风险'), '理由：试验误判，已人工确认无风险');
      assert.strictEqual(lib.parseOverrideComment('## Diff Quiz Override\n'), null);
      assert.strictEqual(lib.parseAnswerComment('nope'), null);
    });
    await t('understand: gradeChoice + extractQuizMeta', async () => {
      assert.strictEqual(lib.gradeChoice('A', 'a'), true);
      assert.strictEqual(lib.gradeChoice('B', 'A'), false);
      const body = lib.formatQuizComment({
        sha: 'abc1234deadbeef',
        questions: [{ type: 'choice', prompt: '改了什么？', choices: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }], answer: 'A', rubric: '' }],
      });
      assert.ok(body.includes(lib.QUIZ_MARKER));
      const meta = lib.extractQuizMeta(body);
      assert.strictEqual(meta.sha, 'abc1234deadbeef');
      assert.strictEqual(meta.questions[0].answer, 'A');
    });
    await t('understand: workflow job name is Diff Quiz Gate', async () => {
      const yml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/understand-gate.yml'), 'utf8');
      assert.ok(/\n    name: Diff Quiz Gate\n/.test(yml), 'evaluate job name must be exactly Diff Quiz Gate');
      assert.ok(yml.includes("name: Diff Quiz Gate Refresh"), 'refresh job name');
      const ex = fs.readFileSync(path.join(__dirname, '..', 'examples/understand-gate.yml'), 'utf8');
      assert.ok(/^  understand:\n/m.test(ex), 'caller job id must be understand');
      const onBlock = ex.split(/^jobs:/m)[0];
      const typesLine = (onBlock.match(/pull_request_target:[\s\S]*?types:\s*\[([^\]]+)\]/) || [])[1] || '';
      assert.ok(!/labeled|unlabeled/.test(typesLine), 'caller must not listen labeled/unlabeled');
      assert.ok(!/skip-understanding-gate/.test(yml) || yml.includes('禁止'), 'no skip label support');
    });
  }



  // ---------- Caller anti-ghost policy (方案 B) ----------
  // A pull_request_target labeled run whose caller jobs all skip creates a
  // check suite with no "<job> / <Gate>" check → GitHub hangs on "is expected".
  // Fix: gate-relevant labels evaluate; irrelevant labels run a label-ack job named as the required check.
  {
    function callerPrtTypes(exampleFile) {
      const ex = fs.readFileSync(path.join(__dirname, '..', 'examples', exampleFile), 'utf8');
      const onBlock = ex.split(/^jobs:/m)[0];
      return (onBlock.match(/pull_request_target:[\s\S]*?types:\s*\[([^\]]+)\]/) || [])[1] || '';
    }
    function callerJobs(exampleFile) {
      const ex = fs.readFileSync(path.join(__dirname, '..', 'examples', exampleFile), 'utf8');
      return ex.split(/^jobs:\s*$/m)[1] || '';
    }
    function callerJobIf(exampleFile, jobId) {
      const jobs = callerJobs(exampleFile);
      const re = new RegExp('^  ' + jobId + ':\\n([\\s\\S]*?)(?=^  [A-Za-z]|(?![\\s\\S]))', 'm');
      const m = jobs.match(re);
      assert.ok(m, exampleFile + ': job ' + jobId + ' not found');
      const ifM = m[1].match(/if:\s*>-\n([\s\S]*?)(?=\n    [a-zA-Z]|\n  [a-zA-Z])/);
      return ifM ? ifM[1] : m[1];
    }
    await t('codex caller: skip-codex-gate evaluates; other labels ack-mirror', () => {
      const types = callerPrtTypes('codex-gate.yml');
      assert.ok(/labeled/.test(types) && /unlabeled/.test(types), 'codex must listen labeled for skip-codex-gate');
      const iff = callerJobIf('codex-gate.yml', 'codex');
      assert.ok(/skip-codex-gate/.test(iff), 'codex if: evaluates skip-codex-gate labeled');
      const ackIf = callerJobIf('codex-gate.yml', 'codex-label-ack');
      assert.ok(/!= 'skip-codex-gate'/.test(ackIf) || /!= "skip-codex-gate"/.test(ackIf),
        'ack if: only non-skip labels');
      const jobs = callerJobs('codex-gate.yml');
      assert.ok(jobs.includes("check_name: 'codex / Codex Review Gate'"), 'ack mirrors exact required name');
      assert.ok(jobs.includes('mirror-required-check.yml'), 'ack uses reusable mirror');
    });
    await t('qa caller: qa-passed evaluates; other labels ack-mirror', () => {
      const types = callerPrtTypes('qa-gate.yml');
      assert.ok(/labeled/.test(types) && /unlabeled/.test(types), 'qa needs labeled');
      const iff = callerJobIf('qa-gate.yml', 'qa');
      assert.ok(/qa-passed/.test(iff), 'qa if: evaluates qa-passed labeled');
      const ackIf = callerJobIf('qa-gate.yml', 'qa-label-ack');
      assert.ok(/!= 'qa-passed'/.test(ackIf), 'ack if: only non-qa-passed labels');
      const jobs = callerJobs('qa-gate.yml');
      assert.ok(jobs.includes("check_name: 'qa / QA Gate'"), 'ack mirrors qa required name');
    });
    await t('reusable codex header documents anti-ghost mirror policy', () => {
      const yml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/codex-gate.yml'), 'utf8');
      const head = yml.split(/^name:/m)[0];
      assert.ok(/is expected/.test(head) && /mirror-required-check/.test(head),
        'reusable header must document mirror anti-ghost');
    });
  }

  for (const file of ['codex-gate.yml', 'qa-gate.yml', 'understand-gate.yml']) {
    await t(`${file}: companion heal uses triggering workflow and respects attempt cap`, async () => {
      for (const attempt of [1, 3]) {
        const reruns = [];
        const source = { id: 21, workflow_id: 7, status: 'completed', conclusion: 'cancelled', event: 'pull_request_target', run_attempt: attempt, created_at: '2026-10-16T01:00:00Z', pull_requests: [{ number: 9 }] };
        const pr = { number: 9, state: 'open', draft: false, head: { sha: RH, ref: 'feature' }, labels: [] };
        const github = { rest: {
          actions: {
            getWorkflowRun: async ({ run_id }) => {
              assert.strictEqual(run_id, 21, 'must fetch source, not companion current run');
              return { data: source };
            },
            listWorkflowRuns: {},
            reRunWorkflow: async ({ run_id }) => reruns.push(run_id),
          },
          pulls: { get: async () => ({ data: pr }), list: {} },
          issues: { listComments: {}, listEvents: {} },
        }, paginate: async (method, args) => {
          if (method === github.rest.actions.listWorkflowRuns) {
            assert.strictEqual(args.workflow_id, 7);
            return [source];
          }
          return [];
        } };
        const context = { runId: 999, repo: { owner: 'o', repo: 'r' }, eventName: 'workflow_run', payload: { workflow_run: source } };
        const core = { info() {}, warning() {}, setFailed(m) { throw new Error(m); } };
        await new AsyncFunction('github', 'context', 'core', 'process', scripts(file)[1])(github, context, core, { env: { GATE_MODE: 'refresh', REFRESH_POLL_MS: '0', QA_LABEL: 'qa-passed' } });
        assert.deepStrictEqual(reruns, attempt === 1 ? [21] : []);
      }
    });
  }

  await t('all refresh paths resolve source workflow from triggering run in companions', () => {
    for (const file of ['codex-gate.yml', 'qa-gate.yml', 'understand-gate.yml']) {
      const refreshScripts = scripts(file).filter(src => src.includes('const triggeredId ='));
      assert.ok(refreshScripts.length);
      for (const src of refreshScripts) {
        assert.match(src, /run_id: triggeredId \|\| context.runId/);
        assert.match(src, /const workflowId = thisRun.workflow_id/);
      }
    }
  });

  // ---------- mirror-required-check.yml script (label ack = required job) ----------
  {
    const SHA = 'abc1234000000000000000000000000000000000';
    const ACK_STEP = 'Label ack mirror latest real gate verdict';
    const job = (id, conclusion, extra = {}) => ({ id, status: 'completed', conclusion,
      started_at: '2026-10-20T02:00:00Z', completed_at: '2026-10-20T02:05:00Z',
      details_url: `https://github.com/o/r/actions/runs/${4000 + id}/job/${id}`, ...extra });
    // checks: array, or function(readNo) => array (simulates progress over polls).
    async function runMirror({ relevantLabels = 'qa-passed,no-auto-merge', events = [], eventsError = false, labels = [],
      runAttempt = 1, workflowRuns = [], checks = [], ackJobs = [], unknownJobs = [], noStepJobs = [], skippedJobs = [], runStatus = {}, jobError = false,
      sha = SHA, label = 'triage', action = 'labeled', checkName = 'qa / QA Gate', jobName = 'QA Gate',
      waitMinutes = '0', selfRun = 9999 } = {}) {
      const src = scripts('mirror-required-check.yml')[0];
      const infos = []; const reruns = []; const comments = []; const created = [];
      let reads = 0; let failed = null; const classified = [];
      const github = {
        paginate: async (method, args) => {
          if (method === github.rest.actions.listWorkflowRuns) return workflowRuns;
          if (method === github.rest.issues.listEvents) { if (eventsError) throw new Error('events unavailable'); return events; }
          assert.strictEqual(args.filter, 'all');
          assert.strictEqual(args.check_name, checkName);
          reads++;
          return typeof checks === 'function' ? checks(reads) : checks;
        },
        rest: {
          checks: { listForRef: {}, create: async (a) => { created.push(a); } },
          issues: { listEvents: {}, get: async () => ({ data: { labels } }), createComment: async (a) => { comments.push(a); } },
          actions: {
            getJobForWorkflowRun: async ({ job_id }) => {
              if (jobError) throw new Error('jobs api down');
              classified.push(job_id);
              if (unknownJobs.includes(job_id)) return { data: { status: 'queued', steps: [] } };
              if (noStepJobs.includes(job_id)) return { data: { status: 'completed', conclusion: 'cancelled', steps: [] } };
              if (skippedJobs.includes(job_id)) return { data: { status: 'completed', conclusion: 'skipped', steps: [] } };
              return { data: { steps: [{ name: 'Set up job' }, { name: ackJobs.includes(job_id) ? ACK_STEP : 'Evaluate' }] } };
            },
            getWorkflowRun: async ({ run_id }) => ({ data: { id: run_id, workflow_id: 99, run_attempt: runAttempt, status: runStatus[run_id] || 'completed' } }),
            listWorkflowRuns: {},
            reRunWorkflow: async (a) => { reruns.push(a); },
          },
        },
      };
      const context = { repo: { owner: 'o', repo: 'r' }, runId: selfRun, eventName: 'pull_request_target',
        payload: { action, label: { name: label }, pull_request: sha ? { number: 9, head: { sha } } : null } };
      const core = { info: (m) => infos.push(m), setFailed: (m) => { failed = m; } };
      await new AsyncFunction('github', 'context', 'core', 'process', src)(github, context, core,
        { env: { CHECK_NAME: checkName, JOB_NAME: jobName, RELEVANT_LABELS: relevantLabels, WAIT_MINUTES: waitMinutes, POLL_SECONDS: '0' } });
      return { failed, infos, reruns, comments, created, reads, classified };
    }
    const okEvents = [{ event: 'labeled', label: { name: 'qa-passed' }, created_at: '2026-10-20T01:00:00Z' }];
    const okLabels = [{ name: 'qa-passed' }];

    await t('mirror: never calls checks.create; job conclusion carries result', async () => {
      const src = scripts('mirror-required-check.yml')[0];
      assert.ok(!/checks\.create/.test(src));
      const yml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/mirror-required-check.yml'), 'utf8');
      assert.ok(!/checks:\s*write/.test(yml), 'no checks: write needed');
      assert.ok(yml.includes('name: ${{ inputs.job_name }}'), 'job name comes from input');
      assert.ok(yml.includes(`- name: ${ACK_STEP}`), 'ack step name is the ack marker');
      assert.ok(!/cancel-in-progress/.test(yml), 'no job-level cancel (would cancel the required check)');
    });
    await t('mirror: latest real success with confirmed labels ⇒ pass', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, checks: [job(1, 'success')] });
      assert.strictEqual(r.failed, null);
      assert.deepStrictEqual(r.created, []);
    });
    await t('mirror: latest real failure ⇒ fail', async () => {
      const r = await runMirror({ checks: [job(1, 'success'), job(2, 'failure')] });
      assert.match(r.failed, /is failure \(source check 2\)/);
    });
    await t('mirror: newest by id wins over later completion', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, checks: [
        job(2, 'failure', { completed_at: '2026-10-20T02:01:00Z' }), job(1, 'success', { completed_at: '2026-10-20T03:00:00Z' })] });
      assert.match(r.failed, /source check 2/);
    });
    await t('mirror: earlier acks (step marker, own run, legacy API mirror) are never sources', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, ackJobs: [5], checks: [
        job(1, 'success'),
        job(5, 'failure'),                                                     // earlier ack job
        job(6, 'failure', { details_url: 'https://github.com/o/r/actions/runs/9999/job/6' }), // this run
        job(7, 'failure', { details_url: 'https://github.com/o/r/runs/7', output: { title: 'Label ack: mirrored failure' } }),
      ] });
      assert.strictEqual(r.failed, null);
    });
    await t('mirror: only acks / nothing ⇒ fail after bounded wait (no invented green)', async () => {
      for (const checks of [[], [job(5, 'success')]]) {
        const r = await runMirror({ ackJobs: [5], checks });
        assert.match(r.failed, /Timed out after 0 min.*no real/);
      }
    });
    await t('mirror: in-flight real ⇒ waits, then mirrors its verdict', async () => {
      const r = await runMirror({ waitMinutes: '1', labels: okLabels, events: okEvents,
        checks: (n) => n < 3 ? [job(1, 'failure'), { ...job(2, null), status: 'in_progress', conclusion: null }] : [job(1, 'failure'), job(2, 'success')] });
      assert.strictEqual(r.failed, null);
      assert.ok(r.infos.some((m) => /still in_progress/.test(m)));
    });
    await t('mirror: in-flight real beyond wait ⇒ fail, not old verdict', async () => {
      const r = await runMirror({ checks: [job(1, 'success'), { ...job(2, null), status: 'in_progress', conclusion: null }] });
      assert.match(r.failed, /Timed out.*still in_progress/);
    });
    await t('mirror: queued job without steps is treated as in-flight', async () => {
      const r = await runMirror({ unknownJobs: [2], checks: [job(1, 'success'), { ...job(2, null), status: 'queued', conclusion: null }] });
      assert.match(r.failed, /Timed out/);
    });
    await t('mirror (jobs#14): stale "summary not yet" failure never re-posted once a newer real success exists', async () => {
      // t1 real PRT gate failed (summary missing) · t2 acks re-posted failure ·
      // t3 Codex review-event real gate succeeded · t4 new label ack.
      const r = await runMirror({ labels: okLabels, events: okEvents, ackJobs: [2, 3],
        checks: [job(1, 'failure'), job(2, 'failure'), job(3, 'failure'), job(4, 'success')] });
      assert.strictEqual(r.failed, null);
      // A rerun of the stale failure that succeeds (new id) also wins.
      const r2 = await runMirror({ labels: okLabels, events: okEvents, ackJobs: [2],
        checks: [job(1, 'failure'), job(2, 'failure'), job(5, 'success', { details_url: 'https://github.com/o/r/actions/runs/4001/job/5' })] });
      assert.strictEqual(r2.failed, null);
    });
    await t('mirror: skipped no-step job is transparent', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, skippedJobs: [2],
        checks: [job(1, 'success'), job(2, 'skipped', { started_at: null })] });
      assert.deepStrictEqual(r.reruns, []);
      assert.strictEqual(r.failed, null);
    });
    await t('mirror (P1-b): cancelled-at-start real evaluation newer than an older success ⇒ heal, never false green', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, noStepJobs: [2],
        checks: [job(1, 'success'), job(2, 'cancelled', { started_at: null })] });
      assert.deepStrictEqual(r.reruns, [{ owner: 'o', repo: 'r', run_id: 4002 }], 'heals the cancelled run');
      assert.ok(r.failed, 'must not mirror the older success');
      assert.ok(!/mirrored/.test(r.infos.join('\n')));
      // Heal capped ⇒ fail closed, still never the older success.
      const c = await runMirror({ runAttempt: 3, labels: okLabels, events: okEvents, noStepJobs: [2],
        checks: [job(1, 'success'), job(2, 'cancelled', { started_at: null })] });
      assert.match(c.failed, /attempt cap/);
    });
    await t('mirror (P1-b): no-step cancelled check proven an ack by a sibling attempt stays transparent', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, noStepJobs: [2], ackJobs: [3],
        checks: [job(1, 'success'), job(2, 'cancelled', { started_at: null }),
          job(3, 'success', { details_url: 'https://github.com/o/r/actions/runs/4002/job/3' })] });
      assert.deepStrictEqual(r.reruns, []);
      assert.strictEqual(r.failed, null);
    });
    await t('mirror (P1-a): queued peer (blocked on our concurrency group) does not defer heal', async () => {
      for (const status of ['queued', 'pending', 'waiting', 'requested']) {
        const r = await runMirror({ waitMinutes: '1', labels: okLabels, events: okEvents,
          workflowRuns: [{ id: 4500, status, pull_requests: [{ number: 9 }] }],
          checks: (k) => k < 3 ? [job(1, 'cancelled')] : [job(1, 'cancelled'), job(3, 'success')] });
        assert.deepStrictEqual(r.reruns, [{ owner: 'o', repo: 'r', run_id: 4001 }], status);
        assert.strictEqual(r.failed, null, status);
      }
    });
    await t('mirror (P1-a): deferral behind an in-progress peer is bounded ⇒ fail closed', async () => {
      const r = await runMirror({ waitMinutes: '60', workflowRuns: [{ id: 4500, status: 'in_progress', pull_requests: [{ number: 9 }] }],
        checks: [job(1, 'cancelled')] });
      assert.deepStrictEqual(r.reruns, []);
      assert.match(r.failed, /deferred 9 times/);
    });
    await t('mirror (P1-a): healed run queued without publishing a replacement check ⇒ bounded fail', async () => {
      const r = await runMirror({ waitMinutes: '60', runStatus: { 4001: 'queued' }, checks: [job(1, 'cancelled')] });
      assert.strictEqual(r.reruns.length, 1);
      assert.match(r.failed, /still queued.*failing closed/);
      assert.ok(r.reads < 20, `bounded polls (${r.reads})`);
    });
    await t('mirror (P1-a): healed run stuck queued behind this ack ⇒ bounded fail, no mutual wait', async () => {
      const r = await runMirror({ waitMinutes: '60', unknownJobs: [3], runStatus: { 4001: 'queued' },
        checks: (k) => k < 2 ? [job(1, 'cancelled')]
          : [job(1, 'cancelled'), { ...job(3, null), status: 'queued', conclusion: null, details_url: 'https://github.com/o/r/actions/runs/4001/job/3' }] });
      assert.strictEqual(r.reruns.length, 1);
      assert.match(r.failed, /still queued.*failing closed/);
      assert.ok(r.reads < 20, `bounded polls (${r.reads})`);
    });
    await t('mirror: deferred heal retried after peer finishes; budget only on issued rerun', async () => {
      let n = 0;
      const peers = [{ id: 4500, status: 'in_progress', pull_requests: [{ number: 9 }] }];
      const r = await runMirror({ waitMinutes: '1', workflowRuns: peers, labels: okLabels, events: okEvents,
        checks: (k) => { n = k; if (k === 3) peers[0].status = 'completed'; return k < 6 ? [job(1, 'cancelled')] : [job(1, 'cancelled'), job(3, 'success')]; } });
      assert.deepStrictEqual(r.reruns, [{ owner: 'o', repo: 'r', run_id: 4001 }]);
      assert.strictEqual(r.failed, null);
    });
    await t('mirror: second cancellation after an issued heal ⇒ fail, no second rerun', async () => {
      const r = await runMirror({ waitMinutes: '1',
        checks: (k) => k < 3 ? [job(1, 'cancelled')] : [job(1, 'cancelled'), job(3, 'cancelled')] });
      assert.strictEqual(r.reruns.length, 1);
      assert.match(r.failed, /cancelled again/);
    });
    await t('mirror: classification stops at newest real check', async () => {
      const r = await runMirror({ labels: okLabels, events: okEvents, ackJobs: [9],
        checks: [job(1, 'failure'), job(2, 'failure'), job(3, 'success'), job(9, 'failure')] });
      assert.strictEqual(r.failed, null);
      assert.ok(!r.classified.includes(1) && !r.classified.includes(2), String(r.classified));
    });
    await t('mirror: jobs API failure ⇒ fail', async () => {
      const r = await runMirror({ jobError: true, checks: [job(1, 'success')] });
      assert.match(r.failed, /Cannot read\/classify/);
    });
    await t('mirror: skipped / neutral real verdict is not a pass', async () => {
      for (const c of ['skipped', 'neutral', 'timed_out']) {
        const r = await runMirror({ checks: [job(1, c)] });
        assert.match(r.failed, new RegExp(`is ${c}`));
      }
    });
    for (const relevant of ['qa-passed', 'skip-codex-gate']) {
      await t(`mirror: ${relevant} removed after source success ⇒ success refused`, async () => {
        const r = await runMirror({ relevantLabels: relevant, checks: [job(1, 'success')],
          events: [{ event: 'unlabeled', label: { name: relevant }, created_at: '2026-10-20T03:00:00Z' }] });
        assert.match(r.failed, /Success refused/);
      });
    }
    await t('mirror: unreadable / missing label history refuses success', async () => {
      for (const o of [{ eventsError: true }, { labels: okLabels, events: [] }, { events: null }, { relevantLabels: '' },
        { labels: okLabels, events: okEvents, checks: [job(1, 'success', { started_at: null, completed_at: null })] }]) {
        const r = await runMirror({ checks: [job(1, 'success')], ...o });
        assert.match(r.failed, /Success refused/);
      }
    });
    await t('mirror: source changing during validation re-polls instead of concluding', async () => {
      const r = await runMirror({ waitMinutes: '1', labels: okLabels, events: okEvents,
        checks: (n) => n < 2 ? [job(1, 'success')] : [job(1, 'success'), job(2, 'failure')] });
      assert.match(r.failed, /source check 2/);
    });
    await t('mirror: cancelled ⇒ heal re-run once then mirror re-run verdict', async () => {
      const r = await runMirror({ waitMinutes: '1', labels: okLabels, events: okEvents,
        checks: (n) => n < 3 ? [job(1, 'cancelled')] : [job(1, 'cancelled'), job(3, 'success')] });
      assert.deepStrictEqual(r.reruns, [{ owner: 'o', repo: 'r', run_id: 4001 }]);
      assert.strictEqual(r.failed, null);
    });
    await t('mirror: cancelled at attempt cap ⇒ comment + fail, no rerun', async () => {
      for (const runAttempt of [3, 4]) {
        const r = await runMirror({ runAttempt, checks: [job(1, 'cancelled')] });
        assert.deepStrictEqual(r.reruns, []);
        assert.strictEqual(r.comments.length, 1);
        assert.strictEqual(r.comments[0].issue_number, 9);
        assert.match(r.failed, /attempt cap.*Actions UI or push/);
      }
    });
    await t('mirror: PR-associated in-progress peer defers heal; queued peer does not (own run ignored)', async () => {
      for (const status of ['queued', 'in_progress', 'completed']) {
        for (const [id, assoc] of [[4001, 9], [4002, 9], [4002, 10], [9999, 9]]) {
          const r = await runMirror({ checks: [job(1, 'cancelled')], workflowRuns: [{ id, status, pull_requests: [{ number: assoc }] }] });
          const blocked = id === 4002 && assoc === 9 && status === 'in_progress';
          assert.strictEqual(r.reruns.length, blocked ? 0 : 1, `${status} ${id} ${assoc}`);
          assert.match(r.failed, /Timed out/);
        }
      }
    });
    await t('mirror: missing PR head or bad name pairing ⇒ fail', async () => {
      assert.match((await runMirror({ sha: null })).failed, /No pull_request/);
      assert.match((await runMirror({ jobName: 'Codex Review Gate' })).failed, /must end with/);
    });
    await t('self-listen guard rejects own name, accepts companion and scans repo', () => {
      const code = "import runpy; f=runpy.run_path('scripts/check-no-self-listen.py')['self_listens']; assert f('name: Gate\\non: {workflow_run: {workflows: [Gate]}}'); assert not f('name: Heal\\non: {workflow_run: {workflows: [Gate]}}')";
      require('child_process').execFileSync('python3', ['-c', code.replace(/\\n/g, '\\n')]);
      require('child_process').execFileSync('python3', ['scripts/check-no-self-listen.py']);
    });
    await t('label-ack callers: named as required prefix, job_name matches, no checks: write', () => {
      const mirror = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/mirror-required-check.yml'), 'utf8');
      assert.ok(!/pull-requests:\s*write/.test(mirror));
      for (const [gate, prefix, jobName] of [['codex', 'codex', 'Codex Review Gate'], ['qa', 'qa', 'QA Gate']]) {
        const caller = fs.readFileSync(path.join(__dirname, '..', 'examples', gate + '-gate.yml'), 'utf8');
        const ack = caller.split('  ' + gate + '-label-ack:')[1].split(/^  [a-zA-Z]/m)[0];
        assert.match(ack, new RegExp(`\\n    name: ${prefix}\\n`));
        assert.ok(ack.includes(`job_name: '${jobName}'`));
        assert.ok(ack.includes(`check_name: '${prefix} / ${jobName}'`));
        assert.match(ack, /issues:\s*write/);
        assert.ok(!/checks:\s*write/.test(ack));
        assert.ok(!/pull-requests:\s*write/.test(ack));
      }
    });
    await t('codex/qa callers: labeled evaluate + ack share the SHA lock; ack never cancels', () => {
      for (const f of ['codex-gate.yml', 'qa-gate.yml']) {
        const ex = fs.readFileSync(path.join(__dirname, '..', 'examples', f), 'utf8');
        const concurrency = ex.split(/^concurrency:/m)[1].split(/^jobs:/m)[0];
        assert.ok(concurrency.includes("format('label-{0}', github.event.pull_request.head.sha)"));
        const cancel = concurrency.split('cancel-in-progress:')[1];
        const labels = f === 'codex-gate.yml' ? 'skip-codex-gate' : 'qa-passed';
        assert.ok(cancel.includes(`|| (contains(fromJSON('["labeled","unlabeled"]'), github.event.action) && contains(fromJSON('["${labels}","no-auto-merge"]'), github.event.label.name))`));
        assert.ok(concurrency.includes("&& 'push'"));
        assert.ok(concurrency.includes("format('run-{0}', github.run_id)"));
      }
    });
  }

  if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
  console.log('all passed');
})();
