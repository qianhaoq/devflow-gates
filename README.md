# devflow-gates

qianhaoq 各仓库共用的可复用 GitHub Actions 门禁（reusable workflows，
`on: workflow_call`）：CI 构建/测试、密钥扫描、Codex 评审门禁、人工 QA
门禁、自动合并、部署后冒烟、AI 代码验收报告。本仓库为 PUBLIC，各仓库通过

```yaml
uses: qianhaoq/devflow-gates/.github/workflows/<工作流文件>.yml@main
```

直接引用，不再各自维护一份逻辑。[examples/](examples/) 下有全部可直接复制的
调用方文件，[templates/QA.md](templates/QA.md) 是人工 QA 验收单模板。

## ⚠️ 检查名命名规则（必读）

可复用工作流里 job 的检查名（check run 名）显示为
**`<调用方 job 名> / <被调用 job 名>`**。调用方 job 不写 `name:` 时，job 名
就是 job id。被调用的 job 名固定为：`Build & Test`、`Secret Scan`、
`Codex Review Gate`、`QA Gate`、`Auto Merge`、`Post-deploy Smoke`。

因此 [examples/](examples/) 里的示例调用方（job id 分别为 `ci`、`codex`、
`qa`）在 PR 上产生的检查名是：

| 示例调用方 | job id | 产生的检查名 |
| --- | --- | --- |
| `examples/ci.yml` | `ci` | `ci / Build & Test`、`ci / Secret Scan` |
| `examples/codex-gate.yml` | `codex` | `codex / Codex Review Gate` |
| `examples/codex-gate.yml` | `codex-refresh` | `codex-refresh / Codex Gate Refresh`（仅 Codex 评论 / `/recheck` 评论触发，**不**挂在 PR 检查上） |
| `examples/qa-gate.yml` | `qa` | `qa / QA Gate` |
| `examples/qa-gate.yml` | `qa-refresh` | `qa-refresh / QA Gate Refresh`（可选，示例默认注释掉；仅 schedule 运行，**不**挂在 PR 检查上） |
| `examples/auto-merge.yml` | `auto-merge` | `auto-merge / Auto Merge` |
| `examples/smoke.yml` | `smoke` | `smoke / Post-deploy Smoke` |
| `examples/acceptance.yml` | `acceptance` | `acceptance / Acceptance Gate`（另有辅助检查 `Acceptance Config` / `Acceptance Measure`；M1 仅观察，**不要**加入分支保护） |

这两个地方必须使用**完全一致**的名字：

1. **分支保护 / Rulesets 的必需检查**：填 `ci / Build & Test`、
   `codex / Codex Review Gate`、`qa / QA Gate`（按需加 `ci / Secret Scan`）。
2. **auto-merge 的 `required_checks` 输入**（见下文），例如：

   ```yaml
   with:
     required_checks: |
       ci / Build & Test
       codex / Codex Review Gate
       qa / QA Gate
   ```

如果你改了调用方的 job id 或加了 `name:`，检查名会随之改变，上面两处必须
同步更新。

## 安全模型

- 门禁类工作流（Codex Gate / QA Gate / Auto Merge）的调用方一律用
  `pull_request_target` 触发：工作流定义永远来自可信的默认分支，绝不来自
  PR head。
- 门禁逻辑只用 `actions/github-script@v7` + GitHub API：**绝不 checkout
  PR head，绝不执行 PR 控制的 shell / 代码**。
- CI（`ci.yml`）会执行 PR 代码，调用方必须用 `pull_request`（不是
  `pull_request_target`）触发，令牌保持只读。
- 可复用工作流里的 `permissions` 只能收紧、不能放大权限；所需写权限必须由
  调用方授予。
- 唯一需要 `actions: write` 的是两个门禁的**刷新 job**（见下文"刷新"）：
  可复用工作流里评估 job 自己的令牌保持只读；GitHub 会按调用方 job 的权限
  上限校验被调文件里的每个 job，所以调用方的 `codex` / `qa` job 也要授予
  `actions: write`（只作为上限，评估 job 内部收紧）。
- **省 Actions 分钟（私有仓库按分钟计费、每个 job 至少按 1 分钟计）**：
  不相关事件用**调用方 job 级 `if:`** 过滤（跳过时不启动 runner，且被跳过的
  检查名是调用方 job 名，例如 `codex`，**不是**必需检查名；若在可复用文件
  内部跳过，会在 PR head 上挂一个 skipped（= 视为通过）的必需检查，所以
  可复用文件从不跳过挂在 head 上的事件）；不再有 `*/15` 定时盲目重跑。

## 各工作流说明

### 1. `.github/workflows/ci.yml` — 构建/测试 + 密钥扫描

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `test_command` | string | **必填** | 测试命令，如 `npm test` |
| `node_version` | string | `''` | 非空则 `setup-node`（空字符串跳过） |
| `python_version` | string | `''` | 非空则 `setup-python`（空字符串跳过） |
| `setup_command` | string | `''` | 测试前的依赖安装命令，如 `npm ci`（空跳过） |
| `working_directory` | string | `'.'` | setup/test 命令的工作目录（monorepo 子目录） |

Job：

- **`Build & Test`**：checkout →（可选）setup-node / setup-python →
  （可选）`setup_command` → `test_command`。
- **`Secret Scan`**：`fetch-depth: 0` 全量 checkout 后，直接下载 gitleaks
  v8 官方 linux x64 release 二进制（不用需要 License 的第三方 action）并执行

  ```bash
  gitleaks detect --redact --no-banner --exit-code 1
  ```

  gitleaks 会自动识别调用方仓库根目录的 `.gitleaks.toml`（自定义规则 /
  白名单生效）；发现任何泄露即失败。

调用方触发建议：`pull_request` + `push: branches: [main]`。见
[examples/ci.yml](examples/ci.yml)。

### 2. `.github/workflows/codex-gate.yml` — Codex 评审门禁

把 chatgpt-codex-connector 的评论型评审转换成真正的必需检查
（`codex / Codex Review Gate`），逻辑移植自已评审过的单仓库版本。

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `wait_minutes` | number | `20` | 等待 Codex 发布/更新 Review Summary 的超时分钟数 |
| `block_unlabeled` | boolean | `true` | 未标级 Codex 线程阻断（既定策略）；`false` = opt-out，仅关键词匹配时阻断 |

调用方触发事件（完整列表见 [examples/codex-gate.yml](examples/codex-gate.yml)）：
`pull_request_target` [opened, synchronize, reopened, ready_for_review,
converted_to_draft, labeled, unlabeled]（labeled/unlabeled 只对
`skip-codex-gate` 评估，其他标签由调用方 `if:` 跳过）、`pull_request_review`
[submitted]（只评估 Codex 的 review）、`pull_request_review_comment`
[created, edited]（只评估 Codex 评论的**编辑**或**线程回复**；新的顶层行内评论
属于已提交的 review，已被评估）、
`issue_comment` [created, edited]（只走刷新 job：Codex 的评论或 `/recheck`）、
`workflow_dispatch(pr_number)`。不再无过滤地对每条 review comment 评估（一次带
N 条行内评论的 Codex review 以前会多触发 N 次运行），也**不再**使用 `schedule`。`converted_to_draft` 让退回草稿的 PR 立刻
重新评估并把检查置为失败（否则旧的绿色检查会一直挂着）。

并发（示例）：push 类事件（opened / synchronize / reopened）每 PR 一组且
`cancel-in-progress`——新提交只取消**旧 head** 的评估；相关的刷新运行每 PR
排队；其余运行（label、Codex review、dispatch、被跳过的事件）各自独立成组，
既不会被取消也不会取消别人。Gate 运行约 15 秒、读实时状态、幂等。

> ⚠️ 线程解决（resolve）**不会**直接重跑本门禁：`pull_request_review_thread`
> 只是 webhook 事件，GitHub Actions 不支持用它触发工作流（把它写进 `on:`
> 无效，评估 job 的 `if` 里也不列它）。解决完 Codex 线程后：
> 在 PR 上评论 `/recheck`（或等下一次 Codex 评论 / push），刷新 job 会在
> Gate **现在能通过**时重跑 head 上失败的 Gate 运行；也可以在 UI 里重跑一次
> pull_request_target 来源的 Gate 运行。

**刷新（Codex Gate Refresh）**：issue_comment / schedule / 从 main 发起的
workflow_dispatch 的 job 结论**不会**挂到 PR head 检查上，所以刷新 job 从不
自己评估成检查。触发：Codex 在 PR 上发/改评论（Summary、"no major issues"）
或有人评论 `/recheck`（可选再加低频 schedule）。对每个目标 PR，只看当前
head 上**最近一次实际评估过的** Gate 运行（pull_request_target /
pull_request_review(_comment) / PR 分支上的 workflow_dispatch；被调用方跳过的
`skipped` 运行不算）：

- head 上仍有排队/运行中的运行 → 不动。
- 最近一次为 `failure` → 用与评估 job **完全相同的脚本**（`GATE_MODE`
  切换，测试强制两份脚本一致）算 `verdict()`；**只有现在能通过**才
  `reRunWorkflowFailedJobs`。仍会失败的 Gate（例如合法地等人工处理）**绝不**
  重跑——不再有盲目的周期性重跑。
- 最近一次为 `success` 但 `verdict()` 现在为假（例如 Codex 在同一 SHA 上把
  Summary 改回 Running / Failed）→ 整体重跑它，让必需检查转红（fail closed）。
- "最近一次"按**最新一次 attempt 的开始时间**（`run_started_at`）排序：被重跑的
  旧运行才是最新的检查。
- 否则若 head 上有 `cancelled` 运行 → 只整体重跑**最新的那一个**（避免分支
  保护把残留的 cancelled 必需检查当结果：405 "Required status check … is
  cancelled"）。
- 每个 PR 每次刷新最多重跑 1 个运行；盲重跑（cancelled）到 `run_attempt 3` 为止，
  由 verdict 翻转驱动的重跑上限 20（避免把一个现在能通过的检查卡成红）。
  列表分页读取；head 上有进行中的运行（多为几秒内即 skipped 的调用方过滤）时
  先等待最多约 40 秒。
- 需要 `actions: write`（调用方授予）。
- 检查缺失 / 最近一次 pull_request_target 运行仍在跑 / 已成功 → 不动。

判定规则（fail-closed）：

- 非 PR 上下文（解析不到 PR / issue 评论不在 PR 上 / PR 已关闭或已合并）
  → `core.info` 直接成功，不算失败。**`workflow_dispatch` 传入非法/非数字
  `pr_number` → 失败**（操作错误必须显式报错，不能静默绿过）。
- 草稿 PR → **失败**（`draft: AI review runs only when ready`，草稿不得报
  成功，`ready_for_review` 会自动重跑）。
- `skip-codex-gate` 标签 → **失败**（人工逃生舱只留记录，绝不给 Auto
  Merge 报成功）。
- 还没有 Codex Review Summary 评论：head commit 早于 `wait_minutes` 分钟 →
  失败（仍在等待）；超时 → 失败（评论 `@codex review`）。
- Summary 仍是 Running / In progress / Queued → 失败；Failed / cancelled /
  error → 失败；没有明确出现 `**Completed**` 或 👍 → 失败。
- Summary 已完成但**不包含当前 head SHA**（synchronize 后的陈旧评审）→ 失败。
- Summary 完成且覆盖 head SHA，但存在**未解决且阻断**的 Codex 线程 → 失败。

**严重度规则（P0/P1/P2）**：

- 阻断（blocking）= 显式 **P0/P1**（识别的头部形式：`**P1**: ...`、
  `**P1** text`、`P1:`、`[P1]`、`P1 Badge`、`badge/P1`，只看正文前 600 个
  字符的头部/徽章区），或**未标级**线程。
- 输入 `block_unlabeled`（boolean，默认 **`true`**，即既定策略）：所有未标级
  Codex 线程都阻断。设为 `false` 为 opt-out：未标级线程仅在正文包含安全/
  正确性关键词时阻断（不区分大小写；`xss`/`csrf`/`rce` 按 `\b` 单词边界，
  其余子串匹配）：
  `security`、`vulnerab`、`injection`、`xss`、`csrf`、`rce`、`secret`、
  `token leak`、`credential`、`auth bypass`、`privilege`、`data loss`、
  `corrupt`、`race condition`、`deadlock`、`crash`、`incorrect result`、
  `wrong result`、`regression`。
- 显式 **P2 永不阻断**（开场为 P2 时，后续未标级回复也不会把它升级）；
  后续 P0/P1 升级仍阻断；后续 P2 不能把未标级的开场降级。
- `auto-merge.yml` 使用相同规则与同名输入 `block_unlabeled`；Copilot / 人工
  发起的线程：开场显式 P2 → 不阻断，其余（P0/P1、未标级）一律阻断。
- GraphQL 线程查询失败且有 Codex 评审评论 → fail-closed 失败。

权限：评估 job 只读（`contents: read`、`pull-requests: read`、
`issues: read`）；仅刷新 job 需要 `actions: write`（由调用方授予）。并发由
调用方设置（见上文"并发"与 examples/codex-gate.yml）。

### 3. `.github/workflows/qa-gate.yml` — 人工 QA 门禁

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `qa_label` | string | `'qa-passed'` | 标记"已在最新 head 上完成人工 QA"的标签 |
| `allowed_labelers` | string | `''` | 可选，逗号/空格分隔的登录名；只有这些人的 `labeled` 事件算签收（设置了但为空 → 失败） |
| `keep_qa_on_clean_main_update` | boolean | `false` | 可选。push 只是把 base 分支**干净合入**已验收 head 时保留标签（见下文） |

**标签流转**：

1. QA 按 [templates/QA.md](templates/QA.md) 在**最新 head commit** 上完成
   测试点 + 黄金样例，然后给 PR 打 `qa-passed`。
2. 门禁通过条件：标签存在，**且**该标签最近一次 `labeled` 事件**绑定到当前
   head SHA**：在 GitHub 服务端记录的本 PR head 观测中（本 caller 工作流的
   `pull_request_target` 运行——含被取消的运行；本 PR 分支上的
   `workflow_dispatch` 运行；当前事件 payload 的 `head.sha`@`updated_at`），
   严格早于打标时间的**最后一次**观测就是当前 head，且其与打标之间没有指向
   其他 SHA 的 `head_ref_force_pushed` 事件。committer date 可由作者伪造
   （回填），**完全不参与判断**；REST `committed` 事件没有时间戳，也不用。
   不满足 → 在**任何事件**上都移除标签并失败（`label predates the latest
   push`）——即使 push 的 synchronize 运行被随后的 label 事件取消也一样
   （fail closed，不依赖调用方的 concurrency 配置）。fork PR 的运行没有 PR
   关联，按 head 仓库 + 分支匹配；同仓库 PR 的运行必须关联本 PR。
3. **新的 push（synchronize）→ 自动移除 `qa-passed` 标签并失败**
   （`new push invalidated QA`），需重新验收、重新打标。
   **例外（`keep_qa_on_clean_main_update: true`，默认关闭）**：新 head H
   满足以下全部条件时**保留**标签、门禁按"标签有效"通过，并发/更新一条置顶
   PR 评论「仅干净合入 main（无冲突、无与本 PR 重叠的文件），qa-passed 保留；
   QA 测试基于 <B 短 SHA>」：
   - H 是恰好 2 个父提交的 merge；parent1 == `github.event.before`（B，QA
     验过的 head）；parent2 在 base 分支上（`git merge-base --is-ancestor
     P2 origin/<base>`）；
   - 在临时裸仓库里 `git merge-tree --write-tree B P2` 无冲突且结果 tree ==
     `H^{tree}`（手工解冲突 / 夹带改动 → 不保留）；
   - 保守规则：`git diff --name-only $(git merge-base B P2) P2` 与
     `… B` 的文件集合**无交集**（main 改过本 PR 也改的文件 → 不保留；
     重命名按删除+新增两侧路径都算）；
   - 签收本身覆盖 B：最后一次 `labeled` 来自允许的打标人，**且**按第 2 步的
     规则绑定到 B（打标前最后一次服务端 head 观测就是 B，中间无指向其他 SHA
     的 force push）；或 B 本身也是这样被保留的干净合入（可连续多次 update
     branch）。
     因此评估 job 需要 `actions: read`（现有调用方的 `qa`
     job 已授予 `actions: write`，示例也已补上）。
   否则（作者普通提交、rebase/force push、`before` 缺失或取不到、多个
   merge base、git < 2.38、任何 git/网络错误）一律按原逻辑移除标签，并把
   原因写进 job summary。只跑 git 管道命令（fetch / merge-base /
   merge-tree / diff），从不检出或执行 PR 代码。标签本身不被改动，所以
   "最后一次 labeled 来自允许打标人"的检查仍针对原 QA 签收；第 3 步的竞态
   保护：标签已绑定到新 head（打标前的最后一次 head 观测就是新 head，例如
   本次 synchronize payload 本身）则保留。之后的非 push 事件（labeled、
   定时刷新重跑等）会沿 first-parent 逐个复核这些干净合入回到 QA 验过的
   head；复核失败（例如 synchronize 运行被取消、残留了过期标签）同样移除标签。GitHub "Update branch"（merge 方式）产生的正是 parent1 = 旧 head、
   parent2 = base tip 的 merge；"Update with rebase" 是 force push → 移除。
4. 草稿 PR → 失败（在第 3 步移除标签**之后**才检查草稿，草稿 PR 收到新 push 同样会被移除 `qa-passed`）；非 PR 上下文 / 已关闭 PR → info 跳过（成功）。
5. **`workflow_dispatch` 传入非法/非数字 `pr_number` → 失败**（与 Codex
   Gate 一致，操作错误必须显式报错）。

⚠️ **调用方必须授予 `pull-requests: write` 和 `issues: write`**（移除标签
需要写权限；可复用工作流自己无法提权）。触发事件：`pull_request_target`
[opened, synchronize, reopened, ready_for_review, converted_to_draft,
labeled, unlabeled] + `workflow_dispatch(pr_number)`；其他标签的
labeled/unlabeled 由调用方 `if:` 跳过（不启动 runner），synchronize 从不过滤。
**没有 schedule**：QA 的每个输入变化（push、打/撤标签、草稿/就绪）本身就是
pull_request_target 事件。`converted_to_draft` 让退回草稿的
PR 立刻把检查置为失败。

**刷新（QA Gate Refresh，可选）**：仅 schedule 路径，示例默认不启用。
不盲目重跑：只有 head 上最近一次评估失败、且 QA 标签存在并在该运行开始
**之后**才打上（输入变了）时才重跑；否则最多整体重跑最新的 cancelled 运行；
每 PR 最多 1 个、`run_attempt >= 3` 不再重跑；合法地等人工 QA 的红检查绝不
重跑。并发（示例）：push 类事件（opened / synchronize / reopened）每 PR 一组
`cancel-in-progress`，新提交只取消旧 head 的评估；其余事件（label、草稿、
dispatch、被跳过的事件）各自独立成组，**label 事件永远无法取消 push 评估**；
门禁本身也不依赖这一点（见第 2 步）。见 [examples/qa-gate.yml](examples/qa-gate.yml)。

### 4. `.github/workflows/auto-merge.yml` — 自动合并

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `required_checks` | string | **必填** | 换行分隔的必需检查名（head SHA 上必须为 success，按名取最新一次） |
| `merge_method` | string | `'squash'` | `squash` / `merge` / `rebase` |
| `require_copilot` | boolean | `false` | 是否要求 Copilot 评审 |
| `block_unlabeled` | boolean | `true` | 未标级 Codex 线程阻断（`false` = 仅关键词）；Copilot/人工显式 P2 不阻断 |

调用方触发：`workflow_run`（对本仓库的 CI / Codex Review Gate / QA Gate
等 `completed`）、`pull_request_review` [submitted]、
`workflow_dispatch(pr_number)`（非法/非数字 `pr_number` → **失败**）。
注意 `workflow_run` 只在默认分支上的文件生效（合并后才触发）。

**并发必须由调用方设置**（可复用工作流管不了调用方的事件流）。已知 PR 的
事件用每 PR 一个 group（review / dispatch / 触发事件为 `pull_request` 的
workflow_run —— 其 head SHA 唯一对应一个 PR）；其余 workflow_run（基础分支
head_sha 的扫描模式）共用一个 `auto-merge-sweep` group。请原样使用：

```yaml
concurrency:
  group: ${{ (github.event_name == 'workflow_dispatch' && format('auto-merge-pr-{0}', github.event.inputs.pr_number)) || (github.event_name == 'pull_request_review' && format('auto-merge-pr-{0}', github.event.pull_request.number)) || (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request' && format('auto-merge-pr-{0}', github.event.workflow_run.head_sha)) || 'auto-merge-sweep' }}
  cancel-in-progress: false
```

`cancel-in-progress: false`：同一 PR 的新事件 / 新的扫描**排队等待**而不是
取消进行中的评估，正在执行的合并不会被中断。

行为：

- `workflow_run` 触发事件为 `push` → job 级跳过（**仅此一种跳过**）。
- **PR 解析按触发事件区分**：
  - `pull_request_review` / `workflow_dispatch` → 精确评估该 PR。
  - 触发事件为 `pull_request` 的 `workflow_run` → 运行的 head_sha 就是 PR
    head：先核对 `workflow_run.pull_requests` 每个候选（**这些条目没有
    `state` 字段**，逐个 `pulls.get` 验证 open 且 `head.sha` 一致），再回退
    到列出全部 open PR 按 head SHA 过滤；找不到 → info 返回。
  - 触发事件为其它（`pull_request_target`、`issue_comment`、
    `pull_request_review`、`pull_request_review_comment`、`schedule`、
    `workflow_dispatch`）的 `workflow_run` → 其 head_sha/head_branch 是
    **基础（默认）分支**，按 head SHA 匹配永远找不到 PR：改为**扫描模式**，
    评估每个指向默认分支的开放非草稿 PR（上限 30 个），合并所有通过检查的；
    单个 PR 评估出错只记 warning，不中断其余扫描。
- 阻断条件（全部满足才合并）：草稿、base 不是默认分支、`no-auto-merge` /
  `skip-codex-gate` 标签、**任一 required check 缺失/非 success（按名取
  最新一次尝试）**、最新评审 CHANGES_REQUESTED、未解决的非 Codex 线程、
  未解决的阻断级 Codex 线程（严重度规则与 codex-gate.yml 完全一致）。
- 可选 Copilot 要求（`require_copilot: true`）：`copilot-pull-request-reviewer`
  检查须 success，且 head 上最新 Copilot 评审为 APPROVED 或 COMMENTED
  （Copilot 常提交 COMMENTED，不要求 APPROVED）。软路径：官方检查缺失但
  head 上已有 Copilot APPROVED/COMMENTED（配额故障）时视为满足；完全没有
  Copilot 评审仍 fail-closed。
  TODO(2026-10-29)：Copilot Pro+ 配额稳定后删除该软路径。
- 本工作流自己的检查（名字含 "auto merge"）会被忽略，不会自我死锁。

### 5. `.github/workflows/post-deploy-smoke.yml` — 部署后冒烟

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `base_url` | string | **必填** | 已部署站点根地址 |
| `protected_path` | string | `''` | 非空时该路径必须返回 **401** |
| `required_headers` | string | `'strict-transport-security,x-content-type-options,x-frame-options\|content-security-policy'` | 逗号分隔的必需响应头分组，组内 `\|` 表示 any-of |

检查内容（纯 curl）：

- `GET /.git/HEAD` 与 `GET /.env` 必须返回 **404；403 同样接受**（WAF/ACL
  拦截等价于"未泄露"，真正不能接受的是 2xx/跳转/5xx）。
- `protected_path` 非空时 `GET <base><protected_path>` 必须返回 **401**。
- 默认响应头要求 = HSTS **且** x-content-type-options **且**
  （x-frame-options **或** content-security-policy）；组间 AND、组内
  `|` any-of，头名不区分大小写。

任何失败 → job 失败，并向 `$GITHUB_STEP_SUMMARY` 写入清晰的中文结果表格
（检查项 / 期望 / 实际 / 结果）。见 [examples/smoke.yml](examples/smoke.yml)
（手动 dispatch 传参，或在自己的部署工作流里直接 `uses:` 调用）。

### 6. `.github/workflows/acceptance.yml` — AI 代码验收门禁（M1：仅观察）

调用方：[examples/acceptance.yml](examples/acceptance.yml)，触发器**必须**是
`pull_request`（Measure job 会执行 PR 代码），job 授予 `contents: read`、
`pull-requests: write`（置顶评论）、`checks: read`（读取 Codex 门禁结果）。
每个仓库用 `.github/acceptance.yml` 配置（模板与默认值：
[templates/acceptance.yml](templates/acceptance.yml)）；配置优先从 PR **base**
提交读取（PR 不能放宽自己的门禁），base 没有时读 PR head，都没有用默认值。

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `config_path` | string | `.github/acceptance.yml` | 配置文件路径 |
| `timeout_minutes` | number | `10` | 每个 job 的超时 |

三个 job：`Acceptance Config`（解析配置，只调 API）→ `Acceptance Measure`
（检出 PR head、`persist-credentials: false`、只读权限，运行 setup / 测试 /
lint 命令，结果写入 artifact）→ `Acceptance Gate`（不执行 PR 代码：汇总、
dependency review、写置顶评论与 JSON 报告，给出结论）。

| # | 指标 id | 判定 | 默认 |
| --- | --- | --- | --- |
| 1 | `tests` | 测试命令通过，且**变更行覆盖率** ≥ 阈值（lcov / cobertura）；未配置命令或没有覆盖率报告 → n/a | 阈值 70%，未配置命令 |
| 2 | `tests_changed` | 改了源码就必须改测试；`no-test-needed` 标签**且** PR 正文写明理由（`reason_regex`，如 `无需测试：…`）才豁免 | 常见语言源码/测试正则 |
| 3 | `lint` | 配置的 lint / 类型检查命令：head 的问题数不得多于 merge base（输出行数或 `count_regex` 匹配数；尽力而为）；`compare_base: false` 时要求每条命令在 head 上退出 0 | 未配置 → n/a |
| 4 | `size` | 变更行数（排除锁文件、`.min.*`、快照）超过阈值即告警 | 600 行 |
| 5 | `dependencies` | 依赖清单（含 `.github/workflows/*`）有变更时跑 `actions/dependency-review-action`：已知漏洞 ≥ `fail_on_severity`、`deny_licenses` | high；依赖图不可用 → n/a |
| 6 | `evidence` | PR 正文必须有标题匹配 `heading_regex` 且内容非空的验收/自测小节（`#` 标题或单独一行 `**粗体**`） | `自测\|验收\|Test plan\|QA` |
| 7 | `ai_review` | 读取 head SHA 上最新的 `codex / Codex Review Gate` 检查结论，**不**重复实现 Codex 逻辑；尚无结论 → pending | `check_name` 可配 |

模式：全局 `mode` 与每个指标的 `mode` 覆盖，取值 `observe`（默认：只报告，
job 退出 0）或 `enforce`（被 enforce 的指标为 fail / error / pending 时 Gate
失败）。n/a、disabled 永不失败。

输出：

- **一条置顶 PR 评论**（标记 `<!-- devflow-gates:acceptance-report -->`，
  每次原地更新，不刷屏），表格列出每个指标的模式 / 结果 / 数值 / 说明；
  fork PR 拿不到写权限时跳过评论，结果仍在 job summary。
- **artifact `acceptance-report`** 内含 `acceptance-report.json`
  （`schema_version: 1`、repo、pr、head/base SHA、overall、每个指标的
  status/value/detail），保留 90 天，供周报汇总。

与其他门禁的关系：不加/不摘任何标签；用 `GITHUB_TOKEN` 写的评论不会触发其他
工作流（不会引起 Codex 门禁的 issue_comment 重跑）；独立的 concurrency 组
（`acceptance-<repo>-<PR>`，cancel-in-progress）；不依赖 Copilot。

已知局限（M2 前需评估）：`ai_review` 是 Acceptance 运行那一刻的快照——Codex
门禁之后变绿不会自动刷新本报告（下一次 push / 编辑正文 / 打标签时刷新，或手动
re-run）；Measure 的结果来自 PR 代码，enforce 时与该 PR 的 CI 同等可信；
Config 解析失败时 Gate 被跳过（跳过 = 通过）。

## 从单仓库版本迁移

1. 把 [examples/](examples/) 里的 5 个文件复制到目标仓库的
   `.github/workflows/`，删除目标仓库里旧的单仓库版
   `codex-gate.yml` / `auto-merge.yml` / CI 文件。
2. 按仓库改输入：`ci.yml` 的 `test_command`（及 node/python 版本、
   `setup_command`、`working_directory`）；`auto-merge.yml` 的
   `required_checks`（与示例 job id 一致则可原样使用）、`merge_method`、
   `require_copilot`；需要时改 `qa_label`。
3. 确认 `qa-gate.yml` 调用方授予 `pull-requests: write` + `issues: write`；
   `codex-gate.yml` / `qa-gate.yml` 调用方 job 按示例授予 `actions: write`
   （刷新 job 需要；评估 job 内部收紧为只读）；
   其余按示例保持最小权限。
4. 更新分支保护 / Rulesets 的必需检查名为新的 `"<调用方 job> / <被调 job>"`
   形式：`ci / Build & Test`、`codex / Codex Review Gate`、`qa / QA Gate`。
5. 合并到默认分支后验证：`workflow_run`（Auto Merge）只在默认分支的文件
   上生效；先开一个测试 PR 走完 CI → Codex → QA → 自动合并全链路。
6. QA 同学改用 [templates/QA.md](templates/QA.md) 验收单，验收完打
   `qa-passed`。

## 本仓库自检

`self-lint.yml` 在 push / pull_request 时下载 actionlint 二进制并对
`.github/workflows/` 与 `examples/` 全量静态检查（表达式、输入类型、
shellcheck），并运行 `node tests/gates.test.js` 与
`python3 tests/acceptance_test.py`（门禁内联脚本的离线测试）。

## 许可证

[MIT](LICENSE)
