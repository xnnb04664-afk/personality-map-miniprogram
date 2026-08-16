const test = require("node:test");
const assert = require("node:assert/strict");

const memory = new Map();
let lastToast = "";
global.wx = {
  getStorageSync(key) { return memory.get(key); },
  setStorageSync(key, value) { memory.set(key, structuredClone(value)); },
  showToast({ title }) { lastToast = title; },
};

const storage = require("../miniprogram/utils/storage");

test.beforeEach(() => {
  memory.clear();
  lastToast = "";
});

test("会话可以保存、读取并被完成结果替换", () => {
  const session = { sessionId: "s1", scaleId: "scale", answers: { q1: 3 }, synced: false };
  storage.saveSession(session);
  assert.deepEqual(storage.getSession("scale"), session);
  storage.saveResult({ resultId: "r1", scaleId: "scale", completedAt: 1 });
  assert.equal(storage.getSession("scale"), null);
  assert.equal(storage.getResult("r1").resultId, "r1");
});

test("删除单条和清空不会保留旧数据", () => {
  storage.saveResult({ resultId: "r1", scaleId: "a", completedAt: 1 });
  storage.saveResult({ resultId: "r2", scaleId: "b", completedAt: 2 });
  storage.removeResult("r1");
  assert.equal(storage.getResult("r1"), null);
  assert.equal(storage.readState().results.length, 1);
  storage.clearAll();
  assert.deepEqual(storage.readState(), { sessions: {}, results: [], pendingDeletes: { all: false, resultIds: [] } });
});

test("云端删除墓碑会持久化并可逐项清除", () => {
  storage.saveResult({ resultId: "r1", scaleId: "a", completedAt: 1 });
  storage.removeResult("r1", true);
  assert.deepEqual(storage.readState().pendingDeletes, { all: false, resultIds: ["r1"] });
  storage.clearPendingResultDelete("r1");
  assert.deepEqual(storage.readState().pendingDeletes, { all: false, resultIds: [] });

  storage.clearAll(true);
  assert.deepEqual(storage.readState().pendingDeletes, { all: true, resultIds: [] });
  storage.clearPendingDeleteAll();
  assert.deepEqual(storage.readState().pendingDeletes, { all: false, resultIds: [] });
});

test("旧版缓存会自动补齐删除队列结构", () => {
  memory.set(storage.STORAGE_KEY, { sessions: {}, results: [] });
  assert.deepEqual(storage.readState().pendingDeletes, { all: false, resultIds: [] });
});

test("已同步报告不会长期保留逐题答案", () => {
  memory.set(storage.STORAGE_KEY, {
    sessions: {}, pendingDeletes: { all: false, resultIds: [] },
    results: [{ resultId: "r1", scaleId: "a", synced: true, answers: { q1: 5 }, domains: [] }],
  });
  const result = storage.getResult("r1");
  assert.equal(Object.hasOwn(result, "answers"), false);
});

test("本地存储写入失败时提示用户且不打断页面逻辑", () => {
  const originalSetStorageSync = wx.setStorageSync;
  const originalConsoleError = console.error;
  wx.setStorageSync = () => { throw new Error("quota exceeded"); };
  console.error = () => {};
  try {
    assert.doesNotThrow(() => storage.saveSession({ sessionId: "s1", scaleId: "a", answers: {} }));
    assert.equal(lastToast, "本地空间不足，当前进度未保存");
    assert.equal(storage.getSession("a").sessionId, "s1");
  } finally {
    wx.setStorageSync = originalSetStorageSync;
    console.error = originalConsoleError;
    storage.clearAll();
  }
});
