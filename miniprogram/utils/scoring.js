const { DOMAIN_META, FACETS, getScale } = require("../data/scales");

function levelFor(score) {
  if (score < 40) return "偏低";
  if (score > 60) return "偏高";
  return "中间";
}

function validateAnswers(scale, answers, requireComplete = false) {
  if (!scale || !answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("INVALID_ANSWERS");
  }
  const validIds = new Set(scale.items.map((item) => item.id));
  const keys = Object.keys(answers);
  keys.forEach((id) => {
    const value = answers[id];
    if (!validIds.has(id) || !Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error("INVALID_ANSWER_VALUE");
    }
  });
  if (requireComplete && keys.length !== scale.itemCount) {
    throw new Error("INCOMPLETE_ANSWERS");
  }
  return true;
}

function toPercent(sum, count) {
  return Math.round(((sum - count) / (count * 4)) * 100);
}

function scoreAssessment(scaleId, answers) {
  const scale = getScale(scaleId);
  if (!scale) throw new Error("UNKNOWN_SCALE");
  validateAnswers(scale, answers, true);

  const facetBuckets = {};
  scale.items.forEach((item) => {
    const raw = answers[item.id];
    const scored = item.keyed === 1 ? raw : 6 - raw;
    if (!facetBuckets[item.facet]) facetBuckets[item.facet] = [];
    facetBuckets[item.facet].push(scored);
  });

  const facets = FACETS.map((meta) => {
    const values = facetBuckets[meta.id];
    const score = toPercent(values.reduce((sum, value) => sum + value, 0), values.length);
    return { ...meta, score, level: levelFor(score) };
  });

  const domains = Object.keys(DOMAIN_META).map((id) => {
    const related = facets.filter((item) => item.domain === id);
    const score = Math.round(related.reduce((sum, item) => sum + item.score, 0) / related.length);
    const meta = DOMAIN_META[id];
    return {
      id,
      ...meta,
      score,
      level: levelFor(score),
      summary: score < 40 ? meta.low : score > 60 ? meta.high : `你在${meta.name}上处于量表中间位置，表现会更多地随情境变化。`,
      facets: related,
    };
  });

  return { scaleId, domains, facets };
}

module.exports = { levelFor, validateAnswers, scoreAssessment };
