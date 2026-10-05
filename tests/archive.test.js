import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GrowthArchive } from "../src/archive.js";

let seq = 0;
function ev(partial) {
  seq += 1;
  return {
    event_id: `t-${seq}`,
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "测试事件",
    ...partial,
  };
}

// 按聚合分配递增版本号，贴近真实接入方的行为
function versioner() {
  const seen = new Map();
  return (aggregateType, aggregateId) => {
    const key = `${aggregateType}:${aggregateId}`;
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    return next;
  };
}

/** 造好谱系（一道公开工序 step-open、一道受限工序 step-core）与课程标准 v1。 */
function setup({ maxApprentices = 2 } = {}) {
  const archive = new GrowthArchive();
  const v = versioner();
  const ok = (partial) => {
    const result = archive.receive(ev(partial));
    assert.ok(result.accepted, result.violations.join("；"));
    return result;
  };
  ok({
    event_type: "LINEAGE_REGISTERED",
    aggregate_type: "craft_lineage",
    aggregate_id: "lin-1",
    version: v("craft_lineage", "lin-1"),
    payload: {
      craft_name: "烧麦制作技艺",
      steps: [
        { step_id: "step-open", name: "和面", disclosure: "open" },
        { step_id: "step-core", name: "调馅", disclosure: "restricted" },
      ],
      masters: [{ master_id: "m-1", max_apprentices: maxApprentices }],
    },
  });
  ok({
    event_type: "CURRICULUM_PUBLISHED",
    aggregate_type: "curriculum_version",
    aggregate_id: "curr-v1",
    version: v("curriculum_version", "curr-v1"),
    payload: {
      lineage_id: "lin-1",
      version_no: 1,
      items: [
        { item_id: "step-open", kind: "step" },
        { item_id: "step-core", kind: "step" },
      ],
    },
  });
  return { archive, v, ok };
}

function enroll(ctx, apprenticeId, archiveId, masterId = "m-1") {
  const { v, ok } = ctx;
  ok({
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "apprenticeship",
    aggregate_id: archiveId,
    version: v("apprenticeship", archiveId),
    payload: { apprentice_id: apprenticeId, lineage_id: "lin-1", curriculum_version_id: "curr-v1" },
  });
  ok({
    event_type: "MENTORSHIP_ESTABLISHED",
    aggregate_type: "mentorship",
    aggregate_id: `mship-${apprenticeId}`,
    version: v("mentorship", `mship-${apprenticeId}`),
    payload: { master_id: masterId, apprentice_id: apprenticeId, lineage_id: "lin-1" },
  });
}

function evaluate(ctx, { apprenticeId, item, party, evaluatorId, verdict, custodyRef }) {
  const { v, ok } = ctx;
  const aggregateId = `comp:${apprenticeId}:${item}`;
  return ok({
    event_type: "EVALUATION_SUBMITTED",
    aggregate_type: "competency_record",
    aggregate_id: aggregateId,
    version: v("competency_record", aggregateId),
    payload: {
      apprentice_id: apprenticeId,
      item_ref: item,
      evaluator: { party, id: evaluatorId },
      verdict,
      ...(custodyRef ? { custody_ref: custodyRef } : {}),
    },
  });
}

test("完整样例流程从报名走到正式就业", async () => {
  const flow = JSON.parse(await readFile(new URL("../data/sample-flow.json", import.meta.url), "utf8"));
  const archive = new GrowthArchive();
  for (const event of flow) {
    const result = archive.receive(event);
    assert.ok(result.accepted, `${event.event_id} 被拒：${result.violations.join("；")}`);
  }
  assert.equal(archive.masterLoad.get("master-wang"), 1, "师徒关系存续期间带教负荷保持占用");
  assert.equal(archive.competencies.get("comp:app-li:step-filling").status, "certified");
  assert.equal(archive.allowances.size, 2, "9 月线上发放与 8 月线下补录各记一笔");
  assert.equal(archive.placements.get("placement:app-li").stage, "confirmed");
  assert.equal(archive.apprenticeships.get("appx-li-001").outcome.type, "employed");
});

test("能力认定不能由一次打卡或单一评价自动得出", () => {
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  ok({
    event_type: "PRACTICE_RECORDED",
    aggregate_type: "practice_work",
    aggregate_id: "work-1",
    version: v("practice_work", "work-1"),
    payload: { apprentice_id: "app-1", work_ref: "works/1", step_refs: ["step-open"] },
  });

  // 只有打卡记录、无任何评价：不能认定
  let result = archive.receive(ev({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-open",
    version: 1,
    payload: { apprentice_id: "app-1", item_ref: "step-open", outcome: "certified" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("单次打卡")));

  // 只有师傅一方通过：仍不能认定
  evaluate(ctx, { apprenticeId: "app-1", item: "step-open", party: "master", evaluatorId: "m-1", verdict: "pass" });
  result = archive.receive(ev({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-open",
    version: 2,
    payload: { apprentice_id: "app-1", item_ref: "step-open", outcome: "certified" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("至少两方")));

  // 学校补评通过后，两方一致方可认定
  evaluate(ctx, { apprenticeId: "app-1", item: "step-open", party: "school", evaluatorId: "sch-1", verdict: "pass" });
  ok({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-open",
    version: v("competency_record", "comp:app-1:step-open"),
    payload: { apprentice_id: "app-1", item_ref: "step-open", outcome: "certified" },
  });
  assert.equal(archive.competencies.get("comp:app-1:step-open").status, "certified");
});

test("师傅、学校与企业评价分歧时须复核裁定", () => {
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  evaluate(ctx, { apprenticeId: "app-1", item: "step-open", party: "master", evaluatorId: "m-1", verdict: "pass" });
  evaluate(ctx, { apprenticeId: "app-1", item: "step-open", party: "school", evaluatorId: "sch-1", verdict: "fail" });
  assert.equal(archive.competencies.get("comp:app-1:step-open").status, "disputed");

  // 存在分歧时未经复核直接认定：拒绝
  const result = archive.receive(ev({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-open",
    version: 3,
    payload: { apprentice_id: "app-1", item_ref: "step-open", outcome: "certified" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("复核")));

  // 复核裁定后认定成立
  ok({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-open",
    version: v("competency_record", "comp:app-1:step-open"),
    payload: { apprentice_id: "app-1", item_ref: "step-open", outcome: "certified", review: true },
  });
  assert.equal(archive.competencies.get("comp:app-1:step-open").status, "certified");
});

test("受限工序只记录完成结论与保管位置", () => {
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  const aggregateId = "comp:app-1:step-core";

  // 携带技法细节：拒绝
  let result = archive.receive(ev({
    event_type: "EVALUATION_SUBMITTED",
    aggregate_type: "competency_record",
    aggregate_id: aggregateId,
    version: 1,
    payload: {
      apprentice_id: "app-1",
      item_ref: "step-core",
      evaluator: { party: "master", id: "m-1" },
      verdict: "pass",
      technique_detail: "馅料配比三两七钱……",
    },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("技法细节")));

  // 缺少保管位置：拒绝
  result = archive.receive(ev({
    event_type: "EVALUATION_SUBMITTED",
    aggregate_type: "competency_record",
    aggregate_id: aggregateId,
    version: 1,
    payload: {
      apprentice_id: "app-1",
      item_ref: "step-core",
      evaluator: { party: "master", id: "m-1" },
      verdict: "pass",
    },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("保管位置")));

  // 只记结论与保管位置：两方通过后认定，认定事件同样须带结论与保管位置
  evaluate(ctx, { apprenticeId: "app-1", item: "step-core", party: "master", evaluatorId: "m-1", verdict: "pass", custodyRef: "工作室保密柜 A-3" });
  evaluate(ctx, { apprenticeId: "app-1", item: "step-core", party: "school", evaluatorId: "sch-1", verdict: "pass", custodyRef: "工作室保密柜 A-3" });
  result = archive.receive(ev({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: aggregateId,
    version: 3,
    payload: { apprentice_id: "app-1", item_ref: "step-core", outcome: "certified", custody_ref: "工作室保密柜 A-3" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("完成结论")));

  ok({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: aggregateId,
    version: v("competency_record", aggregateId),
    payload: {
      apprentice_id: "app-1",
      item_ref: "step-core",
      outcome: "certified",
      conclusion: "已完成",
      custody_ref: "工作室保密柜 A-3",
    },
  });
  const record = archive.competencies.get(aggregateId);
  assert.equal(record.status, "certified");
  assert.equal(record.custody_ref, "工作室保密柜 A-3");
});

test("津贴按台账标识去重，线下补录不得重复发放且须注明凭证", () => {
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  const issue = (aggregateId, version, extra = {}) => ({
    event_type: "ALLOWANCE_ISSUED",
    aggregate_type: "allowance_ledger",
    aggregate_id: aggregateId,
    version,
    payload: { apprentice_id: "app-1", period: "2026-09", item: "实训津贴", amount: 800, ...extra },
  });

  ok(issue("allowance:app-1:2026-09:training", 1));

  // 同一期间同一项目再次发放（含补录口径）：拒绝
  for (const extra of [{}, { backfilled: true, source_ref: "线下签到表" }]) {
    const result = archive.receive(ev(issue("allowance:app-1:2026-09:training", 2, extra)));
    assert.ok(!result.accepted);
    assert.ok(result.violations.some((m) => m.includes("不得重复发放")));
  }

  // 补录缺少原始凭证：拒绝；注明凭证的其他期间补录：受理
  let result = archive.receive(ev(issue("allowance:app-1:2026-08:training", 1, { period: "2026-08", backfilled: true })));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("原始凭证")));
  ok(issue("allowance:app-1:2026-08:training", 1, { period: "2026-08", backfilled: true, source_ref: "线下签到表 034" }));
  assert.equal(archive.allowances.size, 2);
});

test("带教负荷随休学、复学、师傅退出及时释放与占用", () => {
  const ctx = setup({ maxApprentices: 1 });
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  assert.equal(archive.masterLoad.get("m-1"), 1);

  // 容量已满，第二名学员无法建立师徒关系
  ok({
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-2",
    version: v("apprenticeship", "appx-2"),
    payload: { apprentice_id: "app-2", lineage_id: "lin-1", curriculum_version_id: "curr-v1" },
  });
  let result = archive.receive(ev({
    event_type: "MENTORSHIP_ESTABLISHED",
    aggregate_type: "mentorship",
    aggregate_id: "mship-app-2",
    version: 1,
    payload: { master_id: "m-1", apprentice_id: "app-2", lineage_id: "lin-1" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("带教负荷已满")));

  // 第一名学员休学：负荷释放，第二名方可入门
  ok({
    event_type: "APPRENTICE_SUSPENDED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: v("apprenticeship", "appx-1"),
    payload: { apprentice_id: "app-1", reason: "因病休学" },
  });
  assert.equal(archive.masterLoad.get("m-1"), 0);
  ok({
    event_type: "MENTORSHIP_ESTABLISHED",
    aggregate_type: "mentorship",
    aggregate_id: "mship-app-2",
    version: v("mentorship", "mship-app-2"),
    payload: { master_id: "m-1", apprentice_id: "app-2", lineage_id: "lin-1" },
  });

  // 负荷已满时复学被拒；师傅退出（结束带教）后释放名额，复学成功
  result = archive.receive(ev({
    event_type: "APPRENTICE_RESUMED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: 3,
    payload: { apprentice_id: "app-1" },
  }));
  assert.ok(!result.accepted);
  ok({
    event_type: "MENTORSHIP_ENDED",
    aggregate_type: "mentorship",
    aggregate_id: "mship-app-2",
    version: v("mentorship", "mship-app-2"),
    payload: { master_id: "m-1", apprentice_id: "app-2", reason: "master_withdrawn" },
  });
  assert.equal(archive.masterLoad.get("m-1"), 0);
  ok({
    event_type: "APPRENTICE_RESUMED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: 3,
    payload: { apprentice_id: "app-1" },
  });
  assert.equal(archive.masterLoad.get("m-1"), 1);
});

test("转项目保留既往成绩并转移带教负荷", () => {
  const ctx = setup({ maxApprentices: 1 });
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  evaluate(ctx, { apprenticeId: "app-1", item: "step-open", party: "master", evaluatorId: "m-1", verdict: "pass" });
  evaluate(ctx, { apprenticeId: "app-1", item: "step-open", party: "school", evaluatorId: "sch-1", verdict: "pass" });
  ok({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-open",
    version: v("competency_record", "comp:app-1:step-open"),
    payload: { apprentice_id: "app-1", item_ref: "step-open", outcome: "certified" },
  });

  // 另一师门（摄影）与课程
  ok({
    event_type: "LINEAGE_REGISTERED",
    aggregate_type: "craft_lineage",
    aggregate_id: "lin-2",
    version: v("craft_lineage", "lin-2"),
    payload: {
      craft_name: "人像摄影技艺",
      steps: [{ step_id: "step-shoot", name: "布光拍摄", disclosure: "open" }],
      masters: [{ master_id: "m-2", max_apprentices: 1 }],
    },
  });
  ok({
    event_type: "CURRICULUM_PUBLISHED",
    aggregate_type: "curriculum_version",
    aggregate_id: "curr-photo-v1",
    version: v("curriculum_version", "curr-photo-v1"),
    payload: { lineage_id: "lin-2", version_no: 1, items: [{ item_id: "step-shoot", kind: "step" }] },
  });

  // 转项目：原师傅负荷释放，既往认定保留
  ok({
    event_type: "APPRENTICE_TRANSFERRED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: v("apprenticeship", "appx-1"),
    payload: { apprentice_id: "app-1", to_lineage_id: "lin-2", to_curriculum_version_id: "curr-photo-v1" },
  });
  assert.equal(archive.masterLoad.get("m-1"), 0);
  assert.equal(archive.mentorships.get("mship-app-1").end_reason, "transferred");
  assert.equal(archive.competencies.get("comp:app-1:step-open").status, "certified", "既往成绩不受转项目影响");

  // 新师门建立师徒关系，占用新师傅负荷
  ok({
    event_type: "MENTORSHIP_ESTABLISHED",
    aggregate_type: "mentorship",
    aggregate_id: "mship-app-1b",
    version: v("mentorship", "mship-app-1b"),
    payload: { master_id: "m-2", apprentice_id: "app-1", lineage_id: "lin-2" },
  });
  assert.equal(archive.masterLoad.get("m-2"), 1);
});

test("课程标准升级后按可转认范围转认，范围外课程项须重新考核", () => {
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  evaluate(ctx, { apprenticeId: "app-1", item: "step-core", party: "master", evaluatorId: "m-1", verdict: "pass", custodyRef: "保密柜 A-3" });
  evaluate(ctx, { apprenticeId: "app-1", item: "step-core", party: "school", evaluatorId: "sch-1", verdict: "pass", custodyRef: "保密柜 A-3" });
  ok({
    event_type: "COMPETENCY_REVIEWED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-core",
    version: v("competency_record", "comp:app-1:step-core"),
    payload: {
      apprentice_id: "app-1",
      item_ref: "step-core",
      outcome: "certified",
      conclusion: "已完成",
      custody_ref: "保密柜 A-3",
    },
  });

  // 标准升级：step-open 全额转认，核心工序 step-core 不随标准迁移
  ok({
    event_type: "CURRICULUM_PUBLISHED",
    aggregate_type: "curriculum_version",
    aggregate_id: "curr-v2",
    version: v("curriculum_version", "curr-v2"),
    payload: { lineage_id: "lin-1", version_no: 2, items: [{ item_id: "step-open", kind: "step" }] },
  });
  ok({
    event_type: "CURRICULUM_SUPERSEDED",
    aggregate_type: "curriculum_version",
    aggregate_id: "curr-v2",
    version: v("curriculum_version", "curr-v2"),
    payload: {
      previous_version_id: "curr-v1",
      transfer_map: [
        { from_item: "step-open", to_item: "step-open", scope: "full" },
        { from_item: "step-core", to_item: null, scope: "none" },
      ],
    },
  });

  // 范围外课程项：拒绝转认；范围内：受理；既往认定依旧保留
  let result = archive.receive(ev({
    event_type: "CREDIT_TRANSFERRED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: 2,
    payload: {
      apprentice_id: "app-1",
      from_curriculum_version_id: "curr-v1",
      to_curriculum_version_id: "curr-v2",
      items: [{ item_ref: "step-core" }],
    },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("不在可转认范围")));

  ok({
    event_type: "CREDIT_TRANSFERRED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: 2,
    payload: {
      apprentice_id: "app-1",
      from_curriculum_version_id: "curr-v1",
      to_curriculum_version_id: "curr-v2",
      items: [{ item_ref: "step-open" }],
    },
  });
  assert.equal(archive.apprenticeships.get("appx-1").transferred_credits.length, 1);
  assert.equal(archive.competencies.get("comp:app-1:step-core").status, "certified", "既往成绩在标准升级后保留");
});

test("事件幂等与版本顺序：重复标识、跳号、回退均被拒", () => {
  const ctx = setup();
  const { archive, v } = ctx;
  const enrolled = ev({
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: v("apprenticeship", "appx-1"),
    payload: { apprentice_id: "app-1", lineage_id: "lin-1", curriculum_version_id: "curr-v1" },
  });
  assert.ok(archive.receive(enrolled).accepted);

  // 同一 event_id 重发：拒绝
  assert.ok(!archive.receive(enrolled).accepted);
  // 版本回退：拒绝；跳号：拒绝
  const base = {
    event_type: "APPRENTICE_SUSPENDED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    payload: { apprentice_id: "app-1", reason: "测试" },
  };
  assert.ok(!archive.receive(ev({ ...base, version: 1 })).accepted);
  assert.ok(!archive.receive(ev({ ...base, version: 3 })).accepted);
  assert.ok(archive.receive(ev({ ...base, version: 2 })).accepted);
});

test("事件与聚合配对及必填字段校验", () => {
  const { archive } = setup();
  // 事件作用于错误的聚合类型
  let result = archive.receive(ev({
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "placement",
    aggregate_id: "appx-1",
    version: 1,
    payload: { apprentice_id: "app-1", lineage_id: "lin-1", curriculum_version_id: "curr-v1" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("应作用于聚合")));

  // payload 缺必填字段
  result = archive.receive(ev({
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: 1,
    payload: { apprentice_id: "app-1" },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("payload 缺少字段：lineage_id")));

  // 未登记的工序不能评价
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  result = ctx.archive.receive(ev({
    event_type: "EVALUATION_SUBMITTED",
    aggregate_type: "competency_record",
    aggregate_id: "comp:app-1:step-unknown",
    version: 1,
    payload: {
      apprentice_id: "app-1",
      item_ref: "step-unknown",
      evaluator: { party: "master", id: "m-1" },
      verdict: "pass",
    },
  }));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("未登记")));
});

test("正式就业须先完成试岗并确认录用", () => {
  const ctx = setup();
  enroll(ctx, "app-1", "appx-1");
  const { archive, v, ok } = ctx;
  const outcome = (type) => ({
    event_type: "EMPLOYMENT_OUTCOME_RECORDED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    version: 2,
    payload: { apprentice_id: "app-1", outcome: type },
  });

  // 无试岗记录直接登记就业：拒绝
  let result = archive.receive(ev(outcome("employed")));
  assert.ok(!result.accepted);
  assert.ok(result.violations.some((m) => m.includes("试岗")));

  // 试岗中但未确认录用：仍拒绝
  ok({
    event_type: "TRIAL_PLACEMENT_STARTED",
    aggregate_type: "placement",
    aggregate_id: "placement:app-1",
    version: v("placement", "placement:app-1"),
    payload: { apprentice_id: "app-1", enterprise_id: "ent-1", position_ref: "面点师助理" },
  });
  result = archive.receive(ev(outcome("employed")));
  assert.ok(!result.accepted);

  // 确认录用后方可登记就业去向
  ok({
    event_type: "PLACEMENT_CONFIRMED",
    aggregate_type: "placement",
    aggregate_id: "placement:app-1",
    version: v("placement", "placement:app-1"),
    payload: { apprentice_id: "app-1", enterprise_id: "ent-1", position_ref: "面点师" },
  });
  ok(outcome("employed"));
  assert.equal(archive.apprenticeships.get("appx-1").outcome.type, "employed");
});
