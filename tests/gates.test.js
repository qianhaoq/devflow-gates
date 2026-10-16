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

  // QA gate dry-run.
  const qa = scripts('qa-gate.yml')[0];
  async function runQa({ draft, action, labels, events = [], allowed = '', updatedAt }) {
    const calls = { removed: [], failed: null };
    const github = {
      rest: {
        pulls: { get: async () => ({ data: { number: 1, state: 'open', merged: false, draft, head: { sha: 'abcdef1234567' }, labels: labels.map((name) => ({ name })) } }) },
        issues: { removeLabel: async (a) => { calls.removed.push(a.name); }, listEvents: async () => ({}), listEventsForTimeline: async () => ({}) },
        repos: { getCommit: async () => ({ data: { commit: { committer: { date: '2026-01-01T00:00:00Z' } } } }) },
      },
      paginate: async (fn) => (fn === github.rest.issues.listEvents ? events : []),
    };
    const core = { info() {}, warning() {}, setFailed: (m) => { calls.failed = m; } };
    const context = { eventName: 'pull_request_target', payload: { action, pull_request: { number: 1, head: { sha: 'abcdef1234567' }, updated_at: updatedAt } }, repo: { owner: 'o', repo: 'r' } };
    await new AsyncFunction('github', 'context', 'core', 'process', qa)(github, context, core, { env: { QA_LABEL: 'qa-passed', ALLOWED_LABELERS: allowed } });
    return calls;
  }
  await t('qa-gate: push to draft PR removes qa-passed and fails', async () => {
    const c = await runQa({ draft: true, action: 'synchronize', labels: ['qa-passed'] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /new push invalidated QA/.test(c.failed), c.failed);
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
    const c = await runQa({ draft: false, action: 'synchronize', labels: ['qa-passed'], allowed: 'qianhaoq',
      updatedAt: '2026-02-01T16:57:25Z', events: [at('labeled', 'qianhaoq', '2026-02-01T16:57:34Z')] });
    assert.deepStrictEqual(c.removed, []);
    assert.strictEqual(c.failed, null, c.failed);
  });
  await t('qa-gate: label applied before the push is stripped on synchronize', async () => {
    const c = await runQa({ draft: false, action: 'synchronize', labels: ['qa-passed'],
      updatedAt: '2026-02-01T16:57:25Z', events: [at('labeled', 'qianhaoq', '2026-02-01T16:50:00Z')] });
    assert.deepStrictEqual(c.removed, ['qa-passed']);
    assert.ok(c.failed && /new push invalidated QA/.test(c.failed), c.failed);
  });

  // Refresh: dispatch runs on the PR branch count (crawl PRs created with GITHUB_TOKEN).
  for (const file of ['codex-gate.yml', 'qa-gate.yml']) {
    const refresh = scripts(file)[1];
    async function runRefresh(runsByEvent) {
      const reran = [];
      const github = {
        rest: {
          actions: {
            getWorkflowRun: async () => ({ data: { workflow_id: 7, name: 'Gate' } }),
            listWorkflowRuns: async (a) => ({ data: { workflow_runs: runsByEvent[a.event] || [] } }),
            reRunWorkflowFailedJobs: async (a) => { reran.push(a.run_id); },
          },
          pulls: { list: async () => ({}) },
        },
        paginate: async () => [{ number: 9, draft: false, head: { sha: 'h1', ref: 'crawl/auto' } }],
      };
      const core = { info() {}, warning() {}, setFailed(m) { throw new Error(m); } };
      const context = { runId: 1, repo: { owner: 'o', repo: 'r' }, payload: {} };
      await new AsyncFunction('github', 'context', 'core', 'process', refresh)(github, context, core, { env: {} });
      return reran;
    }
    await t(`${file} refresh: re-runs failed workflow_dispatch run on the PR branch`, async () => {
      const r = await runRefresh({ workflow_dispatch: [{ id: 5, event: 'workflow_dispatch', head_sha: 'h1', head_branch: 'crawl/auto', conclusion: 'failure', created_at: '2026-10-16T01:20:00Z' }] });
      assert.deepStrictEqual(r, [5]);
    });
    await t(`${file} refresh: ignores dispatch on another branch`, async () => {
      const r = await runRefresh({ workflow_dispatch: [{ id: 6, event: 'workflow_dispatch', head_sha: 'h1', head_branch: 'main', conclusion: 'failure', created_at: '2026-10-16T01:20:00Z' }] });
      assert.deepStrictEqual(r, []);
    });
    await t(`${file} refresh: newest run decides (later target success wins)`, async () => {
      const r = await runRefresh({
        workflow_dispatch: [{ id: 5, event: 'workflow_dispatch', head_sha: 'h1', head_branch: 'crawl/auto', conclusion: 'failure', created_at: '2026-10-16T01:20:00Z' }],
        pull_request_target: [{ id: 8, event: 'pull_request_target', head_sha: 'h1', conclusion: 'success', created_at: '2026-10-16T02:00:00Z' }] });
      assert.deepStrictEqual(r, []);
    });
  }

  if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
  console.log('all passed');
})();
