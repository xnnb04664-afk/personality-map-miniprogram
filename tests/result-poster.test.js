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
  beginPath(...args) { drawingCalls.push(["beginPath", ...args]); },
  moveTo(...args) { drawingCalls.push(["moveTo", ...args]); },
  lineTo(...args) { drawingCalls.push(["lineTo", ...args]); },
  closePath(...args) { drawingCalls.push(["closePath", ...args]); },
  stroke(...args) { drawingCalls.push(["stroke", ...args]); },
  fill(...args) { drawingCalls.push(["fill", ...args]); },
  arc(...args) { drawingCalls.push(["arc", ...args]); },
};
const posterCanvas = {
  width: 0,
  height: 0,
  getContext(type) {
    assert.equal(type, "2d");
    return context;
  },
};
const radarCanvas = {
  width: 0,
  height: 0,
  getContext(type) {
    assert.equal(type, "2d");
    return context;
  },
};

function selectorQuery() {
  let selected = "";
  return {
    in() { return this; },
    select(selector) { selected = selector; return this; },
    fields(options) { assert.deepEqual(options, { node: true, size: true }); return this; },
    exec(callback) {
      if (selected === "#posterCanvas") callback([{ node: posterCanvas, width: 300, height: 410 }]);
      else if (selected === "#radarCanvas") callback([{ node: radarCanvas, width: 320, height: 300 }]);
      else callback([]);
    },
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
  const page = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    result: {
      scaleTitle: "IPIP-NEO-60",
      completedAt: new Date(2026, 7, 16).getTime(),
      domains: [
        { id: "N", name: "情绪敏感性", score: 40, level: "中间", color: "#D45D5D" },
        { id: "E", name: "外向性", score: 50, level: "中间", color: "#D9823F" },
        { id: "O", name: "开放性", score: 60, level: "中间", color: "#6E63A6" },
        { id: "A", name: "宜人性", score: 70, level: "偏高", color: "#2E8B77" },
        { id: "C", name: "尽责性", score: 80, level: "偏高", color: "#3277A8" },
      ],
    },
  };
  page.setData = function setData(update, callback) {
    this.data = { ...this.data, ...update };
    if (callback) callback();
  };
  return page;
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

  assert.equal(posterCanvas.width, 1200);
  assert.equal(posterCanvas.height, 1640);
  assert.deepEqual(drawingCalls[0], ["scale", 2, 2]);
  assert.ok(drawingCalls.some((call) => call[0] === "fillText" && call[1] === "人格图谱"));
  assert.equal(exportedOptions.canvas, posterCanvas);
  assert.equal(Object.hasOwn(exportedOptions, "canvasId"), false);
  assert.equal(lastToast, "已保存到相册");
});

test("相册权限首次拒绝后可从设置页授权并自动重试", async () => {
  wx.rejectFirstSave = true;
  await createPage().savePoster();

  assert.equal(saveAttempts, 2);
  assert.equal(lastToast, "已保存到相册");
});

test("分享卡片只携带公开入口，不包含量表或报告标识", () => {
  const share = createPage().onShareAppMessage();
  assert.equal(share.path, "/pages/index/index");
  assert.doesNotMatch(share.path, /scaleId|resultId|openid/i);
});

test("报告包含概览、五维、分面三个视图并支持折叠", () => {
  const template = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/result/index.wxml"), "utf8");
  assert.match(template, /data-view="overview"[\s\S]*?>概览<\/button>/);
  assert.match(template, /data-view="domains"[\s\S]*?>五维<\/button>/);
  assert.match(template, /data-view="facets"[\s\S]*?>分面<\/button>/);
  assert.match(template, /facetReliability === 'exploratory'/);

  const page = createPage();
  page.selectReportView({ currentTarget: { dataset: { view: "domains" } } });
  assert.equal(page.data.activeView, "domains");
  page.toggleDomain({ currentTarget: { dataset: { id: "N" } } });
  assert.equal(page.data.expandedDomain, "N");
  page.toggleDomain({ currentTarget: { dataset: { id: "N" } } });
  assert.equal(page.data.expandedDomain, "");
});

test("五轴雷达图按 DPR 绘制网格、数据区域和标签", async () => {
  const page = createPage();
  await page.drawRadar();

  assert.equal(radarCanvas.width, 640);
  assert.equal(radarCanvas.height, 600);
  assert.ok(drawingCalls.filter((call) => call[0] === "lineTo").length >= 24);
  assert.equal(drawingCalls.filter((call) => call[0] === "arc").length, 5);
  assert.ok(drawingCalls.some((call) => call[0] === "fillText" && call[1] === "情绪敏感性"));
});

test("中性报告标题由偏离中点最明显的维度生成", () => {
  const { buildReportPresentation } = require("../miniprogram/utils/report");
  const presentation = buildReportPresentation(createPage().result.domains);
  assert.equal(presentation.prominentTraits[0].id, "C");
  assert.equal(presentation.prominentTraits[1].id, "A");
  assert.doesNotMatch(presentation.profileTitle, /人格类型|型人格|诊断/);
});
