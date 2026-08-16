const test = require("node:test");
const assert = require("node:assert/strict");
const { getScale } = require("../miniprogram/data/scales");

const memory = new Map();
const cloudCalls = [];

global.wx = {
  getStorageSync(key) { return memory.get(key); },
  setStorageSync(key, value) { memory.set(key, structuredClone(value)); },
  cloud: {
    callFunction({ data }) {
      cloudCalls.push(data);
      return Promise.resolve({ result: { ok: true, data: {} } });
    },
  },
};
global.getApp = () => ({ globalData: { cloudEnabled: true } });

const storage = require("../miniprogram/utils/storage");
const assessment = require("../miniprogram/services/assessment");

test.beforeEach(() => {
  memory.clear();
  cloudCalls.length = 0;
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
