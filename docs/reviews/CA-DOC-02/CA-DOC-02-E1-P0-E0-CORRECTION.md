# CA-DOC-02 E1-P0 — E0 复核修正说明

**版本：** E1-P0.R1（2026-11-28；修正 R1.5 专项统计为 26，F-01 独立）
**状态：** 只读方案编制；不修改仓库；不修改 R1.5
**适用报告：** `F:\6\soul-harness-inputs\CA-DOC-02-E0-REPORT.md`
**作用：** 本说明是 E0 分类统计与四项语义的复核修订；E0 报告顶部已加修正横幅，R1.5 专项主统计为 26；本说明提供逐项依据。原 28 项统计仅作为修订前审计记录保留在说明中；包含独立 F-01 的全局统计为 27。

> **归档说明（PR #24）：** 本报告生成时没有创建仓库 PR；它是 E1-P0.R1 的原始只读复核文本。后续仅为归档与独立审查，才通过 PR #24 将副本加入 `docs/reviews/CA-DOC-02/`。归档 PR 不代表 WP-1/WP-2/WP-3 已实施。

---

## 1. 修正后的分类统计

| 分类 | 修正值 |
|---|---:|
| MATCH | 10 |
| DRIFT | 6 |
| CONFLICT | 2 |
| OPEN | 3 |
| MISSING | 3 |
| NOT_VERIFIED | 2 |
| **合计** | **26** |

**全局统计（含独立 F-01）：** MATCH 10 / DRIFT 7 / CONFLICT 2 / OPEN 3 / MISSING 3 / NOT_VERIFIED 2 = **27**。其中 R1.5 专项为 26 项，F-01 为独立项。

修正后明细构成：

- **MATCH 10**：M-01 至 M-10。
- **DRIFT 6**：D-01–D-04、D-06、D-07。
- **CONFLICT 2**：X-01、X-02。
- **OPEN 3**：O-01、O-02、O-03。
- **MISSING 3**：D-05、N-01、N-04。
- **NOT_VERIFIED 2**：N-02、N-03。

原 E0 统计为 MATCH 10 / DRIFT 8 / CONFLICT 2 / OPEN 3 / MISSING 3 / NOT_VERIFIED 2 / 合计 28。差异来自 D-08：它是独立仓库文档的 **后续修正项**，不再计入 R1.5 外部草案的 26 项发现。R1.5 专项为 26 项；包含 F-01 的全局统计为 27 项，其中 DRIFT 全局合计 7 项；详见 §4。

D-05 仍为 **MISSING**，只计入 MISSING 一次，不得同时计入 DRIFT。

---

## 2. X-02 重新评估

### 2.1 结论

X-02 保留为 **CONFLICT**，但应标注为“**跨阶段文档承诺冲突 / 待决歧义**”，不是“当前 pull 实现与未来 push 目标在技术上被证明互斥”。

### 2.2 事实

- 当前实现：WebSocket 是首帧认证后的 pull 快照；客户端只发送 `pull`，服务端返回 `snapshot`（`apps/soul-daemon/README.md` L211–L212；`ws-protocol.ts` L84–L105；`ws.ts` L139–L177）。
- 当前权威描述：`OVERVIEW.md` L124 与 `MODULES.md` L106 明确写为 pull，不是事件推送。
- P2 目标：`PLAN.md` L386 要求“WS 实时推送事件状态”；L122 写“实时推送”。
- `DATA-MODEL.md` L744 的“广播（WebSocket）”没有区分当前/未来，容易被读成现有 push。
- R1.5 L413 已把它标为 CA-OPEN-15，并明确不得把当前 pull 当作 P2 push 验收。

### 2.3 是否存在真正互斥的架构约束

没有证据证明 pull 与未来 push 在协议上必然互斥；可以通过新增 push 能力、同一连接同时支持 pull + push、或独立事件通道实现，具体方案尚未裁决。真正的问题是：

- 当前**实际实现/当前范围描述**是 pull；
- P2 **验收目标**要求 push；
- `MODULES §5` 与 `PLAN P2` 的措辞尚未被 CA-OPEN-15 统一；
- `DATA-MODEL §7` 的“广播”措辞未标明阶段。

因此这是 **文档/阶段语义未明确**，不是已证明的实现不可能性。CA-OPEN-15 继续 OPEN；本批不裁决 pull/push。

---

## 3. N-04：sessionId 纳入方案

R1.5 §6 身份表（L474–L480）列了 `personaId`、`eventId`、`threadId`、`runId`、`actionId`、`taskId`、`requestNonce`，但漏掉 `sessionId`。`IDENTITY-PROTOCOL.md` L31、L110–L120、L149 把 `sessionId` 定义为适配器交互窗口，`RUNTIME-LIFECYCLE.md` 也使用 `sessionId`。

推荐方案：**在 R1.5 §6 身份表直接增加一行 `sessionId`**，同时明确“权威定义见 IDENTITY-PROTOCOL.md §4.2”；不复制 IDENTITY 的完整规则，不引入新的 session 字段或身份语义。

理由：

1. 身份表是跨模块关联表，缺 `sessionId` 会使 Session → Event 关系不完整；
2. 直接引用 IDENTITY 可避免在 R1.5 另立会话生命周期；
3. 不新增状态、字段或权限语义。

验收：R1.5 §6 直接有 `sessionId` 行并引用 IDENTITY §4.2；不得自行定义 `externalSessionRef` 或新会话 ID。

---

## 4. D-08：IDENTITY-PROTOCOL.md 状态漂移的归属

### 4.1 事实

`IDENTITY-PROTOCOL.md` 仍存在过时陈述：

- L4：称 Ingress “Daemon 未装配”、Scheduler “Daemon 未装配”；
- L346：`tasks` 行称“Daemon 未装配”；
- L500：I03 称“无 HTTP，Daemon 未调用”；
- L502：I05 称“Daemon 未装配”。

当前 main 的事实是：

- SH-008E 的 E1–E5、AUDIT-001、E6 已装配 Persona Recovery、Runtime Recovery、Ingress、Scheduler；SH-008E 整批仍等待最终独立验收签署。
- SH-009 E1–E4、E5.P0、E5A 已实现本地 HTTP/WebSocket/Health；E5B 已提交，整批尚未验收。
- Ingress 仍无外部 transport，HTTP API 不是 Stimulus transport。
- 因此“未装配/无 HTTP”作为当前状态已不准确。

### 4.2 归属

D-08 **不计入 R1.5 外部草案的 26 项发现**，转为独立仓库文档修正项 **F-01**。理由：

- 它不是 R1.5 草案内部的偏差；
- 它属于 `docs/architecture/IDENTITY-PROTOCOL.md` 的权威文档状态；
- 不能在“修订 R1.5 外部草案”的批次中顺手修改仓库文档；
- 需要独立文件范围、独立基线和独立复审。

### 4.3 建议的准确措辞

建议将上述位置统一为：

> SH-008E 的 E1–E5、AUDIT-001、E6 已把 Persona Recovery、Runtime Recovery、Ingress、Scheduler 接入 Daemon；SH-008E 整批仍等待最终独立验收签署。SH-009 的本地 HTTP/WebSocket/Health 已实现，E5B 已提交；SH-009 整批尚未验收。Ingress 仍无外部 Stimulus transport；本地 HTTP API 是管理与状态查询接口，不是外部 Stimulus transport。

对于 I03/I05 等验收表行：

> 保留“整条验收未通过”的结论；只把“Daemon 未装配 / 无 HTTP”改为“Daemon 已装配，但 SH-008E/009 批次仍待最终验收；无外部 transport”。

不得写成 SH-008E/009 已整批验收通过。

### 4.4 后续任务

建议独立任务 `CA-DOC-02 E1-F01` 或等价的仓库文档修正批次，只改 `IDENTITY-PROTOCOL.md` 中与当前装配状态相关的句子；不改身份格式、生命周期规则、验收结论。该任务不阻塞 R1.5 的流程设计，建议在 R1.5 冻结前完成，但默认不是 R1.5 冻结的硬前置；不得用该独立任务取消 WP-3。

---

## 5. N-03：目标表未实现的性质

原 E0 将 N-03 标为 `NOT_VERIFIED`；该标签表示“无法从现有实现验证”，但必须进一步说明：

- P1 的 `0001_init_core.sql` 只创建 `personas`、`sessions`、`events`、`tasks`、`runtime_state`、`schema_migrations`；
- `memory_nodes`、`memory_edges`、`thought_threads`、`action_records`、`dream_sessions` 等目标表没有 Migration、Repository 或写入路径；
- 因此其 `state_version` / `content_epoch` / `intent_version` / OCC 行为 **尚未实现，无法做运行时验证**；
- 这不是“已实现但缺少证据”，也不是“验证通过”；
- 文档只能把它们写成目标 Schema / 未来实现，不能写成当前表已有字段。

N-03 保留在 `NOT_VERIFIED` 统计中，但性质是 **implementation-absent**，不是单纯的 evidence gap。不得用“等待补证据”替代“尚未实现”。

---

## 6. 对 E0 其他分类的影响

- D-05 保持 `MISSING`，不从 DRIFT 重复计数。
- X-01 保持 `CONFLICT`：`DATA-MODEL §6` 的“三个独立版本”漏掉 `memory_nodes.content_epoch`，与 `DATA-MODEL` L364 / `R1.5` L47 的四类不一致。
- N-01 保持 `MISSING`：CA-OPEN-15 的同步清单未列 `DATA-MODEL §7` 的广播措辞。
- N-02 保持 `NOT_VERIFIED`：未找到 R1.4 独立审查原始记录。
- O-01/O-02/O-03 保持 `OPEN`，不因本说明关闭。

---

## 7. 本说明未做的事

- 未修改任何仓库文件；
- 未修改 R1.5 原文件；
- 未创建分支、提交或 PR；
- 未关闭任何 CA-OPEN；
- 未决定 pull/push；
- 未修改 DATA-MODEL、IDENTITY-PROTOCOL.md 或 RUNTIME-LIFECYCLE.md。
