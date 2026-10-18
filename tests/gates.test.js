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
  async function runRefresh(file, runsByEvent, { summary = SUMMARY_DONE, labels = [], labelEvents = [], eventName = 'schedule', payload = {}, prs, mode = 'refresh', failed = [] } = {}) {
    const reran = [];
    const prList = prs || [{ number: 9, state: 'open', draft: false, head: { sha: RH, ref: 'crawl/auto' }, labels: labels.map((name) => ({ name })) }];
    const github = {
      rest: {
        actions: {
          getWorkflowRun: async () => ({ data: { workflow_id: 7, name: 'Gate' } }),
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
        if (fn === github.rest.issues.listComments) return summary ? [summary] : [];
        if (fn === github.rest.issues.listEvents) return labelEvents;
        if (fn === github.rest.pulls.list) return prList;
        if (fn === github.rest.actions.listWorkflowRuns) return runsByEvent[args.event] || [];
        return [];
      },
    };
    const core = { info(m) { if (process.env.DEBUG_T) console.log('  info:', m); }, warning() {}, setFailed(m) { if (mode !== 'refresh') { failed.push(m); return; } throw new Error(m); }, summary: { addRaw() { return this; }, write: async () => {} } };
    const context = { runId: 1, eventName, repo: { owner: 'o', repo: 'r' }, payload };
    const src = scripts(file)[mode === 'refresh' ? 1 : 0];
    await new AsyncFunction('github', 'context', 'core', 'process', 'exec', src)(github, context, core, { env: { GATE_MODE: mode, QA_LABEL: 'qa-passed', REFRESH_POLL_MS: '0' } }, {});
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
    await t(`${file} refresh: newest run decides (later success, older failure → nothing)`, async () => {
      const r = await runRefresh(file, {
        workflow_dispatch: [run(5, 'workflow_dispatch', 'failure', '2026-10-16T01:20:00Z')],
        pull_request_target: [run(8, 'pull_request_target', 'success', '2026-10-16T02:00:00Z')] });
      assert.deepStrictEqual(r, []);
    });
  }

  if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
  console.log('all passed');
})();
