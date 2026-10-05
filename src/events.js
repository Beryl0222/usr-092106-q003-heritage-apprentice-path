// 事件目录：事件名 → 所属聚合与 payload 必填字段。
// 这是领域规则的单一事实来源，tests/contract.test.js 会校验它与
// contracts/domain.schema.json 的枚举保持同步；业务不变量由 src/archive.js 执行。

export const EVENT_CATALOG = Object.freeze({
  // 学徒档案：从登记入学到去向落定的主线
  APPRENTICE_ENROLLED: {
    aggregate: "apprenticeship",
    required: ["apprentice_id", "lineage_id", "curriculum_version_id"],
  },
  APPRENTICE_SUSPENDED: { aggregate: "apprenticeship", required: ["apprentice_id", "reason"] },
  APPRENTICE_RESUMED: { aggregate: "apprenticeship", required: ["apprentice_id"] },
  APPRENTICE_TRANSFERRED: {
    aggregate: "apprenticeship",
    required: ["apprentice_id", "to_lineage_id", "to_curriculum_version_id"],
  },
  CREDIT_TRANSFERRED: {
    aggregate: "apprenticeship",
    required: ["apprentice_id", "from_curriculum_version_id", "to_curriculum_version_id", "items"],
  },
  EMPLOYMENT_OUTCOME_RECORDED: {
    aggregate: "apprenticeship",
    required: ["apprentice_id", "outcome"],
  },

  // 技艺谱系与课程标准
  LINEAGE_REGISTERED: { aggregate: "craft_lineage", required: ["craft_name", "steps"] },
  CURRICULUM_PUBLISHED: {
    aggregate: "curriculum_version",
    required: ["lineage_id", "version_no", "items"],
  },
  CURRICULUM_SUPERSEDED: {
    aggregate: "curriculum_version",
    required: ["previous_version_id", "transfer_map"],
  },

  // 师徒关系（带教负荷随建立/结束/休学/转项目占用或释放）
  MENTORSHIP_ESTABLISHED: {
    aggregate: "mentorship",
    required: ["master_id", "apprentice_id", "lineage_id"],
  },
  MENTORSHIP_ENDED: { aggregate: "mentorship", required: ["master_id", "apprentice_id", "reason"] },

  // 实训作品（打卡类记录，不能单独构成能力认定）
  PRACTICE_RECORDED: { aggregate: "practice_work", required: ["apprentice_id", "work_ref"] },

  // 工序能力与考核证据：多方评价 → 认定 / 复核
  EVALUATION_SUBMITTED: {
    aggregate: "competency_record",
    required: ["apprentice_id", "item_ref", "evaluator", "verdict"],
  },
  COMPETENCY_REVIEWED: {
    aggregate: "competency_record",
    required: ["apprentice_id", "item_ref", "outcome"],
  },

  // 津贴台账：按聚合标识去重，线下补录不得重复发放
  ALLOWANCE_ISSUED: {
    aggregate: "allowance_ledger",
    required: ["apprentice_id", "period", "item", "amount"],
  },

  // 试岗与正式录用
  TRIAL_PLACEMENT_STARTED: {
    aggregate: "placement",
    required: ["apprentice_id", "enterprise_id", "position_ref"],
  },
  PLACEMENT_CONFIRMED: {
    aggregate: "placement",
    required: ["apprentice_id", "enterprise_id", "position_ref"],
  },
});

// 评价方：师傅、学校、用工企业三方可以存在分歧，分歧须复核裁定
export const EVALUATOR_PARTIES = Object.freeze(["master", "school", "enterprise"]);

// 学员去向
export const OUTCOMES = Object.freeze(["employed", "further_study", "exited"]);

// 传统核心（受限）工序在记录中只允许出现完成结论与保管位置，
// 以下字段不得出现在受限工序的事件 payload 中
export const RESTRICTED_FORBIDDEN_KEYS = Object.freeze([
  "evidence_refs",
  "technique_detail",
  "media_refs",
]);
