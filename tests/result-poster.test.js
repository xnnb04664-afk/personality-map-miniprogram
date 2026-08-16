const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let pageDefinition;
let saveAttempts;
let lastToast;
let exportedOptions;
const drawingCalls = [];

const context = {
  scale(...args) { drawingCalls.push(["scale", ...args]); },
  fillRect(...args) { drawingCalls.push(["fillRect", ...args]); },
  fillText(...args) { drawingCalls.push(["fillText", ...args]); },
};
const canvas = {
  width: 0,
  height: 0,
  getContext(type) {
    assert.equal(type, "2d");
    return context;
  },
};

function selectorQuery() {
  return {
    in() { return this; },
    select(selector) { assert.equal(selector, "#posterCanvas"); return this; },
    fields(options) { assert.deepEqual(options, { node: true, size: true }); return this; },
    exec(callback) { callback([{ node: canvas, width: 300, height: 410 }]); },
  };
}

global.wx = {
  createSelectorQuery: selectorQuery,
  getWindowInfo() { return { pixelRatio: 2 }; },
  showLoading() {},
  hideLoading() {},
  showToast({ title }) { lastToast = title; },
  canvasToTempFilePath(options) {
    exportedOptions = options;
    options.success({ tempFilePath: "poster.png" });
  },
  saveImageToPhotosAlbum(options) {
    saveAttempts += 1;
    if (saveAttempts === 1 && wx.rejectFirstSave) options.fail({ errMsg: "saveImageToPhotosAlbum:fail auth deny" });
    else options.success({});
  },
  showModal(options) { options.success({ confirm: true, cancel: false }); },
  openSetting(options) { options.success({ authSetting: { "scope.writePhotosAlbum": true } }); },
};
global.getApp = () => ({ globalData: { cloudEnabled: false } });
global.Page = (definition) => { pageDefinition = definition; };

require("../miniprogram/pages/result/index");

function createPage() {
  return {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    result: {
      scaleTitle: "IPIP-NEO-60",
      completedAt: new Date(2026, 7, 16).getTime(),
      domains: [
        { name: "情绪敏感性", score: 40, level: "中间", color: "#D45D5D" },
        { name: "外向性", score: 50, level: "中间", color: "#D9823F" },
        { name: "开放性", score: 60, level: "中间", color: "#6E63A6" },
        { name: "宜人性", score: 70, level: "偏高", color: "#2E8B77" },
        { name: "尽责性", score: 80, level: "偏高", color: "#3277A8" },
      ],
    },
  };
}

test.beforeEach(() => {
  saveAttempts = 0;
  lastToast = "";
  exportedOptions = null;
  drawingCalls.length = 0;
  wx.rejectFirstSave = false;
});

test("报告页只使用 Canvas 2D 节点接口", () => {
  const pageSource = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/result/index.js"), "utf8");
  const template = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/result/index.wxml"), "utf8");
  assert.doesNotMatch(pageSource, /createCanvasContext|canvasId\s*:/);
  assert.match(template, /<canvas\s+type="2d"\s+id="posterCanvas"/);
  assert.doesNotMatch(template, /canvas-id=/);
});

test("Canvas 2D 海报按 DPR 绘制并通过节点导出", async () => {
  await createPage().savePoster();

  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 1640);
  assert.deepEqual(drawingCalls[0], ["scale", 2, 2]);
  assert.ok(drawingCalls.some((call) => call[0] === "fillText" && call[1] === "人格图谱"));
  assert.equal(exportedOptions.canvas, canvas);
  assert.equal(Object.hasOwn(exportedOptions, "canvasId"), false);
  assert.equal(lastToast, "已保存到相册");
});

test("相册权限首次拒绝后可从设置页授权并自动重试", async () => {
  wx.rejectFirstSave = true;
  await createPage().savePoster();

  assert.equal(saveAttempts, 2);
  assert.equal(lastToast, "已保存到相册");
});
