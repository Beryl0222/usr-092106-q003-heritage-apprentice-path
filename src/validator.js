// 非遗学徒成长服务：领域事件结构校验（不含状态推演，状态规则见 projection.js）

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "source"];

// 事件与聚合的归属关系：事件只能落在其所属聚合上
export const EVENT_AGGREGATE = {
  LINEAGE_REGISTERED: "lineage",
  CURRICULUM_PUBLISHED: "curriculum_version",
  CURRICULUM_SUPERSEDED: "curriculum_version",
  MASTER_REGISTERED: "master",
  MASTER_CAPACITY_UPDATED: "master",
  MASTER_WITHDRAWN: "master",
  APPRENTICE_ENROLLED: "apprenticeship",
  APPRENTICE_SUSPENDED: "apprenticeship",
  APPRENTICE_RESUMED: "apprenticeship",
  APPRENTICE_TRANSFERRED: "apprenticeship",
  CREDIT_TRANSFERRED: "apprenticeship",
  PATHWAY_COMPLETED: "apprenticeship",
  MENTORSHIP_ASSIGNED: "mentorship",
  MENTORSHIP_PAUSED: "mentorship",
  MENTORSHIP_RESUMED: "mentorship",
  MENTORSHIP_ENDED: "mentorship",
  ATTENDANCE_MARKED: "practice_record",
  PRACTICE_WORK_SUBMITTED: "practice_work",
  CORE_STEP_ATTESTED: "competency_record",
  COMPETENCY_ASSESSED: "competency_record",
  COMPETENCY_REVIEW_OPENED: "competency_review",
  COMPETENCY_REVIEW_DECIDED: "competency_review",
  ASSESSMENT_EVIDENCE_ATTACHED: "assessment_evidence",
  STIPEND_GRANTED: "stipend",
  STIPEND_REVOKED: "stipend",
  TRIAL_PLACEMENT_STARTED: "placement",
  TRIAL_PLACEMENT_EVALUATED: "placement",
  PLACEMENT_CONFIRMED: "placement"
};

// 受限技法细节禁止出现在任何事件字段中；核心步骤只留完成结论与保管位置
const FORBIDDEN_DETAIL_KEYS = ["technique_detail", "method_detail", "recipe", "formula", "parameters", "secret_knack"];

const PARTIES = ["MASTER", "SCHOOL", "ENTERPRISE"];
const ASSESSMENT_RESULTS = ["PASS", "FAIL", "CONDITIONAL"];

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function findForbiddenKeys(value, path = "") {
  const hits = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN_DETAIL_KEYS.includes(key)) hits.push(here);
      hits.push(...findForbiddenKeys(child, here));
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findForbiddenKeys(item, `${path}[${i}]`)));
  }
  return hits;
}

// 校验单条事件的结构约定
export function validateEvent(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["记录必须是对象"];

  for (const name of REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || !record.event_id) errors.push("event_id 必须是非空字符串");
  if (!(record.event_type in EVENT_AGGREGATE)) errors.push(`未知事件类型：${record.event_type}`);
  if (record.event_type in EVENT_AGGREGATE && record.aggregate_type !== EVENT_AGGREGATE[record.event_type]) {
    errors.push(`事件 ${record.event_type} 必须归属聚合 ${EVENT_AGGREGATE[record.event_type]}，实际为 ${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id) errors.push("aggregate_id 必须是非空字符串");
  if (!isIsoDateTime(record.occurred_at)) errors.push("occurred_at 必须是合法时间");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.summary !== "string" || !record.summary) errors.push("summary 必须是非空字符串");

  const source = record.source;
  if (!source || typeof source !== "object") {
    errors.push("source 必须是追溯块对象");
  } else {
    if (!source.system) errors.push("source.system 缺失");
    if (!source.record_id) errors.push("source.record_id 缺失");
    if (!isIsoDateTime(source.recorded_at)) errors.push("source.recorded_at 必须是合法时间");
    const isBackfill = source.entry_channel === "OFFLINE_BACKFILL" || source.system === "OFFLINE_BACKFILL";
    if (isBackfill) {
      if (!source.batch_id) errors.push("线下补录必须填写 source.batch_id");
      if (!isIsoDateTime(source.imported_at)) errors.push("线下补录必须填写 source.imported_at");
      if (isIsoDateTime(source.imported_at) && Date.parse(source.imported_at) < Date.parse(record.occurred_at)) {
        errors.push("补录录入时间 imported_at 不得早于业务实际发生时间 occurred_at");
      }
    }
  }

  const payload = record.payload ?? {};
  if (record.payload !== undefined && (typeof payload !== "object" || Array.isArray(payload))) {
    errors.push("payload 必须是对象");
    return errors;
  }

  for (const key of findForbiddenKeys(payload)) {
    errors.push(`受限技法细节不得进入事件载荷：payload.${key}`);
  }

  if (record.event_type === "CORE_STEP_ATTESTED") {
    const r = payload.restriction;
    if (!r) {
      errors.push("CORE_STEP_ATTESTED 必须携带 payload.restriction");
    } else {
      if (r.classification !== "RESTRICTED_CORE_TECHNIQUE") errors.push("restriction.classification 必须为 RESTRICTED_CORE_TECHNIQUE");
      if (!["COMPLETED", "NOT_COMPLETED", "WAIVED"].includes(r.conclusion)) errors.push("restriction.conclusion 只能记录完成结论");
      if (!r.vault_location) errors.push("restriction.vault_location 必填（只记保管位置，不记内容）");
      const allowed = new Set(["classification", "conclusion", "vault_location", "custodian_id"]);
      for (const key of Object.keys(r)) {
        if (!allowed.has(key)) errors.push(`核心步骤受限块不得携带技法字段：${key}`);
      }
    }
    if (!payload.step_id) errors.push("CORE_STEP_ATTESTED 必须指明 step_id");
  }

  if (record.event_type === "COMPETENCY_ASSESSED") {
    const list = payload.assessments;
    if (!Array.isArray(list) || list.length === 0) {
      errors.push("COMPETENCY_ASSESSED 至少需要一方评价");
    } else {
      list.forEach((a, i) => {
        if (!PARTIES.includes(a.party)) errors.push(`评价[${i}] party 非法：${a.party}`);
        if (!ASSESSMENT_RESULTS.includes(a.result)) errors.push(`评价[${i}] result 非法：${a.result}`);
      });
    }
  }

  if (record.event_type === "COMPETENCY_REVIEW_OPENED") {
    const parties = payload.divergent_parties ?? [];
    if (!Array.isArray(parties) || parties.length < 2) errors.push("复核受理至少需要两方存在分歧");
    parties.forEach((p, i) => {
      if (!PARTIES.includes(p)) errors.push(`divergent_parties[${i}] 非法：${p}`);
    });
  }

  if (["STIPEND_GRANTED", "STIPEND_REVOKED"].includes(record.event_type) && !payload.dedupe_key) {
    errors.push("津贴事件必须携带 payload.dedupe_key 以防重复发放");
  }

  if (record.correction_of_event_id !== undefined && (typeof record.correction_of_event_id !== "string" || !record.correction_of_event_id)) {
    errors.push("correction_of_event_id 必须是非空字符串");
  }

  return errors;
}

// 校验事件流的跨记录约定：幂等去重、版本单调、补录凭证不重复、更正引用存在
export function validateStream(events) {
  const errors = [];
  const seenEventIds = new Set();
  const seenRecordIds = new Set();
  const seenDedupeKeys = new Set();
  const versions = new Map(); // aggregate_id -> 已接收最大版本

  events.forEach((event, index) => {
    const where = `第 ${index + 1} 条（${event?.event_id ?? "无 event_id"}）`;

    for (const err of validateEvent(event)) errors.push(`${where}：${err}`);
    if (!event) return;

    if (seenEventIds.has(event.event_id)) errors.push(`${where}：event_id 重复 ${event.event_id}`);
    seenEventIds.add(event.event_id);

    const lastVersion = versions.get(event.aggregate_id) ?? 0;
    if (event.version <= lastVersion) {
      errors.push(`${where}：聚合 ${event.aggregate_id} 版本号必须单调递增（已有 ${lastVersion}，收到 ${event.version}）`);
    }
    versions.set(event.aggregate_id, Math.max(lastVersion, event.version));

    const recordKey = `${event.source?.system}:${event.source?.record_id}`;
    if (event.source?.record_id) {
      if (seenRecordIds.has(recordKey)) errors.push(`${where}：来源凭证已存在，不得重复接入 ${recordKey}`);
      seenRecordIds.add(recordKey);
    }

    if (event.event_type === "STIPEND_GRANTED") {
      const key = event.payload?.dedupe_key;
      if (seenDedupeKeys.has(key)) errors.push(`${where}：津贴幂等键重复，禁止重复发放 ${key}`);
      seenDedupeKeys.add(key);
    }

    if (event.correction_of_event_id && !seenEventIds.has(event.correction_of_event_id)) {
      errors.push(`${where}：更正指向的原事件不存在 ${event.correction_of_event_id}`);
    }
  });

  return errors;
}
