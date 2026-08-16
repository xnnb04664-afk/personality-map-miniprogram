const test = require("node:test");
const assert = require("node:assert/strict");
const { getMissingItems, getNextMissingIndex } = require("../miniprogram/utils/unanswered");

const items = Array.from({ length: 6 }, (_, index) => ({ id: `q${index + 1}` }));

test("未答列表只包含编号、索引和当前状态", () => {
  const missing = getMissingItems(items, { q1: 3, q3: 5, q6: 1 }, 3);
  assert.deepEqual(missing, [
    { index: 1, number: 2, isCurrent: false },
    { index: 3, number: 4, isCurrent: true },
    { index: 4, number: 5, isCurrent: false },
  ]);
  assert.equal(Object.hasOwn(missing[0], "text"), false);
});

test("补答模式寻找后续漏题并在末尾循环", () => {
  const answers = { q1: 3, q3: 5, q6: 1 };
  assert.equal(getNextMissingIndex(items, answers, 1), 3);
  assert.equal(getNextMissingIndex(items, answers, 4), 1);
  assert.equal(getNextMissingIndex(items, Object.fromEntries(items.map((item) => [item.id, 3])), 2), -1);
});

test("300 题未答列表不携带完整题目数据", () => {
  const large = Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, text: "不应进入视图" }));
  const missing = getMissingItems(large, {}, 0);
  assert.equal(missing.length, 300);
  assert.deepEqual(Object.keys(missing[0]).sort(), ["index", "isCurrent", "number"]);
});
