const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/assessmentApi/index.js"), "utf8");

test("云端分别读取三种量表的未完成会话", () => {
  assert.match(source, /Promise\.all\(Object\.keys\(SCALE_DEFS\)\.map/);
  assert.doesNotMatch(source, /status: "in_progress" \}\)\.limit\(2\)/);
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
