import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GrowthArchive } from "../src/archive.js";
import { regulatorSummary, viewAllowance, viewCompetencyRecord } from "../src/views.js";

async function archiveFromSampleFlow() {
  const flow = JSON.parse(await readFile(new URL("../data/sample-flow.json", import.meta.url), "utf8"));
  const archive = new GrowthArchive();
  for (const event of flow) {
    const result = archive.receive(event);
    assert.ok(result.accepted, `${event.event_id} 被拒：${result.violations.join("；")}`);
  }
  return archive;
}

test("企业查看受限工序只见完成结论，不见保管位置与评价细节", async () => {
  const archive = await archiveFromSampleFlow();
  const record = archive.competencies.get("comp:app-li:step-filling");

  const enterpriseView = viewCompetencyRecord("enterprise", record);
  assert.deepEqual(enterpriseView, {
    apprentice_id: "app-li",
    item_ref: "step-filling",
    disclosure: "restricted",
    conclusion: "已完成",
  });
  assert.ok(!("custody_ref" in enterpriseView), "企业无权查看受限工序的保管位置");
  assert.ok(!("evaluations" in enterpriseView), "企业无权查看受限工序的评价细节");

  const masterView = viewCompetencyRecord("master", record);
  assert.equal(masterView.custody_ref, "锦馨园工作室保密柜 A-3");
  assert.equal(masterView.evaluations.length, 2);
});

test("公开工序对各角色可见，津贴对企业不可见", async () => {
  const archive = await archiveFromSampleFlow();
  const openRecord = archive.competencies.get("comp:app-li:step-knead");
  const enterpriseView = viewCompetencyRecord("enterprise", openRecord);
  assert.equal(enterpriseView.disclosure, "open");
  assert.equal(enterpriseView.evaluations.length, 2);

  const allowance = archive.allowances.get("allowance:app-li:2026-09:training");
  assert.equal(viewAllowance("enterprise", allowance), null);
  assert.equal(viewAllowance("school", allowance).amount, 800);
  assert.equal(viewAllowance("service_center", allowance).period, "2026-09");

  assert.throws(() => viewCompetencyRecord("stranger", openRecord), RangeError);
});

test("管理部门汇总：培训投入与合格上岗一账可查", async () => {
  const archive = await archiveFromSampleFlow();
  const summary = regulatorSummary(archive);
  assert.deepEqual(summary, {
    apprentices_total: 1,
    apprentices_active: 1,
    apprentices_suspended: 0,
    competencies_certified: 2,
    competencies_in_review: 0,
    allowances_issued: 2,
    allowances_amount_total: 1600,
    placements_trial: 0,
    placements_confirmed: 1,
    outcomes: { employed: 1, further_study: 0, exited: 0 },
  });
});
