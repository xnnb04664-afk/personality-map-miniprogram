const TRAIT_PHRASES = {
  N: { low: "情绪相对平稳", high: "对情绪与风险更敏锐", middle: "情绪反应随情境调整" },
  E: { low: "偏好安静与独立空间", high: "容易从互动与行动中获得能量", middle: "社交节奏较为灵活" },
  O: { low: "重视熟悉且可验证的方法", high: "乐于探索观念与新体验", middle: "能在熟悉与新颖之间切换" },
  A: { low: "表达直接并重视独立判断", high: "重视合作、体谅与关系协调", middle: "会按情境平衡合作与立场" },
  C: { low: "做事灵活并保留调整空间", high: "偏好有序推进并重视完成质量", middle: "能在计划与灵活之间切换" },
};

function phraseFor(domain) {
  const phrases = TRAIT_PHRASES[domain.id] || {};
  if (domain.score < 40) return phrases.low || domain.summary;
  if (domain.score > 60) return phrases.high || domain.summary;
  return phrases.middle || domain.summary;
}

function buildReportPresentation(domains) {
  const safeDomains = Array.isArray(domains) ? domains : [];
  const ranked = safeDomains
    .map((domain, index) => ({ ...domain, sourceIndex: index, deviation: Math.abs(Number(domain.score) - 50), phrase: phraseFor(domain) }))
    .sort((left, right) => right.deviation - left.deviation || left.sourceIndex - right.sourceIndex);
  const leading = ranked.slice(0, 2).map((domain) => domain.phrase).filter(Boolean);
  return {
    profileTitle: leading.length ? leading.join("，") : "你的特质会随情境呈现不同侧面",
    prominentTraits: ranked.slice(0, 3),
    expandedDomain: ranked.length ? ranked[0].id : "",
  };
}

module.exports = { buildReportPresentation };
