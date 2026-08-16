const test = require("node:test");
const assert = require("node:assert/strict");

const memory = new Map();
global.wx = {
  getStorageSync(key) { return memory.get(key); },
  setStorageSync(key, value) { memory.set(key, structuredClone(value)); },
};

const storage = require("../miniprogram/utils/storage");

test.beforeEach(() => memory.clear());

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
  assert.deepEqual(storage.readState(), { sessions: {}, results: [] });
});
