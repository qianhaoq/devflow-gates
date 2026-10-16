"""Offline tests for the inline Python in .github/workflows/acceptance.yml.

Extracts the `# >>> acceptance-*-core` … `# <<<` blocks and exec()s them,
then exercises the pure functions. No network, no tokens.
Run: python3 tests/acceptance_test.py
"""
import os, re, sys, tempfile, textwrap

WF = os.path.join(os.path.dirname(__file__), '..', '.github', 'workflows', 'acceptance.yml')
SRC = open(WF, encoding='utf-8').read()


def core(name):
    m = re.search(r'^([ \t]*)# >>> acceptance-%s-core\n(.*?)^[ \t]*# <<< acceptance-%s-core' % (name, name), SRC, re.S | re.M)
    assert m, name
    ns = {}
    exec(textwrap.dedent(m.group(1) + '# x\n' + m.group(2)), ns)
    return ns


C, M, G = core('config'), core('measure'), core('gate')
fails = 0


def t(name, fn):
    global fails
    try:
        fn()
        print('ok   ' + name)
    except Exception as e:  # noqa
        fails += 1
        print('FAIL ' + name + '\n     ' + repr(e))


def cfg(raw=None):
    c, w = C['resolve'](raw)
    return c


# ---- config
def _defaults():
    c, w = C['resolve'](None)
    assert c['mode'] == 'observe' and not w
    assert all(m['mode'] == 'observe' and m['enabled'] for m in c['metrics'].values())
    assert c['metrics']['tests']['threshold'] == 70 and c['metrics']['size']['threshold'] == 600
t('config: defaults when file missing', _defaults)

def _override():
    c, w = C['resolve']({'mode': 'enforce', 'metrics': {'size': {'threshold': 400, 'mode': 'observe'},
                                                        'lint': {'commands': ['ruff check .', {'run': 'tsc', 'count_regex': 'error'}]},
                                                        'bogus': {}}, 'x': 1})
    assert c['mode'] == 'enforce' and c['metrics']['size']['mode'] == 'observe' and c['metrics']['tests']['mode'] == 'enforce'
    assert c['metrics']['size']['threshold'] == 400.0
    assert [x['run'] for x in c['metrics']['lint']['commands']] == ['ruff check .', 'tsc']
    assert len(w) == 2, w
t('config: global/per-metric mode, thresholds, unknown keys warn', _override)

def _bad():
    c, w = C['resolve']({'mode': 'strict', 'metrics': {'tests': {'threshold': 'x'}, 'evidence': {'heading_regex': '('}}})
    assert c['mode'] == 'observe' and c['metrics']['tests']['threshold'] == 70
    assert c['metrics']['evidence']['heading_regex'] == C['DEFAULTS']['metrics']['evidence']['heading_regex']
    assert len(w) == 3
    c, w = C['resolve'](['not', 'a', 'map'])
    assert c['mode'] == 'observe' and w
t('config: invalid values fall back to defaults with warnings', _bad)

# ---- measure
DIFF = """diff --git a/src/a.py b/src/a.py
--- a/src/a.py
+++ b/src/a.py
@@ -1,0 +2,3 @@
+x
+y
+z
@@ -10 +12 @@
-a
+b
diff --git a/old.py b/old.py
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-q
-r
"""
def _diff():
    a = M['parse_diff_added_lines'](DIFF)
    assert a == {'src/a.py': {2, 3, 4, 12}}, a
t('measure: diff added lines', _diff)

def _lcov():
    root = tempfile.mkdtemp()
    lcov = f"SF:{root}/src/a.py\nDA:2,1\nDA:3,0\nDA:12,5\nDA:50,1\nend_of_record\n"
    cov = M['parse_lcov'](lcov, root)
    c, tot, per = M['changed_line_coverage'](M['parse_diff_added_lines'](DIFF), cov)
    assert (c, tot) == (2, 3), (c, tot)  # line 4 not instrumented
t('measure: lcov changed-line coverage (abs paths)', _lcov)

def _cobertura():
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, 'src'))
    open(os.path.join(root, 'src', 'a.py'), 'w').close()
    xml = f"""<coverage><sources><source>{root}/src</source></sources><packages><package><classes>
      <class filename="a.py"><lines><line number="2" hits="0"/><line number="3" hits="2"/><line number="4" hits="1"/></lines></class>
    </classes></package></packages></coverage>"""
    cov = M['parse_cobertura'](xml, root)
    assert 'src/a.py' in cov, cov
    c, tot, _ = M['changed_line_coverage'](M['parse_diff_added_lines'](DIFF), cov)
    assert (c, tot) == (2, 3)
t('measure: cobertura with <source> resolution', _cobertura)

def _count():
    assert M['count_issues']('a\n\nb\n') == 2
    assert M['count_issues']('x: error E1\nnote\ny: error E2', r'error') == 2
t('measure: lint issue counting', _count)

def _run():
    r = M['run']('echo hi; exit 3', '.', 10)
    assert r['exit'] == 3 and 'hi' in r['output']
    r = M['run']('sleep 30 & sleep 30', '.', 1)
    assert r['timed_out'] and r['exit'] is None and r['seconds'] < 10
t('measure: run() exit code + process-group timeout', _run)

# ---- gate
R = G['r']
def F(name, a=1, d=0, status='modified'):
    return {'filename': name, 'additions': a, 'deletions': d, 'status': status}

def _tests():
    m = cfg()['metrics']['tests']
    assert G['eval_tests'](m, None, 'success')['status'] == 'n/a'
    m = dict(m, command='pytest')
    assert G['eval_tests'](m, None, 'failure')['status'] == 'error'
    ms = {'tests': {'exit': 0, 'timed_out': False, 'coverage': {'covered': 7, 'coverable': 10}}}
    assert G['eval_tests'](m, ms, 'success')['status'] == 'pass'
    ms['tests']['coverage'] = {'covered': 6, 'coverable': 10}
    assert G['eval_tests'](m, ms, 'success')['status'] == 'fail'
    ms['tests']['coverage'] = None
    x = G['eval_tests'](m, ms, 'success')
    assert x['status'] == 'pass' and 'n/a' in x['value']
    ms['tests']['exit'] = 1
    assert G['eval_tests'](m, ms, 'success')['status'] == 'fail'
    assert G['eval_tests'](m, {'setup': {'exit': 2}, 'tests': {'exit': 0}}, 'success')['status'] == 'fail'
t('gate: tests/coverage statuses', _tests)

def _tc():
    m = cfg()['metrics']['tests_changed']
    e = G['eval_tests_changed']
    assert e(m, [F('README.md')], [], '')['status'] == 'pass'
    assert e(m, [F('src/a.py')], [], '')['status'] == 'fail'
    assert e(m, [F('src/a.py'), F('tests/test_a.py')], [], '')['status'] == 'pass'
    assert e(m, [F('src/a.ts'), F('src/a.test.ts')], [], '')['status'] == 'pass'
    assert e(m, [F('pkg/x.go'), F('pkg/x_test.go')], [], '')['status'] == 'pass'
    assert e(m, [F('src/a.py', status='removed')], [], '')['status'] == 'pass'
    assert e(m, [F('src/a.py')], ['no-test-needed'], 'nothing')['status'] == 'fail'
    assert e(m, [F('src/a.py')], ['no-test-needed'], '## Why\nno-test-needed: pure rename of a constant')['status'] == 'pass'
    assert e(m, [F('src/a.py')], ['no-test-needed'], '无需测试：只改了日志文案和注释')['status'] == 'pass'
    assert e(m, [F('src/a.py')], [], 'no-test-needed: pure rename of a constant')['status'] == 'fail'
t('gate: tests changed with source + exemption needs label AND reason', _tc)

def _lint():
    m = cfg({'metrics': {'lint': {'commands': ['x']}}})['metrics']['lint']
    e = G['eval_lint']
    assert e(cfg()['metrics']['lint'], None, '')['status'] == 'n/a'
    assert e(m, {'lint': {'commands': [{'head': 3, 'base': 3}]}}, 's')['status'] == 'pass'
    assert e(m, {'lint': {'commands': [{'head': 2, 'base': 5}]}}, 's')['status'] == 'pass'
    assert e(m, {'lint': {'commands': [{'head': 4, 'base': 3}]}}, 's')['status'] == 'fail'
    assert e(m, {'lint': {'commands': [{'head': 4, 'base': None}]}}, 's')['status'] == 'n/a'
    assert e(m, None, 'cancelled')['status'] == 'error'
t('gate: lint compares head vs base', _lint)

def _size():
    m = cfg()['metrics']['size']
    assert G['eval_size'](m, [F('a.py', 300, 300)])['status'] == 'pass'
    assert G['eval_size'](m, [F('a.py', 300, 301)])['status'] == 'fail'
    assert G['eval_size'](m, [F('a.py', 10), F('package-lock.json', 5000), F('web/yarn.lock', 900)])['value'] == '10 lines'
t('gate: size threshold excludes lockfiles', _size)

def _deps():
    m = cfg()['metrics']['dependencies']
    e = G['eval_dependencies']
    assert e(m, [F('a.py')], {'outcome': 'failure'})['status'] == 'pass'
    assert e(m, [F('package.json')], {'outcome': 'success'})['status'] == 'pass'
    assert e(m, [F('package.json')], {'outcome': 'failure'})['status'] == 'n/a'
    assert e(m, [F('.github/workflows/ci.yml')], {'outcome': ''})['status'] == 'n/a'
    x = e(m, [F('requirements.txt')], {'outcome': 'failure', 'vulnerable': '[{"name":"lodash"}]', 'invalid_license': '[]'})
    assert x['status'] == 'fail' and 'lodash' in x['detail']
t('gate: dependencies (no manifest / clean / unavailable / vulnerable)', _deps)

def _ev():
    m = cfg()['metrics']['evidence']
    e = G['eval_evidence']
    assert e(m, '## 自测\n- 跑了 pytest')['status'] == 'pass'
    assert e(m, '### Test plan\n\n1. open page')['status'] == 'pass'
    assert e(m, '**验收**\n截图如下')['status'] == 'pass'
    assert e(m, '## QA\n<!-- fill me -->\n## Notes\nx')['status'] == 'fail'
    assert e(m, 'tested locally')['status'] == 'fail'
    assert e(cfg({'metrics': {'evidence': {'heading_regex': 'Verification'}}})['metrics']['evidence'], '# verification\nok')['status'] == 'pass'
t('gate: evidence heading must exist and be non-empty', _ev)

def _ai():
    m = cfg()['metrics']['ai_review']
    e = G['eval_ai_review']
    n = 'codex / Codex Review Gate'
    assert e(m, [])['status'] == 'pending'
    assert e(m, [{'name': n, 'status': 'in_progress', 'started_at': '1'}])['status'] == 'pending'
    runs = [{'name': n, 'status': 'completed', 'conclusion': 'failure', 'started_at': '2026-01-01T00:00:00Z', 'id': 1},
            {'name': n, 'status': 'completed', 'conclusion': 'success', 'started_at': '2026-01-01T00:05:00Z', 'id': 2},
            {'name': 'qa / QA Gate', 'status': 'completed', 'conclusion': 'failure', 'started_at': '2026-01-02', 'id': 3}]
    assert e(m, runs)['status'] == 'pass'
    assert e(m, runs[:1])['status'] == 'fail'
t('gate: AI review reads the latest Codex gate check run', _ai)

def _final():
    c = cfg()
    res = {k: R('pass') for k in G['NAMES']}
    res['size'] = R('fail', '900 lines')
    metrics, overall, blocking, observed = G['finalize'](c, res)
    assert overall == 'warn' and blocking == [] and observed == ['size']
    c = cfg({'mode': 'enforce', 'metrics': {'tests': {'enabled': False}}})
    res['tests'] = R('fail')
    metrics, overall, blocking, observed = G['finalize'](c, res)
    assert overall == 'fail' and blocking == ['size']
    assert [x for x in metrics if x['id'] == 'tests'][0]['status'] == 'disabled'
    md = G['render']({'head_sha': 'abcdef1234', 'overall': overall, 'config_source': 'defaults', 'run_url': 'u',
                      'metrics': metrics, 'blocking': blocking, 'observed': observed, 'config_warnings': ['a|b']})
    assert md.startswith(G['MARKER']) and md.count('\n| ') == 9 and 'a\\|b' in md
    assert '@codex' not in md and 'Codex Review Summary' not in md
t('gate: observe never blocks, enforce blocks, render sticky table', _final)

def _template():
    import yaml
    y = yaml.safe_load(open(os.path.join(os.path.dirname(__file__), '..', 'templates', 'acceptance.yml'), encoding='utf-8'))
    c, w = C['resolve'](y)
    assert not w and c == cfg(), w
try:
    import yaml  # noqa: F401
    t('templates/acceptance.yml documents exactly the defaults', _template)
except ImportError:
    print('skip templates/acceptance.yml check (no PyYAML)')

print(f'\n{fails} failure(s)')
sys.exit(1 if fails else 0)
