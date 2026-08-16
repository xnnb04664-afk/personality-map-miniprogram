function getMissingItems(items, answers, currentIndex) {
  const responseMap = answers || {};
  return items.reduce((missing, item, index) => {
    if (!responseMap[item.id]) {
      missing.push({
        index,
        number: index + 1,
        isCurrent: index === currentIndex,
      });
    }
    return missing;
  }, []);
}

function getNextMissingIndex(items, answers, afterIndex) {
  const missing = getMissingItems(items, answers, -1).map((item) => item.index);
  if (!missing.length) return -1;
  const next = missing.find((index) => index > afterIndex);
  return next === undefined ? missing[0] : next;
}

module.exports = { getMissingItems, getNextMissingIndex };
