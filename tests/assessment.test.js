const test = require("node:test");
const assert = require("node:assert/strict");
const { getScale } = require("../miniprogram/data/scales");

const memory = new Map();
const cloudCalls = [];

function successfulCallFunction({ data }) {
  cloudCalls.push(data);
  const responseData = data.action === "getState"
    ? { sessions: [], results: [] }
    : data.action === "upsertSession"
      ? { accepted: true, session: { ...data.session, serverUpdatedAt: 777 } }
      : {};
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

test("同步后的同版本云端草稿会回写已同步状态", async () => {
  const scaleId = "ipip-neo-60-zh-local-v1";
  const session = assessment.getOrCreateSession(scaleId, true);
  session.answers = { [`${scaleId}-N1-1`]: 3 };
  session.updatedAt = 12345;
  session.synced = false;
  storage.saveSession(session);
  let remoteSession = null;
  wx.cloud.callFunction = ({ data }) => {
    cloudCalls.push(data);
    if (data.action === "upsertSession") remoteSession = structuredClone(data.session);
    const responseData = data.action === "getState" ? { sessions: [remoteSession], results: [] } : {};
    return Promise.resolve({ result: { ok: true, data: responseData } });
  };

  await assessment.syncAll();
  assert.equal(storage.getSession(scaleId).synced, true);
  assert.equal(cloudCalls.filter((call) => call.action === "upsertSession").length, 1);

  cloudCalls.length = 0;
  await assessment.syncAll();
  assert.equal(cloudCalls.some((call) => call.action === "upsertSession"), false);
});

test("防抖同步会更新答题页持有的服务端版本基线", async () => {
  const scale = getScale("ipip-neo-60-zh-local-v1");
  let session = assessment.getOrCreateSession(scale.id, true);
  session = assessment.answerQuestion(session, scale.items[0].id, 3, 0);
  await new Promise((resolve) => setTimeout(resolve, 760));

  assert.equal(session.serverUpdatedAt, 777);
  assert.equal(storage.getSession(scale.id).serverUpdatedAt, 777);
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
  assert.equal(Object.hasOwn(storage.readState().results[0], "answers"), false);
  assert.equal(storage.readState().results[0].synced, true);
});

test("确定性结果错误会标记同步失败且不再反复空推", async () => {
  const scale = getScale("ipip-neo-60-zh-local-v1");
  const session = assessment.getOrCreateSession(scale.id, true);
  session.answers = Object.fromEntries(scale.items.map((item) => [item.id, 3]));
  storage.saveSession(session);
  wx.cloud.callFunction = ({ data }) => {
    cloudCalls.push(data);
    if (data.action === "completeSession") return Promise.resolve({ result: { ok: false, error: "SCORE_MISMATCH" } });
    if (data.action === "getState") return Promise.resolve({ result: { ok: true, data: { sessions: [], results: [] } } });
    return Promise.resolve({ result: { ok: true, data: {} } });
  };

  const result = await assessment.completeSession(session);
  assert.equal(result.syncBlocked, true);
  assert.equal(result.syncError, "SCORE_MISMATCH");
  assert.equal(Object.hasOwn(result, "answers"), true, "失败时保留答案以便排查或后续恢复");

  cloudCalls.length = 0;
  await assessment.syncAll();
  assert.equal(cloudCalls.some((call) => call.action === "completeSession"), false);
});

test("同答题数会使用服务端版本时间解决会话冲突", async () => {
  const scaleId = "ipip-neo-60-zh-local-v1";
  storage.saveSession({
    sessionId: "local-session", scaleId, scaleVersion: 1, answers: { [`${scaleId}-N1-1`]: 2 },
    currentIndex: 0, updatedAt: 9999999999999, serverUpdatedAt: 200, synced: true,
  });
  let remoteRevision = 100;
  wx.cloud.callFunction = ({ data }) => {
    cloudCalls.push(data);
    if (data.action === "getState") {
      return Promise.resolve({ result: { ok: true, data: { sessions: [{
        sessionId: "remote-session", scaleId, scaleVersion: 1, answers: { [`${scaleId}-N1-1`]: 4 },
        currentIndex: 0, updatedAt: 1, serverUpdatedAt: remoteRevision,
      }], results: [] } } });
    }
    return Promise.resolve({ result: { ok: true, data: {} } });
  };

  await assessment.syncAll();
  assert.equal(storage.getSession(scaleId).answers[`${scaleId}-N1-1`], 2, "较旧云端版本不应覆盖本地");
  remoteRevision = 300;
  await assessment.syncAll();
  assert.equal(storage.getSession(scaleId).answers[`${scaleId}-N1-1`], 4, "较新云端版本应胜出");
});

test("云端历史结果会自动翻页并合并到本地", async () => {
  wx.cloud.callFunction = ({ data }) => {
    cloudCalls.push(data);
    if (data.action === "getState") {
      return Promise.resolve({ result: { ok: true, data: {
        sessions: [], results: [{ resultId: "page-1", completedAt: 2, domains: [] }],
        resultsHasMore: true, resultsNextOffset: 50,
      } } });
    }
    if (data.action === "listResults") {
      assert.equal(data.offset, 50);
      return Promise.resolve({ result: { ok: true, data: {
        results: [{ resultId: "page-2", completedAt: 1, domains: [] }], hasMore: false, nextOffset: null,
      } } });
    }
    return Promise.resolve({ result: { ok: true, data: {} } });
  };

  await assessment.syncAll();
  assert.deepEqual(storage.readState().results.map((item) => item.resultId), ["page-1", "page-2"]);
  assert.equal(cloudCalls.filter((call) => call.action === "listResults").length, 1);
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
