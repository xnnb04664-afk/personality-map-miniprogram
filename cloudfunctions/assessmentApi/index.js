const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const SCALE_CONFIG = require("./scale-keys.json");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const SESSION_COLLECTION = "assessment_sessions";
const RESULT_COLLECTION = "assessment_results";
const RESULT_PAGE_SIZE = 50;

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
    collectionsReady = Promise.all([SESSION_COLLECTION, RESULT_COLLECTION].map(async (name) => {
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

function cleanDoc(doc) {
  if (!doc) return null;
  const { _id, _openid, ...safe } = doc;
  return safe;
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
  const results = response.data.slice(0, RESULT_PAGE_SIZE).map(cleanDoc);
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
    const explicitRestart = session.sessionId !== current.sessionId && session.startedAt >= current.startedAt;
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
    domains: input.domains,
    completedAt: Number(input.completedAt) || Date.now(),
    serverUpdatedAt: Date.now(),
  };
  const existing = await db.collection(RESULT_COLLECTION).where({ _openid: openid, resultId: input.resultId }).limit(1).get();
  if (existing.data.length) await db.collection(RESULT_COLLECTION).doc(existing.data[0]._id).set({ data: result });
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
  return response.data.length ? cleanDoc(response.data[0]) : null;
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
      case "getState": data = await getState(OPENID); break;
      case "upsertSession": data = await upsertSession(OPENID, event.session); break;
      case "completeSession": data = await completeSession(OPENID, event.result); break;
      case "getResult": data = await getResult(OPENID, event.resultId); break;
      case "listResults": data = await listStoredResults(OPENID, event.offset); break;
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
