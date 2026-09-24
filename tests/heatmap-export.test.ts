import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { unzipSync } from "fflate";
import type { AnalysisResult } from "../src/analysis-engine";
import { heatmapDimensions, planHeatmapPages, type HeatmapOptions } from "../src/heatmap";
import { canvasPng, createHeatmapDownload, downloadImageFile } from "../src/heatmap-export";

const options: HeatmapOptions = { chunkSize: 50, focusCpg: false, focusAllC: false, highlightTarget: true, targetSequences: ["CG"] };

test("export pages cover every reference chunk and sample exactly once within canvas bounds", () => {
  for (const [length, samples, chunkSize] of [[100, 2, 50], [50_003, 3, 50], [123, 500, 100]]) {
    const chunks = Math.ceil(length / chunkSize);
    const seen = new Set<string>();
    const pages = planHeatmapPages(length, samples, chunkSize);
    for (const page of pages) {
      const dimensions = heatmapDimensions(chunkSize, page.sampleCount, page.chunkCount);
      assert.ok(dimensions.width <= 8192 && dimensions.height <= 8192);
      assert.ok(dimensions.width * dimensions.height <= 16_000_000);
      for (let s = page.sampleStart; s < page.sampleStart + page.sampleCount; s += 1) {
        for (let c = page.chunkStart; c < page.chunkStart + page.chunkCount; c += 1) {
          assert.ok(s < samples && c < chunks);
          const key = `${s}:${c}`;
          assert.ok(!seen.has(key));
          seen.add(key);
        }
      }
    }
    assert.equal(seen.size, samples * chunks);
    if (length === 100) assert.equal(pages.length, 1);
    else assert.ok(pages.length > 1);
  }
});

function mockBrowser(t: TestContext, failAbove = Infinity) {
  const setGlobal = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  };
  const canvases: Array<{ width: number; height: number; style: object }> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const anchors: Array<{ href: string; download: string; click: () => void; remove: () => void }> = [];
  const labels: string[] = [];
  const revocations: string[] = [];
  let attached = false;
  let clicked = false;
  const context = {
    scale() {}, fillRect() {}, strokeRect() {}, save() {}, restore() {}, setLineDash() {},
    fillText(value: string) { labels.push(value); },
    measureText(value: string) { return { width: value.length * 6 }; },
    getImageData() { return { data: new Uint8Array([255, 255, 255, 255]) }; },
  };
  setGlobal("window", {
    devicePixelRatio: 1,
    setTimeout(callback: () => void, delay: number) {
      if (delay === 0) queueMicrotask(callback);
      else timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
  });
  setGlobal("document", {
    body: { appendChild() { attached = true; } },
    createElement(tag: string) {
      if (tag === "a") {
        const anchor = { href: "", download: "", click() { assert.ok(attached); clicked = true; }, remove() { attached = false; } };
        anchors.push(anchor);
        return anchor;
      }
      const canvas = {
        width: 0, height: 0, style: {}, getContext: () => context,
        toBlob(callback: (blob: Blob | null) => void) {
          callback(canvas.height > failAbove ? null : new Blob(["test-image"], { type: "image/png" }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  t.mock.method(URL, "createObjectURL", () => "blob:test-download");
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revocations.push(url); });
  return { canvases, timers, anchors, labels, revocations, wasClicked: () => clicked };
}

function samples(length: number, count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    name: `sample-${index + 1}`,
    matrix: { A: Array(length).fill(0), C: Array(length).fill(0.4), G: Array(length).fill(0), T: Array(length).fill(0.6) },
    matchStatus: Array(length).fill(true),
  })) as AnalysisResult[];
}

test("ordinary exports stay a single PNG and release the canvas", async (t) => {
  const browser = mockBrowser(t);
  const file = await createHeatmapDownload("CG".repeat(25), samples(50), options);
  assert.equal(file.pageCount, 1);
  assert.equal(file.filename, "Sanger_Full_Alignment_Optimized.png");
  assert.equal(file.blob.type, "image/png");
  assert.ok(browser.canvases.every((c) => c.width === 0 && c.height === 0));
});

test("failed large encodings retry smaller pages and include the entire reference in one ZIP", async (t) => {
  const browser = mockBrowser(t, 300);
  const progress: number[] = [];
  const file = await createHeatmapDownload("CG".repeat(75), samples(150), options, (completed) => progress.push(completed));
  assert.equal(file.pageCount, 3);
  assert.equal(file.blob.type, "application/zip");
  const archive = unzipSync(new Uint8Array(await file.blob.arrayBuffer()));
  const names = Object.keys(archive);
  assert.equal(names.length, 3);
  assert.ok(names[0].includes("ref-1-50_samples-1-1"));
  assert.ok(names[1].includes("ref-51-100_samples-1-1"));
  assert.ok(names[2].includes("ref-101-150_samples-1-1"));
  names.forEach((name) => assert.equal(new TextDecoder().decode(archive[name]), "test-image"));
  assert.ok(browser.labels.includes("Reference 101–150"));
  assert.equal(progress.at(-1), 3);
  assert.ok(browser.canvases.every((c) => c.width === 0 && c.height === 0));
});

test("encoding fallback also splits samples without omitting rows", async (t) => {
  const browser = mockBrowser(t, 200);
  const file = await createHeatmapDownload("CG".repeat(25), samples(50, 3), options);
  const archive = unzipSync(new Uint8Array(await file.blob.arrayBuffer()));
  assert.equal(file.pageCount, 3);
  [1, 2, 3].forEach((sample) => assert.ok(Object.keys(archive).some((name) => name.includes(`samples-${sample}-${sample}`))));
  assert.ok(browser.canvases.every((c) => c.width === 0 && c.height === 0));
});

test("persistent encoding failure surfaces an error and frees every attempted canvas", async (t) => {
  const browser = mockBrowser(t, 0);
  await assert.rejects(createHeatmapDownload("CG".repeat(50), samples(100), options), /图片导出失败/);
  assert.ok(browser.canvases.every((c) => c.width === 0 && c.height === 0));
});

test("encoding has a timeout and download URLs are retained until after the click", async (t) => {
  const browser = mockBrowser(t);
  const pending = canvasPng({ width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: [255, 255, 255, 255] }) }), toBlob() {} } as unknown as HTMLCanvasElement);
  browser.timers.find((timer) => timer.delay === 30_000)!.callback();
  await assert.rejects(pending, /超时/);
  downloadImageFile(new Blob(["png"]), "full.png");
  assert.ok(browser.wasClicked());
  assert.equal(browser.anchors[0].download, "full.png");
  assert.equal(browser.revocations.length, 0);
  browser.timers.find((timer) => timer.delay === 60_000)!.callback();
  assert.deepEqual(browser.revocations, ["blob:test-download"]);
});
