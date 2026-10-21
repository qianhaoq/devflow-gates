# 踩坑与根治（2026-10-20）

我们自己踩过的坑 → 如何彻底修。状态：已修 / 待修 / 根治方向。Owner：专业研发 / 产品。

| 坑 | 状态 | 根治动作 | Owner |
| --- | --- | --- | --- |
| Codex「is expected」幽灵：labeled 事件只出 skipped job、无同名 check | 方案 A **已修**；方案 B **本 PR 合入后完成** | B：相关 label 真评估 + 无关 label `mirror-required-check`；PR+SHA 共用 `label-{sha}` 主锁串行化，相关标签 evaluate 可 cancel、无关标签 ack 不 cancel；ack 替换排队 evaluate 时由标签事件时间校验拒绝镜像 success（写 failure）；success 前读取当前相关标签和 issue events，变化或无法确认则 post failure；保留创建前校验；cancelled heal 加 attempt>=3 上限、PR 提示及同 SHA in-flight guard | 专业研发 |
| 临时撤必需检查才能合 | **已约束** | 只允许清幽灵且合后立刻加回；**禁止 `--admin`**；优先 `heal-required-checks.sh` | 专业研发 |
| label-ack 用 checks.create 造的同名检查落入任意 suite（jobs #13 落 Acceptance suite），suite 重跑被 GitHub 复制（pinhaoyun #28） | **已修**（本 PR） | ack job 本身即必需检查名（caller `name: codex/qa/editorial` + `job_name`），以 job 结论表达最新真实结论；进行中有界轮询后失败；不再 checks.create | 专业研发 |
| 打无关标签（如 `qa-passed`）触发 codex-gate labeled → 幽灵 | **进行中**（随 B） | codex/qa caller 增加 `*-label-ack`；无关 label 不再 skip-all | 专业研发 |
| 转仓后 workflow 权限被改成 write / 可批 PR（kilocean） | **待修**/检查单 | **转仓必查**：permissions、branch protection、required checks、App 安装 | 专业研发 |
| runner 预置 Python 漏 `build` 目录 → pip 缺 `operations` | **已修**/需固化 | runner 镜像/预置含完整 stdlib；CI 用官方 setup-python 或自检 `import operations` | 专业研发 |
| deploy sparse-checkout 污染共享 workdir（jobs） | **已修**（`.deploy-sparse`） | Deploy 稀疏检出用独立路径，结束后恢复默认 `GITHUB_WORKSPACE` | 专业研发 |
| AI 同写代码+测试可能一起漏；弱化测试凑绿 | **已约束**（AGENTS「禁止弱化凑绿」） | 独立评审（Codex Gate）+ PR 贴测试证据；禁止 skip/放宽断言凑绿 | 专业研发 + 产品 |
| understand caller 自监听（`name: Diff Quiz Gate` + `workflow_run.workflows: ["Diff Quiz Gate"]`）→ 整份 workflow silent 失效，不出 `understand / Diff Quiz Gate`，Auto Merge startup_failure | **已修**/根治 | cancel-heal 拆到独立文件 `examples/understand-gate-cancel-heal.yml`（name=`Diff Quiz Gate Cancel Heal`）；主文件禁止自听；Codex/QA 同样拆为 `codex-gate-cancel-heal.yml` / `qa-gate-cancel-heal.yml`，companion name 必须不同；`scripts/check-no-self-listen.py` 在 CI 拦截所有自监听 | 专业研发 |
| understand-refresh（及一切调用 reusable 的 job）只给 `pull-requests`/`issues: read`，而 reusable `understand-gate.yml@430987e` 顶层/nested 要 write → startup_failure（注解：only allowed read, requesting write） | **已修**/根治 | 所有 caller job（understand / refresh / cancel-heal）一律 `pull-requests: write` + `issues: write`；示例与 qh 已对齐；kilocean #29 由翻译修 | 专业研发 |
| understand Diff Quiz 第 5 条保护 | **待修** | 等 PR 产出稳定 check 名后再加入 branch protection | 专业研发 |
| 必需检查有两个同名 success 仍「is expected」（duo-two-pane #5 @ f198db6，edited/labeled 后） | **已定位；根因已由 647105c 修（caller 按 examples 迁移并合入后才生效）**；GitHub 规则为推断，未官方确认 | 证据：05:00:35Z（UTC）标签事件为 Codex Gate、QA Gate 两个 workflow 各新建一个 suite（107170044477 / 107170044454），里面只有 skipped job 和旧名 `codex-label-ack / Mirror Required Check`，**都没有** `codex / Codex Review Gate`；两条同名 success 分别在旧的 Codex suite 107169174361 和 QA suite 107169174266（checks.create 生成的副本，05:09:24Z 落进 QA suite）。直到 05:20Z 旧 Codex suite 重跑后才变绿。推断：分支保护按「每个 workflow 在该 SHA 上最新的 suite」认 Actions 检查，所以被新 suite 取代的 suite 里的同名 check 不算数，而另一个 workflow suite 里的副本也会随那个 workflow 的新 suite 一起失效。修法：647105c 让 label-ack job 本身就带必需检查名（每个新 suite 都有同名 check），并去掉 checks.create。**迁移不能只改 `uses` SHA**：647105c 要求 caller 的 ack job 加上 `name: codex`/`name: qa`，并新增必填 input `job_name`，以及对应的 permissions/timeout，要按 `examples/` 一起拷过去，否则 workflow 调用无效，必需检查直接缺失。**注意**：pull_request_target 跑的是 base 分支上的 caller，所以迁移 PR 本身还是旧行为；合入前如果卡住，不要重跑标签事件那个 run：rerun 沿用原 SHA 和旧 caller，仍然只会出旧的 ack。应该重跑那个**真正跑过 `codex / Codex Review Gate` 的 evaluate run**（duo #5 是在 05:20Z（UTC）重跑 suite 107169174361 之后变绿的），或者在新 caller 合入 base 后用新事件触发一次新的 run。`scripts/heal-required-checks.sh` 这时会判定 OK（同名 check 已经是 success），**不适用**。禁止 `--admin` | 专业研发 |

## 操作红线（与本文同步）

- 不 merge 本批 docs PR 以外的动作由产品决定；执行器：**不 `--admin`、不打 `qa-passed`、不动分支保护、不读 `auth.json`、不删仓**。
- PR 证据：必须贴「跑了什么测试 + 关键输出」。
- 同类 P1 自动修 >3 轮 → 停循环，跟进或 observe。


## Cancel-heal companion 与标签镜像（2026-10-20）

`on.workflow_run.workflows` 包含文件自身 `name` 会报 cannot listen to itself，
整份 workflow 失效。Codex、QA、Diff Quiz 都必须使用独立命名的 cancel-heal
companion，并一起安装到默认分支。`scripts/check-no-self-listen.py` 在 CI 阻止回归。

Companion 中当前 workflow 是 healer 自己。heal 必须通过
`github.event.workflow_run.workflow_id` 或读取 `workflow_run.id` 获取源 workflow，
不能用当前 run 的 workflow_id、context.workflow 或 GITHUB_WORKFLOW 定位。
仍保留 run_attempt >= 3 不再自动重跑的上限。

镜像只复制同名真 job 的结论，从不凭空造 success，也不能把旧镜像当成新的
真实评估。相关标签（包括 no-auto-merge）走真评估，其他标签走 ack；两者用
`label-{sha}` 同组作为主锁串行化，ack 运行期间 evaluator 不能并发启动，反之亦然。
只有相关标签 evaluate 的 cancel-in-progress 为 true；无关标签 ack 为 false，
永不取消正在运行的真评估。ack 仍可能替换排队中的 evaluate，此时由 mirror 的
标签事件时间校验拒绝镜像过期 success（写 failure）。主锁负责互斥，时间校验负责
排队评估被替换后的保守拒绝。镜像 success 前读取
PR 当前标签及 issue events；相关标签在源评估之后变化、缺数据或 API 失败时，
写 failure 并提示重新运行真评估；同秒事件保守拒绝。标签校验保守地以 started_at（缺失时用
completed_at）为界，避免评估运行途中标签变化产生过期 success。

## 不要对 required 的 reusable-workflow 调用方做 job 级跳过（2026-10-21）

对调用 reusable workflow 的 job 加 job 级 `if:`（例如
`if: github.event.action != 'edited' || ...`），被跳过时仍会创建一个新的
check suite，但其中只有一个被跳过的 `ci`，没有 `ci / Build & Test`、
`ci / Secret Scan` 等 required check 名。branch protection 只看每个 workflow
最新的 suite，于是 required checks 缺失，PR 被挡住。

- 永远不要对产生 required checks 的调用方做 job 级跳过。
- `pull_request` 的 `edited` 不能删（改 base 时 GitHub 只发 `edited`），
  对 edited 事件完整运行 CI；标题/描述编辑多跑一次的成本可接受。
- 如加 concurrency，edited 事件用 `cancel-in-progress: false`，只取消旧 run，
  不让最新 suite 变成 cancelled。
