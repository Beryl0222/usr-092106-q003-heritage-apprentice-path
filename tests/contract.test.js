import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateStream } from "../src/validator.js";
import { fold, enterpriseView, trainingInvestmentReport } from "../src/projection.js";

const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
const lifecycle = JSON.parse(await readFile(new URL("../data/sample-lifecycle.json", import.meta.url), "utf8"));

test("最小样例符合领域约定", () => {
  assert.deepEqual(validateEvent(sample), []);
});

test("全生命周期样例结构校验与业务投影均无冲突", () => {
  assert.deepEqual(validateStream(lifecycle), []);
  const { errors } = fold(lifecycle);
  assert.deepEqual(errors, []);
});

test("结构校验：事件必须落在所属聚合，且携带追溯块", () => {
  const bad = {
    ...sample,
    event_id: "x-1",
    event_type: "PLACEMENT_CONFIRMED",
    aggregate_type: "apprenticeship"
  };
  assert.match(validateEvent(bad).join("；"), /必须归属聚合 placement/);

  const noSource = { ...sample, event_id: "x-2" };
  delete noSource.source;
  assert.match(validateEvent(noSource).join("；"), /缺少字段：source/);
});

test("线下补录必须带批次与录入时间，且录入不早于发生", () => {
  const bad = {
    ...sample,
    event_id: "x-3",
    occurred_at: "2026-09-21T10:00:00+08:00",
    source: {
      system: "OFFLINE_BACKFILL",
      record_id: "P-1",
      entry_channel: "OFFLINE_BACKFILL",
      recorded_at: "2026-09-21T10:00:00+08:00",
      imported_at: "2026-09-20T08:00:00+08:00"
    }
  };
  const msg = validateEvent(bad).join("；");
  assert.match(msg, /batch_id/);
  assert.match(msg, /不得早于业务实际发生时间/);
});

test("核心步骤只记完成结论与保管位置，技法细节一律拒收", () => {
  const good = lifecycle.find((e) => e.event_type === "CORE_STEP_ATTESTED");
  assert.deepEqual(validateEvent(good), []);

  const leak = structuredClone(good);
  leak.event_id = "x-4";
  leak.payload.recipe = "保密配方内容";
  leak.payload.restriction.method_detail = "手法角度 37 度";
  const msg = validateEvent(leak).join("；");
  assert.match(msg, /payload.recipe/);
  assert.match(msg, /payload.restriction.method_detail/);
});

test("一次打卡不会自动产生能力认定；多方分歧必须进复核", () => {
  const { state, errors } = fold(lifecycle);
  assert.deepEqual(errors, []);
  const rec = state.competencies.get("appr-A001:step-zouchuipi");
  assert.equal(rec.status, "RECOGNIZED_WITH_SCOPE");
  assert.equal(rec.finalDecision.decision, "PASS_WITH_SCOPE");
  assert.equal(rec.finalDecision.recognized_scope, "门店常规出品节拍下的走槌擀皮");
  assert.equal(rec.finalDecision.excluded_scope, "量产高速节拍");
});

test("评价一致也不得自动认定：缺确认环节时保持待确认状态", () => {
  const events = [
    enrollEvent("e1"),
    {
      event_id: "e2", event_type: "CORE_STEP_ATTESTED", aggregate_type: "competency_record",
      aggregate_id: "cr-appr-X-step-a", occurred_at: "2026-09-10T10:00:00+08:00", version: 1,
      summary: "核心步骤", source: studioSource("c1"),
      payload: { apprentice_id: "appr-X", step_id: "step-a", restriction: restricted() }
    },
    {
      event_id: "e3", event_type: "COMPETENCY_ASSESSED", aggregate_type: "competency_record",
      aggregate_id: "cr-appr-X-step-a", occurred_at: "2026-09-11T10:00:00+08:00", version: 2,
      summary: "两方一致通过", source: centerSource("c2"),
      payload: {
        apprentice_id: "appr-X", step_id: "step-a",
        assessments: [
          { party: "MASTER", result: "PASS" },
          { party: "SCHOOL", result: "PASS" }
        ]
      }
    }
  ];
  const { state } = fold(events);
  assert.equal(state.competencies.get("appr-X:step-a").status, "ASSESSED_UNANIMOUS_PENDING_CONFIRM");
});

test("津贴按幂等键去重：线下补录重复发放被拦截", () => {
  const dup = structuredClone(lifecycle.find((e) => e.event_id === "evt-st-A002-202609-backfill"));
  dup.event_id = "evt-st-A002-dup";
  dup.aggregate_id = "st-A002-202609-dup";
  dup.source.record_id = "纸质凭证 PX-QS-2026-09-A002-DUP";
  const errors = validateStream([...lifecycle, dup]);
  assert.match(errors.join("；"), /津贴幂等键重复，禁止重复发放/);

  const { state } = fold(lifecycle);
  assert.equal(state.stipendTotals.get("appr-A002"), 90000);
});

test("师傅带教负荷随休学/复课/转项目/退出及时释放与占用，且不超额", () => {
  const { state } = fold(lifecycle);
  const sm01 = state.masters.get("master-sm-01");
  const sm02 = state.masters.get("master-sm-02");
  assert.equal(sm01.load, 0);
  assert.equal(sm01.withdrawn, true);
  assert.equal(sm02.load, 2); // 陈砚、林禾
  assert.ok(sm02.load <= sm02.capacity);
  assert.equal(state.mentorships.get("ment-A001-sm01").status, "ENDED");
  assert.equal(state.mentorships.get("ment-A002-ph01").status, "ENDED");

  // 超额指派被拒（独立小流：师傅上限 1，两次占用）
  const overload = [
    {
      event_id: "o0", event_type: "MASTER_REGISTERED", aggregate_type: "master",
      aggregate_id: "master-o", occurred_at: "2026-09-03T14:00:00+08:00", version: 1,
      summary: "备案", source: studioSource("mo"),
      payload: { lineage_id: "lineage-x", capacity: 1 }
    },
    enrollEvent("o1", "appr-O1"),
    enrollEvent("o2", "appr-O2"),
    {
      event_id: "o3", event_type: "MENTORSHIP_ASSIGNED", aggregate_type: "mentorship",
      aggregate_id: "ment-o1", occurred_at: "2026-09-06T10:00:00+08:00", version: 1,
      summary: "占用名额", source: studioSource("m1"),
      payload: { apprentice_id: "appr-O1", master_id: "master-o", load_delta: 1 }
    },
    {
      event_id: "o4", event_type: "MENTORSHIP_ASSIGNED", aggregate_type: "mentorship",
      aggregate_id: "ment-o2", occurred_at: "2026-09-06T11:00:00+08:00", version: 1,
      summary: "超额指派", source: studioSource("m2"),
      payload: { apprentice_id: "appr-O2", master_id: "master-o", load_delta: 1 }
    }
  ];
  const { errors } = fold(overload);
  assert.match(errors.join("；"), /超过师傅带教上限/);
});

test("休学、转项目、课程升版保留既往成绩并登记可转认范围", () => {
  const { state } = fold(lifecycle);
  const a001 = state.apprentices.get("appr-A001");
  const a002 = state.apprentices.get("appr-A002");

  assert.equal(a001.curriculumVersionId, "cur-sm-v2");
  const upgrade = a001.creditTransfers.find((t) => t.to_curriculum_version_id === "cur-sm-v2");
  assert.equal(upgrade.recognized[0].restricted_conclusion_retained, true);
  assert.equal(upgrade.not_recognized[0].module_id, "SM103");

  const transfer = a002.creditTransfers.find((t) => t.from_curriculum_version_id === "cur-photo-v1");
  assert.equal(transfer.recognized[0].scope, "general_only");
  assert.equal(transfer.not_recognized[0].module_id, "PH102"); // 受限核心技法不带出工作室
  // 既往摄影考勤与作品仍保留在档案中
  assert.ok(state.practiceRecords.some((r) => r.apprentice_id === "appr-A002"));
});

test("企业视图只见能力结论，不见保管位置与受限细节", () => {
  const { state } = fold(lifecycle);
  const view = enterpriseView(state, "appr-A001");
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /vault_location/);
  assert.doesNotMatch(text, /保密柜/);
  assert.doesNotMatch(text, /custodian/);
  const comp = view.competencies.find((c) => c.step_id === "step-zouchuipi");
  assert.equal(comp.recognized.decision, "PASS_WITH_SCOPE");
  assert.equal(view.placement.status, "FORMAL_EMPLOYMENT");
});

test("正式录用必须有合格试岗评价；管理口径能回答投入是否形成上岗", () => {
  const { state } = fold(lifecycle);
  const report = trainingInvestmentReport(state);
  const a001 = report.find((r) => r.apprentice_id === "appr-A001");
  assert.equal(a001.qualified_for_post, true);
  assert.equal(a001.stipend_total_cents, 120000);
  assert.equal(a001.recognized_competencies, 1);

  // 缺试岗评价直接录用应报错
  const events = [
    enrollEvent("b1", "appr-B"),
    {
      event_id: "b2", event_type: "TRIAL_PLACEMENT_STARTED", aggregate_type: "placement",
      aggregate_id: "pl-B", occurred_at: "2026-09-29T09:00:00+08:00", version: 1,
      summary: "试岗", source: enterpriseSource("p1"),
      payload: { apprentice_id: "appr-B", enterprise_id: "ent-x", trial_from: "2026-09-29", trial_to: "2026-10-03" }
    },
    {
      event_id: "b3", event_type: "PLACEMENT_CONFIRMED", aggregate_type: "placement",
      aggregate_id: "pl-B", occurred_at: "2026-10-04T09:00:00+08:00", version: 2,
      summary: "无评价录用", source: enterpriseSource("p2"),
      payload: { employed_from: "2026-10-04" }
    }
  ];
  const { errors } = fold(events);
  assert.match(errors.join("；"), /未取得试岗评价不得正式录用/);
});

test("更正只能追加后继事件：更正引用必须指向已存在事件", () => {
  const bad = { ...sample, event_id: "x-corr", correction_of_event_id: "evt-not-exist" };
  assert.match(validateStream([bad]).join("；"), /更正指向的原事件不存在/);
});

// ---- 测试夹具 ----
function baseSource(system, id) {
  return { system, record_id: id, entry_channel: "ONLINE", recorded_at: "2026-09-05T09:00:00+08:00" };
}
const centerSource = (id) => baseSource("TALENT_CENTER", id);
const studioSource = (id) => baseSource("MASTER_STUDIO", id);
const enterpriseSource = (id) => baseSource("EMPLOYING_ENTERPRISE", id);

function enrollEvent(id, apprenticeId = "appr-X") {
  return {
    event_id: id,
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "apprenticeship",
    aggregate_id: apprenticeId,
    occurred_at: "2026-09-05T09:30:00+08:00",
    version: 1,
    summary: "入学",
    source: baseSource("SKILL_SCHOOL", `s-${id}`),
    payload: { apprentice_name: "测试学徒", lineage_id: "lineage-x", curriculum_version_id: "cur-x-v1" }
  };
}

function restricted() {
  return {
    classification: "RESTRICTED_CORE_TECHNIQUE",
    conclusion: "COMPLETED",
    vault_location: "工作室保密柜/测试位置",
    custodian_id: "master-x"
  };
}
