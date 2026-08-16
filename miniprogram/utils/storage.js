const STORAGE_KEY = "personality-map-state-v1";
let storageWarningShown = false;
let volatileState = null;

function emptyState() {
  return { sessions: {}, results: [], pendingDeletes: { all: false, resultIds: [] }, cloudConsent: null };
}

function normalizeState(saved) {
  if (!saved || !saved.sessions || !Array.isArray(saved.results)) return { state: emptyState(), changed: false };
  const pending = saved.pendingDeletes || {};
  const consent = saved.cloudConsent && typeof saved.cloudConsent === "object" ? saved.cloudConsent : null;
  let changed = false;
  const results = saved.results.map((result) => {
    if (!result || !result.synced || !("answers" in result)) return result;
    changed = true;
    const { answers, ...summary } = result;
    return summary;
  });
  return {
    state: {
      sessions: saved.sessions,
      results,
      pendingDeletes: {
        all: Boolean(pending.all),
        resultIds: Array.isArray(pending.resultIds) ? Array.from(new Set(pending.resultIds.filter((id) => typeof id === "string"))) : [],
      },
      cloudConsent: consent,
    },
    changed,
  };
}

function readState() {
  if (volatileState) return normalizeState(volatileState).state;
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    const normalized = normalizeState(saved);
    if (normalized.changed) {
      try {
        wx.setStorageSync(STORAGE_KEY, normalized.state);
      } catch (error) {
        console.warn("清理本地逐题答案失败", error);
        volatileState = normalized.state;
      }
    }
    return normalized.state;
  } catch (error) {
    console.warn("读取本地记录失败", error);
  }
  return emptyState();
}

function writeState(state) {
  try {
    wx.setStorageSync(STORAGE_KEY, state);
    storageWarningShown = false;
    volatileState = null;
  } catch (error) {
    console.error("保存本地记录失败", error);
    volatileState = state;
    if (!storageWarningShown) {
      storageWarningShown = true;
      try { wx.showToast({ title: "本地空间不足，当前进度未保存", icon: "none" }); } catch (toastError) { /* 非页面环境 */ }
    }
  }
  return state;
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getSession(scaleId) {
  return readState().sessions[scaleId] || null;
}

function saveSession(session) {
  const state = readState();
  state.sessions[session.scaleId] = session;
  writeState(state);
  return session;
}

function removeSession(scaleId) {
  const state = readState();
  delete state.sessions[scaleId];
  writeState(state);
}

function saveResult(result, options = {}) {
  const state = readState();
  const rejectDeleted = options.rejectDeleted === true;
  if (rejectDeleted && (state.pendingDeletes.all || state.pendingDeletes.resultIds.includes(result.resultId))) return null;
  state.results = [result, ...state.results.filter((item) => item.resultId !== result.resultId)];
  if (options.removeSession !== false) delete state.sessions[result.scaleId];
  writeState(state);
  return result;
}

function getResult(resultId) {
  return readState().results.find((item) => item.resultId === resultId) || null;
}

function removeResult(resultId, queueCloudDelete = false) {
  const state = readState();
  state.results = state.results.filter((item) => item.resultId !== resultId);
  if (queueCloudDelete && !state.pendingDeletes.all && !state.pendingDeletes.resultIds.includes(resultId)) {
    state.pendingDeletes.resultIds.push(resultId);
  }
  writeState(state);
}

function clearPendingResultDelete(resultId) {
  const state = readState();
  state.pendingDeletes.resultIds = state.pendingDeletes.resultIds.filter((id) => id !== resultId);
  writeState(state);
}

function clearPendingDeleteAll() {
  const state = readState();
  state.pendingDeletes = { all: false, resultIds: [] };
  writeState(state);
}

function clearAll(queueCloudDelete = false) {
  const state = emptyState();
  state.pendingDeletes.all = queueCloudDelete;
  writeState(state);
}

function getCloudConsent() {
  return readState().cloudConsent || null;
}

function saveCloudConsent(consent) {
  const state = readState();
  state.cloudConsent = consent || null;
  writeState(state);
  return state.cloudConsent;
}

function clearCloudConsent() {
  return saveCloudConsent(null);
}

module.exports = {
  STORAGE_KEY,
  readState,
  writeState,
  createId,
  getSession,
  saveSession,
  removeSession,
  saveResult,
  getResult,
  removeResult,
  clearPendingResultDelete,
  clearPendingDeleteAll,
  clearAll,
  getCloudConsent,
  saveCloudConsent,
  clearCloudConsent,
};
