import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds a GitHub Pages-ready static application", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /Young Methy \| Sanger 甲基化效率分析/);
  assert.match(html, /\/Young-methy-Analysis-Tool\/assets\//);
  assert.match(html, /\/Young-methy-Analysis-Tool\/favicon\.svg/);
  await access(new URL("../dist/og.jpg", import.meta.url));
  await access(new URL("../dist/.nojekyll", import.meta.url));
});

test("retains the analysis and export capabilities", async () => {
  const [app, engine, heatmap] = await Promise.all([
    readFile(new URL("../src/analysis-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/analysis-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/heatmap.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /剪切低质量末端/);
  assert.match(app, /下载完整 PNG/);
  assert.match(app, /CpG_Distance_Analysis\.csv/);
  assert.match(app, /任意位点查询/);
  assert.match(engine, /readAscii\(view, 0, 4\) !== "ABIF"/);
  assert.match(engine, /reference\[i - 1\] === query\[j - 1\] \? 5 : -4/);
  assert.match(engine, /match\[up\] - 20/);
  assert.match(engine, /gapQuery\[up\] - 2/);
  assert.match(heatmap, /renderHeatmap/);
});
