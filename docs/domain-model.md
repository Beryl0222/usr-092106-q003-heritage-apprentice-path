# 非遗学徒成长服务 · 领域模型

东城区老字号大师工作室与技能学校课程接通后，本服务为人才服务中心与管理部门
提供一份贯穿「报名 → 实训 → 认定 → 津贴 → 试岗 → 就业」的共同记录，
串联技艺谱系、课程版本、师徒关系、实训作品、工序能力、考核证据、津贴、
试岗与去向九类信息。

## 追溯字段（事件信封）

所有接入记录——学校系统、工作室、企业与线下补录——沿用同一事件信封
（`contracts/domain.schema.json`）：

| 字段 | 含义 |
| --- | --- |
| `event_id` | 全局唯一事件标识，重复即拒收（幂等） |
| `event_type` / `aggregate_type` / `aggregate_id` | 事件类型与作用对象 |
| `occurred_at` | 业务发生时间；补录填原始发生时间 |
| `version` | 同一聚合内从 1 起严格递增；补录同样顺延 |
| `summary` / `payload` | 中文摘要与业务内容 |

事件一经接收不原地改写，业务更正（如津贴金额错误）以后继事件表达。
被拒收的事件不留下任何痕迹，接入方可修正后按原版本号重发。

聚合标识约定：能力记录 `comp:<学员>:<工序>`，津贴台账
`allowance:<学员>:<期间>:<项目>`，试岗 `placement:<学员>`。

## 聚合与事件目录

| 聚合 | 事件 | 说明 |
| --- | --- | --- |
| `craft_lineage` | `LINEAGE_REGISTERED` | 登记谱系、工序分级（open/restricted）与师傅带教容量 |
| `curriculum_version` | `CURRICULUM_PUBLISHED` / `CURRICULUM_SUPERSEDED` | 发布课程标准；升级时给出可转认范围 |
| `apprenticeship` | `APPRENTICE_ENROLLED` / `SUSPENDED` / `RESUMED` / `TRANSFERRED`、`CREDIT_TRANSFERRED`、`EMPLOYMENT_OUTCOME_RECORDED` | 学徒档案主线：报名、休复学、转项目、学分转认、去向 |
| `mentorship` | `MENTORSHIP_ESTABLISHED` / `MENTORSHIP_ENDED` | 师徒关系建立与结束（含师傅退出），驱动带教负荷 |
| `practice_work` | `PRACTICE_RECORDED` | 实训作品（打卡类记录，不单独构成认定） |
| `competency_record` | `EVALUATION_SUBMITTED` / `COMPETENCY_REVIEWED` | 多方评价与认定/复核裁定 |
| `allowance_ledger` | `ALLOWANCE_ISSUED` | 津贴发放台账，按标识去重 |
| `placement` | `TRIAL_PLACEMENT_STARTED` / `PLACEMENT_CONFIRMED` | 试岗与正式录用 |

各事件 payload 必填字段见 `src/events.js` 的 `EVENT_CATALOG`，
该目录与契约枚举由测试保证同步。

## 关键规则（不变量）

1. **能力认定不自动得出**：`COMPETENCY_REVIEWED` 必须基于已提交的评价证据；
   无分歧时至少两方（师傅/学校/企业）评价通过方可认定；单次打卡或实训
   记录（`PRACTICE_RECORDED`）不构成评价。
2. **分歧须复核**：任何一方评价未通过即进入分歧状态，认定须以
   `review: true` 的复核裁定作出。
3. **受限工序只记结论与保管位置**：谱系中 `disclosure: restricted` 的
   传统核心工序，其事件不得携带 `evidence_refs` / `technique_detail` /
   `media_refs`，必须记录 `custody_ref`（考核材料保管位置）；认定时还须
   给出完成结论 `conclusion`。技法细节不进系统，换师门时也就无从带出。
4. **津贴去重**：台账以 `allowance:<学员>:<期间>:<项目>` 为标识，同一标识
   只发放一次；线下补录（`backfilled: true`）须在 `source_ref` 注明原始
   凭证，且同样受去重约束，不得重复发放。
5. **带教负荷随关系变化**：建立师徒关系占用师傅名额（容量在谱系登记时
   声明，默认 3），休学、转项目、师傅退出或关系结束时释放；复学重新
   占用，容量不足即拒。
6. **既往成绩保留**：休学、转项目、师傅退出、课程标准升级均不删除历史
   记录；升级时以 `transfer_map` 明确可转认范围（full/partial/none），
   范围为 none 的课程项不得转认，须按新标准重新考核。
7. **就业路径完整**：登记 `employed` 去向前须先试岗并确认录用。

## 角色视图

| 信息 | 师傅 | 学校 | 用工企业 | 人才服务中心/管理部门 |
| --- | --- | --- | --- | --- |
| 公开工序能力记录 | ✔ | ✔ | ✔ | ✔ |
| 受限工序完成结论 | ✔ | ✔ | ✔（仅结论） | ✔ |
| 受限工序保管位置与评价细节 | ✔ | ✔ | ✘ | ✔ |
| 津贴台账 | ✔ | ✔ | ✘ | ✔ |
| 全区汇总报表 | — | — | — | ✔（`regulatorSummary`） |

实现见 `src/views.js`。企业据此核验「可申请岗位」所需结论，但接触不到
任何受限技法细节。

## 线下补录约定

补录记录使用同一信封：`occurred_at` 填原始业务时间，`version` 照常顺延，
`payload.backfilled: true` 并附 `source_ref` 原始凭证号。事件标识与台账
标识的去重对线上线下一体生效，保证补录不会重复发放津贴或篡改历史。

## 样例

`data/sample-flow.json` 演示完整主线：谱系登记 → 标准发布 → 报名 →
拜师 → 实训 → 两方评价认定公开工序 → 受限工序评价分歧与复核 →
津贴发放与补录 → 试岗 → 录用 → 登记就业去向。
