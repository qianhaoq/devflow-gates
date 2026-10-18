# AGENTS.md — devflow-gates

Guidance for AI agents (and humans) changing this repo. User-facing docs are
in [README.md](README.md).

## Layout

- `.github/workflows/*.yml` — reusable workflows (`on: workflow_call`):
  `ci.yml`, `codex-gate.yml`, `qa-gate.yml`, `auto-merge.yml`,
  `post-deploy-smoke.yml`, `acceptance.yml`. `self-lint.yml` is this repo's
  own CI.
- `examples/` — caller files to copy into product repos.
- `templates/` — `QA.md` (manual QA sheet), `acceptance.yml` (Acceptance Gate
  config; must equal the built-in defaults — a test enforces this).
- `tests/gates.test.js` — dry-runs the inline github-script blocks with a
  mocked API. `tests/acceptance_test.py` — exec's the
  `# >>> acceptance-*-core` … `# <<<` Python blocks of `acceptance.yml`.

## Rules for changes

- Run before pushing: `actionlint .github/workflows/*.yml examples/*.yml`,
  `node tests/gates.test.js`, `python3 tests/acceptance_test.py`.
- Check names are API: never rename a called job (`Build & Test`,
  `Secret Scan`, `Codex Review Gate`, `QA Gate`, `Auto Merge`,
  `Post-deploy Smoke`, `Acceptance Gate`) without updating every caller's
  branch protection.
- Anything that executes PR code runs from a `pull_request` caller with
  read-only permissions and no secrets; gates on `pull_request_target`
  must never check out or run PR code.
- `runs_on` (default `ubuntu-latest`): callers may pass `self-hosted`
  (or a JSON label array) to avoid GitHub-hosted minute billing.
  Persistent self-hosted runners that execute PR code (Reusable CI)
  are only for trusted private repos with no untrusted fork PRs;
  prefer ephemeral/isolated runners otherwise. Read-only gates are
  safer on self-hosted than CI.
- Minimal permissions per job, `timeout-minutes` on every job.
- Actions minutes (private callers pay; every job bills >= 1 min):
  - Filter irrelevant events with a CALLER job-level `if:` (no runner, and
    the skipped check is named after the caller job). Never skip a
    head-attached event INSIDE a reusable file: that attaches a skipped
    (= passing) required check.
  - No blind periodic re-runs. Refresh jobs re-run a failed gate run only
    when its input changed (Codex: the shared `verdict()` would now pass;
    QA: label applied after the run), else at most the newest cancelled
    run; one re-run per PR per refresh; never at `run_attempt >= 3`.
  - Concurrency: `cancel-in-progress` only within the push class
    (opened/synchronize/reopened) per PR, so a new commit cancels only the
    older head's evaluation. Label / review / dispatch runs get their own
    group: a label or review event must never cancel a push evaluation, and
    a cancelled required check must never be the final word.
- Gates other than the QA gate never add or remove labels. Only the editor /
  QA owner applies `qa-passed` / `editorial-approved` — agents never do.
- QA gate `keep_qa_on_clean_main_update` (opt-in, default `false`): the only
  place a gate runs git, and only plumbing in a temp bare repo (never a
  checkout, never PR code). Any doubt or error must STRIP the label (fail
  safe). The git scenarios live in `tests/gates.test.js` ("qa-gate keep:")
  and use real git against a local bare remote — keep them passing.
- No dependency on Copilot (quota is not guaranteed).
- Callers pin a merged commit SHA; after merging here, re-pin callers via
  their own PRs.
- Acceptance Gate: new metrics start as `observe`; flipping a repo to
  `enforce` or adding `acceptance / Acceptance Gate` to branch protection
  is a separate, explicit decision (M2+).

## Handoff between bots

- When work passes to the next bot, message that bot **one-on-one (direct
  message), marked priority**, so it wakes up. Don't rely on a group
  channel mention or a PR comment alone. Include the repo, PR URL, head SHA,
  what is done, and what the next bot must do.
- When a gate turns green on a PR (CI, Codex, QA/editorial, Acceptance),
  notify **the product bot** and **专业测试** with the PR URL, head SHA, and
  which gates are green.
