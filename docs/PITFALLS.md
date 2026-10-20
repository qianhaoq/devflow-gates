# 踩坑与根治（2026-10-20）

我们自己踩过的坑 → 如何彻底修。状态：已修 / 待修 / 根治方向。Owner：专业研发 / 产品。

| 坑 | 状态 | 根治动作 | Owner |
| --- | --- | --- | --- |
| Codex「is expected」幽灵：labeled 事件只出 skipped job、无同名 check | 方案 A **已修**；方案 B **本 PR 合入后完成** | B：相关 label 真评估 + 无关 label `mirror-required-check`；PR+SHA `label-{sha}` concurrency 串行化并 cancel-in-progress 修复 list→create TOCTOU，保留创建前校验；cancelled heal 加 attempt>=3 上限、PR 提示及同 SHA in-flight guard | 专业研发 |
| 临时撤必需检查才能合 | **已约束** | 只允许清幽灵且合后立刻加回；**禁止 `--admin`**；优先 `heal-required-checks.sh` | 专业研发 |
| 打无关标签（如 `qa-passed`）触发 codex-gate labeled → 幽灵 | **进行中**（随 B） | codex/qa caller 增加 `*-label-ack`；无关 label 不再 skip-all | 专业研发 |
| 转仓后 workflow 权限被改成 write / 可批 PR（kilocean） | **待修**/检查单 | **转仓必查**：permissions、branch protection、required checks、App 安装 | 专业研发 |
| runner 预置 Python 漏 `build` 目录 → pip 缺 `operations` | **已修**/需固化 | runner 镜像/预置含完整 stdlib；CI 用官方 setup-python 或自检 `import operations` | 专业研发 |
| deploy sparse-checkout 污染共享 workdir（jobs） | **已修**（`.deploy-sparse`） | Deploy 稀疏检出用独立路径，结束后恢复默认 `GITHUB_WORKSPACE` | 专业研发 |
| AI 同写代码+测试可能一起漏；弱化测试凑绿 | **已约束**（AGENTS「禁止弱化凑绿」） | 独立评审（Codex Gate）+ PR 贴测试证据；禁止 skip/放宽断言凑绿 | 专业研发 + 产品 |
| understand Diff Quiz 第 5 条保护 | **待修** | 等 PR 产出稳定 check 名后再加入 branch protection | 专业研发 |

## 操作红线（与本文同步）

- 不 merge 本批 docs PR 以外的动作由产品决定；执行器：**不 `--admin`、不打 `qa-passed`、不动分支保护、不读 `auth.json`、不删仓**。
- PR 证据：必须贴「跑了什么测试 + 关键输出」。
- 同类 P1 自动修 >3 轮 → 停循环，跟进或 observe。
