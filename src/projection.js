// 非遗学徒成长服务：事件流状态投影。
// 只追加、不回改事件；本模块把事件折叠为当前可查状态，并在折叠过程中报告业务不变量冲突。
// 接入顺序即接收顺序——线下补录允许晚到，但幂等键与来源凭证保证其不产生重复效果。

import { validateEvent } from "./validator.js";

function emptyState() {
  return {
    lineages: new Map(),
    curricula: new Map(), // curriculum_version_id -> {status, superseded_by, modules, ...}
    masters: new Map(),   // master_id -> {capacity, load, withdrawn, lineageId}
    apprentices: new Map(),
    mentorships: new Map(),
    practiceRecords: [],
    practiceWorks: [],
    competencies: new Map(), // competency record id (apprentice+step)
    reviews: new Map(),
    evidence: new Map(),
    stipends: new Map(), // dedupe_key -> grant event
    stipendTotals: new Map(), // apprentice_id -> 分
    placements: new Map()
  };
}

function initApprentice(state, id, event) {
  if (!state.apprentices.has(id)) {
    state.apprentices.set(id, {
      apprentice_id: id,
      name: event.payload?.apprentice_name,
      status: "ENROLLED",
      lineageId: event.payload?.lineage_id,
      curriculumVersionId: event.payload?.curriculum_version_id,
      curriculumHistory: [event.payload?.curriculum_version_id],
      creditTransfers: [],
      retainedRecordsNote: [],
      activeMentorshipId: null,
      mentorshipHistory: [],
      stipends: [],
      placementId: null,
      outcome: null
    });
  }
}

// 折叠单条事件；错误追加到 errors（带 event_id 定位）
function apply(state, event, errors) {
  const p = event.payload ?? {};
  const flag = (msg) => errors.push(`${event.event_id}：${msg}`);

  switch (event.event_type) {
    case "LINEAGE_REGISTERED":
      state.lineages.set(event.aggregate_id, { lineage_id: event.aggregate_id, ...p });
      break;

    case "CURRICULUM_PUBLISHED":
      state.curricula.set(event.aggregate_id, { version_id: event.aggregate_id, status: p.status ?? "ACTIVE", ...p });
      break;

    case "CURRICULUM_SUPERSEDED": {
      const cur = state.curricula.get(event.aggregate_id);
      if (!cur) return flag("课程版本不存在即被替代");
      cur.status = "SUPERSEDED";
      cur.superseded_by = p.superseded_by;
      cur.credit_transfer_map = p.credit_transfer_map ?? [];
      break;
    }

    case "MASTER_REGISTERED":
      state.masters.set(event.aggregate_id, {
        master_id: event.aggregate_id,
        name: p.name,
        lineageId: p.lineage_id,
        capacity: p.capacity ?? 0,
        load: 0,
        withdrawn: false
      });
      break;

    case "MASTER_CAPACITY_UPDATED": {
      const m = state.masters.get(event.aggregate_id);
      if (!m) return flag("师傅不存在即调整容量");
      m.capacity = p.capacity;
      if (m.load > m.capacity) flag(`容量下调后当前负荷 ${m.load} 超过上限 ${m.capacity}`);
      break;
    }

    case "MASTER_WITHDRAWN": {
      const m = state.masters.get(event.aggregate_id);
      if (!m) return flag("师傅不存在即退出");
      const active = [...state.mentorships.values()].filter((x) => x.masterId === m.master_id && x.status !== "ENDED");
      if (active.length > 0) return flag(`师傅退出时仍有 ${active.length} 段未结束师徒关系，须先转接并释放负荷`);
      m.withdrawn = true;
      break;
    }

    case "APPRENTICE_ENROLLED":
      initApprentice(state, event.aggregate_id, event);
      break;

    case "APPRENTICE_SUSPENDED": {
      const a = state.apprentices.get(event.aggregate_id);
      if (!a) return flag("学徒未入学即休学");
      if (a.status !== "ENROLLED" && a.status !== "LEARNING") return flag(`当前状态 ${a.status} 不可休学`);
      a.status = "SUSPENDED";
      // 既往成绩不清除：不动 competency/credit 数据，仅打保留标记
      a.retainedRecordsNote.push({ at: event.occurred_at, reason: p.reason, retained: p.retained !== false });
      break;
    }

    case "APPRENTICE_RESUMED": {
      const a = state.apprentices.get(event.aggregate_id);
      if (!a) return flag("学徒未入学即复课");
      if (a.status !== "SUSPENDED") return flag(`非休学状态不可复课（当前 ${a.status}）`);
      a.status = "LEARNING";
      break;
    }

    case "APPRENTICE_TRANSFERRED": {
      const a = state.apprentices.get(event.aggregate_id);
      if (!a) return flag("学徒未入学即转项目");
      a.lineageId = p.to_lineage_id;
      a.curriculumVersionId = p.to_curriculum_version_id;
      a.curriculumHistory.push(p.to_curriculum_version_id);
      a.status = "LEARNING"; // 转项目后仍在培养中，既往成绩保留、可转认范围另行登记
      a.retainedRecordsNote.push({ at: event.occurred_at, from: p.from_lineage_id, retained: p.retained_records ?? [] });
      break;
    }

    case "CREDIT_TRANSFERRED": {
      const a = state.apprentices.get(event.aggregate_id);
      if (!a) return flag("成绩转认目标学徒不存在");
      // 课程标准升级时，转认事件同时把学徒档案迁到新版本；转项目则由 APPRENTICE_TRANSFERRED 先迁移
      if (a.curriculumVersionId !== p.to_curriculum_version_id) {
        a.curriculumVersionId = p.to_curriculum_version_id;
        a.curriculumHistory.push(p.to_curriculum_version_id);
      }
      a.creditTransfers.push({ at: event.occurred_at, ...p });
      break;
    }

    case "MENTORSHIP_ASSIGNED": {
      const m = state.masters.get(p.master_id);
      if (!m) return flag("指派的师傅不存在");
      if (m.withdrawn) return flag("师傅已退出带教名册，不可再接收学徒");
      const a = state.apprentices.get(p.apprentice_id);
      if (!a) return flag("指派的学徒不存在");
      if (a.activeMentorshipId) return flag("学徒尚有未结束师徒关系，不可重复拜入师门");
      const delta = p.load_delta ?? 1;
      if (m.load + delta > m.capacity) return flag(`占用后负荷 ${m.load + delta} 超过师傅带教上限 ${m.capacity}`);
      m.load += delta;
      state.mentorships.set(event.aggregate_id, {
        mentorship_id: event.aggregate_id,
        apprenticeId: p.apprentice_id,
        masterId: p.master_id,
        status: "ACTIVE",
        lineageId: p.lineage_id
      });
      a.activeMentorshipId = event.aggregate_id;
      a.mentorshipHistory.push(event.aggregate_id);
      break;
    }

    case "MENTORSHIP_PAUSED":
    case "MENTORSHIP_RESUMED":
    case "MENTORSHIP_ENDED": {
      const rel = state.mentorships.get(event.aggregate_id);
      if (!rel) return flag("师徒关系不存在");
      const m = state.masters.get(rel.masterId);
      const a = state.apprentices.get(rel.apprenticeId);
      const resume = event.event_type === "MENTORSHIP_RESUMED";
      const pause = event.event_type === "MENTORSHIP_PAUSED";
      const end = event.event_type === "MENTORSHIP_ENDED";

      if (pause && rel.status !== "ACTIVE") return flag(`仅进行中的师徒关系可挂起（当前 ${rel.status}）`);
      if (resume && rel.status !== "PAUSED") return flag(`仅挂起的师徒关系可恢复（当前 ${rel.status}）`);
      if (end && rel.status === "ENDED") return flag("师徒关系已结束，不可重复结束");

      if (resume && m.load + 1 > m.capacity) return flag(`恢复带教后负荷超过上限 ${m.capacity}`);
      m.load += p.load_delta ?? (pause || end ? -1 : 1);
      if (m.load < 0) flag("师傅负荷被释放为负数，存在多余的释放事件");

      rel.status = pause ? "PAUSED" : end ? "ENDED" : "ACTIVE";
      if (end && a?.activeMentorshipId === event.aggregate_id) a.activeMentorshipId = null;
      if (resume && a) a.activeMentorshipId = event.aggregate_id;
      break;
    }

    case "ATTENDANCE_MARKED":
      // 打卡只产生考勤，不产生任何能力结论
      state.practiceRecords.push({ id: event.aggregate_id, at: event.occurred_at, ...p });
      break;

    case "PRACTICE_WORK_SUBMITTED":
      state.practiceWorks.push({ id: event.aggregate_id, at: event.occurred_at, ...p });
      break;

    case "ASSESSMENT_EVIDENCE_ATTACHED":
      state.evidence.set(event.aggregate_id, { evidence_id: event.aggregate_id, ...p });
      break;

    case "CORE_STEP_ATTESTED": {
      const key = `${p.apprentice_id}:${p.step_id}`;
      const rec = state.competencies.get(key) ?? {
        recordId: event.aggregate_id,
        apprenticeId: p.apprentice_id,
        moduleId: p.module_id,
        stepId: p.step_id,
        restriction: null,
        assessments: [],
        status: "NO_ASSESSMENT",
        reviewId: null,
        finalDecision: null
      };
      rec.recordId = event.aggregate_id;
      rec.restriction = p.restriction; // 仅完成结论与保管位置
      state.competencies.set(key, rec);
      break;
    }

    case "COMPETENCY_ASSESSED": {
      const key = `${p.apprentice_id}:${p.step_id}`;
      const rec = state.competencies.get(key);
      if (!rec) return flag("缺少核心步骤/工序记录即开展评价");
      rec.assessments = p.assessments;
      const results = new Set(p.assessments.map((x) => x.result));
      // 任何单次评价都不自动形成认定；结果一致也仍需后续确认环节，分歧则必须进复核
      rec.status = results.size === 1 && !results.has("CONDITIONAL") ? "ASSESSED_UNANIMOUS_PENDING_CONFIRM" : "DIVERGENT";
      break;
    }

    case "COMPETENCY_REVIEW_OPENED": {
      const rec = state.competencies.get(compKeyOf(state, p.competency_record_id));
      if (!rec) return flag("复核针对的工序能力记录不存在");
      if (rec.status !== "DIVERGENT" && rec.status !== "ASSESSED_UNANIMOUS_PENDING_CONFIRM") {
        return flag(`当前评价状态 ${rec.status} 不受理复核`);
      }
      rec.status = "IN_REVIEW";
      rec.reviewId = event.aggregate_id;
      state.reviews.set(event.aggregate_id, { review_id: event.aggregate_id, status: "OPEN", ...p });
      break;
    }

    case "COMPETENCY_REVIEW_DECIDED": {
      const review = state.reviews.get(event.aggregate_id);
      if (!review) return flag("复核决定缺少受理记录");
      if (review.status !== "OPEN") return flag("复核已作出决定，不可重复决定");
      review.status = "DECIDED";
      review.decision = p;
      const rec = state.competencies.get(compKeyOf(state, p.competency_record_id));
      if (rec) {
        rec.status = "RECOGNIZED_WITH_SCOPE";
        rec.finalDecision = { decision: p.decision, recognized_scope: p.recognized_scope, excluded_scope: p.excluded_scope };
      }
      break;
    }

    case "STIPEND_GRANTED": {
      // 线上与线下补录共用同一去重键空间，重复发放在此被拦截
      if (state.stipends.has(p.dedupe_key)) return flag(`津贴已发放（幂等键 ${p.dedupe_key}），线下补录不得重复发放`);
      state.stipends.set(p.dedupe_key, event);
      const a = state.apprentices.get(p.apprentice_id);
      a?.stipends.push({ period: p.period, amount_cents: p.amount_cents, at: event.occurred_at, key: p.dedupe_key });
      state.stipendTotals.set(p.apprentice_id, (state.stipendTotals.get(p.apprentice_id) ?? 0) + p.amount_cents);
      break;
    }

    case "STIPEND_REVOKED": {
      const grant = state.stipends.get(p.dedupe_key);
      if (!grant) return flag("撤销的津贴发放记录不存在");
      state.stipends.delete(p.dedupe_key);
      state.stipendTotals.set(p.apprentice_id, (state.stipendTotals.get(p.apprentice_id) ?? 0) - (grant.payload?.amount_cents ?? 0));
      break;
    }

    case "TRIAL_PLACEMENT_STARTED": {
      const a = state.apprentices.get(p.apprentice_id);
      if (!a) return flag("试岗学徒不存在");
      state.placements.set(event.aggregate_id, {
        placement_id: event.aggregate_id,
        apprenticeId: p.apprentice_id,
        enterpriseId: p.enterprise_id,
        position: p.position,
        status: "TRIAL",
        trialFrom: p.trial_from,
        trialTo: p.trial_to,
        evaluation: null
      });
      a.placementId = event.aggregate_id;
      break;
    }

    case "TRIAL_PLACEMENT_EVALUATED": {
      const pl = state.placements.get(event.aggregate_id);
      if (!pl) return flag("评价的试岗记录不存在");
      if (pl.status !== "TRIAL") return flag("仅试岗中可提交试岗评价");
      pl.evaluation = { result: p.result, note: p.note, at: event.occurred_at };
      break;
    }

    case "PLACEMENT_CONFIRMED": {
      const pl = state.placements.get(event.aggregate_id);
      if (!pl) return flag("录用记录缺少试岗起点");
      if (pl.status !== "TRIAL") return flag("试岗已结案，不可重复录用");
      if (!pl.evaluation) return flag("未取得试岗评价不得正式录用");
      if (pl.evaluation.result !== "PASS") return flag(`试岗评价 ${pl.evaluation.result}，不可直接录用（应延长试岗或另行安排）`);
      pl.status = "FORMAL_EMPLOYMENT";
      pl.employedFrom = p.employed_from;
      break;
    }

    case "PATHWAY_COMPLETED": {
      const a = state.apprentices.get(event.aggregate_id);
      if (!a) return flag("闭环的学徒档案不存在");
      const pl = state.placements.get(p.placement_id);
      if (!pl || pl.status !== "FORMAL_EMPLOYMENT") return flag("成长路径闭环必须以正式录用为前提");
      a.status = "PATH_COMPLETED";
      a.outcome = p.outcome;
      break;
    }

    default:
      flag(`未实现的投影事件：${event.event_type}`);
  }
}

// 复核事件载荷通过 competency_record 聚合 id 指向能力档案
function compKeyOf(state, recordId) {
  for (const [key, rec] of state.competencies) {
    if (rec.recordId === recordId) return key;
  }
  return recordId;
}

// 折叠整个事件流，返回状态与业务错误
export function fold(events) {
  const state = emptyState();
  const errors = [];
  events.forEach((event, i) => {
    const structural = validateEvent(event);
    structural.forEach((e) => errors.push(`第 ${i + 1} 条：${e}`));
    if (structural.length === 0) apply(state, event, errors);
  });
  return { state, errors };
}

// 企业视图：只可查能力结论与其认定范围；保管位置、保管人、原始评语等受限细节一律不可见
export function enterpriseView(state, apprenticeId) {
  const competencies = [...state.competencies.values()]
    .filter((c) => c.apprenticeId === apprenticeId)
    .map((c) => ({
      step_id: c.stepId,
      module_id: c.moduleId,
      status: c.status,
      recognized: c.finalDecision
        ? {
            decision: c.finalDecision.decision,
            recognized_scope: c.finalDecision.recognized_scope ?? null,
            excluded_scope: c.finalDecision.excluded_scope ?? null
          }
        : null
    }));
  const placement = state.placements.get(state.apprentices.get(apprenticeId)?.placementId ?? "");
  return {
    apprentice_id: apprenticeId,
    competencies,
    placement: placement ? { enterprise_id: placement.enterpriseId, position: placement.position, status: placement.status } : null
  };
}

// 管理视图：培训投入（津贴）是否形成合格上岗
export function trainingInvestmentReport(state) {
  const rows = [];
  for (const [id, a] of state.apprentices) {
    const pl = state.placements.get(a.placementId ?? "");
    const recognized = [...state.competencies.values()].filter((c) => c.apprenticeId === id && c.status === "RECOGNIZED_WITH_SCOPE").length;
    rows.push({
      apprentice_id: id,
      name: a.name,
      status: a.status,
      stipend_total_cents: state.stipendTotals.get(id) ?? 0,
      recognized_competencies: recognized,
      placement_status: pl?.status ?? "NONE",
      qualified_for_post: pl?.status === "FORMAL_EMPLOYMENT" || a.outcome === "FORMAL_EMPLOYMENT"
    });
  }
  return rows;
}
