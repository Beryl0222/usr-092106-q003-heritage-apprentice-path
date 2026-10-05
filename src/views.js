// 角色视图：同一份档案，不同角色看到不同内容。
// 核心约束：传统核心（受限）工序对企业只暴露完成结论，
// 保管位置与评价细节仅师傅、学校、人才服务中心与管理部门可见。

export const ROLES = Object.freeze(["master", "school", "enterprise", "service_center", "regulator"]);

function assertRole(role) {
  if (!ROLES.includes(role)) throw new RangeError(`未知角色：${role}`);
}

/** 能力记录视图。受限工序对企业只给结论；其余角色可见保管位置与评价明细。 */
export function viewCompetencyRecord(role, record) {
  assertRole(role);
  if (!record.restricted) {
    return {
      apprentice_id: record.apprentice_id,
      item_ref: record.item_ref,
      disclosure: "open",
      status: record.status,
      conclusion: record.conclusion,
      evaluations: record.evaluations.map((ev) => ({ ...ev })),
    };
  }
  if (role === "enterprise") {
    return {
      apprentice_id: record.apprentice_id,
      item_ref: record.item_ref,
      disclosure: "restricted",
      conclusion: record.conclusion ?? "在评",
    };
  }
  return {
    apprentice_id: record.apprentice_id,
    item_ref: record.item_ref,
    disclosure: "restricted",
    status: record.status,
    conclusion: record.conclusion,
    custody_ref: record.custody_ref,
    evaluations: record.evaluations.map((ev) => ({ ...ev })),
  };
}

/** 津贴视图：与用工企业无关，企业一律不可见。 */
export function viewAllowance(role, record) {
  assertRole(role);
  if (role === "enterprise") return null;
  return { ...record };
}

/**
 * 管理部门汇总：培训投入（津贴）是否形成合格上岗。
 * 只输出汇总数，不含任何受限工序细节。
 */
export function regulatorSummary(archive) {
  const apprentices = [...archive.apprenticeships.values()];
  const competencies = [...archive.competencies.values()];
  const allowances = [...archive.allowances.values()];
  const placements = [...archive.placements.values()];
  const countOutcome = (type) => apprentices.filter((a) => a.outcome?.type === type).length;
  return {
    apprentices_total: apprentices.length,
    apprentices_active: apprentices.filter((a) => a.status === "active").length,
    apprentices_suspended: apprentices.filter((a) => a.status === "suspended").length,
    competencies_certified: competencies.filter((c) => c.status === "certified").length,
    competencies_in_review: competencies.filter((c) => c.status === "disputed").length,
    allowances_issued: allowances.length,
    allowances_amount_total: allowances.reduce((sum, a) => sum + a.amount, 0),
    placements_trial: placements.filter((p) => p.stage === "trial").length,
    placements_confirmed: placements.filter((p) => p.stage === "confirmed").length,
    outcomes: {
      employed: countOutcome("employed"),
      further_study: countOutcome("further_study"),
      exited: countOutcome("exited"),
    },
  };
}
