# AGENTS.md — devflow-gates

Guidance for AI agents (and humans) changing this repo. User-facing docs are
in [README.md](README.md).

## Layout

- `.github/workflows/*.yml` — reusable workflows (`on: workflow_call`):
  `ci.yml`, `codex-gate.yml`, `qa-gate.yml`, `understand-gate.yml`, `auto-merge.yml`,
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
  `Secret Scan`, `Codex Review Gate`, `QA Gate`, `Diff Quiz Gate`, `Auto Merge`,
  `Post-deploy Smoke`, `Acceptance Gate`) without updating every caller's
  branch protection.
- Anything that executes PR code runs from a `pull_request` caller with
  read-only permissions and no secrets; gates on `pull_request_target`
  must never check out or run PR code.
- `runs_on` (default `ubuntu-latest`): callers may pass `self-hosted`
  (or a JSON label array) to avoid GitHub-hosted minute billing.
  Persistent self-hosted runners that execute PR code (Reusable CI)
  are only for trusted private repos with no untrusted fork PRs;
  prefer ephemeral/isolated runners otherwise. Reusable CI Secret
  Scan downloads a linux_x64 gitleaks binary — prefer
  `["self-hosted","linux","x64"]` (not bare `self-hosted`) for CI.
  Gates that do not execute PR code still hold write tokens
  (auto-merge / QA / refresh); only run them on trusted, isolated
  runners — do not treat them as credential-free.
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
- Cancelled required checks are healed, never bypassed (A1/A2, 2026-10):
  branch protection gates on the LATEST check run per required name on the
  head SHA, so a stuck cancelled/expected check blocks merge even when the
  change is substantively green (jobs-qianhao-ai #4).
  - A1: the gate callers self-listen via `workflow_run(completed)` (fires
    from the default branch only; GitHub caps workflow_run chains at 3
    levels, so self-listening cannot loop) and run a `*-cancel-heal` job
    (QA's is DEFAULT ON) that routes to the reusable refresh job, which
    re-runs the TRIGGERING cancelled run — a cancelled run cannot run its
    own post steps. Same caps: one re-run per PR, attempt 3, never while a
    run is in flight. Heal/refresh concurrency groups are never
    cancelled and never join the push cancel-in-progress group.
  - A2: auto-merge classifies the LATEST run per required name
    (`classifyRequiredCheck`): missing/pending → skip, cancelled → re-run
    that run (`actions: write`, cap 3) and skip merging this round,
    failure → ordinary red. An OLDER success never overrides the newest
    run (same rule as branch protection).
  - If a merge is still stuck on expected/cancelled, run
    `./scripts/heal-required-checks.sh owner/repo PR` first — do NOT
    temporarily remove branch protection. The extreme fallback (manual
    protection removal) must come with an issue.
  - B (a "Ready to Merge" rollup check) is deliberately NOT done this
    week (2026-W42); it is next week's work.
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

## Coding 工具顺序（2026-10-20 起）

**适用范围（写死）**：下列 Codex / `coding` / `/home/box/.../codex-quota.sh` 顺序**仅**适用于已预装这些工具的**本机或 `/home/box` 工作站**。Copilot cloud、仅 Node·npm 的云端 agent、以及任何未预装 Codex/`coding` 的环境：**必须按该环境已有工具执行**；**严禁**把本机/box 工具序、`codex`/`coding` 或 `/home/box` 路径当作云端硬性要求。

1. **（本机/box）默认用 Codex CLI**（ChatGPT 账号登录），模型 `gpt-6.1-sol`（`~/.codex/config.toml`）。
2. **周额度用完后继续用 credits** 跑 Codex；**credits 也用完**再切：`coding glm`（一般代码）/ `coding kimi`（前端/交互/UI）。
3. 查额度（仅本机/box）：`/home/box/.coding-plans/codex-quota.sh`（退出码 0=继续 Codex，1=切 glm/kimi，2=未知；`--json`、`--probe`），或 Codex TUI 内 `/status`。云端无此脚本时跳过。
4. 凭证 `~/.codex/auth.json` 及任何 API key **绝不打印、外传或提交**；`.codex/`、`auth.json` 已在 `.gitignore`。

## 测试与门禁（禁止弱化凑绿）

- **禁止**为过 CI / Gate 而弱化、删改断言，或用 `skip` / `xit` / `.only`、改 fixture、放宽阈值等方式凑绿；也禁止让测试迁就错误实现。
- 红灯时优先修产品代码，或按真实意图**加强**测试；若断言本身写错，须在 PR 写明「原断言为何错、新断言覆盖什么」再改测试。
- AI 同时写代码与测试时，须用独立评审（Codex Gate / 人工）或既有回归交叉验证，勿代码与测试互相迁就。


## PR 证据与自动修上限（2026-10-20）

- **不要求人类 approve**；Gate 仍只挡 **P0/P1（及未标注）**（纯 P2 不挡）。
- **PR 必须贴证据**：正文写清「跑了什么测试 + 关键输出」（命令与摘要即可）；口头 done / 只勾 checkbox 不算。
- **同类 P1 自动修超 3 轮仍未清（写死）**：三轮上限**只**停止自动修循环（不得继续盲推）。**未 Resolve 的 P1 永远挡合入**——重试次数不改变严重度、不降级门禁。交给人/产品开跟进 issue/PR 继续修。**严禁**因重试次数把 P1 标成 observe、won't-fix、或 Resolve 后放行合入。

- 踩坑与根治清单：[docs/PITFALLS.md](docs/PITFALLS.md)
