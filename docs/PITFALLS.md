# 踩坑与根治（2026-10-20）

我们自己踩过的坑 → 如何彻底修。状态：已修 / 待修 / 根治方向。Owner：专业研发 / 产品。

| 坑 | 状态 | 根治动作 | Owner |
| --- | --- | --- | --- |
| Codex「is expected」幽灵：labeled 事件只出 skipped job、无同名 check | 方案 A **已修**（cancel-heal 已合）；方案 B **待修** | B：labeled 不产新 suite，或 skipped 也挂同名 required check（下周） | 专业研发 |
| 临时撤必需检查才能合 | **已约束** | 只允许清幽灵且合后立刻加回；**禁止 `--admin`**；优先 `heal-required-checks.sh` | 专业研发 |
| 打无关标签（如 `qa-passed`）触发 codex-gate labeled → 幽灵 | **待修**/流程 | 勿用无关标签触发 Gate；caller `if:` 过滤无关 label；勿在 Gate 路径打 `qa-passed` | 专业研发 |
| 转仓后 workflow 权限被改成 write / 可批 PR（kilocean） | **待修**/检查单 | **转仓必查**：permissions、branch protection、required checks、App 安装 | 专业研发 |
| runner 预置 Python 漏 `build` 目录 → pip 缺 `operations` | **已修**/需固化 | runner 镜像/预置含完整 stdlib；CI 用官方 setup-python 或自检 `import operations` | 专业研发 |
| deploy sparse-checkout 污染共享 workdir（jobs） | **已修**（`.deploy-sparse`） | Deploy 稀疏检出用独立路径，结束后恢复默认 `GITHUB_WORKSPACE` | 专业研发 |
| AI 同写代码+测试可能一起漏；弱化测试凑绿 | **已约束**（AGENTS「禁止弱化凑绿」） | 独立评审（Codex Gate）+ PR 贴测试证据；禁止 skip/放宽断言凑绿 | 专业研发 + 产品 |
| understand caller 自监听（`name: Diff Quiz Gate` + `workflow_run.workflows: ["Diff Quiz Gate"]`）→ 整份 workflow silent 失效，不出 `understand / Diff Quiz Gate`，Auto Merge startup_failure | **已修**/根治 | cancel-heal 拆到独立文件 `examples/understand-gate-cancel-heal.yml`（name=`Diff Quiz Gate Cancel Heal`）；主文件禁止自听；**不要**再复制 Codex/QA 的自听写法到 understand | 专业研发 |
| understand-refresh（及一切调用 reusable 的 job）只给 `pull-requests`/`issues: read`，而 reusable `understand-gate.yml@430987e` 顶层/nested 要 write → startup_failure（注解：only allowed read, requesting write） | **已修**/根治 | 所有 caller job（understand / refresh / cancel-heal）一律 `pull-requests: write` + `issues: write`；示例与 qh 已对齐；kilocean #29 由翻译修 | 专业研发 |
| understand Diff Quiz 第 5 条保护 | **待修** | 等 PR 产出稳定 check 名后再加入 branch protection | 专业研发 |

## 操作红线（与本文同步）

- 不 merge 本批 docs PR 以外的动作由产品决定；执行器：**不 `--admin`、不打 `qa-passed`、不动分支保护、不读 `auth.json`、不删仓**。
- PR 证据：必须贴「跑了什么测试 + 关键输出」。
- 同类 P1 自动修 >3 轮 → 停循环，跟进或 observe。
