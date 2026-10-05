import { readFileSync } from "node:fs";

// 信封校验以契约为准：必填字段与枚举直接读取 contracts/domain.schema.json，
// 避免代码与契约两处维护而漂移。
const schema = JSON.parse(readFileSync(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const REQUIRED = schema.required;
const EVENT_TYPES = schema.properties.event_type.enum;
const AGGREGATE_TYPES = schema.properties.aggregate_type.enum;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function validateEvent(record) {
  const errors = [];
  for (const name of REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if ("event_id" in record && !isNonEmptyString(record.event_id)) errors.push("event_id 必须是非空字符串");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if ("aggregate_id" in record && !isNonEmptyString(record.aggregate_id)) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是可解析的日期时间");
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("summary" in record && !isNonEmptyString(record.summary)) errors.push("summary 必须是非空字符串");
  if ("payload" in record) {
    const p = record.payload;
    if (typeof p !== "object" || p === null || Array.isArray(p)) errors.push("payload 必须是对象");
  }
  return errors;
}
