const test = require("node:test");
const assert = require("node:assert/strict");
const { getScale } = require("../miniprogram/data/scales");

const memory = new Map();
const cloudCalls = [];

function successfulCallFunction({ data }) {
  cloudCalls.push(data);
  const responseData = data.action === "getState" ? { sessions: [], results: [] } : {};
  return Promise.resolve({ result: { ok: true, data: responseData } });
}

global.wx = {
  getStorageSync(key) { return memory.get(key); },
  setStorageSync(key, value) { memory.set(key, structuredClone(value)); },
  cloud: {
    callFunction: successfulCallFunction,
  },
};
global.getApp = () => ({ globalData: { cloudEnabled: true } });

const storage = require("../miniprogram/utils/storage");
const assessment = require("../miniprogram/services/assessment");

test.beforeEach(() => {
  memory.clear();
  cloudCalls.length = 0;
  wx.cloud.callFunction = successfulCallFunction;
});

test("删除失败时墓碑阻止云端结果复活并在恢复后清除", async () => {
  const remoteResult = { resultId: "r1", scaleId: "ipip-neo-60-zh-local-v1", completedAt: 1, domains: [] };
  storage.saveResult(remoteResult);
  let deleteSucceeds = false;
  let remoteExists = true;
  wx.cloud.callFunction = ({ data }) => {
    cloudCalls.push(data);
    if (data.action === "deleteResult") {
      if (!deleteSucceeds) return Promise.reject(new Error("offline"));
      remoteExists = false;
      return Promise.resolve({ result: { ok: true, data: {} } });
    }
    if (data.action === "getState") {
      return Promise.resolve({ result: { ok: true, data: { sessions: [], results: remoteExists ? [remoteResult] : [] } } });
    }
    return Promise.resolve({ result: { ok: true, data: {} } });
  };

  await assert.rejects(assessment.deleteResult("r1"), /offline/);
  assert.equal(storage.getResult("r1"), null);
  assert.deepEqual(storage.readState().pendingDeletes.resultIds, ["r1"]);

  await assessment.syncAll();
  assert.equal(storage.getResult("r1"), null);
  assert.deepEqual(storage.readState().pendingDeletes.resultIds, ["r1"]);

  deleteSucceeds = true;
  await assessment.syncAll();
  assert.equal(storage.getResult("r1"), null);
  assert.deepEqual(storage.readState().pendingDeletes.resultIds, []);
});

test("云端清空失败时保留全量删除标记并在恢复后重试", async () => {
  storage.saveResult({ resultId: "r2", scaleId: "ipip-neo-120-zh-v1", completedAt: 2, domains: [] });
  let deleteSucceeds = false;
  wx.cloud.callFunction = ({ data }) => {
    cloudCalls.push(data);
    if (data.action === "deleteAll") {
      if (!deleteSucceeds) return Promise.reject(new Error("offline"));
      return Promise.resolve({ result: { ok: true, data: {} } });
    }
    if (data.action === "getState") {
      return Promise.resolve({ result: { ok: true, data: { sessions: [], results: [] } } });
    }
    return Promise.resolve({ result: { ok: true, data: {} } });
  };

  await assert.rejects(assessment.deleteAll(), /offline/);
  assert.equal(storage.readState().results.length, 0);
  assert.equal(storage.readState().pendingDeletes.all, true);

  await assessment.syncAll();
  assert.equal(storage.readState().pendingDeletes.all, true);

  deleteSucceeds = true;
  await assessment.syncAll();
  assert.equal(storage.readState().pendingDeletes.all, false);
});

test("并发同步请求复用同一个进行中的任务", async () => {
  const first = assessment.syncAll();
  const second = assessment.syncAll();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(cloudCalls.filter((call) => call.action === "getState").length, 1);
});

test("完成答题会取消尚未执行的草稿同步", async () => {
  const scale = getScale("ipip-neo-60-zh-local-v1");
  let session = assessment.getOrCreateSession(scale.id, true);
  session.answers = Object.fromEntries(scale.items.slice(0, -1).map((item) => [item.id, 3]));
  storage.saveSession(session);
  const lastIndex = scale.items.length - 1;
  session = assessment.answerQuestion(session, scale.items[lastIndex].id, 3, lastIndex);

  await assessment.completeSession(session);
  await new Promise((resolve) => setTimeout(resolve, 760));

  assert.deepEqual(cloudCalls.map((call) => call.action), ["completeSession"]);
  assert.equal(storage.getSession(scale.id), null);
  assert.equal(storage.readState().results.length, 1);
});

test("云函数长时间无响应时主动结束等待", async () => {
  const nativeSetTimeout = global.setTimeout;
  const originalCallFunction = wx.cloud.callFunction;
  wx.cloud.callFunction = () => new Promise(() => {});
  global.setTimeout = (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args);

  try {
    await assert.rejects(assessment.deleteResult("missing-result"), /CLOUD_REQUEST_TIMEOUT/);
  } finally {
    global.setTimeout = nativeSetTimeout;
    wx.cloud.callFunction = originalCallFunction;
  }
});
