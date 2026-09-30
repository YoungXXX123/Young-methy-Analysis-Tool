import { BASES, getMeasuredNonCpgCMask, type AnalysisResult } from "./analysis-engine";

export type HeatmapPage = {
  chunkStart: number;
  chunkCount: number;
  sampleStart: number;
  sampleCount: number;
};

export type HeatmapOptions = {
  chunkSize: number;
  focusCpg: boolean;
  focusAllC: boolean;
  focusCpn?: boolean;
  highlightTarget: boolean;
  targetSequences: string[];
  preview?: boolean;
  page?: HeatmapPage;
};

const CELL_HEIGHT = 19;
const TOP = 58;
const BOTTOM = 58;
const GAP = 34;

export function heatmapDimensions(chunkSize: number, sampleCount: number, chunkCount: number, preview = false) {
  const chunkHeight = TOP + sampleCount * 4 * CELL_HEIGHT + BOTTOM;
  return {
    width: (preview ? 150 : 260) + chunkSize * (preview ? 24 : 30) + 32,
    height: chunkCount * chunkHeight + Math.max(0, chunkCount - 1) * GAP,
    chunkHeight,
  };
}

export function planHeatmapPages(referenceLength: number, sampleCount: number, chunkSize: number): HeatmapPage[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || referenceLength <= 0 || sampleCount <= 0) {
    throw new Error("没有可导出的比对结果");
  }
  // Bound both canvas dimensions and raw pixel memory; smaller devices can retry smaller pages.
  const maxDimension = 8192;
  const maxPixels = 16_000_000;
  const width = heatmapDimensions(chunkSize, 1, 1).width;
  const heightLimit = Math.min(maxDimension, Math.floor(maxPixels / width));
  const maxSamples = Math.floor((heightLimit - TOP - BOTTOM) / (4 * CELL_HEIGHT));
  if (width > maxDimension || maxSamples < 1) throw new Error("图片宽度超出可导出范围");
  const chunkCount = Math.ceil(referenceLength / chunkSize);
  const pages: HeatmapPage[] = [];
  for (let sampleStart = 0; sampleStart < sampleCount; sampleStart += maxSamples) {
    const pageSamples = Math.min(maxSamples, sampleCount - sampleStart);
    const { chunkHeight } = heatmapDimensions(chunkSize, pageSamples, 1);
    const maxChunks = Math.max(1, Math.floor((heightLimit + GAP) / (chunkHeight + GAP)));
    for (let chunkStart = 0; chunkStart < chunkCount; chunkStart += maxChunks) {
      pages.push({ chunkStart, chunkCount: Math.min(maxChunks, chunkCount - chunkStart), sampleStart, sampleCount: pageSamples });
    }
  }
  return pages;
}

const COLORS = {
  ink: "#13242b",
  muted: "#697a80",
  border: "#d6dee0",
  green: "#2f9e72",
  red: "#dc5a4f",
  purple: "#7b61a8",
  yellow: "#f2c84b",
  nonCpg: "#57aa75",
};

function blue(value: number) {
  if (!Number.isFinite(value)) return "#f3f6f6";
  const start = [242, 247, 249];
  const end = [22, 99, 146];
  return `rgb(${start.map((channel, index) => Math.round(channel + (end[index] - channel) * value)).join(",")})`;
}

function cpgMask(reference: string) {
  const mask = Array(reference.length).fill(false);
  for (let i = 0; i < reference.length - 1; i += 1) {
    if (reference[i] === "C" && reference[i + 1] === "G") {
      mask[i] = true;
      mask[i + 1] = true;
    }
  }
  return mask;
}

export function fitLabel(context: Pick<CanvasRenderingContext2D, "measureText">, label: string, maxWidth: number) {
  if (context.measureText(label).width <= maxWidth) return label;
  let shortened = label;
  while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

export function renderHeatmap(reference: string, allResults: AnalysisResult[], options: HeatmapOptions) {
  const page = options.preview ? undefined : options.page;
  const results = options.preview ? allResults.slice(0, 3) : page
    ? allResults.slice(page.sampleStart, page.sampleStart + page.sampleCount) : allResults;
  const chunkCount = Math.ceil(reference.length / options.chunkSize);
  const firstChunk = page?.chunkStart ?? 0;
  const visibleChunks = options.preview ? Math.min(5, chunkCount) : page?.chunkCount ?? chunkCount;
  const cellWidth = options.preview ? 24 : 30;
  const cellHeight = CELL_HEIGHT;
  const labelWidth = options.preview ? 150 : 260;
  const top = TOP;
  const gap = GAP;
  const { width, height, chunkHeight } = heatmapDimensions(options.chunkSize, results.length, visibleChunks, options.preview);
  const scale = options.preview ? Math.min(1.5, window.devicePixelRatio || 1) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) {
    canvas.width = canvas.height = 0;
    throw new Error("无法创建绘图画布");
  }
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.textBaseline = "middle";
  const cpg = cpgMask(reference);
  const nonCpg = getMeasuredNonCpgCMask(reference, options.preview ? results : allResults);
  const targetRanges = options.targetSequences.map((sequence) => {
    const start = reference.indexOf(sequence);
    return { start, end: start >= 0 ? start + sequence.length : -1 };
  }).filter((range) => range.start >= 0);

  for (let chunk = 0; chunk < visibleChunks; chunk += 1) {
    const start = (firstChunk + chunk) * options.chunkSize;
    const end = Math.min(reference.length, start + options.chunkSize);
    const originY = chunk * (chunkHeight + gap);
    context.fillStyle = COLORS.ink;
    context.font = "600 13px Arial";
    context.fillText(`Reference ${start + 1}–${end}`, labelWidth, originY + 18);
    context.fillStyle = COLORS.muted;
    context.font = "12px Arial";
    context.fillText(`${results.length} sample${results.length === 1 ? "" : "s"}`, width - 100, originY + 18);

    results.forEach((result, sampleIndex) => {
      const sampleCpn = options.focusCpn ? getMeasuredNonCpgCMask(reference, [result]) : null;
      const sampleTop = originY + top + sampleIndex * 4 * cellHeight;
      context.fillStyle = COLORS.ink;
      context.font = "600 11px Arial";
      context.textAlign = "right";
      context.fillText(fitLabel(context, result.name, labelWidth - 54), labelWidth - 42, sampleTop + 2 * cellHeight);
      context.textAlign = "left";

      BASES.forEach((base, baseIndex) => {
        context.fillStyle = COLORS.muted;
        context.font = "700 10px Arial";
        context.fillText(base, labelWidth - 32, sampleTop + baseIndex * cellHeight + cellHeight / 2);
        for (let local = 0; local < options.chunkSize; local += 1) {
          const global = start + local;
          const x = labelWidth + local * cellWidth;
          const y = sampleTop + baseIndex * cellHeight;
          const value = global < reference.length ? result.matrix[base][global] : Number.NaN;
          const focused = (!options.focusCpg && !options.focusAllC && !options.focusCpn) ||
            (options.focusCpg && cpg[global]) || (options.focusAllC && reference[global] === "C") ||
            (options.focusCpn && sampleCpn?.[global]);
          context.fillStyle = focused ? blue(value) : "#f7f8f8";
          context.fillRect(x, y, cellWidth, cellHeight);
          context.strokeStyle = "#dde4e5";
          context.lineWidth = 0.7;
          context.strokeRect(x, y, cellWidth, cellHeight);
          if (Number.isFinite(value) && value >= 0.05) {
            context.fillStyle = focused ? (value > 0.56 ? "#ffffff" : COLORS.ink) : "#aeb8bb";
            context.font = `${focused ? 700 : 400} ${options.chunkSize > 70 ? 8 : 9}px Arial`;
            context.textAlign = "center";
            context.fillText(`${Math.floor(value * 100)}`, x + cellWidth / 2, y + cellHeight / 2 + 0.5);
            context.textAlign = "left";
          }
        }
      });

      for (let local = 0; local < end - start; local += 1) {
        const global = start + local;
        const status = result.matchStatus[global];
        if (status === null) continue;
        context.strokeStyle = status ? COLORS.green : COLORS.red;
        context.lineWidth = status ? 1.6 : 2.5;
        context.strokeRect(labelWidth + local * cellWidth + 1, sampleTop + 1, cellWidth - 2, 4 * cellHeight - 2);
      }
    });

    const axisY = originY + top + results.length * 4 * cellHeight;
    for (let local = 0; local < options.chunkSize; local += 1) {
      const global = start + local;
      if (global >= reference.length) break;
      const x = labelWidth + local * cellWidth + cellWidth / 2;
      if (options.highlightTarget && targetRanges.some((range) => global >= range.start && global < range.end)) {
        context.save();
        context.strokeStyle = COLORS.purple;
        context.setLineDash([4, 3]);
        context.lineWidth = 1.8;
        context.strokeRect(labelWidth + local * cellWidth + 2, originY + top - 3, cellWidth - 4, results.length * 4 * cellHeight + 6);
        context.restore();
      }
      context.fillStyle = options.focusCpn
        ? nonCpg[global] ? COLORS.nonCpg : COLORS.ink
        : cpg[global] ? COLORS.yellow : COLORS.ink;
      context.font = `700 ${options.chunkSize > 70 ? 8 : 10}px ui-monospace, monospace`;
      context.textAlign = "center";
      context.fillText(reference[global], x, axisY + 16);
      context.fillStyle = COLORS.muted;
      context.font = "9px Arial";
      context.fillText(String(global + 1), x, axisY + 35);
    }
    context.textAlign = "left";
  }
  return canvas;
}
