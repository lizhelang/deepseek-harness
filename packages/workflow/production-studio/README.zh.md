---
description: "直接从 AEA 对话执行工作流、编辑未来节点、持久化监控执行，并按证据检查图纸交付。"
kind: "package-reference"
---

# @deepseek-ai/dsh-production-studio

[English](README.md) | 中文

## 概述

Production Studio 让已绑定的 AEA 对话、任务监控、轨迹和流程编辑器共用同一次带版本的运行。对话执行 agent（智能体）步骤；受支持的未来节点编辑影响后续步骤，不启动另一个执行器。未绑定的对话保留显式调度的运行与子 agent。交付仍要求通过几何、制造选型、文件字节与哈希，以及已记录交付条件的检查。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

此服务依赖 agent、工具、subagent、文件系统和 storage-domain。可信对话提供方把直接的 AEA 调用绑定到当前流程。未绑定的调度式 agent 节点需要进程内 `fork` subagent 提供方；调度式程序节点使用 ToolRuntime，沿用现有审批与沙箱流水线。此包不增加模型可调用的工具 schema。

```yaml
- name: '@deepseek-ai/dsh-production-studio'
```

部署默认值为 80 次执行、三个并行调度任务、256 KiB 保留证据、每个文件最多读取 4 MiB、400 条历史和每个会话保留 20 次运行。绑定对话的流程始终只有一个执行器。较大图纸需要配置 `maxFileBytes`；[配置目录](../../../docs/config-catalog.zh.md)负责记录可接受的部署字段。

### 绑定的 AEA 对话

通过现有对话发送模型处理请求。AEA 提供方把首次符合条件的 `create_case` 调用绑定到真实用户目标与源输入。同一个父对话执行 agent 节点，流程仅准入并记录每次实际工具调用一次。不要再调用 `start`：绑定的配置会拒绝这个第二次启动动作，即使尚未开始第一次运行。

通过 `saveGraph` 和预期流程版本，在同一次运行中修改受支持的未来提示词、工具列表或接线。陈旧版本的保存会失败，需要重新加载。已准入节点的执行设置与出线不能修改，但标签和位置可以调整。人工节点批准后仍保留稳定的准入记录，后续阶段变化不会解除这些设置与接线的锁定。编辑不能增加执行或重试预算、引入并行执行，或弱化必需的交付检查。保存影响后续准入步骤，不影响已开始的模型请求或原生调用。

附加只读 AEA 检查未配置 certification 时，读取其 arguments.stage 指定的阶段；必需授证门禁使用 certification 阶段。读取阶段本身不授予证书。

`pause`、`resume`、`answer`、`reconcile` 要求运行 ID 与当前版本。对话暂停阻止下一次操作准入；已分派的操作仍可返回已知结果。停在两次已知回执之间的节点为暂停状态，可以恢复。真正未决的调用为未知状态：恢复和人工回答都不授予重放权限。已知检查失败属于阻塞，不是未知执行结果。

显式恢复和人工回答解除工作流限制，并可能推进只读检查。运行处于活跃状态、有可执行的 agent 节点且没有人工等待、未知结果或在途调用时，服务继续同一个父对话。符合条件的继续执行统一使用 `steer`，包括前一次取消尚在收尾时；它不根据驱动器的暂时状态选择 `inject`。继续执行保留源绑定、已消费接线与运行剩余预算，不启动另一次生产运行，也不重放已结算调用。保存流程、读取状态和重新连接从不唤醒空闲驱动器。

对话适配器保留 AEA Host 的有界搜索、必需制造评估、比较和修复动作，沿用原冻结设置与预算。它不强加调度式默认流程的基线限定 `user_requested` 捷径，不把搜索分数当成制造成本，也不证明全局最优。

### 未绑定的调度式运行

没有对话提供方时，`start` 要求流程版本、目标、JSON 输入和 `goalContractAcknowledged: true`。`input.deliveryGoal` 必须包含 `kind: 'verified-drawings'`，以及与目标完全相同的 `objectiveText`；可选片数、焊接次数、折弯次数与制造分数上限成为冻结验收条件。调度式运行在启动时捕获流程和输入，草稿编辑只影响后续调度式运行。独立调度分支和真实子 agent 仍受支持。

默认调度式流程使用已确认的有限试验：先基线，允许时合法调用 `finish_search(reason="user_requested")`，失败或未达条件后再做必要优化。其受限基线工具列表与子会话自有证据和绑定对话的执行方式分开。暂停与人工决定影响选中的调度分支，其他独立分支继续执行。

<a id="evidence-and-recovery"></a>
### 证据与恢复

必需路径在交付前检查几何、制造、保存文件和已记录目标。Host 内部的 `production_aea_evidence` 读取真实 AEA 账本和报告，验证身份与报告哈希，并从二进制字节计算两个选中模型的哈希。制造选型必须把真实成功工具回执与账本绑定。模型文字、人工回答和单独路径不能认证交付，流程编辑也不能替换或绕过必需检查。

识别的 AEA 和 `rhino_*` 调用在所有执行模式间共用持久化原生独占租约。可信原生提供方在开始原生工作前记录分派。分派前拒绝属于已知失败，已分派调用出错或原生回执未决则隔离后续原生工作。节点资源编辑不能删除租约。`reconcile` 只接受 Session ID 和带版本比较的运行／节点引用，调用方不能提供自己的安全标记或回执。

可信插件通过 effect 注册 `registerNativeReconciliationProvider({ id, toolNames, reconcile })`，可选的 `appliesTo(sessionId)` 将其限制在所属预设的 Session。每次选择，包括等待 Host 读取之后，都要求恰好匹配一个提供方。DSH 提供原始 Session 调用／结果事件、参数原文的 SHA-256、运行、任务与原生租约。提供方只读权威 Host 账本，不执行工具，并返回完全一致的 Session／调用／工具／哈希身份、结果（`rejected_before_native`、`completed` 或 `unknown`）、回执和证据。事件缺失、身份不一致、多个提供方匹配以及陈旧引用均保留隔离。执行完成不授予工程认证。手动核对暂停原节点；显式恢复保留已消耗的尝试次数与执行次数。新记录的错误若具有经过核验的原生执行前拒绝回执，会在下次提示词装配前自动结清，让同一对话从该错误继续，不重放调用。

经过认证的控制端可对空闲、已暂停、收件箱为空且没有原生租约的对话传入 `resume(sessionId, ref, { requestId, text })`。UUID、文本和生成的消息 ID 先写入检查点，再仅投递一次继续执行消息；其来源为带有该 `rpcId` 的 `user-approval`。陈旧引用或重复 UUID 均拒绝重发，重启或收件箱投递结果不确定时也一样。文本及完整消息受配置的证据字节上限约束。返回的任务证据标识已准入请求，Session 历史标识其最终消费。普通恢复保留默认继续执行文本。

结清记录先持久化到原生租约，再附到原任务并持久化检查点，最后才释放该租约。中间写入失败继续阻止新操作准入和流程修改。中断或重启后，重试核对会按已记录的身份和证据完成原结清，不再次查询 Host 或分派工具。没有结清元数据的旧租约仍可读取并保持未知，元数据缺失从不表示成功。

较大的普通工具诊断可保存为 `data.productionEvidenceReference`，避免重复内联 JSON。完整观察记录先写入存储域的 `evidence` 表，并绑定所属 Session、SHA-256、UTF-8 字节数与观察元数据。`readEvidence(sessionId, observation)` 将这些精确字节恢复为 JSON，引用缺失、被修改或属于其他会话时拒绝读取。核对与具名继续操作也会先归档旧的超大诊断记录，再执行原有的完整保留字节上限。客观 `production_aea_evidence`、结清、人工和文件证据仍完整内联。客观检查前先还原引用，继续执行原始完整证据字节上限与认证条件；归档不能让超限证明通过。归档内容随存储域保留，目前不自动回收。

结算写入失败不会把已返回的结果变成未知。服务在进程内保留已知回执和调用身份，在结算提交前阻止新操作准入，并重试发布而非重新分派工具。持续的领域写入故障不具备持久性。状态与待发布历史检查点一同提交后，追加或持久性刷新失败会留下可恢复的元数据待发队列，并明确显示发布错误。新操作准入等待该队列完成持久化发布，重试或重启绝不会通过分派原生工作来恢复历史。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

服务串行化流程修改、准入和结算，父对话持有每次绑定工具调用。只读流程检查根据真实回执推进，普通调度器跳过对话式运行。[对话编辑校验器](src/conversation.ts)保护已准入工作，拒绝不受支持的执行器。[服务](src/index.ts)负责生命周期结算与发布，[领域模块](src/domain.ts)负责已保存状态校验与默认流程。

`production_studio` 存储域持有按 Session ID 保存的当前执行状态，以及独立全局原生租约表。每次对话运行变化与可选的 `pendingCheckpoints` 待发队列在同一次领域状态写入中提交。随后发布过程把带有 `ignorable: true` 的完整运行 `production/checkpoint` 事件追加到同一个 Session。对话和轨迹在原日志序号处渲染每个历史事件，任务监控和流程编辑追踪当前状态。当前状态变化不会改写历史检查点卡片，fork 也不继承活跃运行权限。

仅 Host 使用的 Session 投影 `productionCheckpoints` 记录每次运行已接受的最大检查点版本。其游标只证明 Session 已接受追加，不证明事件已经落盘。发布和重启恢复在追加待发条目前先查该投影，已经接受的运行／版本不会再次追加。在确认并清除任何已发布待发条目前，发布过程必须等待 `ctx.sessions.flush(session)` 并确认返回 `true`，即使依据游标跳过了追加也一样。返回 `false` 或抛出错误时，待发元数据仍保留供重试。待发队列的确认写入失败也会保留条目，不添加重复历史。恢复只重新发布元数据，不重放对应工具或原生操作。领域状态／待发队列提交和 Session 持久化仍是分开的写入，不是同一个原子事务，发布错误会明确显示。

停止时，服务等待已准入父对话调用结算后再关闭状态。两次操作之间的已知对话回执仍可恢复，只有未决调用变成未知。恢复过程不会自动分派任何一种状态。[架构决策](../../../.agents/notes/implemented/architecture/2026-10-08-conversation-owned-production-workflow.zh.md)记录了为什么四个视图共用一个执行器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Production Studio 客户端](../../client/ui-production-studio/README.zh.md)——当前状态控制与历史渲染。
- [会话日志](../../core/session/README.zh.md)——可选仅日志事件与持久性检查点。
- [工作流子系统](../../../docs/subsystems/workflow.zh.md)——独立的脚本工作流引擎与生成式服务声明。

-----

## Model Experience

### 绑定对话的步骤

#### What the model sees

提示词装配把活跃运行身份、流程版本、阶段和当前 agent 节点提示词添加到父对话。装配按该节点保存的允许列表过滤已注册工具，ToolRuntime 准入也会对直接调用执行相同限制。工作流检查点仅写入日志，不添加模型消息。符合条件的显式恢复或人工回答添加已记录的继续执行上下文，使用现有来源类型 `user-approval`，归属于显式 UI 批准，而非来源类型为 `user` 的普通人工消息。上下文标识同一次运行，要求保留源绑定、已消费接线与剩余执行预算。末尾指令为 `Never repeat a settled invocation or start a second run.`

#### Token effect

父对话承担现有对话请求成本，以及当前工作流指令和已准入继续执行上下文的成本。显式控制可以唤醒空闲父对话发起另一次模型请求，但不重置运行已消耗的执行预算。未来提示词编辑改变后续准入请求，监控与检查点渲染不增加模型 token。流程预算限制准入的流程工作，而非模型 token 用量。

#### KV Cache effect

正常父对话请求与系统提示词策略决定复用。继续执行上下文进入已记录的用户消息历史，不改写较早的对话消息；工作流提示词或工具列表变化可能影响下次请求的缓存复用。

### 调度式 agent 节点的子会话输入

#### What the model sees

每个调度式 agent 节点启动真实 subagent，输入为配置提示词或标签，以及冻结目标、JSON 输入、上游数据和人工决定。这些内容写入子会话的用户消息。末尾固定指令由此包持有：

##### 执行指令

```markdown
Use actual registered tools. A final assistant message is not delivery evidence. Never modify source code, frozen settings, credentials, or replay an unknown native operation.
```

#### Token effect

每次尝试产生独立子会话输入。长度随节点提示词、目标、输入、上游数据和人工决定变化。节点尝试与运行预算限制 subagent 启动次数，证据大小限制保留的观察记录，但不限制模型提供方的 token 消耗。

#### KV Cache effect

subagent 通过其提供方创建独立请求，此包不改写父会话已有请求 token。节点提示词、冻结输入与目标、上游数据和人工决定变化会改变新增子会话请求。缓存是否可用及其淘汰由提供方决定。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

受支持的执行模式具有不同限制：

- **未知操作核对** — 原生提供方必须把权威证据绑定到精确原调用。未注册的工具、歧义或缺失的 Session 事件、不受支持的历史 Host 记录仍保持未知。调度式子调用若没有匹配的父任务／租约身份，不能通过对话核对器结清。人工回答不能代替这些证据。
- **对话适配器范围** — agent ID 限于 `baseline`、`manufacture`、`repair`。对话流程拒绝并行分支、自定义 agent 身份、按节点覆盖模型或提供方、程序节点，以及只读 AEA 证据检查以外的自动工具。额外受支持的人工决定不提供另一个执行器。
- **继续执行的条件** — 显式恢复和回答只唤醒有可执行 agent 节点、且没有人工等待、未知结果或在途调用的活跃对话运行。它们本身不解决已阻塞或未知工作。保存流程不会唤醒空闲驱动器。
- **能力缺失与存储** — 缺少真实绑定时不能模拟成功。二进制读取受文件大小限制。此处同版本兼容性仅指可选 Session 仅日志事件的 `ignorable` 标记。不保证旧 DSH 的严格读取器能够解析新的生产领域字段，即使新字段为可选也是如此。回退需要匹配的更新前应用与数据备份，不代表旧应用能够打开新的领域状态。领域状态／待发队列提交不与 Session 持久化构成原子事务。
- **验收范围** — 软件检查和文件哈希证明本流程的交付条件，不等于实物加工验收、车间验收或专家认可新工件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
