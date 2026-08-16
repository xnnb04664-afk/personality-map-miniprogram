const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const SESSION_COLLECTION = "assessment_sessions";
const RESULT_COLLECTION = "assessment_results";

const SCALE_DEFS = {
  "ipip-neo-60-zh-local-v1": { version: 1, rounds: 2, itemCount: 60, facetReliability: "exploratory" },
  "ipip-neo-120-zh-v1": { version: 1, rounds: 4, itemCount: 120 },
  "ipip-neo-300-zh-local-v1": { version: 1, rounds: 10, itemCount: 300 },
};
const FACETS = ["N1", "E1", "O1", "A1", "C1", "N2", "E2", "O2", "A2", "C2", "N3", "E3", "O3", "A3", "C3", "N4", "E4", "O4", "A4", "C4", "N5", "E5", "O5", "A5", "C5", "N6", "E6", "O6", "A6", "C6"];
const KEYS = {
  N1: [1, 1, 1, 1, 1, -1, -1, -1, -1, -1], E1: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1],
  O1: [1, 1, 1, 1, 1, 1, -1, -1, -1, -1], A1: [1, 1, 1, -1, 1, 1, 1, -1, -1, -1],
  C1: [1, 1, 1, 1, 1, 1, -1, -1, -1, -1], N2: [1, 1, 1, -1, 1, 1, -1, -1, -1, -1],
  E2: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1], O2: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1],
  A2: [-1, -1, -1, -1, 1, 1, -1, -1, -1, -1], C2: [1, -1, -1, -1, 1, 1, 1, 1, -1, -1],
  N3: [1, 1, 1, -1, 1, 1, 1, 1, -1, -1], E3: [1, 1, 1, -1, 1, 1, -1, -1, -1, -1],
  O3: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1], A3: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1],
  C3: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1], N4: [1, 1, 1, -1, 1, 1, 1, -1, -1, -1],
  E4: [1, 1, 1, -1, 1, 1, -1, -1, -1, -1], O4: [1, -1, -1, -1, 1, 1, 1, -1, -1, -1],
  A4: [-1, -1, -1, -1, 1, 1, 1, -1, -1, -1], C4: [1, 1, -1, -1, 1, 1, 1, 1, 1, -1],
  N5: [1, -1, -1, -1, 1, 1, 1, 1, -1, -1], E5: [1, 1, 1, 1, 1, 1, 1, 1, -1, -1],
  O5: [1, -1, -1, -1, 1, 1, 1, 1, -1, -1], A5: [-1, -1, -1, -1, 1, 1, 1, 1, -1, -1],
  C5: [1, 1, -1, -1, 1, 1, 1, -1, -1, -1], N6: [1, 1, 1, -1, 1, 1, -1, -1, -1, -1],
  E6: [1, 1, 1, 1, 1, 1, 1, 1, -1, -1], O6: [1, 1, 1, 1, 1, 1, -1, -1, -1, -1],
  A6: [1, 1, -1, -1, 1, 1, -1, -1, -1, -1], C6: [-1, -1, -1, -1, 1, 1, 1, -1, -1, -1],
};
const IPIP_NEO_60_KEYS = {
  N1: [1, 1], N2: [1, 1], N3: [1, 1], N4: [1, 1], N5: [-1, -1], N6: [-1, -1],
  E1: [1, 1], E2: [1, -1], E3: [1, 1], E4: [1, 1], E5: [1, 1], E6: [1, 1],
  O1: [1, 1], O2: [1, -1], O3: [1, -1], O4: [-1, -1], O5: [-1, -1], O6: [1, -1],
  A1: [1, 1], A2: [-1, -1], A3: [1, 1], A4: [-1, -1], A5: [-1, -1], A6: [1, 1],
  C1: [1, 1], C2: [1, -1], C3: [1, -1], C4: [1, 1], C5: [1, -1], C6: [-1, -1],
};

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
  const keys = scaleId === "ipip-neo-60-zh-local-v1" ? IPIP_NEO_60_KEYS : KEYS;
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

async function getState(openid) {
  const [sessionResponses, resultResponse] = await Promise.all([
    Promise.all(Object.keys(SCALE_DEFS).map((scaleId) => (
      db.collection(SESSION_COLLECTION).where({ _openid: openid, scaleId, status: "in_progress" }).limit(5).get()
    ))),
    db.collection(RESULT_COLLECTION).where({ _openid: openid }).orderBy("completedAt", "desc").limit(30).get(),
  ]);
  return {
    sessions: sessionResponses.map((response) => preferredSession(response.data)).filter(Boolean).map(cleanDoc),
    results: resultResponse.data.map(cleanDoc),
  };
}

async function upsertSession(openid, input) {
  const def = SCALE_DEFS[input && input.scaleId];
  if (!input || !def || input.scaleVersion !== def.version || typeof input.sessionId !== "string") throw new Error("INVALID_SESSION");
  validateAnswers(input.scaleId, input.answers, false);
  if (await hasCompletedSession(openid, input.sessionId)) return { sessionId: input.sessionId, ignored: true };
  const now = Date.now();
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
  if (existing.data.length) {
    const current = existing.data[0];
    const incomingCount = Object.keys(session.answers).length;
    const currentCount = Object.keys(current.answers || {}).length;
    const explicitRestart = session.sessionId !== current.sessionId && session.startedAt >= current.startedAt;
    if (explicitRestart || incomingCount > currentCount || (incomingCount === currentCount && session.updatedAt >= current.updatedAt)) {
      await db.collection(SESSION_COLLECTION).doc(current._id).set({ data: session });
    }
  } else {
    const documentId = scopedDocumentId(openid, "session", input.scaleId);
    await db.collection(SESSION_COLLECTION).doc(documentId).set({ data: session });
  }
  if (await hasCompletedSession(openid, input.sessionId)) {
    await db.collection(SESSION_COLLECTION).where({ _openid: openid, sessionId: input.sessionId, status: "in_progress" }).remove();
    return { sessionId: input.sessionId, ignored: true };
  }
  return { sessionId: input.sessionId };
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
      case "listResults": data = (await getState(OPENID)).results; break;
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
