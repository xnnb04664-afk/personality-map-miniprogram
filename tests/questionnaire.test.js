const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const memory = new Map();
let pageDefinition;
let lastToast = "";
let windowInfo = { windowHeight: 667, windowWidth: 375, screenHeight: 667, safeArea: { bottom: 667 } };

global.wx = {
  getStorageSync(key) { return memory.get(key); },
  setStorageSync(key, value) { memory.set(key, structuredClone(value)); },
  setNavigationBarTitle() {},
  getWindowInfo() { return windowInfo; },
  showToast({ title }) { lastToast = title; },
  navigateBack() {},
  showModal() {},
  cloud: null,
};
global.getApp = () => ({ globalData: { cloudEnabled: false } });
global.Page = (definition) => { pageDefinition = definition; };

require("../miniprogram/pages/questionnaire/index");

function createPage() {
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data) };
  page.setData = function setData(update) { this.data = { ...this.data, ...update }; };
  return page;
}

test.beforeEach(() => {
  memory.clear();
  lastToast = "";
  windowInfo = { windowHeight: 667, windowWidth: 375, screenHeight: 667, safeArea: { bottom: 667 } };
});

test("答题页使用单屏布局并只让长题文区域滚动", () => {
  const template = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/questionnaire/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/questionnaire/index.wxss"), "utf8");
  assert.match(template, /class="question-text-scroll"\s+scroll-y/);
  assert.match(template, /class="reset-button"[^>]*>重置<\/button>/);
  assert.match(styles, /\.question-page\s*\{[\s\S]*?height:\s*100vh;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.question-body\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.choice-list\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/);
  assert.match(template, /class="choice-label"/);
  assert.match(styles, /\.choice-label\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?white-space:\s*normal;/);
  assert.match(styles, /\.choice-button\s*\{[\s\S]*?grid-template-columns:\s*60rpx minmax\(0, 1fr\) 38rpx;/);
  assert.match(styles, /\.scroll-mode\s*\{[\s\S]*?overflow:\s*visible;/);
});

test("不同屏幕高度会放大选项或自动启用滚动兜底", () => {
  const page = createPage();
  [[320, 568], [375, 667], [390, 844], [430, 932]].forEach(([windowWidth, windowHeight]) => {
    page.configureLayout({ windowWidth, windowHeight, screenHeight: windowHeight, safeArea: { bottom: windowHeight } });
    assert.equal(page.data.scrollMode, false, `${windowWidth}x${windowHeight}`);
    assert.ok(page.data.choiceWidth >= windowWidth * 0.9, `${windowWidth}x${windowHeight}`);
    assert.ok(page.data.choiceHeight >= 52, `${windowWidth}x${windowHeight}`);
  });
  assert.ok(page.data.choiceHeight >= 120, "高屏选项应充分利用纵向空间");

  page.configureLayout({ windowWidth: 568, windowHeight: 320, screenHeight: 320, safeArea: { bottom: 320 } });
  assert.equal(page.data.scrollMode, true);
  assert.ok(page.data.choiceHeight >= 78);
});

test("60 题页可从抽屉跳转并连续补答", async () => {
  const page = createPage();
  page.onLoad({ scaleId: "ipip-neo-60-zh-local-v1", restart: "1" });
  assert.equal(page.data.total, 60);
  assert.equal(page.data.missingCount, 60);

  page.openMissingDrawer();
  assert.equal(page.data.showMissingDrawer, true);
  assert.equal(page.data.missingItems.length, 60);
  assert.equal(Object.hasOwn(page.data.missingItems[0], "text"), false);
  assert.ok(page.data.missingScrollHeight <= 321);

  page.jumpToMissing({ currentTarget: { dataset: { index: 5 } } });
  assert.equal(page.data.currentIndex, 5);
  assert.equal(page.data.reviewingMissing, true);
  page.chooseAnswer({ currentTarget: { dataset: { value: 4 } } });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(page.data.currentIndex, 6);
  assert.equal(page.data.missingCount, 59);
  page.onUnload();
});

test("未答为零时不打开抽屉", () => {
  const page = createPage();
  page.onLoad({ scaleId: "ipip-neo-60-zh-local-v1", restart: "1" });
  page.data.missingCount = 0;
  page.openMissingDrawer();
  assert.equal(page.data.showMissingDrawer, false);
  assert.equal(lastToast, "所有题目已回答");
  page.onUnload();
});

test("手动切题会取消自动前进并恢复到实际浏览位置", async () => {
  const page = createPage();
  page.onLoad({ scaleId: "ipip-neo-60-zh-local-v1", restart: "1" });
  page.showQuestion(2);
  page.chooseAnswer({ currentTarget: { dataset: { value: 3 } } });
  page.previous();
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(page.data.currentIndex, 1);
  page.onUnload();

  const resumed = createPage();
  resumed.onLoad({ scaleId: "ipip-neo-60-zh-local-v1" });
  assert.equal(resumed.data.currentIndex, 1);
  resumed.onUnload();
});
