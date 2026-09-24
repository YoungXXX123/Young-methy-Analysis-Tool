import { Zip, ZipPassThrough } from "fflate";
import type { AnalysisResult } from "./analysis-engine";
import { planHeatmapPages, renderHeatmap, type HeatmapOptions, type HeatmapPage } from "./heatmap";

const BASENAME = "Sanger_Full_Alignment_Optimized";

export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("图片编码超时")), 30_000);
    try {
      // Oversized canvases can silently stop drawing even when a context exists.
      const context = canvas.getContext("2d");
      if (!canvas.width || !canvas.height || !context ||
        context.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3] !== 255) {
        throw new Error("绘图画布超出浏览器容量");
      }
      canvas.toBlob((blob) => {
        window.clearTimeout(timeout);
        if (blob?.size) resolve(blob);
        else reject(new Error("浏览器未能生成 PNG 图片"));
      }, "image/png");
    } catch (error) {
      window.clearTimeout(timeout);
      reject(error);
    }
  });
}

function splitPage(page: HeatmapPage): HeatmapPage[] {
  if (page.chunkCount > 1) {
    const firstCount = Math.floor(page.chunkCount / 2);
    return [
      { ...page, chunkCount: firstCount },
      { ...page, chunkStart: page.chunkStart + firstCount, chunkCount: page.chunkCount - firstCount },
    ];
  }
  if (page.sampleCount > 1) {
    const firstCount = Math.floor(page.sampleCount / 2);
    return [
      { ...page, sampleCount: firstCount },
      { ...page, sampleStart: page.sampleStart + firstCount, sampleCount: page.sampleCount - firstCount },
    ];
  }
  return [];
}

export async function createHeatmapDownload(
  reference: string,
  results: AnalysisResult[],
  options: HeatmapOptions,
  onProgress: (completed: number, total: number) => void = () => {},
) {
  const pages = planHeatmapPages(reference.length, results.length, options.chunkSize);
  const archiveParts: BlobPart[] = [];
  let archive: Zip | undefined;
  let archiveError: Error | undefined;
  let archiveFinished = false;
  let singlePng: Blob | undefined;
  let completed = 0;
  try {
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      onProgress(completed, pages.length);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      let canvas: HTMLCanvasElement | undefined;
      let png: Blob;
      try {
        canvas = renderHeatmap(reference, results, { ...options, preview: false, page });
        png = await canvasPng(canvas);
      } catch (error) {
        const smaller = splitPage(page);
        if (!smaller.length) throw new Error(`图片导出失败：${error instanceof Error ? error.message : "绘图错误"}。请关闭其他占用内存的页面后重试。`);
        pages.splice(index, 1, ...smaller);
        index -= 1;
        continue;
      } finally {
        if (canvas) canvas.width = canvas.height = 0;
      }

      if (pages.length === 1) singlePng = png;
      else {
        archive ??= new Zip((error, data, final) => {
          if (error) archiveError = error;
          else {
            archiveParts.push(new Blob([new Uint8Array(data)]));
            archiveFinished = final;
          }
        });
        const start = page.chunkStart * options.chunkSize + 1;
        const end = Math.min(reference.length, (page.chunkStart + page.chunkCount) * options.chunkSize);
        const name = `${BASENAME}_${String(completed + 1).padStart(4, "0")}_ref-${start}-${end}_samples-${page.sampleStart + 1}-${page.sampleStart + page.sampleCount}.png`;
        const entry = new ZipPassThrough(name);
        archive.add(entry);
        entry.push(new Uint8Array(await png.arrayBuffer()), true);
        if (archiveError) throw archiveError;
      }
      completed += 1;
      onProgress(completed, pages.length);
    }
    if (singlePng) return { blob: singlePng, filename: `${BASENAME}.png`, pageCount: 1 };
    archive?.end();
    if (archiveError) throw archiveError;
    if (!archiveFinished) throw new Error("图片打包未完成，请重试");
    return { blob: new Blob(archiveParts, { type: "application/zip" }), filename: `${BASENAME}.zip`, pageCount: completed };
  } catch (error) {
    archive?.terminate();
    throw error;
  }
}

export function downloadImageFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
