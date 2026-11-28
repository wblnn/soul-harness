# CA-DOC-02 E1-P0 — R1.5 修订方案

**版本：** E1-P0.R1（2026-11-28；修订分类统计、WP-1 P1 写入边界、WP-3 冻结依赖与 sessionId 方案）
**状态：** 只读调查与方案编制；不执行修改；R1.5 未冻结
**基线：** `wblnn/soul-harness` `main` = `e4ea4acc862b382868f9b26a17ecf7e087bf219a`
**外部草案：** `F:\6\soul-harness-inputs\COGNITIVE-ARCHITECTURE-R1.5.md`
**草案 SHA-256：** `227d315df8fe1a9e787a93e4657ddce4224b26614bc2fec843ff9480a8cdf26b`
**E0 修正说明：** `F:\6\soul-harness-inputs\CA-DOC-02-E1-P0-E0-CORRECTION.md`

---

## 1. 固定前置与只读证明

### 1.1 身份核对

| 项目 | 实际值 |
|---|---|
| GitHub `main` | `e4ea4acc862b382868f9b26a17ecf7e087bf219a` |
| `origin/main` | `e4ea4acc862b382868f9b26a17ecf7e087bf219a` |
| 本地当前 HEAD | `aeb68c4108bdae6828e45e11809273b015bce338`（PR #23 head；当前 checkout 分支） |
| 当前分支 | `docs/ca-r1.5-lifecycle-sync` |
| 本地 `main` | `43259b0c9435d72f1798fc07463a001bb4ca032c`（未切换的陈旧本地引用；不影响 fixed main 核对） |
| 工作区 | `git status --porcelain` 为空 |
| R1.5 大小 / 行数 | `66,094` bytes / `706` lines |
| R1.5 SHA-256 | `227d315df8fe1a9e787a93e4657ddce4224b26614bc2fec843ff9480a8cdf26b` |

R1.5 摘要一致，文件存在。未修改、未覆盖、未加入 Git。

### 1.2 只读边界

本批：

- 不修改任何仓库文件；
- 不修改 R1.5 外部草案；
- 不创建分支、commit、PR；
- 不修改 Runtime、Contracts、Persistence 源码；
- 不新增数据库字段或 Migration；
- 不关闭或重新定义任何 CA-OPEN；
- 不决定 CA-OPEN-15 的 pull/push；
- 不称 R1.5 已冻结。

---

## 2. E0 修正摘要

按 `CA-DOC-02-E1-P0-E0-CORRECTION.md`：

| 分类 | 修正值 |
|---|---:|
| MATCH | 10 |
| DRIFT | 6 |
| CONFLICT | 2 |
| OPEN | 3 |
| MISSING | 3 |
| NOT_VERIFIED | 2 |
| **合计** | **26** |

R1.5 范围内 26 项；另加独立 F-01（D-08）后，整体审计为 27 个事项。全局统计中 MATCH 10 / DRIFT 7 / CONFLICT 2 / OPEN 3 / MISSING 3 / NOT_VERIFIED 2 = 27。

关键调整：

- D-05 只计 `MISSING`，不再被误计为 DRIFT；修正后 DRIFT 为 D-01–D-04、D-06、D-07（6 项）。
- D-08（IDENTITY 状态漂移）不属于 R1.5 26 项，转为独立仓库文档任务 F-01；包含 F-01 的全局统计为 27 项、DRIFT 7 项。
- X-02 保留 `CONFLICT`，但定性为“当前 pull 与 P2 push 的跨阶段文档承诺冲突 / 待决歧义”，不声称技术互斥；CA-OPEN-15 仍未决。
- N-04 纳入 R1.5 身份表修订。
- N-03 明确为“目标表未实现，无法运行时验证”，不是“已实现仅缺证据”。

---

## 3. 方案原则

1. **最小必要修改**：不借修订重设计已稳定的模块、状态机和身份协议。
2. **分开批次**：DATA-MODEL §6、R1.5 外部草案、IDENTITY 状态漂移分别处理，不把所有文档塞进一个提交。
3. **不裁决 OPEN**：CA-OPEN-05/10/15 等只记录状态，不替负责人决定。
4. **目标与实现分开**：P1 六表与未来目标 Schema 必须显式区分。
5. **不新增字段**：不新增 `state_version` 到 `thought_threads`，不改 Migration。
6. **R1.5 冻结不由本方案宣布**：本方案只定义使 R1.5 可进入冻结审查的文档条件。

### 3.1 E0 复核修正在方案中的落点

- **X-02**：保留为跨阶段文档承诺冲突/待决歧义；不证明 pull 与未来 push 技术互斥，也不在方案中决定 pull/push；归 CA-OPEN-15（WP-4）。
- **N-04**：进入 WP-2，R1.5 §6 直接补 `sessionId` 行并引用 IDENTITY §4.2。
- **D-08**：移出 R1.5 的 26 项统计，作为独立仓库任务 WP-3（F-01）；不在 R1.5 修订中顺手改 IDENTITY。
- **N-03**：在 WP-1/WP-2 明确目标表未实现、无法运行时验证；不得写成仅缺少证据或已通过。
- **D-05**：保持 MISSING，补入 WP-2 的 G5 修订；不重复计入 DRIFT。

---

## 4. 任务切分与依赖

### WP-1 — DATA-MODEL §6 仓库文档修正

| 项 | 内容 |
|---|---|
| 文件范围 | 只改 `docs/architecture/DATA-MODEL.md` §6「版本与纪元」；必要时只加 §6 内说明，不改表定义、不改 §7 |
| 固定基线 | `e4ea4ac...` |
| 依赖 | 无前置；先于 R1.5 外部草案的最终版本描述 |
| 是否阻塞 R1.5 冻结 | 是（R1.5 不应引用错误的版本/OCC 口径） |
| 独立复审 | 必须；文档审阅人需核对 P1 实际表与目标领域定义 |
| 不得改变 | 不新增字段、不新增 Migration、不给 `thought_threads` 指定 OCC、不弱化目标 `base_version` 规则 |

**P1 实际写入边界（必须写准，不得笼统声称所有写入都是 CAS）：**

- `personas`：当前 P1 列名是 `version`，不是 `state_version`；`compareAndSetState` / `commitLifecycle` 使用 `state + version` 条件写；`updateState` 按 `id` 更新并递增 `version`，不比较预期状态/版本，E0 报告称当前没有调用者。文档必须分别描述这些 API，不能把 `personas` 的所有写入写成 CAS。
- `runtime_state`：checkpoint 保存路径在事务中比较 `runtime_state.epoch` 与输入 epoch；`runtime-state.ts` 的通用 `upsert()` 没有 CAS，会按冲突更新 epoch 等字段。checkpoint 的 epoch 检查不等于整个 `runtime_state` Repository 具备统一 OCC。
- `sessions`：区分 `ux_sessions_external` 部分唯一索引、`closed_at IS NULL` 有效会话谓词，以及关闭操作的 `persona` / `closed_at` 条件；不是版本 CAS。
- `events`：不同操作使用 `status` / `archive_state` 条件；没有 `state_version`。
- `tasks`：不同操作使用 `state` / `run_id` / `attempt` 等谓词；不能称为 `state_version` CAS。
- 未实现目标表：`memory_*`、`thought_threads`、`action_records`、`dream_sessions` 不列入 P1 实际写入能力。
- `thought_threads` 的目标 Schema 确实有 `epoch`，但不能直接等同 Persona `epoch`；不得自行确定 OCC 语义，不得新增 `state_version`；其并发契约仍归 CA-OPEN-05。
- 四类概念仍按 `state_version` / Persona `epoch` / `memory_nodes.content_epoch` / `action_records.intent_version` 修订；明确当前 P1 `personas.version` 与目标 `state_version` 的命名区别；保留目标 `base_version` 规则，但不得据此提前裁决 CA-OPEN-05。

**具体修订点：**

1. 将 §6 的“三个独立版本”扩展为完整的四类概念说明：
   - `state_version`：目标实体/记录的乐观并发版本；不是所有表都已具备；
   - Persona `epoch`：人格级内容纪元/恢复下限；
   - `memory_nodes.content_epoch`：节点级内容/索引新旧；
   - `action_records.intent_version`：动作记录的意图版本。
2. 明确 `intent_version` 只属于 `action_records`，不是所有认知实体或所有 Intent 对象的通用字段。
3. 保留目标 `base_version` 规则，但增加“目标领域契约”限定；不得删除或弱化。
4. 增加 P1 实际条件写表；按上方“P1 实际写入边界”逐项列出，不能写成统一的 `state_version` CAS。
5. 把 `thought_threads` 的 OCC 明确留给 CA-OPEN-05，不写新字段名。
6. 不修改 §7 的 WebSocket 广播措辞（留给 WP-4 / CA-OPEN-15）。

**验收标准：**

- §6 同时出现四类概念，且各自作用域不混用；
- `intent_version` 明确标注仅 `action_records`；
- P1 五个实际条件写表与源码/迁移一致；
- 未新增字段或 Migration；
- 目标 `base_version` 规则仍存在；
- `thought_threads` 的 OCC 仍为 OPEN；
- 独立复审通过。

---

### WP-2 — R1.5 外部草案修订

| 项 | 内容 |
|---|---|
| 文件范围 | 仅 `F:\6\soul-harness-inputs\COGNITIVE-ARCHITECTURE-R1.5.md` |
| 固定基线 | `e4ea4ac...`；以 CA-DOC-01 合并后的 RUNTIME §8 为准 |
| 依赖 | WP-1 的版本口径；CA-DOC-01 已完成；WP-3 可并行，建议冻结前完成，但默认不是 R1.5 冻结的硬前置 |
| 是否阻塞 R1.5 冻结 | 是（这是 R1.5 自身修订） |
| 独立复审 | 必须；按 R1.5 §13 审阅清单逐项复跑 |
| 不得改变 | 不决定 CA-OPEN-05/10/11/15；不引入新状态枚举；不把目标写成已实现；不修改仓库 |

**具体修订点：**

1. **基线/状态**：把 L3、L6、L343 的基线更新为 `e4ea4ac...`；把 L15 的 G1–G4 修订说明更新为 G1–G6（或“G5/G6 已处理，待复核”），保留“R1.5 未冻结”。
2. **RUNTIME §8 同步事实**：删除 L443 的旧 `DREAM_STOPPED` 图和“文字没有插入片段选择”的陈述；改为“RUNTIME §8 已由 CA-DOC-01 同步；本节与其 8 步顺序一致”。删除 L706 的“同步前仍是拟议修订”旧结论，保留未冻结结论。更新 L658 的 CA-OPEN-10 状态为“同步前置完成，机制仍 OPEN”。在 §8.2 L571–L577 增加对 §5.3 与 G5/G6 的交叉引用，不复制第二套规则；并把正常路径的最终 AWAKE/SLEEPING 转换与 §5.3 第 8 步保持一致。
3. **正常路径第 8 步**：在 L445–L456 的 1–7 步后补第 8 步“进入 `AWAKE` / `SLEEPING`”，与 RUNTIME L655 一致。
4. **G5**：在强制控制段落（L439 附近）补：
   - 控制面状态转移构成强制控制生效边界；
   - 边界前已成功持久提交的 `FRAGMENT_SELECTION` 结果保留；
   - 边界到达时尚未成功持久提交的 Proposal 失去提交资格；
   - 迟到结果不得越过边界提交；
   - 不等待正在执行的片段选择、模型 Proposal 或 Handler；
   - 不定义 fencing 字段、取消 API、超时、Handler 中止算法。
5. **G6**：把梦境中断改为“若存在正在进行的梦境，则以 `INTERRUPTED` 收束”；无条件保留“跳过新的片段选择 / 不生成新的醒后片段”。
6. **P1 六表 vs 目标 Schema**：在 §0.1 L45 和 §5.1 L390–L405 附近明确：当前 P1 只有六表；`memory_*`、`thought_threads`、`action_records`、`dream_sessions` 是目标 Schema，不是当前列；目标 OCC 行为不可做运行时验证。
7. **版本/纪元**：按 WP-1 的四类概念修正，不决定 `thought_threads` 的 OCC 字段。
8. **actionId**：保留 L42、L490 的“同意图重试复用，新意图/`intentVersion` 递增分配新 `actionId`”语义；不新增字段。
9. **sessionId**：在 §6 身份表 L474–L480 直接增加一行 `sessionId`，同时明确“权威定义见 IDENTITY-PROTOCOL.md §4.2”；不得复制会话生命周期，不引入新的 session 字段或身份语义。
10. **WebSocket 广播**：在 §5.1 L413 附近保留当前 pull 事实；把 `DATA-MODEL §7` 的“广播（WebSocket）”明确列入 CA-OPEN-15 的同步范围，或明确它是未来目标；不得决定 pull→push。
11. **CA-OPEN-10**：标注“RUNTIME §8 同步前置已完成；具体阶段/选择/失败恢复机制仍 OPEN”。
12. **审阅重点/结论**：更新 §13 与 L706，加入 G5/G6、CA-DOC-01 同步完成、D-05/N-04；保留 CA-OPEN-01/10/15 等 OPEN，不宣称冻结。

**验收标准：**

- 全文无 `43259b0c...` 基线；
- 无“RUNTIME §8 尚未同步”/旧 `DREAM_STOPPED` 陈述；
- 正常路径 1–8 与 RUNTIME §8 图/文字一致；
- G5 的边界/保留/失效/迟到/不等待全部出现；
- G6 条件梦境 + 无条件跳过新片段；
- P1 六表/目标 Schema 有明确边界；
- §6 直接有 `sessionId` 行并引用 IDENTITY §4.2；
- 不新增状态/字段/API；
- R1.5 仍明确未冻结；
- 独立复审通过。

---

### WP-3 — IDENTITY-PROTOCOL.md 状态漂移修正（F-01）

| 项 | 内容 |
|---|---|
| 文件范围 | 只改 `docs/architecture/IDENTITY-PROTOCOL.md` 的当前状态/验收说明：L4、L346、L500、L502 及相关同义句 |
| 固定基线 | `e4ea4ac...` |
| 依赖 | 无前置；可与 WP-1 并行；建议在 R1.5 冻结前完成，但默认不是硬前置 |
| 是否阻塞 R1.5 冻结 | 默认否；这是独立仓库文档卫生修正，建议冻结前完成，但不作为 R1.5 冻结硬门槛 |
| 独立复审 | 必须；需要核对 SH-008E/009 的批次状态，不得写成已整批验收 |
| 不得改变 | 身份格式、生命周期规则、`sessionId` 语义、验收结论的“未通过/部分”状态；不得改源码 |

**建议措辞：**

> SH-008E 的 E1–E5、AUDIT-001、E6 已把 Persona Recovery、Runtime Recovery、Ingress、Scheduler 接入 Daemon；SH-008E 整批仍等待最终独立验收签署。SH-009 的本地 HTTP/WebSocket/Health 已实现，E5B 已提交；SH-009 整批尚未验收。Ingress 仍无外部 Stimulus transport；本地 HTTP API 是管理与状态查询接口，不是外部 Stimulus transport。

I03/I05 的验收结论保留“整条未通过”，只修正“Daemon 未装配 / 无 HTTP”状态句。

**验收标准：**

- 不再出现“Daemon 未装配”或“无 HTTP，Daemon 未调用”；
- 不把 SH-008E/009 写成整批验收通过；
- 保留“无外部 transport”和“验收未通过”事实；
- 仅改状态句，不改变身份规则；
- 独立复审通过。

---

### WP-4 — CA-OPEN-15 的受控同步（未来、条件性）

| 项 | 内容 |
|---|---|
| 文件范围 | `MODULES.md §5`、`OVERVIEW.md §8`、`PLAN.md` P2（L122/L386）、`DATA-MODEL.md §7`、R1.5 §5.1/§11/§13 |
| 固定基线 | CA-OPEN-15 裁决时的 main；不是本批 |
| 依赖 | CA-OPEN-15 ADR；先消费 CA-OPEN-01 P2 子集 |
| 是否阻塞 R1.5 冻结 | 否；可保留 OPEN，但不得把当前 pull 写成 P2 push 已完成 |
| 是否阻塞 P2 | 是 |
| 独立复审 | 必须；ADR 与所有同步文档一起审 |
| 不得改变 | 不预先决定 pull 或 push；不在本批修改 |

---

### WP-5 — R1.5 冻结裁决（不是文档实施批次）

| 项 | 内容 |
|---|---|
| 文件范围 | 无（负责人裁决/记录） |
| 依赖 | WP-1、WP-2 完成；WP-3 建议完成但不硬性阻塞；CA-OPEN-15 可保持 OPEN |
| 是否阻塞 | 由负责人决定；本方案不宣布冻结 |
| 验收 | R1.5 无旧基线/旧同步陈述；G5/G6 完整；OPEN 状态真实；负责人明确签署 |

---

## 5. 依赖关系与执行顺序

### 5.1 推荐顺序

1. **WP-1**（DATA-MODEL §6）——先确定四类版本/实际 P1 口径。
2. **WP-3**（IDENTITY 状态修正）——可与 WP-1 并行；不依赖 WP-1。
3. **WP-2**（R1.5 外部草案）——引用 WP-1 的版本口径；WP-3 可并行，建议冻结前完成，但不是硬前置。
4. **独立复审**——WP-1/WP-3 可分别复审；WP-2 最后复审。
5. **WP-5**——负责人冻结裁决；保留所有未决 OPEN。
6. **WP-4**——只在 CA-OPEN-15 真正裁决后进行，可晚于 R1.5 冻结。

### 5.2 必须 / 可独立 / 不阻塞

- **必须先完成**：WP-1 的版本/实现边界，WP-2 的 G5/G6/第 8 步/旧基线清除。
- **可独立进行**：WP-1 与 WP-3 并行；WP-2 起草可在 WP-1 完成前开始，但最终文本必须引用 WP-1 结果。
- **不阻塞 R1.5 冻结**：WP-4（CA-OPEN-15 仍未决）、CA-OPEN-02/03/04/05/06/07/08/09/11/12/13/14 的具体机制，只要明确标 OPEN；WP-3 默认也属于不硬性阻塞项。
- **建议但不硬性阻塞 R1.5**：WP-3 的 IDENTITY 状态修正；应独立执行和复审，但不作为 R1.5 冻结硬门槛。

### 5.3 为什么不能合并为一个大批次

- DATA-MODEL §6 是**仓库权威文档**，需要独立基线/复审；
- R1.5 是**外部未冻结草案**，修改不进入仓库 Git；
- IDENTITY 是**另一个仓库权威文档**，不能借 R1.5 修订顺带修改；
- CA-OPEN-15 是**未决架构裁决**，不能用文档批次代替；
- 分开可以避免把“文档事实修正”和“架构裁决”混成一个不可审查的提交。

---

## 6. 每个批次的统一交付/复审门槛

所有 WP 都必须：

1. 记录 fixed baseline（仓库任务为 `e4ea4ac...`；R1.5 为外部 hash）；
2. 只改声明的文件/章节；
3. 保留现有状态枚举、字段、Schema、API；
4. 不把目标写成已实现，不把部分验收写成通过；
5. 提供 before/after diff、行号、`git diff --check`（仓库任务）或文本 diff（外部草案）；
6. 由独立复审确认语义；
7. 复审前不合并、不冻结。

---

## 7. 拟议修改文件清单

本批**不修改**以下任何文件，仅列出未来批次拟议范围：

| 批次 | 文件 | 性质 |
|---|---|---|
| WP-1 | `docs/architecture/DATA-MODEL.md` §6 | 仓库权威文档 |
| WP-2 | `F:\6\soul-harness-inputs\COGNITIVE-ARCHITECTURE-R1.5.md` | 外部未冻结草案 |
| WP-3 | `docs/architecture/IDENTITY-PROTOCOL.md` 状态句 | 仓库权威文档 |
| WP-4（未来） | `docs/architecture/MODULES.md §5`、`OVERVIEW.md §8`、`PLAN.md` P2、`DATA-MODEL.md §7`、R1.5 | 仅 CA-OPEN-15 裁决后 |
| WP-5 | 无文件（负责人冻结记录） | 裁决 |

不需要修改 `RUNTIME-LIFECYCLE.md`：CA-DOC-01 已把 §8 同步到当前 main，且 G5/G6 已落地。

---

## 8. 尚不能解决的问题

1. **CA-OPEN-15 pull/push**：未决；本方案不选择方案、不关闭。
2. **CA-OPEN-01 P2 子集**：未决；CA-OPEN-15 的外部语义需其先行。
3. **CA-OPEN-10 具体机制**：同步前置已完成，但阶段、片段选择执行者、失败/恢复、重试仍 OPEN；不得把“同步完成”写成“CA-OPEN-10 关闭”。
4. **CA-OPEN-05 `thought_threads` OCC**：未决；不得新增 `state_version` 或指定字段。
5. **R1.4 独立审查原始记录**：未找到；只能验证 R1.5 自述。
6. **目标表实际 OCC**：`memory_*`、`thought_threads`、`action_records`、`dream_sessions` 尚未实现，无法运行时验证。
7. **R1.5 是否冻结**：由负责人决定；本方案不宣布冻结。

---

## 9. 本批没有修改任何文件

- 仓库工作区：干净；
- Git：无新分支、无 commit、无 PR、无 `main` 推进；
- R1.5：未修改，SHA 仍为 `227d315...`；
- 源码/测试/Schema/Migration/配置/其他文档：未修改；
- 仅生成本方案与 E0 修正说明两份仓库外文件。

---

## 10. 结论

R1.5 可以在不关闭所有 CA-OPEN 的前提下进入冻结审查，但必须先完成：

1. WP-1 的 DATA-MODEL §6 版本/实现边界修正；
2. WP-2 的 R1.5 基线、G5/G6、第 8 步、P1/目标表边界、sessionId、CA-OPEN 状态修正；
3. WP-3 的 IDENTITY 状态漂移修正（独立仓库任务；建议完成，但不是 R1.5 冻结硬前置）。

CA-OPEN-15 与 CA-OPEN-10 的机制仍保持 OPEN；R1.5 未冻结。
