const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/assessmentApi/index.js"), "utf8");

test("云端同意记录和答案收集受服务端门禁保护", () => {
  assert.match(source, /const CONSENT_COLLECTION = "assessment_consents"/);
  assert.match(source, /case "getConsent": data = await getConsent\(OPENID\)/);
  assert.match(source, /case "saveConsent": data = await saveConsent\(OPENID, event\)/);
  assert.match(source, /await requireConsent\(openid\)/);
  assert.match(source, /answers: input\.answers/);
  assert.match(source, /CONSENT_COLLECTION\)\.where\(\{ _openid: openid \}\)\.remove/);
  assert.match(source, /function cleanResultDoc/);
});

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

test("AI 只接受 resultId 并由云端按 OpenID 读取分数", () => {
  assert.match(source, /case "generateAiInsight": data = await generateAiInsight\(OPENID, event\.resultId\)/);
  assert.match(source, /where\(\{ _openid: openid, resultId \}\)\.limit\(1\)\.get\(\)/);
  assert.match(source, /function scorePayload\(result\)/);
  assert.doesNotMatch(source, /generateAiInsight\(OPENID, event\.(domains|answers|scores)/);
  assert.match(source, /process\.env\.DEEPSEEK_API_KEY/);
});

test("AI 生成使用事务锁、失败冷却和成功缓存", () => {
  assert.match(source, /const AI_LOCK_MS = 2 \* 60 \* 1000/);
  assert.match(source, /const AI_RETRY_MS = 30 \* 1000/);
  assert.match(source, /db\.runTransaction/);
  assert.match(source, /AI_GENERATION_IN_PROGRESS/);
  assert.match(source, /if \(doc\.aiInsight\) return aiResponse\(doc\)/);
  assert.match(source, /aiInsightVersion: AI_INSIGHT_VERSION/);
});

test("AI 输出经固定结构校验与微信内容安全检查后才缓存", () => {
  assert.match(source, /function validateAiInsight/);
  assert.match(source, /value\.keyTraits\.length !== 3/);
  assert.match(source, /requireThreeStrings\(value\.strengths/);
  assert.match(source, /requireThreeStrings\(value\.watchouts/);
  assert.match(source, /requireThreeStrings\(value\.actions/);
  assert.match(source, /cloud\.openapi\.security\.msgSecCheck/);
  assert.ok(source.indexOf("await checkAiContent(openid, insight)") < source.indexOf("cacheAiInsight(doc._id"));
});
