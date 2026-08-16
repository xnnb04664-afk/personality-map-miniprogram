const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const https = require("https");
const SCALE_CONFIG = require("./scale-keys.json");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const SESSION_COLLECTION = "assessment_sessions";
const RESULT_COLLECTION = "assessment_results";
const CONSENT_COLLECTION = "assessment_consents";
const CONSENT_VERSION = "v1";
const CONSENT_SCOPES = ["openid", "answers", "scores"];
const RESULT_PAGE_SIZE = 50;
const AI_INSIGHT_VERSION = 1;
const AI_LOCK_MS = 2 * 60 * 1000;
const AI_RETRY_MS = 30 * 1000;
const AI_REQUEST_TIMEOUT_MS = 25 * 1000;

const FACETS = SCALE_CONFIG.facets;
const SCALE_DEFS = {};
Object.keys(SCALE_CONFIG.scales).forEach((scaleId) => {
  const config = SCALE_CONFIG.scales[scaleId];
  SCALE_DEFS[scaleId] = {
    version: config.version,
    rounds: config.rounds,
    itemCount: config.itemCount,
    facetReliability: config.facetReliability,
  };
});

let collectionsReady;
async function ensureCollections() {
  if (!collectionsReady) {
    collectionsReady = Promise.all([SESSION_COLLECTION, RESULT_COLLECTION, CONSENT_COLLECTION].map(async (name) => {
      try { await db.createCollection(name); } catch (error) { /* 已存在时继续 */ }
    }));
  }
  return collectionsReady;
}

function expectedIds(scaleId) {
  const def = SCALE_DEFS[scaleId];
  const ids = new Set();
  for (let round = 1; round <= def.rounds; round += 1) {
    FACETS.forEach((facet) => ids.add(`${scaleId}-${facet}-${round}`));
  }
  return ids;
}

function validateAnswers(scaleId, answers, complete) {
  const def = SCALE_DEFS[scaleId];
  if (!def || !answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("INVALID_ANSWERS");
  const validIds = expectedIds(scaleId);
  const keys = Object.keys(answers);
  keys.forEach((id) => {
    const value = answers[id];
    if (!validIds.has(id) || !Number.isInteger(value) || value < 1 || value > 5) throw new Error("INVALID_ANSWER_VALUE");
  });
  if (complete && keys.length !== def.itemCount) throw new Error("INCOMPLETE_ANSWERS");
}

function validateDomains(domains) {
  if (!Array.isArray(domains) || domains.length !== 5) throw new Error("INVALID_SCORES");
  const ids = new Set(domains.map((domain) => domain.id));
  if (["N", "E", "O", "A", "C"].some((id) => !ids.has(id))) throw new Error("INVALID_SCORES");
  domains.forEach((domain) => {
    if (!Number.isInteger(domain.score) || domain.score < 0 || domain.score > 100) throw new Error("INVALID_SCORES");
    if (!Array.isArray(domain.facets) || domain.facets.length !== 6) throw new Error("INVALID_SCORES");
  });
}

function calculateScores(scaleId, answers) {
  const rounds = SCALE_DEFS[scaleId].rounds;
  const keys = SCALE_CONFIG.scales[scaleId].keys;
  const facetScores = {};
  FACETS.forEach((facet) => {
    let sum = 0;
    for (let round = 1; round <= rounds; round += 1) {
      const raw = answers[`${scaleId}-${facet}-${round}`];
      sum += keys[facet][round - 1] === 1 ? raw : 6 - raw;
    }
    facetScores[facet] = Math.round(((sum - rounds) / (rounds * 4)) * 100);
  });
  const domains = {};
  ["N", "E", "O", "A", "C"].forEach((domain) => {
    const values = Object.keys(facetScores).filter((facet) => facet[0] === domain).map((facet) => facetScores[facet]);
    domains[domain] = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  });
  return { domains, facets: facetScores };
}

function verifyScores(scaleId, answers, domains) {
  const calculated = calculateScores(scaleId, answers);
  domains.forEach((domain) => {
    if (calculated.domains[domain.id] !== domain.score) throw new Error("SCORE_MISMATCH");
    domain.facets.forEach((facet) => {
      if (calculated.facets[facet.id] !== facet.score) throw new Error("SCORE_MISMATCH");
    });
  });
}

function requireText(value, field, minLength, maxLength) {
  if (typeof value !== "string") throw new Error("AI_INVALID_RESPONSE");
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength) throw new Error("AI_INVALID_RESPONSE");
  return text;
}

function requireThreeStrings(value, field, maxLength) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("AI_INVALID_RESPONSE");
  return value.map((item, index) => requireText(item, `${field}.${index}`, 4, maxLength));
}

function validateAiInsight(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI_INVALID_RESPONSE");
  if (!Array.isArray(value.keyTraits) || value.keyTraits.length !== 3) throw new Error("AI_INVALID_RESPONSE");
  if (!value.contexts || typeof value.contexts !== "object" || Array.isArray(value.contexts)) throw new Error("AI_INVALID_RESPONSE");
  const insight = {
    title: requireText(value.title, "title", 4, 48),
    overview: requireText(value.overview, "overview", 30, 700),
    keyTraits: value.keyTraits.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("AI_INVALID_RESPONSE");
      return {
        name: requireText(item.name, "keyTraits.name", 2, 32),
        evidence: requireText(item.evidence, "keyTraits.evidence", 8, 180),
      };
    }),
    strengths: requireThreeStrings(value.strengths, "strengths", 150),
    watchouts: requireThreeStrings(value.watchouts, "watchouts", 150),
    contexts: {
      relationships: requireText(value.contexts.relationships, "contexts.relationships", 10, 260),
      workStudy: requireText(value.contexts.workStudy, "contexts.workStudy", 10, 260),
      stress: requireText(value.contexts.stress, "contexts.stress", 10, 260),
    },
    actions: requireThreeStrings(value.actions, "actions", 160),
  };
  const allText = JSON.stringify(insight);
  if (allText.length > 4200) throw new Error("AI_INVALID_RESPONSE");
  const prohibited = [
    /确诊|诊断为|诊断结论/,
    /治疗方案|治疗建议|用药建议|服药/,
    /固定人格类型|人格类型是|属于.{0,8}型人格|[A-Z]{4}型人格/i,
    /人群百分位|第\s*\d+\s*百分位|超过\s*\d+\s*%\s*的人/,
    /(招聘|录用|升学).{0,16}(适合|不适合|建议|决定|结论)/,
    /(适合|不适合).{0,10}(职业|岗位|专业)/,
  ];
  if (prohibited.some((pattern) => pattern.test(allText))) throw new Error("AI_INVALID_RESPONSE");
  return insight;
}

function scorePayload(result) {
  return {
    scaleId: result.scaleId,
    scaleVersion: result.scaleVersion,
    domains: (result.domains || []).map((domain) => ({
      id: domain.id,
      score: domain.score,
      facets: (domain.facets || []).map((facet) => ({ id: facet.id, score: facet.score })),
    })),
  };
}

function deepSeekMessages(result) {
  const system = [
    "你是严谨、中性的人格量表报告撰写助手。只依据给定的大五维度与分面分数进行描述，不猜测用户身份或经历。",
    "分数是0到100的量表位置，不是人群百分位。不得给出心理诊断、治疗或用药建议，不得定义固定人格类型，不得作招聘、升学、岗位或职业适配结论。",
    "避免好坏评判和绝对断言，使用可能、倾向、在某些情境下等措辞。行动建议必须具体、低风险且可自行尝试。",
    "只输出一个JSON对象，不要Markdown。结构必须是：title字符串；overview字符串；keyTraits为3个{name,evidence}；strengths为3个字符串；watchouts为3个字符串；contexts包含relationships、workStudy、stress三个字符串；actions为3个字符串。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(scorePayload(result)) },
  ];
}

function requestDeepSeek(result, apiKey) {
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: deepSeekMessages(result),
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0.2,
    max_tokens: 1800,
  });
  return new Promise((resolve, reject) => {
    const request = https.request("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 256000) request.destroy(new Error("AI_SERVICE_ERROR"));
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("AI_SERVICE_ERROR"));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
          if (typeof content !== "string") throw new Error("AI_INVALID_RESPONSE");
          resolve(content);
        } catch (error) {
          reject(new Error(error.message === "AI_INVALID_RESPONSE" ? error.message : "AI_INVALID_RESPONSE"));
        }
      });
    });
    request.setTimeout(AI_REQUEST_TIMEOUT_MS, () => request.destroy(new Error("AI_REQUEST_TIMEOUT")));
    request.on("error", (error) => reject(new Error(error.message === "AI_REQUEST_TIMEOUT" ? "AI_REQUEST_TIMEOUT" : "AI_SERVICE_ERROR")));
    request.write(body);
    request.end();
  });
}

async function checkAiContent(openid, insight) {
  const content = [
    insight.title,
    insight.overview,
    ...insight.keyTraits.flatMap((item) => [item.name, item.evidence]),
    ...insight.strengths,
    ...insight.watchouts,
    insight.contexts.relationships,
    insight.contexts.workStudy,
    insight.contexts.stress,
    ...insight.actions,
  ].join("\n");
  for (let offset = 0; offset < content.length; offset += 1800) {
    let checked;
    try {
      checked = await cloud.openapi.security.msgSecCheck({ content: content.slice(offset, offset + 1800), version: 2, scene: 2, openid });
    } catch (error) {
      throw new Error("AI_CONTENT_CHECK_FAILED");
    }
    if (!checked || !checked.result || checked.result.suggest !== "pass") throw new Error("AI_CONTENT_REJECTED");
  }
}

function aiResponse(result) {
  return {
    aiInsight: result.aiInsight,
    aiInsightVersion: result.aiInsightVersion,
    aiGeneratedAt: result.aiGeneratedAt,
    aiStatus: result.aiStatus || { state: "ready" },
  };
}

function assertAiGenerationAvailable(result, now) {
  if (result.aiInsight) return;
  const status = result.aiStatus || {};
  if (status.state === "generating" && now - Number(status.lockedAt || 0) < AI_LOCK_MS) throw new Error("AI_GENERATION_IN_PROGRESS");
  if (status.state === "failed" && Number(status.retryAfter || 0) > now) throw new Error("AI_RETRY_LATER");
}

async function acquireAiLock(doc) {
  const now = Date.now();
  const token = crypto.randomBytes(16).toString("hex");
  let cached = null;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.collection(RESULT_COLLECTION).doc(doc._id).get();
    const current = snapshot.data;
    if (!current || current._openid !== doc._openid || current.resultId !== doc.resultId) throw new Error("INVALID_RESULT_ID");
    if (current.aiInsight) {
      cached = current;
      return;
    }
    assertAiGenerationAvailable(current, now);
    await transaction.collection(RESULT_COLLECTION).doc(doc._id).update({ data: { aiStatus: { state: "generating", lockedAt: now, token } } });
  });
  return { token, cached };
}

async function markAiFailure(docId, token, errorCode) {
  const now = Date.now();
  try {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.collection(RESULT_COLLECTION).doc(docId).get();
      const current = snapshot.data;
      if (!current || !current.aiStatus || current.aiStatus.token !== token) return;
      await transaction.collection(RESULT_COLLECTION).doc(docId).update({
        data: { aiStatus: { state: "failed", failedAt: now, retryAfter: now + AI_RETRY_MS, error: errorCode } },
      });
    });
  } catch (error) {
    console.error("markAiFailure", error.message);
  }
}

async function cacheAiInsight(docId, token, insight) {
  const generatedAt = Date.now();
  let stored;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.collection(RESULT_COLLECTION).doc(docId).get();
    const current = snapshot.data;
    if (!current) throw new Error("INVALID_RESULT_ID");
    if (current.aiInsight) {
      stored = current;
      return;
    }
    if (!current.aiStatus || current.aiStatus.token !== token) throw new Error("AI_GENERATION_IN_PROGRESS");
    const fields = {
      aiInsight: insight,
      aiInsightVersion: AI_INSIGHT_VERSION,
      aiGeneratedAt: generatedAt,
      aiStatus: { state: "ready", generatedAt },
    };
    await transaction.collection(RESULT_COLLECTION).doc(docId).update({ data: fields });
    stored = { ...current, ...fields };
  });
  return stored;
}

async function generateAiInsight(openid, resultId) {
  if (typeof resultId !== "string" || !resultId) throw new Error("INVALID_RESULT_ID");
  const apiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) throw new Error("AI_NOT_CONFIGURED");
  const response = await db.collection(RESULT_COLLECTION).where({ _openid: openid, resultId }).limit(1).get();
  if (!response.data.length) throw new Error("INVALID_RESULT_ID");
  const doc = response.data[0];
  if (doc.aiInsight) return aiResponse(doc);
  const lock = await acquireAiLock(doc);
  if (lock.cached) return aiResponse(lock.cached);

  try {
    const raw = await requestDeepSeek(doc, apiKey);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error("AI_INVALID_RESPONSE"); }
    const insight = validateAiInsight(parsed);
    await checkAiContent(openid, insight);
    return aiResponse(await cacheAiInsight(doc._id, lock.token, insight));
  } catch (error) {
    const code = String(error && error.message || "AI_SERVICE_ERROR");
    await markAiFailure(doc._id, lock.token, code);
    const publicErrors = new Set(["AI_INVALID_RESPONSE", "AI_CONTENT_REJECTED", "AI_CONTENT_CHECK_FAILED", "AI_REQUEST_TIMEOUT", "AI_GENERATION_IN_PROGRESS"]);
    throw new Error(publicErrors.has(code) ? code : "AI_SERVICE_ERROR");
  }
}

function cleanDoc(doc) {
  if (!doc) return null;
  const { _id, _openid, ...safe } = doc;
  return safe;
}

function cleanResultDoc(doc) {
  const safe = cleanDoc(doc);
  if (safe) delete safe.answers;
  return safe;
}

async function getConsent(openid) {
  const response = await db.collection(CONSENT_COLLECTION).where({ _openid: openid, consentVersion: CONSENT_VERSION }).limit(1).get();
  if (!response.data.length) return { accepted: false, consentVersion: CONSENT_VERSION, scopes: CONSENT_SCOPES };
  const consent = response.data[0];
  return { accepted: true, consentVersion: consent.consentVersion, scopes: consent.scopes, acceptedAt: consent.acceptedAt };
}

async function requireConsent(openid) {
  const consent = await getConsent(openid);
  if (!consent.accepted) throw new Error("CONSENT_REQUIRED");
  return consent;
}

async function saveConsent(openid, input) {
  if (!input || input.consentVersion !== CONSENT_VERSION || !Array.isArray(input.scopes)
    || input.scopes.length !== CONSENT_SCOPES.length || input.scopes.some((scope) => !CONSENT_SCOPES.includes(scope))) {
    throw new Error("INVALID_CONSENT");
  }
  const acceptedAt = Date.now();
  const consent = {
    _openid: openid,
    consentVersion: CONSENT_VERSION,
    scopes: CONSENT_SCOPES,
    acceptedAt,
    revokedAt: null,
  };
  await db.collection(CONSENT_COLLECTION).doc(scopedDocumentId(openid, "consent", CONSENT_VERSION)).set({ data: consent });
  return { accepted: true, consentVersion: CONSENT_VERSION, scopes: CONSENT_SCOPES, acceptedAt };
}

function scopedDocumentId(openid, scope, value) {
  return crypto.createHash("sha256").update(`${openid}:${scope}:${value}`).digest("hex");
}

function preferredSession(docs) {
  return docs.reduce((preferred, candidate) => {
    if (!preferred) return candidate;
    const preferredCount = Object.keys(preferred.answers || {}).length;
    const candidateCount = Object.keys(candidate.answers || {}).length;
    if (candidateCount !== preferredCount) return candidateCount > preferredCount ? candidate : preferred;
    return candidate.updatedAt > preferred.updatedAt ? candidate : preferred;
  }, null);
}

async function hasCompletedSession(openid, sessionId) {
  if (!sessionId) return false;
  const response = await db.collection(RESULT_COLLECTION).where({ _openid: openid, sessionId }).limit(1).get();
  return response.data.length > 0;
}

async function listStoredResults(openid, requestedOffset = 0) {
  const offset = Math.max(0, Math.floor(Number(requestedOffset) || 0));
  const response = await db.collection(RESULT_COLLECTION)
    .where({ _openid: openid })
    .orderBy("completedAt", "desc")
    .skip(offset)
    .limit(RESULT_PAGE_SIZE + 1)
    .get();
  const hasMore = response.data.length > RESULT_PAGE_SIZE;
  const results = response.data.slice(0, RESULT_PAGE_SIZE).map(cleanResultDoc);
  return { results, hasMore, nextOffset: hasMore ? offset + results.length : null };
}

async function getState(openid) {
  const [sessionResponses, resultPage] = await Promise.all([
    Promise.all(Object.keys(SCALE_DEFS).map((scaleId) => (
      db.collection(SESSION_COLLECTION).where({ _openid: openid, scaleId, status: "in_progress" }).limit(5).get()
    ))),
    listStoredResults(openid),
  ]);
  return {
    sessions: sessionResponses.map((response) => preferredSession(response.data)).filter(Boolean).map(cleanDoc),
    results: resultPage.results,
    resultsHasMore: resultPage.hasMore,
    resultsNextOffset: resultPage.nextOffset,
  };
}

async function upsertSession(openid, input) {
  const def = SCALE_DEFS[input && input.scaleId];
  if (!input || !def || input.scaleVersion !== def.version || typeof input.sessionId !== "string") throw new Error("INVALID_SESSION");
  await requireConsent(openid);
  validateAnswers(input.scaleId, input.answers, false);
  if (await hasCompletedSession(openid, input.sessionId)) {
    await db.collection(SESSION_COLLECTION).where({ _openid: openid, sessionId: input.sessionId, status: "in_progress" }).remove();
    return { sessionId: input.sessionId, ignored: true };
  }
  const now = Date.now();
  const baseServerUpdatedAt = Number(input.serverUpdatedAt) || 0;
  const session = {
    _openid: openid,
    sessionId: input.sessionId,
    scaleId: input.scaleId,
    scaleVersion: input.scaleVersion,
    answers: input.answers,
    currentIndex: Math.max(0, Math.min(def.itemCount - 1, Number(input.currentIndex) || 0)),
    status: "in_progress",
    startedAt: Number(input.startedAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    serverUpdatedAt: now,
  };
  const existing = await db.collection(SESSION_COLLECTION).where({ _openid: openid, scaleId: input.scaleId, status: "in_progress" }).limit(1).get();
  let accepted = true;
  let storedSession = session;
  if (existing.data.length) {
    const current = existing.data[0];
    const incomingCount = Object.keys(session.answers).length;
    const currentCount = Object.keys(current.answers || {}).length;
    const explicitRestart = session.sessionId !== current.sessionId && (input.restart === true || session.startedAt >= current.startedAt);
    const sameSessionUpdate = session.sessionId === current.sessionId && incomingCount === currentCount;
    const basedOnCurrentServerVersion = baseServerUpdatedAt && baseServerUpdatedAt >= Number(current.serverUpdatedAt || 0);
    const legacyTimestampFallback = !current.serverUpdatedAt && session.updatedAt >= current.updatedAt;
    if (explicitRestart || incomingCount > currentCount || (sameSessionUpdate && (basedOnCurrentServerVersion || legacyTimestampFallback))) {
      await db.collection(SESSION_COLLECTION).doc(current._id).set({ data: session });
    } else {
      accepted = false;
      storedSession = current;
    }
  } else {
    const documentId = scopedDocumentId(openid, "session", input.scaleId);
    await db.collection(SESSION_COLLECTION).doc(documentId).set({ data: session });
  }
  if (await hasCompletedSession(openid, input.sessionId)) {
    await db.collection(SESSION_COLLECTION).where({ _openid: openid, sessionId: input.sessionId, status: "in_progress" }).remove();
    return { sessionId: input.sessionId, ignored: true };
  }
  return { sessionId: input.sessionId, accepted, session: cleanDoc(storedSession) };
}

async function completeSession(openid, input) {
  const def = SCALE_DEFS[input && input.scaleId];
  if (!input || !def || input.scaleVersion !== def.version || typeof input.resultId !== "string") throw new Error("INVALID_RESULT");
  await requireConsent(openid);
  validateAnswers(input.scaleId, input.answers, true);
  validateDomains(input.domains);
  verifyScores(input.scaleId, input.answers, input.domains);
  const result = {
    _openid: openid,
    resultId: input.resultId,
    sessionId: String(input.sessionId || ""),
    scaleId: input.scaleId,
    scaleVersion: input.scaleVersion,
    scaleTitle: String(input.scaleTitle || ""),
    itemCount: def.itemCount,
    facetReliability: def.facetReliability || "standard",
    answers: input.answers,
    domains: input.domains,
    completedAt: Number(input.completedAt) || Date.now(),
    serverUpdatedAt: Date.now(),
  };
  const existing = await db.collection(RESULT_COLLECTION).where({ _openid: openid, resultId: input.resultId }).limit(1).get();
  if (existing.data.length) {
    const current = existing.data[0];
    ["aiInsight", "aiInsightVersion", "aiGeneratedAt", "aiStatus"].forEach((field) => {
      if (current[field] !== undefined) result[field] = current[field];
    });
    await db.collection(RESULT_COLLECTION).doc(current._id).set({ data: result });
  }
  else {
    const documentId = scopedDocumentId(openid, "result", input.resultId);
    await db.collection(RESULT_COLLECTION).doc(documentId).set({ data: result });
  }
  await db.collection(SESSION_COLLECTION).where({ _openid: openid, sessionId: input.sessionId }).remove();
  return { resultId: input.resultId };
}

async function getResult(openid, resultId) {
  if (typeof resultId !== "string") throw new Error("INVALID_RESULT_ID");
  const response = await db.collection(RESULT_COLLECTION).where({ _openid: openid, resultId }).limit(1).get();
  return response.data.length ? cleanResultDoc(response.data[0]) : null;
}

async function deleteResult(openid, resultId) {
  if (typeof resultId !== "string") throw new Error("INVALID_RESULT_ID");
  await db.collection(RESULT_COLLECTION).where({ _openid: openid, resultId }).remove();
  return { resultId };
}

async function deleteAll(openid) {
  await Promise.all([
    db.collection(SESSION_COLLECTION).where({ _openid: openid }).remove(),
    db.collection(RESULT_COLLECTION).where({ _openid: openid }).remove(),
    db.collection(CONSENT_COLLECTION).where({ _openid: openid }).remove(),
  ]);
  return { deleted: true };
}

exports.main = async (event) => {
  try {
    await ensureCollections();
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) throw new Error("UNAUTHENTICATED");
    let data;
    switch (event.action) {
      case "getConsent": data = await getConsent(OPENID); break;
      case "saveConsent": data = await saveConsent(OPENID, event); break;
      case "getState": data = await getState(OPENID); break;
      case "upsertSession": data = await upsertSession(OPENID, event.session); break;
      case "completeSession": data = await completeSession(OPENID, event.result); break;
      case "getResult": data = await getResult(OPENID, event.resultId); break;
      case "listResults": data = await listStoredResults(OPENID, event.offset); break;
      case "generateAiInsight": data = await generateAiInsight(OPENID, event.resultId); break;
      case "deleteResult": data = await deleteResult(OPENID, event.resultId); break;
      case "deleteAll": data = await deleteAll(OPENID); break;
      default: throw new Error("UNKNOWN_ACTION");
    }
    return { ok: true, data };
  } catch (error) {
    console.error("assessmentApi", event.action, error);
    return { ok: false, error: error.message || "INTERNAL_ERROR" };
  }
};
