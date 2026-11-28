# CA-DOC-02 E0 — Cognitive Architecture R1.5 收敛前置调查报告

**版本：** E1-P0.R1（2026-11-28；R1.5 专项统计 26；F-01 独立）
**状态：** 只读调查 / 修订计划；R1.5 未冻结；仓库文件未修改
**调查日期：** 2026-11-28
**报告输出位置：** `F:\6\soul-harness-inputs\CA-DOC-02-E0-REPORT.md`

> **CA-DOC-02 E1-P0 复核修订（优先）：** D-08 不属于 R1.5 外部草案的 26 项发现，已移出主统计并作为独立仓库文档任务 F-01；R1.5 专项分类为 MATCH 10 / DRIFT 6 / CONFLICT 2 / OPEN 3 / MISSING 3 / NOT_VERIFIED 2 = 26。包含 F-01 的全局统计为 27 项、DRIFT 全局 7 项。X-02 是跨阶段文档承诺冲突/待决歧义，不是已证明的技术互斥；N-03 是目标表未实现导致的不可验证，不是“已实现仅缺证据”。详见 `CA-DOC-02-E1-P0-E0-CORRECTION.md`。

> **归档说明（PR #24）：** 本报告生成时没有创建仓库 PR；它是 E1-P0.R1 的原始只读复核文本。后续仅为归档与独立审查，才通过 PR #24 将副本加入 `docs/reviews/CA-DOC-02/`。归档 PR 不代表 WP-1/WP-2/WP-3 已实施。

---

## 1. 开工基线与工作区检查

### 1.1 固定基线与 Git 事实

| 项目 | 实际值 |
|---|---|
| 仓库 | `wblnn/soul-harness` |
| 固定 `main` SHA | `e4ea4acc862b382868f9b26a17ecf7e087bf219a` |
| GitHub `main` | `e4ea4acc862b382868f9b26a17ecf7e087bf219a` |
| PR #23 | merged = true |
| PR #23 merge commit | `e4ea4acc862b382868f9b26a17ecf7e087bf219a` |
| PR #23 head | `aeb68c4108bdae6828e45e11809273b015bce338` |
| PR #23 原 base | `43259b0c9435d72f1798fc07463a001bb4ca032c` |
| 本地当前 HEAD | `aeb68c4108bdae6828e45e11809273b015bce338` |
| 本地当前分支 | `docs/ca-r1.5-lifecycle-sync` |
| 本地 `main` | `43259b0c9435d72f1798fc07463a001bb4ca032c`（未切换；陈旧本地引用） |
| `origin/main`（fetch 后） | `e4ea4acc862b382868f9b26a17ecf7e087bf219a` |
| 工作区 | `git status --porcelain` 为空 |

说明：本地 `main` 仍停留在 PR 合并前的 SHA，是因为当前 checkout 在 PR 分支且本地 `main` 未被更新；`git fetch origin main` 已把 `origin/main` 更新到固定基线。没有 reset、没有切换分支、没有清理工作区。PR head 与合并提交的 `RUNTIME-LIFECYCLE.md` 内容一致（合并提交没有改变 PR 文件树）。

### 1.2 PR #23 合并内容确认

已确认：

- `git diff aeb68c4 e4ea4ac -- docs/architecture/RUNTIME-LIFECYCLE.md` 为空；
- `main` 中 `RUNTIME-LIFECYCLE.md` 的 Blob 为 `2064c7a3d9f34eed11c873f0fde9eedb1b41051b`，与当前工作区一致；
- `main` 中 §8 已包含 CA-DOC-01 的 G5/G6 内容：
  - 控制面状态转移构成生效边界；
  - 未提交的 `FRAGMENT_SELECTION` 提案失去提交资格；
  - 若存在正在进行的梦境才以 `INTERRUPTED` 收束；
  - 已提交片段结果保留、不再开始新选择。

### 1.3 外部 R1.5 草案身份

| 项目 | 实际值 |
|---|---|
| 路径 | `F:\6\soul-harness-inputs\COGNITIVE-ARCHITECTURE-R1.5.md` |
| 大小 | `66,094` bytes |
| 行数 | `706` |
| SHA-256 | `227d315df8fe1a9e787a93e4657ddce4224b26614bc2fec843ff9480a8cdf26b` |
| 与预期摘要 | **一致** |
| Git 状态 | 仓库外只读输入；未加入 Git，未修改 |

### 1.4 仓库文件基线

本报告引用的仓库文件均为 `main` = `e4ea4acc862b382868f9b26a17ecf7e087bf219a` 的内容；当前工作区在这些文件上与 main 一致。主要引用：

- `docs/PLAN.md`
- `docs/architecture/OVERVIEW.md`
- `docs/architecture/RUNTIME-LIFECYCLE.md`
- `docs/architecture/MODULES.md`
- `docs/architecture/DATA-MODEL.md`
- `docs/architecture/TRUST-BOUNDARIES.md`
- `docs/architecture/IDENTITY-PROTOCOL.md`
- `docs/architecture/AI-DEVELOPMENT-RULES.md`
- `docs/adr/ADR-001-independent-runtime.md`
- `packages/persistence/migrations/0001_init_core.sql`
- `packages/persistence/src/repositories/*.ts`
- `apps/soul-daemon/README.md` 与 WebSocket 源码

未发现“R1.4 独立审查记录”文件。仓库和 `F:\6\soul-harness-inputs` 中只有 R1.5 草案本身；因此 R1.4 审查原始记录属于 `NOT_VERIFIED`，见 N-02。

---

## 2. CA-DOC-01 合并内容回填核对

### 2.1 正常唤醒顺序：RUNTIME 与 R1.5 对照

当前 `RUNTIME-LIFECYCLE.md §8` 的正式流程图在 L621–L655，文字步骤在 L657–L669：

1. 停止新的普通睡眠工作派发；
2. 使未提交提案失去提交资格；
3. 写入 metadata-only checkpoint；
4. 执行 `FRAGMENT_SELECTION`；
5. 清理梦境临时上下文；
6. 执行 `REALITY_ORIENTATION`；
7. 决定继续睡眠或清醒；
8. 进入 `AWAKE` / `SLEEPING`。

图中顺序为：

`SLEEPING` → `STOP_NEW_SLEEP` → `FENCE_UNCOMMITTED` → `CHECKPOINT` → `FRAGMENT_SELECTION` → `CLEANUP` → `REALITY_ORIENTATION` → `DECIDE_RESUME` → `AWAKE` / `SLEEPING`。

R1.5 §5.3 的正常路径（L445–L456）有步骤 1–7：

1. 停止派发新的普通睡眠任务；
2. 使唤醒前尚未提交的普通睡眠阶段提案失去提交资格；
3. 保存 metadata-only 检查点；
4. 进入 `FRAGMENT_SELECTION`；
5. 选择完成后清理梦境临时上下文；
6. `REALITY_ORIENTATION`；
7. 再决定是否继续睡眠。

**对照结论：**

- 步骤 1–7 的语义与 RUNTIME 基本一致（M-02、M-03）。
- R1.5 缺少“决定后续睡眠状态之后，显式进入 `AWAKE` / `SLEEPING`”的步骤 8（D-03）。R1.5 的“再决定是否继续睡眠”停留在决策，没有把最终状态转换写完整；RUNTIME 图已有 `DECIDE_RESUME → AWAKE / SLEEPING`。
- R1.5 的 checkpoint 描述（L449）与 RUNTIME 的 metadata-only 约束一致。
- R1.5 的崩溃/选择语义（L451–L462）与 RUNTIME 的“选择前崩溃、丢弃未提交候选、INTERRUPTED、不重建正文”一致（M-03）。

### 2.2 强制控制：G5 / G6 对照

R1.5 §5.3 的强制控制段落目前在 L439：

> ...使所有尚未提交的睡眠提案失去提交资格；将正在进行的梦境按既有生命周期规则以 `outcome=INTERRUPTED` 收束，**不执行醒后片段选择、不生成醒后片段**。

与 CA-DOC-01.R1 合并后的 RUNTIME 相比，存在两处必须修订：

1. **G5 缺失**：R1.5 只说“睡眠提案”失去提交资格，没有明确：
   - 控制面状态转移是生效边界；
   - 生效边界前已成功持久提交的 `FRAGMENT_SELECTION` 结果保留；
   - 生效边界到达时尚未成功持久提交的 `FRAGMENT_SELECTION` Proposal 失去提交资格；
   - 迟到结果不得越过边界提交；
   - 不再开始新的片段选择；
   - 强制控制不等待正在执行的片段选择、模型 Proposal 或 Handler。
2. **G6 偏差**：L439 把梦境中断写成了直接执行的陈述，没有写成“**若存在正在进行的梦境**，则以 `INTERRUPTED` 收束”。需要改成条件语义；同时保留无条件的“跳过新的 `FRAGMENT_SELECTION` / 不生成新的醒后片段”。

R1.5 §8.2（L571–L577）只重述了正常醒后顺序，没有重述强制控制边界或条件梦境中断。它应当引用 §5.3 的完整控制面语义，而不是另立一套；在 §5.3 修正后，§8.2 至少应补一句强制控制 bypass 的交叉引用。

### 2.3 崩溃与恢复语义

R1.5 L455–L462 已明确：

- 选择完成并成功提交前崩溃：未提交候选全部丢弃；
- 梦境按 `INTERRUPTED` / 无醒后片段收束；
- 检查点只保存阶段枚举、身份引用和版本元数据，不保存梦境正文或候选；
- 已完成且持久化提交的选择结果保留；
- 不得从检查点把“待处理”解释为已有片段。

这与 RUNTIME §8.1 的崩溃收束段落一致（M-03）。R1.5 需要补充的只是 G5 的“控制面生效边界前/后”时间边界，以及 G6 的“若存在梦境”条件；不需要重写既有崩溃语义。

### 2.4 基线/受控同步陈述的陈旧性

R1.5 目前仍把 `43259b0c...` 作为修订基线（L6、L343），并多处声称 RUNTIME §8 尚未同步：

- L443：称 RUNTIME §8 当前图是 `DREAM_STOPPED → FRAGMENT_SELECTION → REALITY_ORIENTATION`，并称文字“没有把片段选择插入”；
- L706：结论仍写“睡眠醒后顺序的澄清在 RUNTIME §8 完成受控同步前仍是拟议修订”；
- L3/L15：文档状态只写 G1–G4 已处理，没有 CA-DOC-01 的 G5/G6 同步状态。

CA-DOC-01 合并后，这些陈述已经是**事实性陈旧**。R1.5 必须在冻结前把它们改为：

- 基线更新到 `e4ea4ac...` 或明确“R1.5 基线 + CA-DOC-01 合并提交”；
- 说明 RUNTIME §8 已完成受控同步；
- 删除旧的 `DREAM_STOPPED` 图引用；
- 保留“R1.5 仍未冻结”的结论，但不再把同步本身写成未完成。

---

## 3. G2 — 版本字段与 OCC 专项核对

### 3.1 实际数据库与文档边界

`packages/persistence/migrations/0001_init_core.sql` 只创建 P1 六表：

- `personas`（L14）
- `sessions`（L26）
- `events`（L45）
- `tasks`（L92）
- `runtime_state`（L109）
- `schema_migrations`（L121）

`packages/persistence/src/migrations/expected-schema.ts` 的列清单也只覆盖这六表（L20–L73）。`memory_nodes`、`memory_edges`、`thought_threads`、`action_records`、`dream_sessions` 等尚未进入 Migration，属于 `DATA-MODEL` 的目标设计，不是当前数据库事实。

### 3.2 逐表/对象核对表

| 表 / 对象 | 当前实际字段 | 用途 | 实际写入校验 | 文档描述 | 结论 |
|---|---|---|---|---|---|
| `personas` | `version`、`epoch`（Migration L14–L23；DATA-MODEL L67–L68） | `version` 为状态版本；`epoch` 为内容纪元 | `compareAndSetState` 使用 `state + version`；`commitLifecycle` 使用 `state + version`；`updateState` 只有 `id` 谓词但当前无调用者（`personas.ts` L246–L251、L305–L321、L362–L410） | DATA-MODEL L67–L68；R1.5 L45 称 `personas` 使用 `version` | **部分一致**：实际 P1 使用 `version`，没有 `state_version`；`version` 的条件写已实现，`epoch` 不是通用 OCC |
| `runtime_state` | `epoch`、`checkpoint_json`，无 `state_version`（Migration L109–L118） | 恢复检查点与 Persona epoch | checkpoint 读取/写入比较 `epoch`（`checkpoint.ts` L145–L150）；`runtime-state.ts` L52–L59 的 upsert 不按版本 CAS | RUNTIME §3/§4；DATA-MODEL L723 | **一致但有边界**：只有 checkpoint 的 epoch 条件，不是实体 `state_version` 条件 |
| `sessions` | 无版本字段（Migration L26–L43） | 适配器会话映射 | `ux_sessions_external` 部分唯一索引；关闭用 `closed_at IS NULL`；`sessions.ts` L163、L239、L281 | DATA-MODEL L26–L43 | **无 OCC**：依赖唯一索引与谓词，不是版本条件写 |
| `events` | 无版本字段（Migration L45–L90） | 事件生命周期 | `commitP1Envelope`、`expireActive`、`rejectIfActive` 使用 `status` / `archive_state` 谓词（`events.ts` L455–L500、L533–L559） | DATA-MODEL L45–L90 | **无 OCC 版本**：条件写基于状态与归档状态，不能写成 `state_version` CAS |
| `tasks` | 无版本字段（Migration L92–L107） | 任务调度/尝试 | `claimNext` 用 queued/attempt/kind；`completeTask`、`failTask` 用 `state='running' + run_id + attempt`；`setTaskState` 用状态与 attempt（`tasks.ts` L412–L424、L466–L476、L519–L590、L668–L684） | DATA-MODEL L92–L107；RUNTIME §4 D-RT1 | **无 OCC 版本**：条件写基于状态机、runId、attempt，不能概括为 `state_version` |
| `memory_nodes` | **不存在实际表**；目标字段 `content_epoch`、`state_version`（DATA-MODEL L348–L365） | 未来记忆节点 | 无实际写入路径；目标要求两个字段 | R1.5 L39–L47；DATA-MODEL L348–L365 | **目标设计，未实现**；不可把目标字段写成当前列 |
| `memory_edges` | **不存在实际表**；目标字段 `state_version`（DATA-MODEL L381–L394） | 未来记忆边 | 无实际写入路径 | DATA-MODEL L381–L394 | **目标设计，未实现**；只有 `state_version`，没有 `content_epoch` |
| `thought_threads` | **不存在实际表**；目标字段 `epoch`，无 `state_version`（DATA-MODEL L408–L419） | 未来思维线程 | 无实际写入路径；OCC 方案未决 | R1.5 L45；CA-OPEN-05 L653 | **目标设计 + OPEN**：不得说当前表已有 `epoch` 或 OCC |
| `action_records` | **不存在实际表**；目标字段 `intent_version`（DATA-MODEL L501–L510） | 未来动作幂等/回执 | 无实际写入路径 | DATA-MODEL L501–L510；R1.5 L42、L490；IDENTITY L238–L251 | **目标设计，未实现**；`intent_version` 只属于动作记录 |
| `dream_sessions` | **不存在实际表**；无版本字段（DATA-MODEL L490–L500） | 未来梦境会话 | 无实际写入路径 | DATA-MODEL L490–L500 | **目标设计，未实现**；不要把 `outcome` 写成当前生命周期枚举 |
| `activation_states` | **不存在实际表**；无版本字段（DATA-MODEL L397–L405） | 可重建易失缓存 | 无实际写入路径 | DATA-MODEL L397–L405 | **目标设计，未实现** |

### 3.3 G2 结论

1. **`thought_threads` 确有目标 `epoch`、没有目标 `state_version`，且没有实际 P1 表。** R1.5 L45 的字段判断正确，但“基线 `thought_threads`”的措辞容易被读成当前数据库表；应改为“DATA-MODEL 目标 Schema 中的 `thought_threads` 设计字段”并明确尚未 Migration。
2. **`memory_edges`、`memory_nodes`、`action_records` 也全部尚未实现。** R1.5 L45 将 `memory_edges` 作为“基线”例子，需加“目标 Schema”限定；否则与 P1 只有六表的实际状态冲突。
3. **`DATA-MODEL §6` 的“三个独立版本”不完整。** 它只列 `state_version`、Persona `epoch`、`intent_version`（DATA-MODEL L719–L725），但同一文件 L364 有 `memory_nodes.content_epoch`，R1.5 L47 也明确四类版本。必须把 `content_epoch` 纳入版本说明，或明确它是节点级单独概念并与四类对照。
4. **`DATA-MODEL §6` 的“任何写事务提交前校验 base_version”超过 P1 实际。** 实际 `events`、`tasks`、`sessions` 没有 `base_version` 或 `state_version`；它们用状态/唯一索引/runId/attempt 条件。文档必须把该条限定为目标领域契约或分别列出实际条件写，不可让读者以为 P1 已有统一 OCC。
5. **R1.5 §5.1 L390–L405 的版本流程是目标流程，不是当前 P1 行为。** 应明确“当前 P1 只有 personas.version、checkpoint epoch 和状态/唯一性谓词；其余为目标 Schema”，否则会把未来 OCC 写成已实现。
6. **不新增 `state_version`。** `thought_threads` 的 OCC 仍归 CA-OPEN-05；R1.5 不应自行指定字段。

---

## 4. G3 — `intent_version` 专项核对

### 4.1 文档语义

| 文档 | 行号 | 事实 |
|---|---|---|
| `DATA-MODEL.md` | L501–L510 | 目标 `action_records` 有 `intent_version INTEGER NOT NULL`；它是动作记录字段 |
| `DATA-MODEL.md` | L725 | `intent_version` 是“场景/意图版本”；意图变更时更新；过期意图不得执行动作 |
| `IDENTITY-PROTOCOL.md` | L238–L251 | 同一意图的重试复用同一 `actionId`；意图实质改变且 `intentVersion` 递增时分配新 `actionId`；旧动作保留结局 |
| `IDENTITY-PROTOCOL.md` | L503–L504、L509 | 当前 `allocateActionId` 只产生字符串，没有对应业务插入；I06/I07/I08 未实现 |
| `R1.5` | L42 | `intent_version` 只在 `action_records`；不是所有实体通用字段；意图实质改变时递增并分配新 `actionId` |
| `R1.5` | L490 | 同一意图重试复用 `actionId`；`intentVersion` 递增是新动作意图，必须新 `actionId` |
| `R1.5` | L497 | 同一 `actionId` 幂等只覆盖同一意图；语义重复意图归 CA-OPEN-07 |

### 4.2 实际实现

`action_records` 没有 Migration 表，也没有 Repository；用 `rg` 在 `packages/*/src` 与 `apps/*/src` 未发现 `action_records` 的读写路径。`packages/runtime` 只有 `allocateActionId` 字符串分配器；`IDENTITY-PROTOCOL.md` L509 明确说明它没有业务插入。因此：

- 文档语义一致（M-05）；
- 实际写入、唯一约束、回执对账均 **NOT_VERIFIED**，不能写成已经实现（N-03）。

### 4.3 容易误解的句子

1. `DATA-MODEL §6` L719 把 `intent_version` 与 `state_version`、Persona `epoch` 并列为“三个独立版本”。这会让读者以为 `intent_version` 是通用实体版本、或所有 Intent 对象都有该列。应在 §6 明确：
   - 它只存在于 `action_records`；
   - 它表达“场景/意图版本”，不是 `state_version` 的别名；
   - 不是所有认知实体都携带。
2. `R1.5 §0.1` L42 已经正确收窄，但 `DATA-MODEL` 本身仍缺这条限定；建议在 `DATA-MODEL §6` 表下补注释，而不是把 `intent_version` 塞进通用实体版本表。
3. `R1.5` L390/L398 的版本快照列表中把 `intent_version` 与实体 `state_version` 并列，必须保留“按本次提交适用的粒度”限定；当前 R1.5 L405 已有该限定，建议保留并在修订时不要删掉。

---

## 5. G4 — WebSocket pull / push 一致性

### 5.1 当前实际行为

当前 Daemon 的 WebSocket 是**首帧鉴权的 pull 快照通道**：

- `apps/soul-daemon/README.md` L211：认证成功后发送 `hello`，再发送一次权威 `snapshot`；
- 同文件 L212：客户端只可发送 `{"type":"pull"}`，返回新 `snapshot`；
- `apps/soul-daemon/src/ws/ws-protocol.ts` L84–L105 只接受 `pull`；
- `apps/soul-daemon/src/ws/ws.ts` L139 在认证后发送快照，L144–L177 只处理 pull 并合并请求；
- 没有周期性 unsolicited event push、事件流或 replay；
- `shutting_down` 是关闭通知，不是普通事件推送。

### 5.2 当前架构基线承诺

- `OVERVIEW.md` L124：`Daemon WebSocket` 是“首帧鉴权的状态快照通道（pull），不是事件推送”；
- `MODULES.md` L106：同样写明 pull 快照，不是事件推送；
- `apps/soul-daemon/README.md` L211–L212 与上述一致；
- `R1.5` L413 明确承认当前 Daemon WebSocket 是 pull，不是 push；`DATA-MODEL.md` L744 的“广播（WebSocket）”不能解释为当前已有 push。

### 5.3 P2 要求

- `PLAN.md` L386：P2 通过标准包括“WS 实时推送事件状态”；
- `PLAN.md` L122：后端 `Fastify + WebSocket` 描述为“本地 HTTP API 与实时推送”；
- 这是目标阶段的验收要求，不是当前 P1 已实现能力。

### 5.4 是否矛盾 / 是否不同阶段

这是**当前 pull 实现与 P2 push 目标之间的未决语义冲突**，不能简单说成“不同阶段所以不矛盾”：

- 当前实现与 `OVERVIEW` / `MODULES` 的 pull 描述一致；
- `PLAN` P2 明确要求 push，且 `MODULES §5` 当前把 pull 写成传输语义约束；
- `DATA-MODEL §7` 的“广播（WebSocket）”进一步模糊了当前/未来；
- R1.5 L413 已把它标为 CA-OPEN-15，并未擅自把 pull 改成 push，也没有删除 P2 要求。

因此应标记为 **OPEN（CA-OPEN-15）**，而不是现在修改任一侧。

### 5.5 决议责任与文档同步

- 主决议：**CA-OPEN-15**；
- 前置：CA-OPEN-01 的 P2 子集（内部 Event / status 通知）；
- 一旦决定 push/pull 语义，必须同步：
  - `MODULES.md §5`（L101–L109）
  - `OVERVIEW.md §8`（L116–L130）
  - `PLAN.md` P2（L382–L386，且 L122 的“实时推送”需与验收口径一致）
  - `DATA-MODEL.md §7`（L744 的“广播（WebSocket）”，需明确当前/未来）
  - R1.5 的 §5.1、§11 CA-OPEN-15、§13 审阅重点
  - 当前实际 pull 语义的 `apps/soul-daemon/README.md` 只应在实现变更时更新，不能拿目标 push 反写当前实现。

本批不决定 pull 或 push。

### 5.6 G4 六问结论

| 问题 | 结论 |
|---|---|
| 1. 当前已实现的 WebSocket 行为是什么？ | 首帧认证后发送 `hello` + 一次权威 `snapshot`；客户端只能发送 `pull` 并取得新快照；没有 unsolicited event push、事件流或 replay。 |
| 2. 当前架构基线对 WebSocket 的正式承诺是什么？ | `OVERVIEW` L124 与 `MODULES` L106 都明确写为 pull 状态快照，不是事件推送；Daemon README 与源码一致。 |
| 3. P2 是否要求事件状态 push？具体要求来自哪里？ | 是目标要求；`PLAN` L386 明确写“WS 实时推送事件状态”，L122 写“实时推送”。这不是当前 P1 已实现内容。 |
| 4. 现有 pull 描述与 P2 push 是否矛盾，还是不同阶段？ | 是未决的架构语义冲突，不只是阶段差异：当前 pull 与 P2 push 不能同时作为无条件的同一承诺；R1.5 L413 已标注 CA-OPEN-15，未擅自裁决。 |
| 5. 应由哪个 CA-OPEN 决议确定最终语义？ | CA-OPEN-15；其 P2 前置依赖 CA-OPEN-01 的 P2 子集。 |
| 6. 一旦确定，哪些文档必须一起同步？ | `MODULES.md §5`、`OVERVIEW.md §8`、`PLAN.md` P2（L122/L386）、`DATA-MODEL.md §7`、R1.5 §5.1/§11/§13；实际实现变更时才更新 Daemon README，不能用目标反写当前。 |

### 5.7 身份与生命周期交叉核对

- **共同身份语义：** R1.5 L474–L480 的 `personaId` / `eventId` / `threadId` / `runId` / `actionId` / `taskId` / `requestNonce` 与 `IDENTITY-PROTOCOL.md` L30–L35、L149–L171 的语义一致；R1.5 没有另造万能关联 ID（M-10）。
- **遗漏 `sessionId`：** R1.5 的 §6 身份表没有列出 `sessionId`，但 `IDENTITY-PROTOCOL.md` L31/L149 和 `RUNTIME-LIFECYCLE.md` §7 都以 `sessionId` 表示适配器交互窗口；R1.5 只在 L26 的权威文件指针中提及它。建议在身份表直接补一行 `sessionId`，并引用“会话身份见 IDENTITY §4.2”，否则跨模块关联表不完整（N-04）。
- **Persona 生命周期：** R1.5 沿用既有 Persona 状态与恢复规则，没有新增 Persona 状态枚举；`RUNTIME-LIFECYCLE.md` §5/L105–L128 仍是权威状态机（M-10 的配套事实）。
- **Thread / Run / Action 生命周期：** R1.5 §7 给出目标线程字段与暂停/恢复/中断/完成/放弃的语义，但 `thought_threads` / `action_records` 尚未 Migration（N-03）。不能把 R1.5 的 `threadId` / `runId` / `actionId` 目标语义写成当前可执行路径。
- **陈旧实现状态：** `IDENTITY-PROTOCOL.md` 仍写“Daemon 未装配”“无 HTTP，Daemon 未调用”等（L4、L346、L500、L502），与当前 main 的 SH-008E/009 装配事实不一致；SH-008E 整批仍待最终签署。该问题不属于 R1.5 的 26 项发现，已移出主统计，作为独立仓库文档任务 F-01（D-08）；见 E1-P0 方案 WP-3。

---

## 6. 全文跨文档差异清单

分类：`MATCH`、`DRIFT`、`CONFLICT`、`OPEN`、`MISSING`、`NOT_VERIFIED`。

| ID | 分类 | 发现 | 证据 | 建议 |
|---|---|---|---|---|
| M-01 | MATCH | PR #23 已合并；RUNTIME §8 已含 G5/G6 | GitHub main `e4ea4ac`；RUNTIME L621–L718；PR head `aeb68c4` | 无需改代码/文档；作为新基线 |
| M-02 | MATCH | RUNTIME §8 正常路径 8 步图与文字一致 | RUNTIME L627–L669 | 保持 |
| M-03 | MATCH | R1.5 checkpoint/崩溃语义与 RUNTIME 一致 | R1.5 L449–L462；RUNTIME L657–L669 | 保持，补 G5 时间边界 |
| M-04 | MATCH | R1.5 §8.2 的 `FRAGMENT_SELECTION → cleanup → REALITY_ORIENTATION` 顺序正确 | R1.5 L573；RUNTIME L645–L655 | 保持 |
| M-05 | MATCH | `intent_version` 的“同意图重试复用 actionId、实质变更新建 actionId”文档语义一致 | R1.5 L42、L490；IDENTITY L238–L251；DATA-MODEL L501–L510 | 保持；补 DATA-MODEL 通用版本表限定 |
| M-06 | MATCH | R1.5 目标/实现状态总体分离 | R1.5 L7–L15、L633；RUNTIME L623 | 保持；修正局部“基线表”措辞 |
| M-07 | MATCH | 当前实际 WS 是 pull，OVERVIEW/MODULES/Daemon README 一致 | Daemon README L211–L212；OVERVIEW L124；MODULES L106；ws-protocol L84–L105 | 保持实际描述 |
| M-08 | MATCH | R1.5 的物理关闭保护与 RUNTIME §3 一致 | R1.5 L441；RUNTIME L49–L77 | 保持 |
| M-09 | MATCH | R1.5 没有把 Handler 取消/硬超时写成已实现 | R1.5 L466；RUNTIME L77 | 保持 |
| M-10 | MATCH | R1.5 的 persona/event/thread/run/action/task/requestNonce 身份语义与 IDENTITY 一致；Persona 生命周期沿用既有状态机 | R1.5 L474–L480；IDENTITY L30–L35、L149–L171；RUNTIME L105–L128 | 保持；补 sessionId 见 N-04 |
| D-01 | DRIFT | R1.5 修订基线仍是旧 SHA `43259b0c...` | R1.5 L6、L343 | 更新到 `e4ea4ac...` 或明确 CA-DOC-01 合并基线 |
| D-02 | DRIFT | R1.5 仍称 RUNTIME §8 未同步，引用旧 `DREAM_STOPPED` 图 | R1.5 L443、L706、L658 | 改为“已由 CA-DOC-01 同步”；删除旧图描述 |
| D-03 | DRIFT | R1.5 正常路径只到“是否续睡”，缺少显式进入 `AWAKE` / `SLEEPING` 的第 8 步 | R1.5 L445–L456；RUNTIME L655 | 补步骤 8，且与 RUNTIME 图一致 |
| D-04 | DRIFT | R1.5 强制控制把梦境中断写成直接陈述，未写“若存在正在进行的梦境” | R1.5 L439 | 改为条件语义；无条件保留跳过新片段选择 |
| D-05 | MISSING | R1.5 缺少 G5 的生效边界、已提交结果保留、未提交 Proposal 失效、迟到结果禁止、不得等待执行中的选择 | R1.5 L439、L458；RUNTIME L676–L700 | 补完整 G5 语义，不定义 fencing 字段/取消 API |
| D-06 | DRIFT | `DATA-MODEL §6` 的“任何写事务校验 base_version”超过 P1 实际 | DATA-MODEL L729；实际 events/tasks/sessions 无该字段 | 限定为目标领域规则，并列出实际条件写 |
| D-07 | DRIFT | R1.5 把 `thought_threads` / `memory_edges` 说成“基线”字段，易被读成当前数据库已有 | R1.5 L45；Migration L14–L121 仅六表 | 改为“DATA-MODEL 目标 Schema 设计字段，未 Migration” |
| X-01 | CONFLICT | `DATA-MODEL §6` 说“三个独立版本”，漏掉 `memory_nodes.content_epoch`；R1.5 L47 说四类 | DATA-MODEL L719–L725、L364；R1.5 L47 | 统一为四类版本/纪元，并明确各自粒度 |
| X-02 | CONFLICT | `PLAN` P2 要求 WS push，但 `OVERVIEW`/`MODULES` 说明当前 pull；`DATA-MODEL §7` 说“广播（WebSocket）”。这是跨阶段文档承诺冲突/待决歧义，不是已证明的技术互斥 | PLAN L386、L122；OVERVIEW L124；MODULES L106；DATA-MODEL L744 | 保留为 CA-OPEN-15；不得现在改任一侧；确定后同步 |
| O-01 | OPEN | CA-OPEN-15 未决：已提交 Event/status 的对外投影与 pull/push 语义 | R1.5 L663 | 必须在 P2 实时状态流设计/实现前裁决 |
| O-02 | OPEN | CA-OPEN-01 的 P2 子集未决：本地提交后的最小内部通知/可靠性/恢复 | R1.5 L649 | 必须先于 CA-OPEN-15 的最终 P2 设计 |
| O-03 | OPEN | CA-OPEN-10 的同步前置已由 CA-DOC-01 满足，但阶段/片段选择/失败恢复细节仍未决 | R1.5 L658；RUNTIME L676–L718 | 不把同步完成当作 CA-OPEN-10 全部关闭 |
| N-01 | MISSING | CA-OPEN-15 的同步清单没有列出 `DATA-MODEL §7` 的“广播（WebSocket）”措辞 | R1.5 L663；DATA-MODEL L744；R1.5 L413 已指出该风险 | 把 `DATA-MODEL §7` 加入同步范围或明确其仅为未来语义 |
| N-02 | NOT_VERIFIED | 未找到 R1.4 独立审查原始记录；只能看到 R1.5 对 G1–G4 的自述 | 仓库无评审文件；inputs 仅有 R1.5 | 补充 R1.4 审查记录后再宣称闭环；本报告不否定其历史存在 |
| N-03 | NOT_VERIFIED | `memory_*`、`thought_threads`、`action_records`、`dream_sessions` 尚无实际表/Repository/写入路径。目标 OCC/版本行为**未实现，无法运行时验证**；不是“已实现但缺证据” | Migration 0001；expected-schema L20–L73；源码无这些表 | 报告/文档必须标注“目标 Schema，未实现”；不得写成仅缺证据或验证通过 |
| N-04 | MISSING | R1.5 §6 身份表缺少 `sessionId`，但 IDENTITY/RUNTIME 均将其作为适配器会话身份 | R1.5 L474–L480；IDENTITY L31、L149；RUNTIME §7 | 直接补一行 `sessionId` 并引用 IDENTITY §4.2 |

### 6.1 计数

| 分类 | 数量 |
|---|---:|
| MATCH | 10 |
| DRIFT | 6 |
| CONFLICT | 2 |
| OPEN | 3 |
| MISSING | 3 |
| NOT_VERIFIED | 2 |
| **合计** | **26** |

**包含独立 F-01 的全局统计：** MATCH 10 / DRIFT 7 / CONFLICT 2 / OPEN 3 / MISSING 3 / NOT_VERIFIED 2 = **27**；其中 R1.5 专项 26 项，F-01 1 项。

**移出主统计的独立后续项：D-08 / F-01。** `IDENTITY-PROTOCOL.md` 的 Daemon 状态陈述仍需纠正，但不属于 R1.5 外部草案的 26 项发现；归入独立仓库文档任务，详见 E1-P0 方案 WP-3 / E0 修正说明。

---

## 7. CA-OPEN 依赖梳理

### 7.1 OPEN 表

| OPEN | 当前状态 | 决策内容 | 依赖项 | 阻塞阶段 / 任务 | 建议先后 |
|---|---|---|---|---|---|
| CA-OPEN-01 | OPEN | 一次逻辑提交的原子边界；内部通知；派生索引刷新；P2 / P3 分阶段 | CA-OPEN-15 的 P2 外部语义需其 P2 子集；P3 记忆提交 | P2 实时状态流前（P2 子集）；P3 记忆提交前（P3 子集） | 1（P2 子集先行） |
| CA-OPEN-02 | OPEN | 睡眠/清醒对节点、意图、人格状态的竞争仲裁 | CA-OPEN-10 的阶段与选择；CA-OPEN-06 的人格状态 | P7 睡眠/唤醒；P8 人格状态 | 后段（P7/P8） |
| CA-OPEN-03 | OPEN | 来源认证、证据、确信、来源谱系数据契约 | CA-OPEN-11 的梦境来源；记忆 Schema | P3 记忆 Schema 冻结前 | P3 前 |
| CA-OPEN-04 | OPEN | 聚合预算、内部刺激谱系、取消/硬超时/abort、不可取消 Handler 与物理关闭保护 | CA-OPEN-10 的睡眠中断；CA-OPEN-01 的调度契约 | P4/P5 调度；任何强制关闭/中止策略 | P4 前（与 P5 共用） |
| CA-OPEN-05 | OPEN | 意图/目标/任务/Thought 权威关系；`thought_threads` OCC 字段 | CA-OPEN-04 的调度；DATA-MODEL 受控修订 | P5 自主认知契约；`thought_threads` 并发写 | P5 前 |
| CA-OPEN-06 | OPEN | 情绪、关系、自我叙事、长期特质状态表示/版本/审计 | Data Model；Personality | P8 人格设计前 | P8 前 |
| CA-OPEN-07 | OPEN | Action Gateway 对账、幂等能力、未知结果、语义重复检测 | CA-OPEN-14 的边界；Action Gateway ADR | 首个真实外部动作前 | 外部动作前 |
| CA-OPEN-08 | OPEN | Model Gateway 调用契约、能力/配置/元数据、超时/重试/fallback | CA-OPEN-13 的 Provider/Embedding | 首个模型角色调用前；P3 若用模型则 P3 前 | P3 前（按首用） |
| CA-OPEN-09 | OPEN | 激活传播、抑制、衰减、Hub 控制、预算 | Memory Graph / Activation | P4 实现前 | P4 前 |
| CA-OPEN-10 | OPEN（同步前置已完成） | 睡眠阶段/调度/恢复/唤醒竞争/片段选择/检查点；`RUNTIME §8` 受控同步 | CA-OPEN-04 的 Handler/关闭契约；CA-OPEN-11 的片段选择执行者；CA-OPEN-02 的竞争 | P7 睡眠/唤醒编排前；R1.5 冻结前的同步条件已满足 | P7 前；文档同步已做 |
| CA-OPEN-11 | OPEN | 梦境生成者/体验者进程协议、隔离、虚拟执行器、片段选择执行者/候选/失败恢复 | CA-OPEN-10 的片段选择阶段；TRUST R4 | 梦境安全隔离门槛；醒后片段选择实现前 | P7 前 |
| CA-OPEN-12 | OPEN | 人格演化候选验证、版本化、回滚、锚点保护、审计 | CA-OPEN-06 的状态模型；Personality | P8 实现前 | P8 前 |
| CA-OPEN-13 | OPEN | Provider/模型独立配置、能力/fallback、Embedding 分离 | CA-OPEN-08 的 Model Gateway 契约 | 首次模型/Embedding 前；P3 若使用则 P3 前 | 与 08 同步（首用前） |
| CA-OPEN-14 | OPEN | Output Commit / Adapter Outbound Delivery；迟到输出、投递确认、恢复；R3 措辞 | CA-OPEN-07 的 Action 边界；Adapter SDK | 任何外部回应传输实现前 | 外部回应实现前 |
| CA-OPEN-15 | OPEN | 已提交 Event/status 的外部投影；P2 是否由 pull 改为 push；同步范围 | CA-OPEN-01 P2 子集；MODULES/OVERVIEW/PLAN/DATA-MODEL | P2 实时状态流设计/实现前 | 2（在 01 P2 子集之后） |

### 7.2 冻结/阶段结论

- **R1.5 冻结前必须解决的不是全部 OPEN**：R1.5 自己指定的硬前置是 CA-OPEN-10 的“确认拟议顺序并完成 RUNTIME §8 同步”。该前置已由 CA-DOC-01 合并满足；但 CA-OPEN-10 的细节决策仍 OPEN，不等于冻结前必须全部裁决。
- **R1.5 冻结前必须修正文档事实**：基线 SHA、旧同步陈述、G5/G6、版本字段冲突；这些是文档质量门，不是新架构裁决。
- **可以保留为明确 OPEN、不妨碍冻结**：CA-OPEN-02、03、04、05、06、07、08、09、11、12、13、14、15，只要范围、依赖和截止点清晰，且不把未决机制写成已决定。
- **P2 前必须完成**：CA-OPEN-01 的 P2 子集；CA-OPEN-15。不能先实现 push 再补决议。
- **P3 前必须完成**：CA-OPEN-03、08、13；若 P3 使用模型/Embedding，按 CA-OPEN-08/13；CA-OPEN-01 的 P3 子集在记忆提交器前。
- **P4/P5 前**：CA-OPEN-09（P4）、CA-OPEN-04（P4/P5）、CA-OPEN-05（P5）。
- **P7 前**：CA-OPEN-02、10、11。
- **P8 前**：CA-OPEN-06、12。
- **真实外部动作前**：CA-OPEN-07；**外部回应传输前**：CA-OPEN-14。

没有任何 CA-OPEN 在本报告中被关闭或重新定义。

---

## 8. 必须修订、建议修订、可以保持不变

### 8.1 必须修订（冻结前）

1. **R1.5 基线/状态**：L3、L6、L343、L443、L658、L706 更新到 CA-DOC-01 合并后的 `e4ea4ac...`，删除“RUNTIME §8 尚未同步”和旧 `DREAM_STOPPED` 描述。
2. **R1.5 §5.3 正常路径**：补第 8 步“进入 `AWAKE` / `SLEEPING`”，与 RUNTIME L655 的图一致。
3. **R1.5 §5.3 G5**：补控制面状态转移边界、已提交结果保留、未提交 `FRAGMENT_SELECTION` Proposal 失效、迟到结果禁止、不得等待执行中的选择/模型/Handler。
4. **R1.5 §5.3/§8.2 G6**：将梦境中断改为“若存在正在进行的梦境”；无条件保留跳过新的片段选择、不生成新的醒后片段。
5. **DATA-MODEL §6 版本表**：把“三个独立版本”修正为四类版本/纪元关系，补 `memory_nodes.content_epoch`，并明确 `intent_version` 仅属于 `action_records`。
6. **DATA-MODEL §6 规则 1**：把“任何写事务校验 base_version”限定为目标领域契约或逐表列出实际条件写；不得让 P1 看起来已有统一 OCC。
7. **CA-OPEN-15 同步清单**：补 `DATA-MODEL §7` 的“广播（WebSocket）”措辞，并明确当前 pull 与未来 push 的阶段边界。

### 8.2 建议修订（不改变已稳定设计）

1. R1.5 L45 把 `thought_threads` / `memory_edges` 的“基线”改为“DATA-MODEL 目标 Schema 设计字段”；同时明确 P1 迁移只有六表。
2. R1.5 §5.1 L390–L405 增加一段“当前 P1 实际版本/条件写”与“目标领域版本”的对照，避免读者把目标 CAS 当成已实现。
3. R1.5 §13 审阅重点补 G5/G6 和 CA-DOC-01 同步完成事实。
4. R1.5 的 CA-OPEN-10 行标注“同步前置完成，机制仍 OPEN”，不要写成 CA-OPEN-10 已关闭。
5. 可考虑在 R1.5 开头增加“本版状态：R1.5 草案，G1–G6 已处理；待负责人冻结”而不是“G1–G4”。

### 8.3 可以保持不变

- 4–6 个功能周期的动态计划（RUNTIME L631）。
- 唤醒分级：未唤醒、部分觉醒、完全觉醒、强制控制。
- 正常顺序中 `FRAGMENT_SELECTION` 先于清理、清理先于 `REALITY_ORIENTATION`。
- “选择前崩溃 → 丢弃未提交候选 → INTERRUPTED → 不生成碎片”语义。
- 强制控制物理关闭必须遵循 §3，不引入 force-kill/`process.exit()`。
- `actionId` 同意图重试复用、实质变更新建的规则。
- R1.5 的目标/实现分离总原则。
- “不把 Handler 取消/硬超时写成已实现”的限制。

---

## 9. R1.5 建议修订顺序

### 第 1 步：基线/状态清理

- 更新 L3、L6、L343、L443、L658、L706。
- 把“CA-DOC-01 已合并、RUNTIME §8 已同步”的事实写入 R1.5，但保持 R1.5 未冻结。
- 验收：全文不再出现 `43259b0c...`；不再声称 RUNTIME §8 尚未同步；不再引用旧 `DREAM_STOPPED` 图。

### 第 2 步：§5.3 正常路径/G5/G6

- 加第 8 步状态转换。
- 在强制控制段落补 G5 生效边界与已提交结果保留。
- 将梦境中断改成“若存在正在进行的梦境”。
- 验收：R1.5 §5.3 与 RUNTIME §8 的 8 步顺序逐项对应；文本含“已提交结果保留”“迟到结果不得提交”“不等待”和“若存在梦境”。

### 第 3 步：§8.2 交叉引用

- §8.2 不复制完整流程，但应明确强制控制走 §5.3，并交叉引用 G5/G6。
- 验收：§5.3 与 §8.2 没有第二套规则；`FRAGMENT_SELECTION` 清理顺序一致。

### 第 4 步：G2 版本/OCC 文档修正

- 修 DATA-MODEL §6 的四个概念与“任何写事务”范围。
- 在 R1.5 §0.1/§5.1 标明实际 P1 表与目标表。
- 验收：`state_version`、`epoch`、`content_epoch`、`intent_version` 四类都有唯一粒度；`thought_threads` 仍未定 OCC；没有新增字段。

### 第 5 步：G3 最小措辞

- 保留现有 `intent_version` 语义；在 DATA-MODEL §6 补“仅 action_records”限定；不新增 Intent 对象字段。
- 验收：R1.5、DATA-MODEL、IDENTITY 对“同意图复用/新意图新 actionId”无冲突。

### 第 6 步：G4 / CA-OPEN-15 受控决议（独立批次）

- 先由 CA-OPEN-15 裁决 P2 是否 push；不要在本次修订中直接改 pull。
- 同步 `MODULES §5`、`OVERVIEW §8`、`PLAN P2`、`DATA-MODEL §7`、R1.5 §5.1/§11/§13。
- 验收：pull/push 只有一个明确阶段承诺；`DATA-MODEL` 的“广播”不再被误读为当前实现。

### 第 7 步：R1.5 结论/审阅清单

- 更新 L706 的当前结论，加入 G5/G6 与 CA-DOC-01 同步完成。
- 更新 §13 审阅重点。
- 验收：R1.5 仍未冻结，但没有“同步未完成”的过期陈述；CA-OPEN 状态不被误写。

### 修订依据/影响/验收汇总

| 修订 | 依据 | 影响范围 | 验收标准 |
|---|---|---|---|
| 基线/状态 | CA-DOC-01 合并 | R1.5 顶部、§4.2.1、§5.3、§6.1、§11、§13 | 无旧 SHA、无“未同步”陈述 |
| 正常路径/G5/G6 | RUNTIME §8、CA-OPEN-10/11 | R1.5 §5.3、§8.2 | 8 步一致；条件梦境；已提交保留/未提交失效 |
| G2 版本 | DATA-MODEL、Migration、实际 Repository | DATA-MODEL §6、R1.5 §0.1/§5.1 | 四类版本清楚；无虚假 OCC |
| G3 intent | DATA-MODEL、IDENTITY、R1.5 | DATA-MODEL §6、R1.5 §6.1 | 同意图/新意图 actionId 规则无歧义 |
| G4 WS | PLAN、OVERVIEW、MODULES、DATA-MODEL、R1.5 | 四份权威 + R1.5 | CA-OPEN-15 未冒充已决；同步清单完整 |
| 目标表限定 | P1 Migration 六表事实 | R1.5 §0.1/§5.1 | 不把目标表写成当前表 |

---

## 10. 尚不能得出结论的事项

1. **R1.4 独立审查原始记录**：未找到文件；只能验证 R1.5 自述，不能独立确认 G1–G4 的历史闭环（N-02）。
2. **CA-OPEN-04 / 10 / 11 的具体机制**：未裁决；本报告不指定 fencing 字段、取消 API、超时、Handler 中止、片段选择执行者或失败恢复状态机。
3. **目标记忆/思维/动作表的实际写入行为**：`memory_*`、`thought_threads`、`action_records`、`dream_sessions` 尚无 Migration/Repository；不能验证目标 OCC、唯一约束或回执路径（N-03）。
4. **P2 push 的最终语义**：CA-OPEN-15 未决；不能确定是修改 `MODULES §5` 的 pull 语义、增加独立 push 通道，还是其他方案。
5. **R1.5 是否在本次修订后立即冻结**：由负责人裁决；本报告只证明同步前置完成，不构成冻结决议。
6. **本地 `main` 与 GitHub main 的本地引用差异**：本地 `main` 仍是 `43259b0c...`，但 `origin/main`/GitHub main 已是 `e4ea4ac...`；这是未切换分支导致的本地引用陈旧，不是远端基线漂移。报告使用了 GitHub/fetch 后的 main 内容。

---

## 11. 最终结论

- E0 调查完成；R1.5 仍是未冻结草案。
- CA-DOC-01 的 G5/G6 已进入 `main` 的 `RUNTIME-LIFECYCLE.md §8`。
- R1.5 的核心流程方向正确，但存在 **6 项 DRIFT、2 项 CONFLICT、3 项 OPEN、3 项 MISSING、2 项 NOT_VERIFIED**；另有 10 项 MATCH。D-08 已移出主统计，作为独立 F-01；包含 F-01 的全局统计为 27 项、DRIFT 7 项。
- 冻结前必须修正基线/旧同步陈述、G5/G6、正常路径第 8 步和 DATA-MODEL 版本/OCC 口径；不得在本批修改 R1.5。
- G4 的 pull/push 冲突应继续由 CA-OPEN-15 裁决，不能以文档修改代替架构决议。
- 本报告只读调查，不修改仓库、不创建分支/提交/PR。
