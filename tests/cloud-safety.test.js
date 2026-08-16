const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/assessmentApi/index.js"), "utf8");

test("云端分别读取三种量表的未完成会话", () => {
  assert.match(source, /Promise\.all\(Object\.keys\(SCALE_DEFS\)\.map/);
  assert.doesNotMatch(source, /status: "in_progress" \}\)\.limit\(2\)/);
});

test("云端历史结果按批次完整读取，不再静默限制 30 条", () => {
  assert.match(source, /async function listStoredResults/);
  assert.match(source, /\.skip\(offset\)[\s\S]*?\.limit\(RESULT_PAGE_SIZE \+ 1\)/);
  assert.match(source, /resultsHasMore: resultPage\.hasMore/);
  assert.match(source, /case "listResults": data = await listStoredResults\(OPENID, event\.offset\)/);
  assert.doesNotMatch(source, /\.limit\(30\)/);
});

test("云端同答题数冲突使用服务端版本而非设备时钟", () => {
  assert.match(source, /baseServerUpdatedAt/);
  assert.match(source, /basedOnCurrentServerVersion/);
  assert.match(source, /accepted, session: cleanDoc\(storedSession\)/);
});

test("云端在草稿写入前后检查完成记录", () => {
  const checks = source.match(/await hasCompletedSession\(openid, input\.sessionId\)/g) || [];
  assert.equal(checks.length, 2);
  assert.match(source, /where\(\{ _openid: openid, sessionId: input\.sessionId, status: "in_progress" \}\)\.remove/);
});

test("结果使用用户隔离的确定性文档 ID 实现幂等写入", () => {
  assert.match(source, /scopedDocumentId\(openid, "result", input\.resultId\)/);
  assert.match(source, /crypto\.createHash\("sha256"\)/);
});
