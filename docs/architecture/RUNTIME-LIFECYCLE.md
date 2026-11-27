# RUNTIME-LIFECYCLE — 运行时生命周期

- **地位**：Daemon、Persona、Thought、Event、Sleep 的状态机与启停顺序权威描述。
- **状态**：下表是目标顺序，不是完成清单。SH-007A 实现了基础设施半段（配置、日志、数据目录、单实例锁、API Token、打开 SQLite、Migration、Schema 校验、启停状态机）。`packages/runtime` 里已有进程内 Persona 生命周期（SH-008B）、进程内 P1 Ingress（SH-008C）、P1 `recoverRuntime`（SH-008D D2）和 `createScheduler`（SH-008D D3）。SH-008D 已完成并通过独立复审与整批验收（D4 `8c10f39`，D4.R1 `4f290e8`）。SH-008E 的 E1–E5、AUDIT-001、E6 已将 Persona Recovery、Runtime Recovery、Ingress、Scheduler 接入 Daemon，整批仍等待最终独立验收签署。SH-009 E1–E4、E5.P0、E5A 已实现本地 HTTP/WebSocket/Health，E5B 文档同步已提交，等待独立复审，整批尚未验收。Scheduler Handler Map 为空，进入 `RUNNING` 只表示组件已装配；人格认知循环没有运行。
- **实现注记**：状态名在已落地的 Daemon 代码中是集中常量，不得在新代码里散落同义字符串。

---

## 1. 设计原则

1. **进程重启不得导致人格状态清零。** 任何状态都必须可从库 + 检查点恢复。
2. 停止**不依赖人格同意**。用户可以随时停掉它，人格的"困倦""不想睡"不能阻挡安全控制。
3. 未完成的任务不得被标记为完成。中断就是中断，记录真实进度。
4. 每个状态转移都必须留下可查询的记录（谁触发、何时、依据版本）。

## 2. Daemon 启动顺序

`BOOTING` → `MIGRATING` → `RECOVERING` → `READY` → `RUNNING`

| # | 步骤 | 失败处理 |
|---|---|---|
| 1 | 读取配置（路径、端口、模型、令牌） | 缺关键项 → `FAILED`，不猜默认值 |
| 2 | 初始化结构化日志（禁明文私人内容） | 失败 → `FAILED` |
| 3 | 检查数据目录与写权限 | 无权限 → `FAILED`（不要自动降级到临时目录） |
| 4 | 获取**单实例锁**（按数据目录） | 已被占用 → 退出并报告持锁进程 |
| 5 | 打开 SQLite（WAL，单连接写入者） | 打开失败 → 释放锁 → `FAILED` |
| 6 | 执行 Migration（见 DATA-MODEL §8） | 失败 → 回滚 → `FAILED` |
| 7 | 恢复 Persona（state / version / epoch） | 见 §4 恢复规则 |
| 8 | 恢复 Runtime（检查点、队列、活跃思维） | 过期条目丢弃并记录 |
| 9 | 初始化 Event Bus | — |
| 10 | 初始化 Scheduler（按自适应 Tick） | — |
| 11 | 启动本地 API + WebSocket（loopback + 令牌） | 端口占用 → `FAILED`，不自动换端口 |
| 12 | 启动健康检查 | — |
| 13 | 进入 `RUNNING`（组件装配完成；外部事件接入仍未实现） | — |

**顺序是硬的。** 特别地：没有单实例锁就不许开库；没跑完 Migration 不许恢复 Persona；API 最后开。

> **当前实现（不修改上表的目标顺序）。** 步骤 1–6 与进入 `RUNNING` 的状态机是 SH-007A；Token 在锁之后、SQLite 之前创建。SH-008E 已把步骤 7–10 接入 Daemon，SH-008E 整批仍等待最终独立验收签署。SH-009 E1–E4、E5.P0、E5A 已把步骤 11–12 接入同一 API 服务器；E5B 文档同步已提交，等待独立复审，整批尚未验收。
>
> | 步骤 | 当前实际行为 |
> |---|---|
> | 7 恢复 Persona | `runPersonaRecovery`：把其它 boot 留下的 `STARTING` / `STOPPING` 收成 `STOPPED`，不自动 start |
> | 8 恢复 Runtime | `recoverRuntime`：P1 崩溃收敛。合法 `running` 任务按 §4 的 D-RT1 退回 `queued` 或转 `failed`；`received` / `accepted` 且 `archive_state='none'` 收成 `expired` + `buffer_lost`。不读检查点，不恢复队列或活跃思维，不领取任务 |
> | 9 Event Bus | 创建进程内 P1 Ingress（`transport: none`，`acceptsInput=false`）；没有 HTTP/WS 刺激入口 |
> | 10 Scheduler | 创建并启动空 Handler Map Scheduler；`handlerKinds=0`、`taskDispatch=unavailable_no_handlers`，不派发任务。没有 Handler 硬超时；Handler 永不 settle 时 `stop()` 可能无限等待 |
> | 11–12 API / Health | 组装 `DaemonApi` facade，监听 `127.0.0.1:18700`；Health live/ready 随同一服务器可用。只提供管理/状态查询，不是外部 Stimulus transport |
> | 13 | 进入 `RUNNING`。这表示组件已装配，不表示认知循环运行或可接收外部事件 |

## 3. Daemon 关闭顺序

`RUNNING` → `DRAINING` → `CHECKPOINTING` → `CLOSING` → `STOPPED`

| # | 步骤 | 说明 |
|---|---|---|
| 1 | 停止接收新任务（API 返回 503） | 不再 ACK 新刺激 |
| 2 | 停止派发新调度 | 已在跑的允许有限收尾 |
| 3 | 等待或取消运行中任务 | 超时则取消，**记录为 cancelled，不记为完成** |
| 4 | 提交合法状态 | 只提交已完整产生的状态 |
| 5 | 写检查点（队列游标、活跃线程、epoch） | 检查点必须自带 `epoch` |
| 6 | 关闭 API / WebSocket | 先广播 `shutting_down` 再断开 |
| 7 | 关闭数据库（含 WAL checkpoint） | — |
| 8 | 释放单实例锁 | 最后一步 |

强制终止（进程被杀）下，靠 §4 的恢复规则保证一致性；**不保证**梦境或睡眠任务状态。

> **当前实现（不修改上表的目标语义）**。实际阶段是 `DRAINING → CLOSING → STOPPED`，不进入 `CHECKPOINTING`；只记录 `checkpoint_skipped`（Runtime checkpoint 未实现）。
>
> | 顺序 | 当前实际行为 |
> |---|---|
> | 1 | `API.beginDrain()`：拒绝新管理请求与 WS Upgrade；已鉴权 WS 尽力发送 `shutting_down`，随后关闭 |
> | 2 | `Ingress.close()` |
> | 3 | `await Scheduler.stop()`；空 Handler 时结束；reject 或 pending 则不关 Store、不放 Lock |
> | 4 | `API.close()`；失败时保持 sticky failure，不关 Store、不放 Lock |
> | 5 | `Store.close()`；失败时不释放 Lock |
> | 6 | `Lock.release()` |
>
> **API Drain 失败分支（与 API close sticky failure 不同）**：`#beginApiDrain()` 失败时记录 `http_api` 失败并返回失败结果；`#shutdown()` 随即以 `shutdown_failed` 拒绝关闭。本次关闭流程停在 API Drain 阶段，**不继续执行** `Ingress.close()`、`Scheduler.stop()`、`API.close()`；Store 与 Instance Lock 均不释放。`API.close()` 失败则是另一条路径：它发生在 Scheduler 停止之后、进入 `CLOSING` 之前，并触发 sticky failure。两者不得合并描述。
>
> `checkpoint_skipped` 跳过的是 Runtime checkpoint（`runtime_state.checkpoint_json` 的队列游标、活跃线程与 epoch），不是 SQLite WAL checkpoint。应用层没有显式 `PRAGMA wal_checkpoint`；`DatabaseSync.close()` 可能触发默认自动 checkpoint。遗忘事务要求的 `PRAGMA wal_checkpoint(TRUNCATE)`（DATA-MODEL §4.1、TRUST-BOUNDARIES §11.3）仍是未落地的目标约束。没有强制关闭超时，也没有用 `process.exit()` 绕过资源保护。

## 4. 崩溃恢复规则

任务 `attempt` 以已批准的 R8.3 决议 **D-RT1** 为准。本文件只复述该决议，不另立语义：

1. 任务被 Scheduler 领取时，`attempt` 加 1，并写入新的 `runId`。
2. 任务运行期间 `attempt` 不变。
3. 运行失败后的重试，在下一次重新领取时加 `attempt`。
4. 崩溃恢复不增加 `attempt`。
5. 恢复后仍沿用原 `attempt`。

| 场景 | 规则 |
|---|---|
| Persona 处于 `STARTING` / `STOPPING` | 归一到 `STOPPED`，要求显式重启，不自动猜 |
| 存在 `running` 状态的 task | 按 D-RT1 崩溃恢复：`attempt` 不变，沿用原 `attempt` 与当前 `runId`。未达上限则退回 `queued`；达到或超过上限转 `failed`。恢复不是一次新的领取，不加 `attempt`，不写新 `runId` |
| 睡眠周期中断 | 记录**已完成**的周期数，不补账、不声称做过 |
| 梦境中断 | `outcome=INTERRUPTED`，不生成醒后片段 |
| 已提交但索引未刷新 | 启动时按 `content_epoch` 重建派生索引 |
| 检查点 `epoch < 当前 epoch` | 丢弃该检查点（不得越过墓碑） |
| 动作处于 `executing` | 用 `actionId` 向适配器核对；**未收到回执一律不标记成功** |

> **D-RT1 与当前代码的对应（不另加规则）。** 领取是 persistence 的 `claimNext`：同一条 `UPDATE` 里 `attempt + 1`，写入调用方给出的新 `runId`，`started_at` 写成领取时刻。运行期间 `completeTask` / `failTask` 用当前 `run_id` 与 `attempt` 做条件写，不改 `attempt`。失败且未达上限时，`failTask` 把行退回 `queued`，`attempt` 仍是这一次领取写下的值；下一次重新领取才再加 1 并写入另一个 `runId`。崩溃恢复是 `recoverRunningTask`：未达上限则退回 `queued`，语句不改 `attempt`、不改 `run_id`；达到或超过上限则 `failed`。`recoverRuntime` 对合法的 `running` 行调用它。
>
> Scheduler 在包内通过 `claimNext` 领取，批次是已通过独立复审的 SH-008D D3；Recovery 的 D2.R1–R4 已通过最终独立代码复审；SH-008D 已完成并通过独立复审与整批验收（D4 `8c10f39`，D4.R1 `4f290e8`）。SH-008E 的 E1–E5、AUDIT-001、E6 已将 `createScheduler`、`recoverRuntime` 和 `normalizeCrashedPersonas` 接入 Daemon，整批仍等待最终独立验收签署。Scheduler 仍使用空 Handler Map，不派发任务；进程重启会执行恢复规则，但不会生成认知循环。

## 5. Persona 状态机

```
CREATED ──start──► STARTING ──► RUNNING
                                  │  ▲
                          suspend │  │ resume
                                  ▼  │
                               SUSPENDED
                                  │
                    stop（任意状态）▼
                              STOPPING ──► STOPPED
                                  │
                              任意失败 ──► FAILED
```

| 状态 | 含义 | 允许的内部活动 |
|---|---|---|
| `CREATED` | 档案已存在，未运行 | 无 |
| `STARTING` | 装载记忆、恢复线程 | 无 |
| `RUNNING` | 正常运行 | 全部通道 |
| `SUSPENDED` | 挂起（如用户要求） | 不调度；保留状态 |
| `STOPPING` | 收尾 | 只允许提交与检查点 |
| `STOPPED` | 已停止 | 无 |
| `FAILED` | 启动或运行失败 | 无；需人工介入 |

**`stop` 可从任意状态发起**，且优先于人格意愿。

## 6. Thought 状态机

```
NEW ──► RUNNING ⇄ PAUSED
             ⇅
        INTERRUPTED
             │
             ▼
      COMPLETED / ABANDONED
```

| 转移 | 触发 | 约束 |
|---|---|---|
| `NEW → RUNNING` | 调度器选中 | 需检查同通道并发上限 |
| `RUNNING ⇄ PAUSED` | 让位高优先级 / 自然搁置 | 保存续接位置（有限摘要，**不存无限思维链**） |
| `RUNNING → INTERRUPTED` | 外部刺激抢占 | 保留合法状态以便恢复 |
| `→ COMPLETED` | 有结论 | — |
| `→ ABANDONED` | 失去意义 / 超时 / 循环检测 | 必须记录原因 |

硬规则：

- 一个线程完成**不等于**其他线程结束。
- `inner` 通道的产出**不是**用户消息，不得伪装成 user 消息，不得自动外发，不得当作已执行的经历。
- 所有线程状态带 `personaId`，**不得**用 `sessionId` 当主体。
- 检测语义循环 / 重复自我争论 / 无新信息空转 → 退火、冷却、切换主题。**允许发呆和沉默。**

## 7. Event 生命周期

```
received → accepted → noticed → understood → response_committed → acted
    │          │          │
    └──────────┴──────────┴──► rejected / expired
```

| 状态 | 含义 |
|---|---|
| `received` | Ingress 收到，已验签/鉴权，**内容尚未进入意识** |
| `accepted` | 通过限流与来源校验，进入前注意队列 |
| `noticed` | 被注意机制选中（`ignored` / `queued` / `partially_aware` / `fully_aware`） |
| `understood` | 模型已解释（产生主观理解） |
| `response_committed` | 输出已提交（经 Output Commit，中断后不得晚到） |
| `acted` | 真实动作已收到 `ActionReceipt` |
| `rejected` | 被拒绝（越权、来源不可信、注入嫌疑） |
| `expired` | 过期（队列满、等待超时、TTL 到期） |

**不必经所有状态。** 关键区分：
收到 ≠ 注意到；注意到 ≠ 理解；产生行动意图 ≠ 行动已执行。

前注意阶段只暴露可信信封（来源、点名程度、紧急度、时间、授权、**非内容元数据**）。
**不得**把正文任何形式的转述（摘要、关键词、情感标签）交给前注意阶段。
**不得**"先让模型读完整内容，再表演没注意到"。

### 7.1 原始正文的唯一进入路径（按归档判定分流）

**决议**：采用**范围受策略限定的完整归档**。归档对象 = 通过 Ingress 鉴权与校验、
**且被确定性策略判定为 `required`** 的刺激；与 Pre-attention 判定、与人格是否编码**均无关**。

"完整审计"**只**覆盖 `required` 范围。`excluded` 事件不被纳入完整审计承诺。

**信封必填字段**（Schema 由 `packages/contracts` 声明，Ingress 执行校验）

> **两层信封（SH-004 修正）**：外部只能提交 `soul.stimulus.input.v1`；Ingress 归一化后产出
> `soul.stimulus.v1` 交给 Runtime。两层的差别只有两点：`receivedAt`（由 Ingress 生成）与
> `schema` 常量（由 Ingress 重写）。

| 字段 | 类型 / 格式 | 约束 |
|---|---|---|
| `schema` | 常量 `soul.stimulus.input.v1`（适配器层）/ `soul.stimulus.v1`（归一化后） | 版本协商；两层各自封闭，混用即 `schema_invalid` |
| **`adapterEventRef`** | 字符串（1–64，受控字符集） | **必填**；适配器**自己的**刺激标识；同一刺激重试**必须复用**。Runtime 据此去重（`(personaId, adapterId, source, adapterEventRef)` 唯一） |
| `eventId` | **不由 Adapter 提供** | 由 Ingress 生成（`evt_`），通过 **ACK 响应返回**给适配器。见 `IDENTITY-PROTOCOL.md` §4.5 |
| **`requestNonce`** | 字符串，`^[A-Za-z0-9_-]{16,64}$` | **必填**；每次**逻辑投递**一个；同一次投递的内部重试**必须复用**；不得由正文/哈希/计数派生；必须与已认证 `adapterId` 绑定 |
| `adapterId` | 受控标识符 `^[a-z0-9._-]{1,64}$` | 必须已在注册表登记；**内部来源也用正式 ID（如 `system.sleep`），不得为 NULL** |
| `source` | 受控标识符，同上 | 必须在注册表登记；须与 `adapterId` 的授权范围一致 |
| `personaId` | 字符串 | 显式指定，禁止"猜最近会话" |
| **`receivedAt`** | Unix ms，**Ingress 生成** | **Adapter 不得提交**：输入层信封不声明该字段，提交即 `schema_invalid`。它是系统权威的接收时间 |
| `occurredAt` | Unix ms，**来源自报** | 可缺省；是"来源声称发生的时间"，**不是**系统权威时间，可偏斜、可错误 |
| `payload` | 对象 | 正文 + 适配器自定义字段，仅在感知缓冲中存在 |

> `requestNonce` 是**投递身份**的一部分，不是内容的一部分：它与 `adapterId`、`eventId`、`source`
> 一起构成冲突审计的幂等键（`DATA-MODEL.md` §5.3）。**不得**为了检测 nonce 重用而保存内容或内容哈希。

```
Adapter 提交（信封 + 正文）
   │
   ▼
[1] Ingress 鉴权与校验：鉴权、来源、限流、协议版本、信封 Schema（`soul.stimulus.input.v1`）
   │  ✗ 失败 → status=rejected（正文立即丢弃，不落任何存储，不归档，不 ACK）
   ▼
[1N] 归一化：生成 `receivedAt`（Ingress 权威），重写 `schema` = `soul.stimulus.v1`
   │     `occurredAt` 原样保留（来源自报，不作权威）；此后只有归一化信封在系统内流动
   ▼
[1D] 去重判定：计算 (personaId, adapterId, source, adapterEventRef)，查唯一索引
   │   ├── 未命中 → **分配新 eventId（evt_）** → 进入 [2]
   │   ├── 命中 + required 且已归档 → archive.compare
   │   │        match    → 返回既有 eventId 与状态，**不新建任何行**
   │   │        conflict → 409（原事件不动 + 冲突审计，见 §7.3）
   │   ├── 命中 + required 且 pending → 缓冲仍在则与缓冲比对；缓冲已丢 → 只幂等命中
   │   └── 命中 + excluded / P1       → **无法核对**，只幂等命中，本次正文丢弃
   │        （命中路径**不写缓冲、不写事件行、不调用 append**，到此结束）
   ▼
[2] 写入短暂感知缓冲（TTL，默认 60s，可配）
   │     └── 正文此刻**只存在于**该缓冲
   ▼
[3] 确定性策略判定 archive_disposition（**不经过模型**，见 §7.2.1）
   │
   ├── required 且 Archive 能力已启用 ─────────────────────────────────┐
   │                                                                  │
   │   [3P] **短事务**：写入 metadata-only pending 事件行                 │
   │         `status='received'`、`archive_state='pending'`、            │
   │         `archive_ref=NULL`、**无正文**                              │
   │         ✗ 失败 → 503，**不 ACK**（适配器可同 adapterEventRef 重投）  │
   │                                                                  │
   │   [3R] Archive Writer `append`（加密，按 eventId 幂等）              │
   │         ✗ 失败 → 有界重试 → 耗尽则 503                              │
   │         **不得 ACK，不得降级 excluded，不得落 events 正文**           │
   │                                                                  │
   │   [3S] **短事务（单次提交三个字段）**：                              │
   │         `archive_ref` + `archive_state='archived'` + `status='accepted'` │
   │         ✗ 失败 → 留在 pending，交由 §7.3 恢复                        │
   │                                                                  │
   │   [3A] ACK `accepted`  ← **必须在 [3S] 事务提交之后**               │
   │                                                                  │
   ├── excluded ─────────────────────────────────────────────────────┘
   │      [3E] 短事务：`archive_state='excluded'`、`status='accepted'`（**不建 Archive Record**）
   │      [3A] ACK `accepted`（无审计承诺）
   │
   └── Archive 能力关闭（P1）
          [3N] 短事务：`archive_state='none'`、`archive_disposition=NULL`、`status='accepted'`
          [3A] ACK `accepted`（**不承诺原始事件审计**）
   ▼
[4] Pre-attention 判定 → attentionOutcome
   │   ├── ignored        → status 保持 accepted，TTL 到期 → expired
   │   ├── queued         → 有限队列，带过期与限流
   │   ├── partially_aware / fully_aware → [5]
   │   └── forced_control → 立即处理，可打断其他通道
   ▼
[5] 选择性编码判定（importance / 注意 / 情绪 / 重复 / 已有联系 / 随机探索）
   │   ├── 不编码 → 缓冲到期即删，**不建立长期痕迹**
   │   └── 编码   → [6]
   ▼
[6] 主观记忆提案 → 提交器 → 记忆节点（密文片段）
```

**不变式**

| # | 不变式 |
|---|---|
| 1 | 正文**只能**存在于 [2] 的 TTL 缓冲、`required` 事件的**加密归档记录**、以及 [6] 之后的**密文片段** |
| 2 | `events`、`tasks.payload_json`、`runtime_state.checkpoint_json`、日志**一律不得**成为原文旁路 |
| 3 | **pending 事件行只存元数据**：`eventId`、信封、`disposition`、`archive_state`；**不含正文、摘要、原文哈希** |
| 4 | `required` 事件：`archive_ref` / `archive_state` / `status` **在同一个短事务里一起提交**，不允许分两次写 |
| 5 | **ACK 必须在数据库事务提交之后返回**；未提交即 ACK 视为缺陷 |
| 6 | `required` 事件：Archive 失败**不得**自动降级为 `excluded`，**不得**进入 `understood` / `response_committed` |
| 7 | `excluded` 事件：不创建 Archive Record，不提供审计能力，原文仍只能在感知缓冲中存在 |
| 8 | 归档判定（disposition）**不得**经过模型：模型无权决定某条输入是否需要审计 |
| 9 | 归档**不得**因 [4] 的 `ignored` 而跳过；`required` 事件的归档先于注意判定 |
| 10 | 崩溃后可扫描到**所有**未完成的 pending 记录（`archive_state='pending'`），不得有"看不见的中间态" |
| 11 | P1（Archive 关闭）：`archive_state='none'`，正文随 TTL 删除，**不承诺任何原始事件审计能力** |
| 12 | **去重先于缓冲与 disposition**：命中去重键的投递**不得**写入感知缓冲、**不得**写事件行、**不得**调用 `append` |
| 13 | `compare` 只在 [1D] 命中 `required` 且已归档时调用，**每个投递最多一次**；未命中路径**不得**调用（边界见 `TRUST-BOUNDARIES.md` §5.5） |
| 14 | `receivedAt` **只能由 Ingress 生成**：Adapter 提交的 `receivedAt` 在 [1] 就被 Schema 拒绝；Runtime 只接受 `soul.stimulus.v1` |
| 15 | `occurredAt` 是来源自报时间，**不得**用于任何"系统何时知道"的判断（那只能看 `receivedAt`） |

### 7.2 Archive 存储语义与 P1 决议

**Archive 保存的是"经过认证的原始记录"，加密存储，与主观记忆是两套东西。**

| 约束 | 内容 |
|---|---|
| 加密 | Archive 原始数据**必须加密存储**，不得以明文落盘 |
| 密钥 | 使用**独立于主观记忆**的 Archive 密钥层级；**禁止与主观记忆密钥混用或派生** |
| 访问 | **Brain 永远没有 Archive 的密钥，也没有读取权限**；Brain 侧不编译 Archive 客户端 |
| 写入者 | **Archive Writer 是唯一写入者**。其他任何进程不得直写 Archive |
| 保留策略 | 每条 Archive 记录必须归属**有限期**保留分类（§7.2.2）；**不允许默认永久保存** |
| 禁止导入 | **不得**把 Archive 内容导入主观记忆当作"隐藏正确答案"；它只能作为**新观察**从 Ingress 进入 |
| 审计边界 | "完整审计"**只**覆盖 `archive_disposition = required` 的事件；`excluded` 不纳入该承诺 |

**P1 决议（本次正式确定）**：P1 **允许在没有 Archive Writer 的情况下接收外部事件**。

| P1 行为 | 规定 |
|---|---|
| 接收与验证 Stimulus | **允许** |
| 创建 `eventId` | **允许** |
| 持久保存事件信封与非内容元数据 | **允许**（字段白名单见 `DATA-MODEL.md` §3.1） |
| `events.archive_ref` | **允许为 NULL** |
| 原始正文 | **只允许**存在于有 TTL 的短暂感知缓冲，不得落任何长期表 |
| TTL 到期 | **必须删除**，不得用索引/日志/检查点变相保留 |
| 原始事件审计能力 | **不承诺**。P1 文档、API 与 UI 均不得暗示具备此能力 |

#### 7.2.1 归档判定 ArchiveDisposition

| 取值 | 含义 | 后果 |
|---|---|---|
| `required` | 该事件属于审计范围 | 必须先归档成功并提交 `archive_ref`，才允许 ACK `accepted`；进入完整审计承诺 |
| `excluded` | 明确排除在审计范围外 | **不创建 Archive Record**，不赋 `retention_class`；照常进入认知流程，但不提供审计 |

**判定规则**

1. 判定必须是**确定性的**：由配置策略 + 事件元数据（来源、类型、渠道、标志位）计算得出，**可复现**。
2. **模型不得参与判定**，也无权提议、覆盖或"申请"豁免。
3. `excluded` **必须有明确策略依据**，且该依据在审计日志中可查（策略 ID + 命中规则）。
4. 未命中任何 `excluded` 规则且 Archive 能力已启用时，默认判定为 `required`
   （即"默认审计，例外才排除"）。
5. P1（Archive 能力关闭）**不判定 disposition**，`archive_state = 'none'`。

#### 7.2.2 保留分类 RetentionClass

| 取值 | 用途 |
|---|---|
| `standard` | 常规审计记录 |
| `restricted` | 敏感来源或受限内容，保留期更短、访问更严 |
| `short_lived` | 仅短期可用（调试、临时排障） |

1. 只有**实际创建 Archive Record** 的事件才有 `retention_class`；`excluded` 与 P1 事件没有该字段值。
2. **具体保留天数暂不决定**（OPEN），但每条记录必须落在某个有限期分类下，
   **不允许"永久保存"作为默认值**。
3. 若某策略未配置有限保留期 → **拒绝归档该记录**（返回配置错误），不得回退为永久。
4. 保留期到期由 Archive Writer 按分类执行删除，**独立于**主观记忆的遗忘流程。

### 7.3 pending 持久化、写入失败与恢复

**pending 机制（本轮冻结）**

1. `required` 事件在调用 Archive Writer **之前**，先以**短事务**写入一条 **metadata-only** 的 pending 事件行：
   - `status = 'received'`
   - `archive_state = 'pending'`
   - `archive_ref = NULL`
2. pending 行**只存元数据**：`eventId`、信封、`personaId`、`disposition`、时间戳。
   **不存正文、不存摘要、不存原文哈希**（判据见 `DATA-MODEL.md` §3.1）。
3. Archive Writer 归档成功（Archive 侧事务已提交）后，用**一个短事务同时提交三个字段**：
   `archive_ref` + `archive_state='archived'` + `status='accepted'`。
   **不允许分两次写** —— 否则会出现"归档了但没记上"或"记上了但没归档"。
4. **ACK 在该短事务提交之后返回。** 提交前 ACK 视为缺陷（§7.4）。
5. 崩溃后**所有**未完成的 pending 记录都必须可被扫描到，判据是 `archive_state='pending'`。
   不允许存在"看不见的中间态"（例如只存在于内存队列里的归档任务）。

**失败与降级**

| 情形 | 处理 |
|---|---|
| P1（Archive 关闭） | 不写 pending；`archive_state='none'`、`disposition=NULL`；正文随 TTL 删除 |
| pending 写入失败 | 返回 **503**，不 ACK；不派发 Archive Writer |
| Archive append 瞬时失败 | 有界重试（默认 3 次，指数退避）。重试期间正文留在缓冲内，**不复制到 `events`**；**仍不 ACK** |
| append 重试耗尽 | 返回 **503**；pending 行标 `archive_state='failed'`；`status` 不进入 `understood` / `response_committed`；**不得**降级为 `excluded` |
| 3S 提交失败 | pending 保留，交由恢复流程处理；**不重试 Archive append**（可能已写入） |
| Archive 长时间不可用 | 对 `required` 源停止受理（503），而不是收下却记不住 |
| `excluded` 事件 | 与 Archive 无关，照常处理；无审计 |

**幂等与同 eventId 重试（硬要求）**

1. **Archive Writer 自己负责 `eventId` 幂等**：同一 `eventId` 重复 append 不得产生第二条记录。
2. **同一 `eventId` 对应不同内容 → 拒绝覆盖并报告冲突**（`archive_conflict`）：
   - **原事件状态一律不改**（尤其禁止把已 `accepted` 及之后的状态改写为 `rejected`）；
   - 冲突请求不落 `events` 行，直接返回 409 `archive_conflict`，**不 ACK**；
   - 冲突写入独立审计记录（**不含内容**，字段见 `DATA-MODEL.md` §5.3）；
   - **唯一例外**：原事件仍是 `received` + `pending`（从未 `accepted`）时，可转 `rejected`（`archive_conflict`）。
   判定在 Archive Writer 内部完成（键控指纹，见 `DATA-MODEL.md` §5.1）；Brain 只见错误码。
3. **同 eventId 重试不得创建第二条事件记录**：`events.id` 是主键，重试走"读取已有行 → 决策"，
   不走"插入新行"。
4. **去重入口是 `adapterEventRef`，不是让适配器报 `eventId`**：适配器只知道自己的引用；
   Runtime 用 `(personaId, adapterId, source, adapterEventRef)` 唯一索引把它映射到同一个 `eventId`
   （见 `IDENTITY-PROTOCOL.md` §4.5）。命中后还要做**正文核对**（§4.5.1）：
   `required` 且已归档 → 调 `archive.compare` 得 `match`/`conflict`；
   `excluded` 或 P1 → **无法核对，只能幂等命中**，不得声称"内容已去重"；
   无法核对时只累加**指标** `dedupe.body_unverifiable`（结构化日志不含内容），
   **不改变事件状态、不建表、不新增原因码**。
   `compare` 的调用者、绑定与防护见 `TRUST-BOUNDARIES.md` §5.5：仅 [1D] 命中路径、每投递最多一次。
   `eventId` 由 Runtime 分配，Adapter 不得提交或猜测。
5. 恢复流程**不得**改变 `eventId`，**不得**为同一条刺激生成新 `eventId`。

**同 eventId 重试决策表**

| # | 情形 | 判据 | 允许的动作 | 明令禁止 |
|---|---|---|---|---|
| 1 | Archive 已写入，events 提交未完成 | `archive_state='pending'` 且 IPC `status` 返回 `archived` | 只补齐事件表提交：`archive_ref` + `'archived'` + `status='accepted'`（同一短事务） | **再次 append**（会撞幂等或产生冲突） |
| 2 | Archive 未写入，缓冲仍有效 | IPC `status` 返回 `not_found`，且缓冲未过期 | 同一 `eventId` **受控重试**：先幂等检查（是否已有 `archived` 记录 / 是否已有事件行），再 append | 创建第二条事件记录；更换 `eventId` |
| 3 | Archive 未写入，缓冲已丢失 | IPC `not_found`，且缓冲已随崩溃/过期失效 | 标 `status='expired'`，原因码 `buffer_lost`；`archive_state='failed'` | 凭空恢复正文；用新 `eventId` 伪装成原事件重试 |
| 4 | 已 `accepted` | 事件行 `status='accepted'` | 只返回已有状态（含 `archive_ref` 是否存在） | 重复归档；重复进入认知流程（不得二次编码/二次应答） |
| 5 | 同 eventId 不同正文 | Archive 侧指纹不匹配 | 见下方"冲突处理"：原事件不动 + 409 + 冲突审计 | 覆盖原记录；静默接受；**改写原事件状态** |
| 6 | 已终态（`expired` / `rejected`） | 去重键命中，事件行 `status ∈ {expired, rejected}` | 只返回既有终态。适配器若要**重新投递**，必须改用**新的 `adapterEventRef` + 新的 `requestNonce`**，由 [1D] 生成新 `eventId` | 重开或改写终态；为同一次投递更换 `eventId`；重写 pending |

**关键区分**

- 第 1 与第 2 种情形都叫"重试"，但**动作完全不同**：前者只补提交，后者才真正 append。
  混淆两者会导致重复归档或永久 pending。
- 第 3 种情形是"**终止**"，不是"重试"。系统必须承认内容已丢，而不是造一个"看起来成功"的结果。
- 第 4 种情形保证 `accepted` 的幂等性：适配器重投不会让事件被处理两遍。

详见 `DATA-MODEL.md` §3.5 的 `failed` / `expired` / `rejected` 转换规则。

**恢复流程（Brain 不直连 Archive）**

1. **Brain 不允许直接连接 Archive 数据库**：无连接串、无句柄、无密钥。
2. 恢复只能通过 **Archive Writer 的 `status` 受限 IPC**（**不是** `compare`），取得三项**且只此三项**：
   `eventId`、`archiveState`、`archiveRef`。
3. **不得**返回：原文、密文、解密内容、内容指纹、字节长度、密钥信息、任何可推断内容的字段。
4. 恢复扫描必须有界（批量 + 限速），不得在启动时全表扫描。

**恢复时序（崩溃发生在 pending 之后）**

```
t0  短事务：写入 pending 事件行（已提交）        events: pending / status=received
t1  Archive Writer append 成功                  Archive: 记录已提交
t2  崩溃                                        events 仍是 pending，无 archive_ref，**未 ACK**

恢复
 R1  启动：有界扫描 archive_state='pending'
 R2  IPC archive.status(eventId)  →  archived
 R3  短事务：写 archive_ref + archive_state='archived' + status='accepted'
 R4  完成。适配器若重投同一 adapterEventRef → 命中已 accepted 的事件，幂等返回既有状态
```

```
t0  短事务：写入 pending 事件行（已提交）
t1' 崩溃（**Archive 尚未写入**）
 R1  启动扫描 → 找到 pending
 R2  IPC → not_found
 R3  进程已重启，**感知缓冲已随内存消失，正文无法重放**
     → 标记 archive_state='failed'、status='expired'（原因码 buffer_lost）
     → **不重建、不推测、不伪造归档记录**
 R4  适配器重投同一 adapterEventRef → 命中已 expired 的事件，**只返回既有终态**
      （终态不重开。若要重新投递，必须使用新的 adapterEventRef + 新的 requestNonce，
        由 [1D] 生成新 eventId；见 §7.3 决策表情形 6）
```

**关键取舍**：崩溃后**不允许**为了"补齐"而从 Archive 反向读取正文（那会让 Archive 变成主观记忆的输入源）。
恢复只做两件事：补标记，或如实标记失败。

**不允许的"聪明做法"**：把正文暂存到 `tasks.payload_json` 等它恢复；写临时文件；压进日志；
重试时换 `eventId` 绕过冲突；让 Brain 直连 Archive"只读确认一下"；崩溃后用 Archive 正文重建缓冲。

#### 7.3.1 重启后的两类扫描（必须分开）

> **`failed` 不是 `pending`。** 扫描目标不同、动作不同，混用会造成永久卡死或伪造归档。

**扫描 A — 归档恢复（对象：`archive_state='pending'`）**

| 步骤 | 动作 |
|---|---|
| A1 | 有界扫描 `archive_state='pending'` 的事件行 |
| A2 | 调 `archive.status(eventId)`（只回三字段） |
| A3 | 返回 `archived` → **只补提交**：`archive_ref` + `'archived'` + `status='accepted'`（同一短事务） |
| A4 | 返回 `not_found` → **直接终态**：`archive_state='failed'`、`status='expired'`、原因码 `buffer_lost` |
| A5 | 返回 `failed`/冲突 → 记录上报，不自动"修复" |

**禁止**：扫描 A **不得**把 `failed` 当作待补归档；**不得**从 Archive 反读正文重建缓冲（IPC 也不给正文）。

**扫描 B — 缓冲生命周期清理（对象：`archive_state='failed'` 且 `status='received'`）**

| 时机 | 判断 | 动作 |
|---|---|---|
| **Daemon 启动** | 缓冲在内存中，重启即丢 → 必然失效 | 一律转 `status='expired'`、原因码 `buffer_lost`。**不允许**留在 `failed + received` |
| **运行期定时清理** | 缓冲仍在但已过 TTL | 转 `status='expired'`、原因码 `ttl_expired` |
| 运行期缓冲仍有效 | 未过期 | **保持** `failed + received`，等待同 eventId 受控重试（不主动终止） |

**为什么启动时必须一律终止**：缓冲不落盘，进程重启后它一定没了。
若把 `failed + received` 留在库里，适配器看到的"还在等重试"就是假的，
而且重试时会发现没有正文可归档 —— 那才是真正的一致性问题。

**启动清理顺序**：先 A 后 B（A 的 `not_found` 分支会产生新的 `failed`，B 不会再碰它，
因为 A 已直接置为 `expired`）。两次扫描都必须有界、限速、可中断。

**冲突处理（原事件已 `accepted` 时）**

```
原事件 E（eventId=X）早已 accepted/noticed/understood/…
Adapter 用同一 X、不同正文重投
   │
   ▼
Archive append → 指纹不匹配 → 返回 conflict
   │
   ├─ 原事件 E：**状态不变**，一个字都不改
   ├─ 冲突请求：**不落 events 行**（events.id 是主键，也不能冒充）
   ├─ 响应适配器：409 archive_conflict
   └─ 写 archive_conflict_records（独立冲突 ID，字段见 DATA-MODEL §5.3）
```

**冲突审计记录的禁止字段**：冲突正文、摘要、关键词、原文普通 SHA-256、长度/token 数、
任何可反推内容的派生值。记录只回答"谁在什么时候对哪个 eventId 重投了异内容"。

#### 7.3.2 `archive_conflict` 唯一例外的并发安全

例外条款允许把"原事件"转 `rejected`，但**只能在一种严格条件下**发生，否则会覆盖恢复流程的成果。

**三条前置条件（缺一不可）**

1. **同一写入协调器**：冲突处理与恢复提交（扫描 A / 扫描 B）必须走同一个 persona 级单写入者，
   **不得**跨线程/跨进程并行写同一个 `eventId`。
2. **短事务内二次确认**：在决定转换的同一个短事务里**重新读取**该行并确认：
   ```
   status = 'received' AND archive_state = 'pending'
   ```
   只有条件成立才允许 `UPDATE … SET status='rejected', status_reason='archive_conflict'`。
3. **条件更新（CAS）**：`UPDATE … WHERE id=? AND status='received' AND archive_state='pending'`；
   受影响行数为 0 → 说明状态已变，**不得重试盲写**。

**状态已变化时怎么办**

| 事务内读到的实际状态 | 处理 |
|---|---|
| `received` + `pending` | 允许转 `rejected`（`archive_conflict`） |
| 已被扫描 A 补提交为 `accepted` | **按当前状态重新决策**：原事件已归档成功，冲突请求只走 409 + 审计，**原事件不动** |
| 已被扫描 B 转 `expired` | 原事件已是终态，**不得改写**；只 409 + 审计 |
| 其它任何状态 | 一律不改原事件 |

**绝对禁止**：冲突处理覆盖恢复流程已提交的 `accepted`；
以"先读后写"的方式凭一次早前读取做判断；在事务外用普通 `UPDATE` 覆盖状态。

### 7.4 ACK 语义（按 disposition 区分）

**`accepted` 不是同一个含义 —— 取决于事件类别。**

| 事件类别 | `accepted` 的含义 | **不代表** |
|---|---|---|
| `required`（Archive 已启用） | Archive **已加密持久化**，且 `archive_ref` / `archive_state` / `status` **已在同一事务提交** | 不代表已注意、已理解、已形成记忆 |
| `excluded` | 已通过鉴权并持久化信封（`archive_state='excluded'`） | 不代表已归档（本就不归档）、不代表具备审计 |
| P1（`archive_state='none'`） | 已通过鉴权并持久化信封 | **不代表已归档**；系统此时无审计能力 |

**规则**

1. **ACK 一律在数据库事务提交之后返回**，且不得早于该事务。
2. `required` 事件在归档完成前**不得**返回 `accepted`；失败重试耗尽返回 **503**。
3. `accepted` **不保证认知处理完成**：TTL 到期、队列溢出、注意力忽略都可能导致不形成任何主观记忆。
   **审计与记忆是两件事** —— `required` 事件即使没被记住，原文仍在 Archive。
4. `excluded` 与 P1 事件：`accepted` 之后系统仍可能不保留任何内容，且**永远无法补查**。
5. Adapter SDK 必须逐条写明上表，禁止把 `accepted` 解释为"已存档"或"已记住"或"已处理完"。
6. 对 `required` 源，Adapter 必须处理 503：退避重试时**复用同一 `adapterEventRef` 与同一 `requestNonce`**；
   适配器**不持有、也不需要保存内部 `eventId`**（见 `IDENTITY-PROTOCOL.md` §4.5）。

### 7.5 队列溢出与事件重试

| 情形 | 处理 |
|---|---|
| 同一会话队列满 | 新事件 `status = expired`（`queue_overflow`）；对适配器回 429，**不静默丢弃** |
| 事件超过 TTL 仍未注意 | `status = expired`；缓冲删除 |
| 适配器重投同一 `adapterEventRef` | 按去重键幂等：已存在则不重复处理，返回已有状态（含终态） |
| 处理失败（非 Archive） | 有限重试（默认 3 次），超限 `status='rejected'`，原因码 `processing_failed`（受控枚举，见 `DATA-MODEL.md` §3.4）；不进主观记忆 |
| 迟到事件（`occurred_at` 远早于 `received_at`） | 允许处理，但 `subjective_time` 必须用 `occurred_at` 与接收时间共同表达，不得伪装成"刚刚发生" |

所有队列必须**有限、可过期、带反刷屏限流**。

### 7.6 P1 与 P8 的处理保证对照

| 维度 | **P1（Archive 关闭）** | **P8（Archive 启用）** |
|---|---|---|
| Archive | 不存在，不写 pending | 加密原始记录，独立密钥域 |
| 原文位置 | 只在短暂感知缓冲；TTL 到期删除 | 缓冲 + Archive 密文（两者独立） |
| `archive_disposition` | NULL | 确定性策略判定 `required` / `excluded` |
| `archive_state` | `none` | `pending` → `archived` / `failed`；排除者 `excluded` |
| ACK 时机 | 信封持久化后 | `required`：三字段同一事务提交后；`excluded`：信封持久化后 |
| `accepted` 保证 | 仅"已通过鉴权并落信封" | 仅"已归档并落信封"，**都不保证认知处理完成** |
| 崩溃丢缓冲 | 事件标 `expired`（`buffer_lost`）或视为处理丢失 | `required`：pending 保留，恢复时按 IPC 结果补标记或标 `failed` |
| 崩溃后能否补正文 | **不能** | **不能**（禁止从 Archive 反读），只能重投 |
| 未完成认知处理的终态 | `expired`，原因码必填 | 同左；**不得**标记 `understood` |
| 审计能力 | **无**；文档/API/UI 不得暗示 | 仅覆盖 `required` 范围 |
| 能否伪装成已理解 | **绝对不允许** | **绝对不允许** |

**终态定义（两者一致）**

未完成认知处理的事件，恢复后只能落在以下终态之一，且**必须带受控原因码**：

- `expired`：`buffer_lost` / `ttl_expired` / `queue_overflow`；
- `rejected`：`auth_failed` / `untrusted_source` / `schema_invalid` / `rate_limited` /
  `archive_unavailable` / `archive_conflict` / `processing_failed`；
- `understood` **只有在模型确实完成解释后**才允许出现。**崩溃恢复不得推断、不得补写 `understood`。**

#### 7.6.1 `failed` 的语义（与 `expired` 严格区分）

| 判断 | 结论 |
|---|---|
| `archive_state='failed'` 等于事件终结吗？ | **不等于。** 它只表示"归档这次尝试失败" |
| `failed` 会自动变 `expired` 吗？ | **不会自动。** 只有缓冲失效或 TTL 到期才转 `expired` |
| `failed` 时能重试吗？ | **取决于缓冲是否仍有效**：有效则允许同 `eventId` 受控重试；失效则必须转 `expired` |
| 崩溃恢复扫 `failed` 吗？ | **分两类扫描，不要混。** 归档补提交（扫描 A）**不扫** `failed`，只扫 `pending`；缓冲生命周期清理（扫描 B）**会扫** `failed + received`，并在启动时把它们转 `expired`（`buffer_lost`）。详见 §7.3.1 |
| `failed` 能变成成功吗？ | 只能通过**同 eventId 重新 append 成功**后走正常提交；不得直接改状态"假装修好" |
| 缓冲丢了还能把 `failed` 补成 `archived` 吗？ | **不能。** 禁止伪造成功、禁止从 Archive 反读正文重建 |

**三个名字不要混用**

| 名字 | 属于 | 含义 |
|---|---|---|
| `failed` | `archive_state` | 归档尝试失败的瞬时状态，**可重试** |
| `expired` | `status` | 事件生命周期终结，内容已丢失或超时，**不可复活** |
| `rejected` | `status` | 被明确拒绝（鉴权/来源/冲突/限流），**不可复活** |

三者关系：`failed` 是过程状态；`expired` 与 `rejected` 是终态。**`failed` 不等于任何终态。**

转换全表见 `DATA-MODEL.md` §3.5；原因码枚举与 CHECK 约束见 `DATA-MODEL.md` §3.4。

## 8. 睡眠与唤醒

```
AWAKE ──enter──► SLEEPING
                    │
       ┌────────────┴────────────┐
       │                         │
   正常完成                   外部刺激
       │                         ▼
       │                  AROUSAL_PENDING
       │                    │         │
       │              未唤醒/部分   完全/强制
       │                    │         │
       ▼                    ▼         ▼
  DREAM_STOPPED ◄───────────┴─────────┘
       ▼
  FRAGMENT_SELECTION
       ▼
  REALITY_ORIENTATION
       ▼
     AWAKE
```

- 正常整夜**动态计划 4–6 个功能周期**（工程调度概念，不等于人类睡眠阶段）。
- 每周期可组合：记忆回放、远近联想、泛化、重构、遗忘、技能候选、梦境、提交、检查点。
- 早期多处理近期痕迹，后期增加远距离关联。
- 夜间**不得**从 Archive 重读已遗忘的经历。
- 被叫醒：先禁止新睡眠任务派发 → 取消未提交提案 → 保存合法检查点 → 清除梦境临时上下文 →
  恢复当下真实环境感知 → 再决定是否续睡。
- **中断时只记录真实完成的部分**，不得标记"已做梦 / 已巩固"。

### 唤醒分级

| 级别 | 行为 |
|---|---|
| 未唤醒 | 无反应，继续当前周期 |
| 部分觉醒 | 提升注意，不中断周期 |
| 完全觉醒 | 走完整醒后流程 |
| 强制控制 | **立即执行**，不受困倦或偏好阻挡（关窗口、停运行、撤权限、安全控制） |

## 9. 单实例与并发

- 单实例锁按**数据目录**粒度，不按端口（端口可换，数据目录是身份）。
- 多人格共存时：每个 persona 一个写入协调器，跨 persona **不共享**缓存、队列与激活状态。
- 同一 persona 的写事务串行；读可并发（WAL）。
- 禁止跨 persona 复用任何内存结构（含模型客户端会话、embedding 缓存）。

## 10. 健康检查

**目标要求（未全部实现）**：必须暴露至少：进程状态、当前 Persona 状态、单实例锁归属、DB 可读写、
队列深度（按通道）、最近一次成功提交时间、最近一次错误。
**不得**在健康检查里泄露主观记忆内容或 Archive 审计数据。

**当前实现（SH-009 E1–E4、E5.P0、E5A）**：只有匿名最小端点：

- `GET /v1/health/live` → `{"status":"ok"}`；
- `GET /v1/health/ready` → `{"status":"ready"}`，或 503 `{"status":"not_ready","reason":...}`。

没有完整健康指标、队列深度、最近成功提交时间或最近错误字段；没有 health loop、Supervisor 或自动重启。管理面的 `/v1/status` 是受 Bearer Token 保护的 StatusView 查询，不是完整健康检查。不要把这些目标指标写成现有 API 已提供。
