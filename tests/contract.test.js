import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_CATALOG } from "../src/events.js";
import { validateEvent } from "../src/validator.js";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("样例符合领域约定", async () => {
  const sample = await readJson("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("完整样例流程的每条事件都符合信封契约", async () => {
  const flow = await readJson("../data/sample-flow.json");
  assert.ok(flow.length > 0);
  for (const event of flow) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 不符合信封契约`);
  }
});

test("事件目录与契约枚举保持同步", async () => {
  const schema = await readJson("../contracts/domain.schema.json");
  const eventTypes = schema.properties.event_type.enum;
  const aggregateTypes = schema.properties.aggregate_type.enum;
  for (const [eventType, spec] of Object.entries(EVENT_CATALOG)) {
    assert.ok(eventTypes.includes(eventType), `契约缺少事件类型 ${eventType}`);
    assert.ok(aggregateTypes.includes(spec.aggregate), `契约缺少聚合类型 ${spec.aggregate}`);
  }
  for (const eventType of eventTypes) {
    assert.ok(EVENT_CATALOG[eventType], `事件目录缺少 ${eventType} 的聚合与必填字段定义`);
  }
});

test("信封校验拒绝缺字段与非法枚举", () => {
  assert.ok(validateEvent({}).length > 0);
  const base = {
    event_id: "x-1",
    event_type: "APPRENTICE_ENROLLED",
    aggregate_type: "apprenticeship",
    aggregate_id: "appx-1",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "测试",
  };
  assert.deepEqual(validateEvent(base), []);
  assert.ok(validateEvent({ ...base, event_type: "NOPE" }).some((e) => e.includes("未知事件类型")));
  assert.ok(validateEvent({ ...base, aggregate_type: "nope" }).some((e) => e.includes("未知聚合类型")));
  assert.ok(validateEvent({ ...base, occurred_at: "不是日期" }).some((e) => e.includes("occurred_at")));
  assert.ok(validateEvent({ ...base, version: 0 }).some((e) => e.includes("version")));
});
