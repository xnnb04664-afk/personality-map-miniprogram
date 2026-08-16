const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getScale } = require("../miniprogram/data/scales");
const { levelFor, validateAnswers, scoreAssessment } = require("../miniprogram/utils/scoring");

const SCALE_IDS = ["ipip-neo-60-zh-local-v1", "ipip-neo-120-zh-v1", "ipip-neo-300-zh-local-v1"];

// Johnson (2014) 官方 IPIP-NEO-120 的 30 个四题分面计分方向。
// O6 在本产品中使用中性本地化题项替换，单独在对应测试中声明。
const OFFICIAL_IPIP_NEO_120_KEYS = {
  N1: [1, 1, 1, 1], N2: [1, 1, 1, -1], N3: [1, 1, 1, -1], N4: [1, 1, 1, -1], N5: [1, -1, -1, -1], N6: [1, 1, 1, -1],
  E1: [1, 1, -1, -1], E2: [1, 1, -1, -1], E3: [1, 1, 1, -1], E4: [1, 1, 1, -1], E5: [1, 1, 1, 1], E6: [1, 1, 1, 1],
  O1: [1, 1, 1, 1], O2: [1, 1, -1, -1], O3: [1, 1, -1, -1], O4: [1, -1, -1, -1], O5: [1, -1, -1, -1], O6: [1, 1, -1, -1],
  A1: [1, 1, 1, -1], A2: [-1, -1, -1, -1], A3: [1, 1, -1, -1], A4: [-1, -1, -1, -1], A5: [-1, -1, -1, -1], A6: [1, 1, -1, -1],
  C1: [1, 1, 1, 1], C2: [1, -1, -1, -1], C3: [1, 1, -1, -1], C4: [1, 1, -1, -1], C5: [1, 1, -1, -1], C6: [-1, -1, -1, -1],
};

test("量表题数、ID 和分面映射完整", () => {
  SCALE_IDS.forEach((scaleId) => {
    const scale = getScale(scaleId);
    assert.equal(scale.items.length, scale.itemCount);
    assert.equal(new Set(scale.items.map((item) => item.id)).size, scale.itemCount);
    assert.equal(new Set(scale.items.map((item) => item.facet)).size, 30);
    scale.items.forEach((item) => {
      assert.match(item.facet, /^[NEOAC][1-6]$/);
      assert.ok(item.keyed === 1 || item.keyed === -1);
      assert.ok(item.text.length >= 4);
    });
  });
  const shortScale = getScale("ipip-neo-60-zh-local-v1");
  const counts = shortScale.items.reduce((result, item) => ({ ...result, [item.facet]: (result[item.facet] || 0) + 1 }), {});
  Object.values(counts).forEach((count) => assert.equal(count, 2));
  assert.equal(shortScale.facetReliability, "exploratory");
});

test("云端计分键与小程序题库保持一致", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/assessmentApi/index.js"), "utf8");
  const match = source.match(/const KEYS = (\{[\s\S]*?\n\});/);
  assert.ok(match, "云函数中应包含计分键");
  const cloudKeys = vm.runInNewContext(`(${match[1]})`);
  const scale = getScale("ipip-neo-300-zh-local-v1");
  scale.items.forEach((item) => {
    const round = Number(item.id.split("-").at(-1));
    assert.equal(cloudKeys[item.facet][round - 1], item.keyed, item.id);
  });

  const shortMatch = source.match(/const IPIP_NEO_60_KEYS = (\{[\s\S]*?\n\});/);
  assert.ok(shortMatch, "云函数中应包含 60 题独立计分键");
  const shortKeys = vm.runInNewContext(`(${shortMatch[1]})`);
  const shortScale = getScale("ipip-neo-60-zh-local-v1");
  shortScale.items.forEach((item) => {
    const round = Number(item.id.split("-").at(-1));
    assert.equal(shortKeys[item.facet][round - 1], item.keyed, item.id);
  });
});

test("60 题版使用官方独立选择而非前两轮截取", () => {
  const scale = getScale("ipip-neo-60-zh-local-v1");
  const texts = new Set(scale.items.map((item) => item.text));
  assert.ok(texts.has("很容易觉得压力大"));
  assert.ok(texts.has("能顺利处理任务"));
  assert.ok(texts.has("喜欢井然有序"));
  assert.ok(texts.has("房间常常很乱"));
  assert.ok(!texts.has("担心会发生最糟糕的情况"));
});

test("120 题版保留 Johnson 官方计分方向，不按正反向数量重新选题", () => {
  const scale = getScale("ipip-neo-120-zh-v1");
  const actual = scale.items.reduce((keys, item) => {
    (keys[item.facet] ||= []).push(item.keyed);
    return keys;
  }, {});

  Object.entries(OFFICIAL_IPIP_NEO_120_KEYS).forEach(([facetId, expected]) => {
    if (facetId !== "O6") assert.deepEqual(actual[facetId], expected, facetId);
  });

  // O6 的文化敏感原题已替换为同方向的中性题项，属于明确披露的本地化差异。
  assert.deepEqual(actual.O6, [1, 1, 1, 1]);
  const sameDirectionFacets = Object.entries(actual)
    .filter(([, keys]) => new Set(keys).size === 1)
    .map(([facetId]) => facetId)
    .sort();
  assert.deepEqual(sameDirectionFacets, ["A2", "A4", "A5", "C1", "C6", "E5", "E6", "N1", "O1", "O6"]);
});

test("全选中点得到 50 分和中间水平", () => {
  SCALE_IDS.forEach((scaleId) => {
    const scale = getScale(scaleId);
    const answers = Object.fromEntries(scale.items.map((item) => [item.id, 3]));
    const result = scoreAssessment(scaleId, answers);
    assert.equal(result.domains.length, 5);
    assert.equal(result.facets.length, 30);
    result.domains.forEach((domain) => assert.equal(domain.score, 50));
    result.facets.forEach((facet) => assert.equal(facet.score, 50));
  });
});

test("正向和反向题按相反方向计分", () => {
  SCALE_IDS.forEach((scaleId) => {
    const scale = getScale(scaleId);
    const answers = Object.fromEntries(scale.items.map((item) => [item.id, item.keyed === 1 ? 5 : 1]));
    scoreAssessment(scaleId, answers).domains.forEach((domain) => assert.equal(domain.score, 100));
    const inverse = Object.fromEntries(scale.items.map((item) => [item.id, item.keyed === 1 ? 1 : 5]));
    scoreAssessment(scaleId, inverse).domains.forEach((domain) => assert.equal(domain.score, 0));
  });
});

test("拒绝缺失、越界和未知答案", () => {
  const scale = getScale(SCALE_IDS[0]);
  const answers = Object.fromEntries(scale.items.map((item) => [item.id, 3]));
  delete answers[scale.items[0].id];
  assert.throws(() => scoreAssessment(scale.id, answers), /INCOMPLETE/);
  assert.throws(() => validateAnswers(scale, { bad: 3 }), /INVALID/);
  assert.throws(() => validateAnswers(scale, { [scale.items[0].id]: 6 }), /INVALID/);
  assert.throws(() => validateAnswers(scale, { [scale.items[0].id]: "4" }), /INVALID/);
  assert.throws(() => validateAnswers(scale, { [scale.items[0].id]: null }), /INVALID/);
});

test("水平分段边界固定", () => {
  assert.equal(levelFor(39), "偏低");
  assert.equal(levelFor(40), "中间");
  assert.equal(levelFor(60), "中间");
  assert.equal(levelFor(61), "偏高");
});
