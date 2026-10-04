# 非遗学徒成长服务 · 领域说明

东城区把老字号大师工作室与技能学校课程接通后，学员从一次实训走到可申请岗位，会经过学校、工作室、用工企业和人才服务中心多个主体。本服务以**只追加的领域事件**统一串联：技艺谱系、课程版本、师徒关系、实训作品、工序能力、考核证据、津贴、试岗与去向。本文档与 `contracts/domain.schema.json`、`data/sample-lifecycle.json` 保持一致。

## 1. 基本约定

1. **事件不可原地改写**：事件一经接收，`event_id`、`occurred_at`、`version` 与载荷不再修改。业务更正通过携带 `correction_of_event_id` 的后继事件完成，原事件保留可查。
2. **同聚合版本单调**：同一 `aggregate_id` 上的 `version` 按接收顺序递增。
3. **接入必带追溯块**：所有事件（含线下补录）携带 `source`，回答“这条记录从哪来、原始凭证号是什么”。
   - `system`：`TALENT_CENTER` / `SKILL_SCHOOL` / `MASTER_STUDIO` / `EMPLOYING_ENTERPRISE` / `OFFLINE_BACKFILL`
   - `record_id`：来源系统原始记录号，线下补录填纸质凭证编号。
   - 补录额外要求 `entry_channel=OFFLINE_BACKFILL`、`batch_id`、`imported_at`；`occurred_at` 仍填业务实际发生时间，`imported_at >= occurred_at`。
4. **最小必要知情**：个人、机构与商业敏感信息只按职责读取；传统核心步骤技法细节不进入事件流（见第 5 节）。

## 2. 聚合与事件目录

| 聚合 | 含义 | 事件 |
|---|---|---|
| `lineage` | 技艺谱系（烧麦、人像摄影等），含受限核心步骤清单 | `LINEAGE_REGISTERED` |
| `curriculum_version` | 课程版本及其生效、替代关系 | `CURRICULUM_PUBLISHED`、`CURRICULUM_SUPERSEDED` |
| `master` | 大师工作室带教师傅与带教容量 | `MASTER_REGISTERED`、`MASTER_CAPACITY_UPDATED`、`MASTER_WITHDRAWN` |
| `apprenticeship` | 学徒成长档案主线 | `APPRENTICE_ENROLLED`、`APPRENTICE_SUSPENDED`、`APPRENTICE_RESUMED`、`APPRENTICE_TRANSFERRED`、`CREDIT_TRANSFERRED`、`PATHWAY_COMPLETED` |
| `mentorship` | 一段师徒关系（占用/释放师傅负荷） | `MENTORSHIP_ASSIGNED`、`MENTORSHIP_PAUSED`、`MENTORSHIP_RESUMED`、`MENTORSHIP_ENDED` |
| `practice_record` | 实训考勤 | `ATTENDANCE_MARKED` |
| `practice_work` | 实训作品 | `PRACTICE_WORK_SUBMITTED` |
| `competency_record` | 某工序能力档案 | `CORE_STEP_ATTESTED`、`COMPETENCY_ASSESSED` |
| `competency_review` | 多方评价分歧的复核 | `COMPETENCY_REVIEW_OPENED`、`COMPETENCY_REVIEW_DECIDED` |
| `assessment_evidence` | 考核证据（线上或线下补录） | `ASSESSMENT_EVIDENCE_ATTACHED` |
| `stipend` | 津贴发放/撤销 | `STIPEND_GRANTED`、`STIPEND_REVOKED` |
| `placement` | 企业试岗与录用 | `TRIAL_PLACEMENT_STARTED`、`TRIAL_PLACEMENT_EVALUATED`、`PLACEMENT_CONFIRMED` |

事件与聚合的强制归属关系在 `src/validator.js` 的 `EVENT_AGGREGATE` 中维护。

## 3. 成长主线

```
LINEAGE_REGISTERED ─ CURRICULUM_PUBLISHED ─ MASTER_REGISTERED
        │                    │                     │
APPRENTICE_ENROLLED ─ MENTORSHIP_ASSIGNED
        │                    │
 ATTENDANCE_MARKED / PRACTICE_WORK_SUBMITTED（学校学分 + 工作室实训同档）
        │
 CORE_STEP_ATTESTED（只记结论）─ COMPETENCY_ASSESSED（师傅/学校/企业多方）
        │                                   │分歧
        │                    COMPETENCY_REVIEW_OPENED → COMPETENCY_REVIEW_DECIDED
        │
 CREDIT_TRANSFERRED（休学/转项目/升版后的可转认范围）
        │
 STIPEND_GRANTED（幂等）─ TRIAL_PLACEMENT_STARTED → EVALUATED → PLACEMENT_CONFIRMED
        │
 PATHWAY_COMPLETED（培训投入 → 合格上岗闭环）
```

## 4. 多方评价与复核（能力认定规则）

- `ATTENDANCE_MARKED` **只形成考勤**，任何一次打卡、作品提交或单方评价都不得自动得出能力认定。
- `COMPETENCY_ASSESSED` 携带师傅（MASTER）、学校（SCHOOL）、用工企业（ENTERPRISE）的评价，结果取 `PASS` / `FAIL` / `CONDITIONAL`。
- 评价结果不一致（含 `CONDITIONAL`）时状态为 `DIVERGENT`，由人才服务中心 `COMPETENCY_REVIEW_OPENED` 受理，证据以 `ASSESSMENT_EVIDENCE_ATTACHED` 归档；即使各方一致，也停留在 `ASSESSED_UNANIMOUS_PENDING_CONFIRM`，须经确认环节。
- 复核结论可以**限定范围认定**：`PASS_WITH_SCOPE` 同时写清 `recognized_scope` 与 `excluded_scope`（样例：门店常规出品节拍有效、量产高速节拍待复评）。能力终态为 `RECOGNIZED_WITH_SCOPE`。

## 5. 受限核心步骤

烧麦走槌擀皮、传统修稿等未获准公开的技法：

- 只用 `CORE_STEP_ATTESTED` 记录**完成结论**（`COMPLETED` / `NOT_COMPLETED` / `WAIVED`）与**保管位置** `vault_location`、保管人 `custodian_id`。
- 载荷中禁止出现手法、配方、参数等字段（校验器枚举 `recipe`、`formula`、`parameters`、`method_detail`、`secret_knack`、`technique_detail` 并拒收）。
- 学徒转项目时，受限核心步骤的成绩**不带出原工作室**；`CREDIT_TRANSFERRED.not_recognized` 须写明原因。
- 企业视图（`enterpriseView`）只返回能力终态与认定范围，不含保管位置、保管人、原始评语和证据存放点。

## 6. 成绩保留与可转认

中途休学、转项目、师傅退出、课程标准升级均**不删除既往成绩**，而是通过事件明确可转认范围：

- **休学/复课**：`APPRENTICE_SUSPENDED` + `MENTORSHIP_PAUSED`（释放负荷）；复课时 `APPRENTICE_RESUMED` + `MENTORSHIP_RESUMED`（重新占用负荷）。考勤、作品、复核结论原样保留。
- **转项目**：`APPRENTICE_TRANSFERRED` 先结束原师门（`MENTORSHIP_ENDED`），再指派新师门；`CREDIT_TRANSFERRED` 用 `recognized`（可转认内容与范围，如仅通识学分 `general_only`）与 `not_recognized`（不转认项及原因）登记。
- **师傅退出**：先结束名下全部师徒关系并释放名额，再 `MASTER_WITHDRAWN`；接续师门在 `MENTORSHIP_ASSIGNED.payload.succeeding_mentorship_id` 指向前一段，既往复核结论继续有效。
- **课程升版**：发布 `CURRICULUM_PUBLISHED` 新版本后，以 `CURRICULUM_SUPERSEDED` 附 `credit_transfer_map` 替代旧版；学徒用 `CREDIT_TRANSFERRED` 逐模块登记全额、部分或不予转认（如新增控制点须补修）。

## 7. 津贴幂等

- `STIPEND_GRANTED` 必须携带 `dedupe_key`，建议规则 `stipend:{apprentice_id}:{period}:{purpose}`。
- 线上名册与线下纸质签收补录共用**同一去重键空间**；校验器在事件流层拦截重复 `dedupe_key` 与重复来源凭证（`system + record_id`），投影层也不会重复累加金额。
- 发放有误时发 `STIPEND_REVOKED` 冲正，不修改原事件。

## 8. 师傅带教负荷

- 容量来自 `MASTER_REGISTERED.capacity`，可由 `MASTER_CAPACITY_UPDATED` 调整。
- `MENTORSHIP_ASSIGNED` 占用（`load_delta=+1`），`PAUSED` / `ENDED` 释放（-1），`RESUMED` 重新占用。投影校验：占用后不得超过容量、释放不得变为负数、已退出师傅不得再接收学徒、一个学徒同时只能有一段未结束师徒关系。

## 9. 试岗与录用

`TRIAL_PLACEMENT_STARTED` → `TRIAL_PLACEMENT_EVALUATED`（企业评价）→ `PLACEMENT_CONFIRMED`。正式录用的前置条件：存在试岗评价且结果为 `PASS`；评价不合格不得直接录用。`PATHWAY_COMPLETED` 以正式录用为前提，标志从一次实训到上岗的路径闭环。

## 10. 查询口径

- **学员/师傅/学校**：按学徒档案聚合视图查看完整谱系、成绩、证据索引与津贴记录（受限内容仅见结论与保管位置）。
- **企业**：`enterpriseView` 仅见能力结论、认定范围与试岗状态。
- **管理部门**：`trainingInvestmentReport` 按学徒汇总津贴投入、已认定工序数、试岗/录用状态与 `qualified_for_post`，回答“培训投入是否形成合格上岗”。

## 11. 本地校验

```bash
node --test
```

`src/validator.js` 负责结构与事件流不变量；`src/projection.js` 负责把事件折叠为当前状态并执行业务规则（负荷、幂等、状态流转、脱敏视图、投入产出报表）。
