const test = require("node:test");
const assert = require("node:assert/strict");

const memory = new Map();
let pageDefinition;
let lastToast = "";

global.wx = {
  getStorageSync(key) { return memory.get(key); },
  setStorageSync(key, value) { memory.set(key, structuredClone(value)); },
  setNavigationBarTitle() {},
  getWindowInfo() { return { windowHeight: 667, windowWidth: 375 }; },
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
