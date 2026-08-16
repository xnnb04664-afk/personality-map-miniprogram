const STORAGE_KEY = "personality-map-state-v1";

function emptyState() {
  return { sessions: {}, results: [] };
}

function readState() {
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    if (saved && saved.sessions && Array.isArray(saved.results)) return saved;
  } catch (error) {
    console.warn("读取本地记录失败", error);
  }
  return emptyState();
}

function writeState(state) {
  wx.setStorageSync(STORAGE_KEY, state);
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

function saveResult(result) {
  const state = readState();
  state.results = [result, ...state.results.filter((item) => item.resultId !== result.resultId)];
  delete state.sessions[result.scaleId];
  writeState(state);
  return result;
}

function getResult(resultId) {
  return readState().results.find((item) => item.resultId === resultId) || null;
}

function removeResult(resultId) {
  const state = readState();
  state.results = state.results.filter((item) => item.resultId !== resultId);
  writeState(state);
}

function clearAll() {
  writeState(emptyState());
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
  clearAll,
};
