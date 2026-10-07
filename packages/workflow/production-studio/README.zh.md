---
description: "面向用户和插件维护者的持久化生产流程执行、会话任务监控，以及通过客观证据验收的 AEA 图纸交付。"
kind: "package-reference"
---

# @deepseek-ai/dsh-production-studio

[English](README.md) | 中文

## 概述

Production Studio 在现有 Harness 对话中执行带版本的生产流程。独立分支并行执行，每次 AEA 原生操作持有全局持久化独占租约。只有 Host 验证几何、制造选型、实际文件字节与哈希，以及用户明确确认的结构化交付条件之后，运行才算交付完成。客户端在同一会话的监控和流程编辑界面展示这些真实状态。

## 目录

- [使用此包](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

此服务依赖 agent、工具、subagent、文件系统和 storage-domain。agent 节点需要进程内 `fork` 子代理提供方；程序节点调用现有 ToolRuntime，继续经过审批与沙箱。此包不增加模型可调用的工具定义。

```yaml
- name: '@deepseek-ai/dsh-production-studio'
```

默认限制为每次运行最多 80 次节点执行、三个并行任务、256 KiB 保留证据、每个文件最多读取 4 MiB、400 条历史和每个会话保留 20 次运行。较大的图纸文件需要配置 `maxFileBytes`。节点尝试次数、运行执行预算和并行数属于流程草稿；启动时冻结流程和输入，编辑草稿只影响后续运行。

### 状态和控制

`ctx.productionStudio` 对应 `productionStudio` Remote 命名空间。`get`、`follow` 返回已经提交的快照；`saveGraph` 检查预期流程版本；`start` 要求该版本、目标和输入，以及显式的 `goalContractAcknowledged: true`。`input.deliveryGoal.kind` 必须为 `verified-drawings`，`objectiveText` 必须与目标完全一致。可选的片数、焊接次数、折弯次数和制造成本上限成为冻结验收条件；缺少确认或目标不一致会拒绝启动。

`pause`、`resume`、`answer`、`reconcile` 使用运行 ID、版本以及可选节点 ID。暂停只影响该分支及其依赖；正在执行的中断会变成未知。回答执行前后断点只释放该分支；人工节点保留上游证据，人工回答不能认证未知的原生操作。其他独立分支继续工作。已阻塞的执行需要修正草稿并开启新运行；恢复只适用于已暂停的任务。

状态保存到独立的 `production_studio` storage domain，不更改 Session 日志格式。会话表按所属 Session ID 保存；原生租约存在独立全局表。重启把在途操作标为未知，并暂停尚未执行的运行。读取状态不会自动重启旧任务，分叉会话也不会继承运行权限。

### 证据和原生边界

默认流程为基础方案 → 几何检查 → 制造出图 → 制造检查 → 文件检查 → 目标检查 → 交付。明确确认的目标合同采用有限试验范围：先基线，满足所列条件就交付，仅在失败或未达目标时做必要优化。制造子代理可根据现有 Host 合法动作以 `finish_search(reason="user_requested")` 记录此范围，再取得真实制造及比较回执；制造或目标失败则在原预算内按合法动作修复或恢复搜索。此范围是软件交付条件，不证明搜索穷尽或全局最优。四个必需门禁使用 Host 内部 `production_aea_evidence`，流程编辑不能替换其认证来源、选择器、冻结输入或核对行为。额外门禁可以自由配置，不能替代原有检查。

基线子代理只可创建或恢复案件、查阅工件配置及几何和候选记录，以及调用 `submit_baseline` 和 `finish_search`。提示词要求验证基线后明确记录已确认的有限范围；此阶段不可调用优化或制造工具。客观新证据只来自 Session 真实 live 边界后的子代理事件，继承的父会话历史回执不能给新案件补身份，也不能认证本次尝试。

证据生产者读取现有 AEA 账本和报告，验证身份、报告哈希、所需几何与制造检查，并按二进制实际读取两个选中模型，核对 SHA-256。制造选型必须来自真实成功的 AEA 工具回执，再与账本绑定。模型文字、自填回执或只有路径都不能作为交付认证。实际报告中的候选失败属于已知失败，不会自动变成未知原生结果。

程序及绑定工具的门禁先按当前作用域内的工具 schema 校验参数，再进入 ToolRuntime 分派。schema 拒绝会记录已知失败并走失败出口；合法调用仍经过现有受保护执行链。进入工具体后的异常仍属于未知，除非可信原生边界证明没有进入原生分派。

Host 对识别的 AEA 和 `rhino_*` 调用进行全局串行化，覆盖程序节点、子代理及普通对话。节点资源配置只能增加锁，不能删除原生租约。可信工具提供方通过 `registerNativeBoundaryProvider` 注册精确操作名并管理 disposer，在真正进入原生执行前等待 `noteNativeDispatch(exec.callId)` 持久化标记。标记前的拒绝属于可修复的已知失败；标记后的错误或明确未决回执会隔离原生执行，重启后仍保留。没有合作标记合同的提供方采取保守处理。

## Model Experience

### agent 节点的子会话输入

#### What the model sees

每个 agent 节点启动真实子代理，输入为配置提示词或标签，以及冻结目标、JSON 输入、上游数据和人工决定。这些内容写入子会话的用户消息。末尾固定指令由此包持有：

##### 执行指令

```markdown
Use actual registered tools. A final assistant message is not delivery evidence. Never modify source code, frozen settings, credentials, or replay an unknown native operation.
```

#### Token effect

每次尝试产生独立子会话输入。长度随节点提示词、目标、输入、上游数据和人工决定变化。节点尝试与运行预算限制子代理启动次数，证据大小限制保留的观察记录，但不限制模型提供方的 token 消耗。

#### KV Cache effect

子代理通过其提供方创建独立请求，此包不改写父会话已有请求 token。节点提示词、冻结输入与目标、上游数据和人工决定变化会改变新增子会话请求。缓存是否可用及其淘汰由提供方决定。

## Known Limitations and Deferred Work

- **未知操作核对** — 目前没有通用提供方能够把中断的 ToolRuntime 调用 ID 绑定到其原生完成回执。`reconcile` 明确报告限制，保留未知；人工回答或再次调用变更工具不能释放隔离，查看账本也不等于允许重放。
- **现有 AEA 完成策略** — 调度器使用 Host 原有有限试验范围和合法后续动作，没有替换成新的原生提前终止算法，也不声称最低可能成本。只有所需真实证据齐备，结构化目标满足后，此流程才停止并交付。
- **能力缺失** — 工具未绑定或子代理不可用时不能模拟通过；部署需要提供真实能力。文件读取受配置大小上限限制。
- **验收范围** — 软件检查和文件哈希证明本流程的交付条件，不等于实物加工验收、车间验收或专家认可新工件。

<a id="dev-note"></a>
## 开发备注

无。
