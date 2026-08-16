const storage = require("../utils/storage");
const { getScale } = require("../data/scales");
const { validateAnswers, scoreAssessment } = require("../utils/scoring");

const CLOUD_TIMEOUT_MS = 12000;
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

async function callCloud(action, data = {}) {
  if (!cloudEnabled()) throw new Error("CLOUD_DISABLED");
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CLOUD_REQUEST_TIMEOUT")), CLOUD_TIMEOUT_MS);
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

function newSession(scaleId) {
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
    synced: false,
  });
}

function getOrCreateSession(scaleId, restart = false) {
  if (restart) {
    cancelSessionSync(scaleId);
    storage.removeSession(scaleId);
  }
  return storage.getSession(scaleId) || newSession(scaleId);
}

function cancelSessionSync(scaleId) {
  const timer = syncTimers.get(scaleId);
  if (timer) clearTimeout(timer);
  syncTimers.delete(scaleId);
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
      await callCloud("upsertSession", { session });
      const current = storage.getSession(session.scaleId);
      if (current && current.sessionId === session.sessionId && current.updatedAt === session.updatedAt) {
        current.synced = true;
        storage.saveSession(current);
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
  if (cloudEnabled()) {
    try {
      await callCloud("completeSession", { result });
      result.synced = true;
      storage.saveResult(result);
    } catch (error) {
      console.warn("结果将在稍后同步", error.message);
    }
  }
  return result;
}

function mergeCloudState(remote) {
  const local = storage.readState();
  if (local.pendingDeletes.all) return local;
  (remote.sessions || []).forEach((incoming) => {
    const current = local.sessions[incoming.scaleId];
    const incomingCount = Object.keys(incoming.answers || {}).length;
    const currentCount = current ? Object.keys(current.answers || {}).length : -1;
    if (!current || incomingCount > currentCount || (incomingCount === currentCount && incoming.updatedAt >= current.updatedAt)) {
      local.sessions[incoming.scaleId] = { ...incoming, synced: true };
    }
  });
  const resultMap = new Map(local.results.map((item) => [item.resultId, item]));
  const deletedResultIds = new Set(local.pendingDeletes.resultIds);
  (remote.results || []).forEach((item) => {
    if (!deletedResultIds.has(item.resultId)) resultMap.set(item.resultId, { ...item, synced: true });
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
  const pendingResults = state.results.filter((item) => !item.synced);
  await Promise.all(pendingSessions.map((session) => callCloud("upsertSession", { session }).catch(() => null)));
  await Promise.all(pendingResults.map((result) => callCloud("completeSession", { result }).catch(() => null)));
  const remote = await callCloud("getState");
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
  deleteResult,
  deleteAll,
};
