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
    async function scenario(build, { keep = true, action = 'synchronize', labeledAt = 2, labeler = 'qa-bot', runAt = 1.1 } = {}) {
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
            const at = args.head_sha === B ? runAt : (pushed.includes(args.head_sha) ? 4 : null);
            return at === null ? [] : [{ id: 1, event: 'pull_request_target', head_sha: args.head_sha, head_branch: 'feat', head_repository: { full_name: 'o/r' }, created_at: iso(at) }];
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
      stripped(c, /no pull_request_target run .* proves/);
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
