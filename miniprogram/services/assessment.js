const storage = require("../utils/storage");
const { getScale } = require("../data/scales");
const { validateAnswers, scoreAssessment } = require("../utils/scoring");

const CLOUD_TIMEOUT_MS = 12000;
const AI_CLOUD_TIMEOUT_MS = 32000;
const PERMANENT_RESULT_ERRORS = new Set([
  "INVALID_RESULT", "INVALID_ANSWERS", "INVALID_ANSWER_VALUE", "INCOMPLETE_ANSWERS", "INVALID_SCORES", "SCORE_MISMATCH",
]);
const syncTimers = new Map();
const completedSessionIds = new Set();
let syncPromise = null;

function cloudEnabled() {
  try {
    return Boolean(getApp().globalData.cloudEnabled && wx.cloud);
  } catch (error) {
    return false;
  }
}

async function callCloud(action, data = {}, timeoutMs = CLOUD_TIMEOUT_MS) {
  if (!cloudEnabled()) throw new Error("CLOUD_DISABLED");
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CLOUD_REQUEST_TIMEOUT")), timeoutMs);
    Promise.resolve().then(() => wx.cloud.callFunction({
      name: "assessmentApi",
      data: { action, ...data },
    })).then((result) => {
      clearTimeout(timeout);
      resolve(result);
    }, (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  if (!response.result || response.result.ok !== true) {
    throw new Error((response.result && response.result.error) || "CLOUD_REQUEST_FAILED");
  }
  return response.result.data;
}

function newSession(scaleId, explicitRestart = false) {
  const scale = getScale(scaleId);
  if (!scale) throw new Error("UNKNOWN_SCALE");
  const now = Date.now();
  return storage.saveSession({
    sessionId: storage.createId("session"),
    scaleId,
    scaleVersion: scale.version,
    answers: {},
    currentIndex: 0,
    status: "in_progress",
    startedAt: now,
    updatedAt: now,
    restart: Boolean(explicitRestart),
    synced: false,
  });
}

function getOrCreateSession(scaleId, restart = false) {
  if (restart) {
    cancelSessionSync(scaleId);
    storage.removeSession(scaleId);
  }
  return storage.getSession(scaleId) || newSession(scaleId, restart);
}

function cancelSessionSync(scaleId) {
  const timer = syncTimers.get(scaleId);
  if (timer) clearTimeout(timer);
  syncTimers.delete(scaleId);
}

function withoutAnswers(result) {
  const { answers, ...summary } = result;
  return summary;
}

function sessionRevision(session) {
  return Number(session && session.serverUpdatedAt) || Number(session && session.updatedAt) || 0;
}

function scheduleSessionSync(session) {
  if (!cloudEnabled()) return;
  cancelSessionSync(session.scaleId);
  const timer = setTimeout(async () => {
    syncTimers.delete(session.scaleId);
    if (completedSessionIds.has(session.sessionId)) return;
    const latest = storage.getSession(session.scaleId);
    if (!latest || latest.sessionId !== session.sessionId || latest.updatedAt !== session.updatedAt) return;
    try {
      const outcome = await callCloud("upsertSession", { session });
      const current = storage.getSession(session.scaleId);
      if (current && current.sessionId === session.sessionId && current.updatedAt === session.updatedAt) {
        const authoritative = outcome && outcome.session ? outcome.session : current;
        if (!outcome || outcome.accepted !== false) {
          // 更新答题页仍持有的会话对象，下一次同题数修改要携带服务端版本基线。
          session.serverUpdatedAt = authoritative.serverUpdatedAt;
        }
        storage.saveSession({ ...authoritative, synced: true });
      }
    } catch (error) {
      console.warn("答题进度将在稍后同步", error.message);
    }
  }, 700);
  syncTimers.set(session.scaleId, timer);
}

function answerQuestion(session, itemId, value, currentIndex) {
  const scale = getScale(session.scaleId);
  validateAnswers(scale, { [itemId]: value });
  const updated = {
    ...session,
    answers: { ...session.answers, [itemId]: value },
    currentIndex,
    updatedAt: Date.now(),
    synced: false,
  };
  storage.saveSession(updated);
  scheduleSessionSync(updated);
  return updated;
}

function updateSessionPosition(session, currentIndex) {
  if (!session || session.currentIndex === currentIndex) return session;
  const updated = { ...session, currentIndex, updatedAt: Date.now(), synced: false };
  storage.saveSession(updated);
  scheduleSessionSync(updated);
  return updated;
}

async function completeSession(session) {
  const score = scoreAssessment(session.scaleId, session.answers);
  const scale = getScale(session.scaleId);
  const result = {
    resultId: storage.createId("result"),
    sessionId: session.sessionId,
    scaleId: session.scaleId,
    scaleVersion: scale.version,
    scaleTitle: scale.title,
    itemCount: scale.itemCount,
    facetReliability: scale.facetReliability || "standard",
    answers: session.answers,
    domains: score.domains,
    completedAt: Date.now(),
    synced: false,
  };
  completedSessionIds.add(session.sessionId);
  cancelSessionSync(session.scaleId);
  storage.saveResult(result);
  try {
    if (cloudEnabled()) return await syncResult(result);
    return result;
  } finally {
    completedSessionIds.delete(session.sessionId);
  }
}

async function syncResult(result) {
  try {
    await callCloud("completeSession", { result });
    const synced = { ...withoutAnswers(result), synced: true, syncBlocked: false, syncError: "" };
    storage.saveResult(synced);
    return synced;
  } catch (error) {
    const errorCode = String(error && error.message || "CLOUD_REQUEST_FAILED");
    const failed = { ...result, synced: false, syncBlocked: PERMANENT_RESULT_ERRORS.has(errorCode), syncError: errorCode };
    storage.saveResult(failed);
    console.warn(failed.syncBlocked ? "结果同步被云端拒绝" : "结果将在稍后同步", errorCode);
    return failed;
  }
}

function mergeCloudState(remote) {
  const local = storage.readState();
  if (local.pendingDeletes.all) return local;
  (remote.sessions || []).forEach((incoming) => {
    const current = local.sessions[incoming.scaleId];
    const incomingCount = Object.keys(incoming.answers || {}).length;
    const currentCount = current ? Object.keys(current.answers || {}).length : -1;
    const cloudRevisionWins = incoming.serverUpdatedAt
      ? (!current || !current.serverUpdatedAt || sessionRevision(incoming) >= sessionRevision(current))
      : sessionRevision(incoming) >= sessionRevision(current);
    if (!current || incomingCount > currentCount || (incomingCount === currentCount && cloudRevisionWins)) {
      local.sessions[incoming.scaleId] = { ...incoming, synced: true };
    }
  });
  const resultMap = new Map(local.results.map((item) => [item.resultId, item]));
  const deletedResultIds = new Set(local.pendingDeletes.resultIds);
  (remote.results || []).forEach((item) => {
    if (!deletedResultIds.has(item.resultId)) resultMap.set(item.resultId, { ...withoutAnswers(item), synced: true, syncBlocked: false, syncError: "" });
  });
  local.results = Array.from(resultMap.values()).sort((a, b) => b.completedAt - a.completedAt);
  storage.writeState(local);
  return local;
}

async function syncPendingDeletes() {
  const pending = storage.readState().pendingDeletes;
  if (pending.all) {
    try {
      await callCloud("deleteAll");
      storage.clearPendingDeleteAll();
      return true;
    } catch (error) {
      console.warn("云端清空将在稍后重试", error.message);
      return false;
    }
  }
  await Promise.all(pending.resultIds.map(async (resultId) => {
    try {
      await callCloud("deleteResult", { resultId });
      storage.clearPendingResultDelete(resultId);
    } catch (error) {
      console.warn("云端删除将在稍后重试", resultId, error.message);
    }
  }));
  return true;
}

async function performSyncAll() {
  if (!await syncPendingDeletes()) return storage.readState();
  const state = storage.readState();
  const pendingSessions = Object.values(state.sessions).filter((item) => !item.synced);
  const pendingResults = state.results.filter((item) => !item.synced && !item.syncBlocked);
  await Promise.all(pendingSessions.map((session) => callCloud("upsertSession", { session }).catch((error) => {
    console.warn("答题进度将在稍后同步", error.message);
  })));
  await Promise.all(pendingResults.map((result) => syncResult(result)));
  const remote = await callCloud("getState");
  while (remote.resultsHasMore) {
    const page = await callCloud("listResults", { offset: remote.resultsNextOffset });
    remote.results = (remote.results || []).concat(page.results || []);
    remote.resultsHasMore = Boolean(page.hasMore);
    remote.resultsNextOffset = page.nextOffset;
  }
  return mergeCloudState(remote);
}

function syncAll() {
  if (!cloudEnabled()) return Promise.resolve(storage.readState());
  if (syncPromise) return syncPromise;
  syncPromise = performSyncAll();
  syncPromise.then(() => { syncPromise = null; }, () => { syncPromise = null; });
  return syncPromise;
}

async function getResult(resultId) {
  const local = storage.getResult(resultId);
  if (local) return local;
  if (!cloudEnabled()) return null;
  try {
    const remote = await callCloud("getResult", { resultId });
    if (remote) return storage.saveResult({ ...remote, synced: true });
  } catch (error) {
    console.warn("读取云端报告失败", error.message);
  }
  return null;
}

async function generateAiInsight(resultId) {
  if (!cloudEnabled()) throw new Error("CLOUD_DISABLED");
  let result = storage.getResult(resultId);
  if (!result) result = await getResult(resultId);
  if (!result) throw new Error("INVALID_RESULT_ID");
  if (result.aiInsight) return result;

  if (!result.synced || result.syncBlocked) {
    await syncAll();
    result = storage.getResult(resultId);
  }
  if (!result || !result.synced || result.syncBlocked) throw new Error("AI_RESULT_NOT_SYNCED");

  const generated = await callCloud("generateAiInsight", { resultId }, AI_CLOUD_TIMEOUT_MS);
  const current = storage.getResult(resultId) || result;
  const updated = {
    ...current,
    aiInsight: generated.aiInsight,
    aiInsightVersion: generated.aiInsightVersion,
    aiGeneratedAt: generated.aiGeneratedAt,
    aiStatus: generated.aiStatus || { state: "ready" },
    synced: true,
  };
  storage.saveResult(updated);
  return updated;
}

async function deleteResult(resultId) {
  const shouldSync = cloudEnabled();
  storage.removeResult(resultId, shouldSync);
  if (shouldSync) {
    await callCloud("deleteResult", { resultId });
    storage.clearPendingResultDelete(resultId);
  }
}

async function deleteAll() {
  syncTimers.forEach((timer) => clearTimeout(timer));
  syncTimers.clear();
  const shouldSync = cloudEnabled();
  storage.clearAll(shouldSync);
  if (shouldSync) {
    await callCloud("deleteAll");
    storage.clearPendingDeleteAll();
  }
}

module.exports = {
  cloudEnabled,
  getOrCreateSession,
  answerQuestion,
  updateSessionPosition,
  completeSession,
  syncAll,
  getResult,
  generateAiInsight,
  deleteResult,
  deleteAll,
};
