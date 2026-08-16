const fs = require("node:fs");
const path = require("node:path");
const { getScale, listScales } = require("../miniprogram/data/scales");

const outputPath = path.join(__dirname, "../cloudfunctions/assessmentApi/scale-keys.json");

function createConfig() {
  const scales = {};
  let facets = [];
  listScales().forEach((meta) => {
    const scale = getScale(meta.id);
    const keys = {};
    scale.items.forEach((item) => {
      (keys[item.facet] ||= []).push(item.keyed);
    });
    if (!facets.length) facets = Array.from(new Set(scale.items.map((item) => item.facet)));
    scales[scale.id] = {
      version: scale.version,
      rounds: scale.itemCount / 30,
      itemCount: scale.itemCount,
      facetReliability: scale.facetReliability || "standard",
      keys,
    };
  });
  return { schemaVersion: 1, facets, scales };
}

const output = `${JSON.stringify(createConfig(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== output) {
    console.error("云函数计分键已过期，请运行 npm run generate:scale-keys");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, output, "utf8");
  console.log(`已生成 ${path.relative(process.cwd(), outputPath)}`);
}
