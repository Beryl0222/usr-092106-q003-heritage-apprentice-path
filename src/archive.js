import {
  EVALUATOR_PARTIES,
  EVENT_CATALOG,
  OUTCOMES,
  RESTRICTED_FORBIDDEN_KEYS,
} from "./events.js";
import { validateEvent } from "./validator.js";

const accept = () => ({ accepted: true, violations: [] });
const reject = (violations) => ({ accepted: false, violations });

const keyOf = (event) => `${event.aggregate_type}:${event.aggregate_id}`;

/**
 * 非遗学徒成长档案服务核心。
 *
 * 按事件契约接收记录（含学校、工作室、企业与线下补录），维护各聚合状态，
 * 并执行领域不变量：能力认定须多方评价且分歧须复核、受限工序只记结论与
 * 保管位置、津贴按台账标识去重、带教负荷随关系变化占用或释放、既往成绩
 * 在休学/转项目/师傅退出/标准升级后保留。文字说明见 docs/domain-model.md。
 */
export class GrowthArchive {
  constructor({ defaultMasterCapacity = 3 } = {}) {
    this.defaultMasterCapacity = defaultMasterCapacity;
    this.seenEvents = new Set();
    this.versions = new Map(); // "aggregate_type:aggregate_id" -> 已接收版本
    this.apprenticeships = new Map(); // aggregate_id -> 学徒档案
    this.apprenticeIndex = new Map(); // apprentice_id -> 档案 aggregate_id
    this.lineages = new Map(); // aggregate_id -> 技艺谱系
    this.curriculumVersions = new Map(); // aggregate_id -> 课程版本
    this.mentorships = new Map(); // aggregate_id -> 师徒关系
    this.masterCapacity = new Map(); // master_id -> 带教容量
    this.masterLoad = new Map(); // master_id -> 当前带教负荷
    this.practiceWorks = new Map(); // aggregate_id -> 实训作品
    this.competencies = new Map(); // aggregate_id -> 能力记录
    this.allowances = new Map(); // aggregate_id -> 津贴台账
    this.placements = new Map(); // aggregate_id -> 试岗/录用
  }

  /** 接收一条事件。返回 { accepted, violations }；被拒事件不留下任何痕迹，可修正后重发。 */
  receive(event) {
    let violations = validateEvent(event);
    if (violations.length === 0) violations = this.#checkContract(event);
    if (violations.length === 0) violations = this.#apply(event);
    if (violations.length > 0) return reject(violations);
    this.seenEvents.add(event.event_id);
    this.versions.set(keyOf(event), event.version);
    return accept();
  }

  // ---- 契约层：事件与聚合的配对、payload 必填字段、幂等与版本顺序 ----

  #checkContract(event) {
    const violations = [];
    const spec = EVENT_CATALOG[event.event_type];
    if (event.aggregate_type !== spec.aggregate) {
      violations.push(`事件 ${event.event_type} 应作用于聚合 ${spec.aggregate}，收到 ${event.aggregate_type}`);
    }
    const payload = event.payload ?? {};
    for (const key of spec.required) {
      if (!(key in payload)) violations.push(`payload 缺少字段：${key}`);
    }
    if (this.seenEvents.has(event.event_id)) violations.push(`事件标识重复：${event.event_id}`);
    const expected = (this.versions.get(keyOf(event)) ?? 0) + 1;
    if (event.version !== expected) {
      violations.push(`聚合 ${keyOf(event)} 期望版本 ${expected}，收到版本 ${event.version}`);
    }
    return violations;
  }

  #apply(event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "LINEAGE_REGISTERED": return this.#lineageRegistered(event, p);
      case "CURRICULUM_PUBLISHED": return this.#curriculumPublished(event, p);
      case "CURRICULUM_SUPERSEDED": return this.#curriculumSuperseded(event, p);
      case "APPRENTICE_ENROLLED": return this.#apprenticeEnrolled(event, p);
      case "APPRENTICE_SUSPENDED": return this.#apprenticeSuspended(event, p);
      case "APPRENTICE_RESUMED": return this.#apprenticeResumed(event, p);
      case "APPRENTICE_TRANSFERRED": return this.#apprenticeTransferred(event, p);
      case "CREDIT_TRANSFERRED": return this.#creditTransferred(event, p);
      case "EMPLOYMENT_OUTCOME_RECORDED": return this.#outcomeRecorded(event, p);
      case "MENTORSHIP_ESTABLISHED": return this.#mentorshipEstablished(event, p);
      case "MENTORSHIP_ENDED": return this.#mentorshipEnded(event, p);
      case "PRACTICE_RECORDED": return this.#practiceRecorded(event, p);
      case "EVALUATION_SUBMITTED": return this.#evaluationSubmitted(event, p);
      case "COMPETENCY_REVIEWED": return this.#competencyReviewed(event, p);
      case "ALLOWANCE_ISSUED": return this.#allowanceIssued(event, p);
      case "TRIAL_PLACEMENT_STARTED": return this.#trialStarted(event, p);
      case "PLACEMENT_CONFIRMED": return this.#placementConfirmed(event, p);
      default: return [`未实现的事件类型：${event.event_type}`];
    }
  }

  // ---- 谱系与课程标准 ----

  #lineageRegistered(event, p) {
    if (this.lineages.has(event.aggregate_id)) return [`技艺谱系已登记：${event.aggregate_id}`];
    if (!Array.isArray(p.steps) || p.steps.length === 0) return ["谱系须包含至少一道工序"];
    for (const step of p.steps) {
      if (!step.step_id || !["open", "restricted"].includes(step.disclosure)) {
        return [`工序 ${step.step_id ?? "?"} 须声明 disclosure 为 open 或 restricted`];
      }
    }
    this.lineages.set(event.aggregate_id, {
      craft_name: p.craft_name,
      steps: p.steps.map((s) => ({ step_id: s.step_id, name: s.name, disclosure: s.disclosure })),
    });
    for (const master of p.masters ?? []) {
      if (Number.isInteger(master.max_apprentices) && master.max_apprentices > 0) {
        this.masterCapacity.set(master.master_id, master.max_apprentices);
      }
    }
    return [];
  }

  #curriculumPublished(event, p) {
    if (this.curriculumVersions.has(event.aggregate_id)) return [`课程版本已发布：${event.aggregate_id}`];
    if (!this.lineages.has(p.lineage_id)) return [`技艺谱系未登记：${p.lineage_id}`];
    if (!Array.isArray(p.items) || p.items.length === 0) return ["课程版本须包含课程项"];
    this.curriculumVersions.set(event.aggregate_id, {
      lineage_id: p.lineage_id,
      version_no: p.version_no,
      items: p.items.map((i) => ({ item_id: i.item_id, kind: i.kind ?? "step" })),
      supersedes: null,
      transfer_map: [],
    });
    return [];
  }

  #curriculumSuperseded(event, p) {
    const next = this.curriculumVersions.get(event.aggregate_id);
    if (!next) return [`课程版本未发布：${event.aggregate_id}（应先发布后声明替代关系）`];
    const previous = this.curriculumVersions.get(p.previous_version_id);
    if (!previous) return [`被替代的课程版本不存在：${p.previous_version_id}`];
    if (!Array.isArray(p.transfer_map)) return ["课程标准升级须给出可转认范围 transfer_map"];
    for (const entry of p.transfer_map) {
      if (!entry.from_item || !["full", "partial", "none"].includes(entry.scope)) {
        return [`可转认范围条目须含 from_item 且 scope 为 full/partial/none：${JSON.stringify(entry)}`];
      }
    }
    next.supersedes = p.previous_version_id;
    next.transfer_map = p.transfer_map;
    previous.superseded_by = event.aggregate_id;
    return [];
  }

  // ---- 学徒档案 ----

  #apprenticeEnrolled(event, p) {
    if (this.apprenticeships.has(event.aggregate_id)) return [`学徒档案已存在：${event.aggregate_id}`];
    if (!this.lineages.has(p.lineage_id)) return [`技艺谱系未登记：${p.lineage_id}`];
    if (!this.curriculumVersions.has(p.curriculum_version_id)) return [`课程版本未发布：${p.curriculum_version_id}`];
    this.apprenticeships.set(event.aggregate_id, {
      apprentice_id: p.apprentice_id,
      lineage_id: p.lineage_id,
      curriculum_version_id: p.curriculum_version_id,
      mentorship_id: null,
      status: "active",
      transferred_credits: [],
      outcome: null,
    });
    this.apprenticeIndex.set(p.apprentice_id, event.aggregate_id);
    return [];
  }

  #apprenticeSuspended(event, p) {
    const record = this.apprenticeships.get(event.aggregate_id);
    if (!record) return [`学徒档案不存在：${event.aggregate_id}`];
    if (record.status !== "active") return [`仅在校学员可休学，当前状态：${record.status}`];
    record.status = "suspended";
    // 休学即释放带教负荷，师徒关系保留以便复学
    const mentorship = this.mentorships.get(record.mentorship_id);
    if (mentorship?.load_held) {
      this.#releaseLoad(mentorship.master_id);
      mentorship.load_held = false;
      mentorship.status = "suspended";
    }
    return [];
  }

  #apprenticeResumed(event, p) {
    const record = this.apprenticeships.get(event.aggregate_id);
    if (!record) return [`学徒档案不存在：${event.aggregate_id}`];
    if (record.status !== "suspended") return [`仅休学学员可复学，当前状态：${record.status}`];
    const mentorship = this.mentorships.get(record.mentorship_id);
    if (mentorship && mentorship.status === "suspended") {
      const violation = this.#occupyLoad(mentorship.master_id);
      if (violation) return [violation];
      mentorship.load_held = true;
      mentorship.status = "active";
    }
    record.status = "active";
    return [];
  }

  #apprenticeTransferred(event, p) {
    const record = this.apprenticeships.get(event.aggregate_id);
    if (!record) return [`学徒档案不存在：${event.aggregate_id}`];
    if (!this.lineages.has(p.to_lineage_id)) return [`目标技艺谱系未登记：${p.to_lineage_id}`];
    if (!this.curriculumVersions.has(p.to_curriculum_version_id)) {
      return [`目标课程版本未发布：${p.to_curriculum_version_id}`];
    }
    // 转项目/换师门：释放原师傅带教负荷，既往能力记录与成绩全部保留
    const mentorship = this.mentorships.get(record.mentorship_id);
    if (mentorship && mentorship.status !== "ended") {
      if (mentorship.load_held) {
        this.#releaseLoad(mentorship.master_id);
        mentorship.load_held = false;
      }
      mentorship.status = "ended";
      mentorship.end_reason = "transferred";
    }
    record.mentorship_id = null;
    record.lineage_id = p.to_lineage_id;
    record.curriculum_version_id = p.to_curriculum_version_id;
    record.status = "active";
    return [];
  }

  #creditTransferred(event, p) {
    const record = this.apprenticeships.get(event.aggregate_id);
    if (!record) return [`学徒档案不存在：${event.aggregate_id}`];
    const toVersion = this.curriculumVersions.get(p.to_curriculum_version_id);
    if (!toVersion) return [`目标课程版本未发布：${p.to_curriculum_version_id}`];
    if (toVersion.supersedes !== p.from_curriculum_version_id) {
      return [`${p.to_curriculum_version_id} 并非 ${p.from_curriculum_version_id} 的升级版本，不能转认`];
    }
    if (!Array.isArray(p.items) || p.items.length === 0) return ["转认须列出课程项"];
    // 先整体校验可转认范围，全部通过后再入账，避免部分写入
    const mapped = [];
    for (const item of p.items) {
      const mapping = toVersion.transfer_map.find((m) => m.from_item === item.item_ref);
      if (!mapping || mapping.scope === "none") {
        return [`课程项 ${item.item_ref} 不在可转认范围内，须按新标准重新考核`];
      }
      mapped.push({ item_ref: item.item_ref, to_item: mapping.to_item, scope: mapping.scope });
    }
    record.transferred_credits.push(...mapped);
    return [];
  }

  #outcomeRecorded(event, p) {
    const record = this.apprenticeships.get(event.aggregate_id);
    if (!record) return [`学徒档案不存在：${event.aggregate_id}`];
    if (!OUTCOMES.includes(p.outcome)) return [`未知去向：${p.outcome}`];
    if (p.outcome === "employed") {
      const confirmed = [...this.placements.values()].some(
        (pl) => pl.apprentice_id === record.apprentice_id && pl.stage === "confirmed",
      );
      if (!confirmed) return ["登记正式就业前须先完成试岗并确认录用"];
    }
    record.outcome = { type: p.outcome, employer_ref: p.employer_ref ?? null, position_ref: p.position_ref ?? null };
    return [];
  }

  // ---- 师徒关系与带教负荷 ----

  #mentorshipEstablished(event, p) {
    if (this.mentorships.has(event.aggregate_id)) return [`师徒关系已存在：${event.aggregate_id}`];
    const apprentice = this.#apprenticeOf(p.apprentice_id);
    if (!apprentice) return [`学员未登记：${p.apprentice_id}`];
    const violation = this.#occupyLoad(p.master_id);
    if (violation) return [violation];
    this.mentorships.set(event.aggregate_id, {
      master_id: p.master_id,
      apprentice_id: p.apprentice_id,
      lineage_id: p.lineage_id,
      status: "active",
      load_held: true,
    });
    apprentice.mentorship_id = event.aggregate_id;
    return [];
  }

  #mentorshipEnded(event, p) {
    const mentorship = this.mentorships.get(event.aggregate_id);
    if (!mentorship) return [`师徒关系不存在：${event.aggregate_id}`];
    if (mentorship.status === "ended") return ["师徒关系已结束，不能重复结束"];
    if (mentorship.load_held) {
      this.#releaseLoad(mentorship.master_id);
      mentorship.load_held = false;
    }
    mentorship.status = "ended";
    mentorship.end_reason = p.reason; // completed / master_withdrawn / transferred 等
    const apprentice = this.#apprenticeOf(mentorship.apprentice_id);
    if (apprentice?.mentorship_id === event.aggregate_id) apprentice.mentorship_id = null;
    return [];
  }

  // ---- 实训作品 ----

  #practiceRecorded(event, p) {
    if (!this.#apprenticeOf(p.apprentice_id)) return [`学员未登记：${p.apprentice_id}`];
    this.practiceWorks.set(event.aggregate_id, {
      apprentice_id: p.apprentice_id,
      work_ref: p.work_ref,
      step_refs: p.step_refs ?? [],
      recorded_by: p.recorded_by ?? null,
    });
    return [];
  }

  // ---- 工序能力与考核证据 ----

  #evaluationSubmitted(event, p) {
    if (!this.#apprenticeOf(p.apprentice_id)) return [`学员未登记：${p.apprentice_id}`];
    const item = this.#findItem(p.item_ref);
    if (!item.known) return [`工序/课程项未登记：${p.item_ref}`];
    const evaluator = p.evaluator ?? {};
    if (!EVALUATOR_PARTIES.includes(evaluator.party) || !evaluator.id) {
      return [`评价方须为 ${EVALUATOR_PARTIES.join("/")} 之一并给出 id`];
    }
    if (!["pass", "fail"].includes(p.verdict)) return [`评价结论须为 pass 或 fail：${p.verdict}`];
    if (item.restricted) {
      const violation = this.#checkRestrictedPayload(p);
      if (violation) return [violation];
    }

    let record = this.competencies.get(event.aggregate_id);
    if (record) {
      if (record.apprentice_id !== p.apprentice_id || record.item_ref !== p.item_ref) {
        return [`能力记录 ${event.aggregate_id} 已对应 ${record.apprentice_id}/${record.item_ref}，不能混入其他评价`];
      }
    } else {
      record = {
        apprentice_id: p.apprentice_id,
        item_ref: p.item_ref,
        restricted: item.restricted,
        custody_ref: null,
        evaluations: [],
        status: "collecting",
        conclusion: null,
      };
      this.competencies.set(event.aggregate_id, record);
    }
    if (record.status === "certified" || record.status === "rejected") {
      return [`能力记录已裁定（${record.status}），更正须另起记录`];
    }
    const duplicated = record.evaluations.some(
      (ev) => ev.evaluator.party === evaluator.party && ev.evaluator.id === evaluator.id,
    );
    if (duplicated) return [`评价方 ${evaluator.party}:${evaluator.id} 已提交过评价`];

    record.evaluations.push({ evaluator, verdict: p.verdict });
    if (item.restricted) record.custody_ref = p.custody_ref;
    record.status = record.evaluations.some((ev) => ev.verdict === "fail") ? "disputed" : "collecting";
    return [];
  }

  #competencyReviewed(event, p) {
    const record = this.competencies.get(event.aggregate_id);
    if (!record || record.evaluations.length === 0) {
      return ["能力认定须基于多方评价证据，单次打卡或实训记录不能自动得出认定"];
    }
    if (!["certified", "rejected"].includes(p.outcome)) return [`认定结论须为 certified 或 rejected：${p.outcome}`];
    if (record.status === "certified" || record.status === "rejected") {
      return [`能力记录已裁定（${record.status}），更正须另起记录`];
    }
    if (record.restricted) {
      const violation = this.#checkRestrictedPayload(p);
      if (violation) return [violation];
      if (!p.conclusion) return ["受限工序须记录完成结论 conclusion"];
    }
    if (p.outcome === "certified") {
      const passParties = new Set(
        record.evaluations.filter((ev) => ev.verdict === "pass").map((ev) => ev.evaluator.party),
      );
      const disputed = record.evaluations.some((ev) => ev.verdict === "fail");
      if (passParties.size === 0) return ["无任何一方评价通过，不能认定"];
      if (disputed && p.review !== true) return ["师傅、学校与企业评价存在分歧，须经复核裁定后方可认定"];
      if (!disputed && passParties.size < 2 && p.review !== true) {
        return ["能力认定需至少两方评价通过，不能由单次记录自动得出"];
      }
    }
    record.status = p.outcome;
    record.reviewed = p.review === true;
    record.conclusion = p.conclusion ?? (p.outcome === "certified" ? "已完成" : "未通过");
    if (record.restricted) record.custody_ref = p.custody_ref;
    return [];
  }

  // 传统核心（受限）工序：只记录完成结论与保管位置，技法细节不得入档
  #checkRestrictedPayload(p) {
    const leaked = RESTRICTED_FORBIDDEN_KEYS.filter((key) => key in p);
    if (leaked.length > 0) return `受限工序不得记录技法细节字段：${leaked.join("、")}`;
    if (!p.custody_ref) return "受限工序须记录考核材料的保管位置 custody_ref";
    return null;
  }

  // ---- 津贴台账 ----

  #allowanceIssued(event, p) {
    if (this.allowances.has(event.aggregate_id)) {
      return ["该期间该项目的津贴已发放，线下补录不得重复发放"];
    }
    if (!this.#apprenticeOf(p.apprentice_id)) return [`学员未登记：${p.apprentice_id}`];
    if (typeof p.amount !== "number" || !(p.amount > 0)) return ["津贴金额须为正数"];
    if (p.backfilled === true && !p.source_ref) {
      return ["线下补录须在 source_ref 注明原始凭证，以便与线上记录对账"];
    }
    this.allowances.set(event.aggregate_id, {
      apprentice_id: p.apprentice_id,
      period: p.period,
      item: p.item,
      amount: p.amount,
      backfilled: p.backfilled === true,
    });
    return [];
  }

  // ---- 试岗与录用 ----

  #trialStarted(event, p) {
    if (!this.#apprenticeOf(p.apprentice_id)) return [`学员未登记：${p.apprentice_id}`];
    const existing = this.placements.get(event.aggregate_id);
    if (existing) return [`试岗记录已存在：${event.aggregate_id}`];
    this.placements.set(event.aggregate_id, {
      apprentice_id: p.apprentice_id,
      enterprise_id: p.enterprise_id,
      position_ref: p.position_ref,
      stage: "trial",
    });
    return [];
  }

  #placementConfirmed(event, p) {
    const placement = this.placements.get(event.aggregate_id);
    if (!placement || placement.stage !== "trial") return ["未先试岗，不能确认正式录用"];
    placement.stage = "confirmed";
    placement.position_ref = p.position_ref;
    placement.basis = p.basis ?? [];
    return [];
  }

  // ---- 内部工具 ----

  #apprenticeOf(apprenticeId) {
    const aggregateId = this.apprenticeIndex.get(apprenticeId);
    return aggregateId ? this.apprenticeships.get(aggregateId) : undefined;
  }

  #findItem(itemRef) {
    for (const lineage of this.lineages.values()) {
      const step = lineage.steps.find((s) => s.step_id === itemRef);
      if (step) return { known: true, restricted: step.disclosure === "restricted" };
    }
    for (const version of this.curriculumVersions.values()) {
      if (version.items.some((i) => i.item_id === itemRef)) return { known: true, restricted: false };
    }
    return { known: false, restricted: false };
  }

  #loadOf(masterId) {
    return this.masterLoad.get(masterId) ?? 0;
  }

  #capacityOf(masterId) {
    return this.masterCapacity.get(masterId) ?? this.defaultMasterCapacity;
  }

  #occupyLoad(masterId) {
    if (this.#loadOf(masterId) + 1 > this.#capacityOf(masterId)) {
      return `师傅 ${masterId} 带教负荷已满（${this.#capacityOf(masterId)}），须先释放再接收新学员`;
    }
    this.masterLoad.set(masterId, this.#loadOf(masterId) + 1);
    return null;
  }

  #releaseLoad(masterId) {
    this.masterLoad.set(masterId, Math.max(0, this.#loadOf(masterId) - 1));
  }
}
