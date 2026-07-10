import { BASES, type AnalysisResult } from "./analysis-engine";

export type HeatmapOptions = {
  chunkSize: number;
  focusCpg: boolean;
  focusAllC: boolean;
  highlightTarget: boolean;
  targetSequence: string;
  preview?: boolean;
};

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

function measuredNonCpgMask(reference: string, results: AnalysisResult[]) {
  const mask = Array(reference.length).fill(false);
  results.forEach((result) => {
    for (let index = 0; index < reference.length; index += 1) {
      if (!Number.isFinite(result.matrix.C[index])) continue;
      const called = BASES.reduce((best, base) => result.matrix[base][index] > result.matrix[best][index] ? base : best, "A");
      if (called !== "C") continue;
      const nextIsG = index + 1 < reference.length && Number.isFinite(result.matrix.A[index + 1]) &&
        BASES.reduce((best, base) => result.matrix[base][index + 1] > result.matrix[best][index + 1] ? base : best, "A") === "G";
      if (!nextIsG) mask[index] = true;
    }
  });
  return mask;
}

function fitLabel(context: CanvasRenderingContext2D, label: string, maxWidth: number) {
  if (context.measureText(label).width <= maxWidth) return label;
  let shortened = label;
  while (shortened.length > 8 && context.measureText(`…${shortened}`).width > maxWidth) shortened = shortened.slice(1);
  return `…${shortened}`;
}

export function renderHeatmap(reference: string, allResults: AnalysisResult[], options: HeatmapOptions) {
  const results = options.preview ? allResults.slice(0, 3) : allResults;
  const chunkCount = Math.ceil(reference.length / options.chunkSize);
  const visibleChunks = options.preview ? Math.min(5, chunkCount) : chunkCount;
  const cellWidth = options.preview ? 24 : 30;
  const cellHeight = 19;
  const labelWidth = options.preview ? 150 : 260;
  const top = 58;
  const bottom = 58;
  const gap = 34;
  const chunkHeight = top + results.length * 4 * cellHeight + bottom;
  const width = labelWidth + options.chunkSize * cellWidth + 32;
  const height = visibleChunks * chunkHeight + Math.max(0, visibleChunks - 1) * gap;
  const scale = options.preview ? Math.min(1.5, window.devicePixelRatio || 1) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建绘图画布");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.textBaseline = "middle";
  const cpg = cpgMask(reference);
  const nonCpg = measuredNonCpgMask(reference, results);
  const targetStart = options.targetSequence ? reference.indexOf(options.targetSequence) : -1;
  const targetEnd = targetStart >= 0 ? targetStart + options.targetSequence.length : -1;

  for (let chunk = 0; chunk < visibleChunks; chunk += 1) {
    const start = chunk * options.chunkSize;
    const end = Math.min(reference.length, start + options.chunkSize);
    const originY = chunk * (chunkHeight + gap);
    context.fillStyle = COLORS.ink;
    context.font = "600 13px Arial";
    context.fillText(`Reference ${start + 1}–${end}`, labelWidth, originY + 18);
    context.fillStyle = COLORS.muted;
    context.font = "12px Arial";
    context.fillText(`${results.length} sample${results.length === 1 ? "" : "s"}`, width - 100, originY + 18);

    results.forEach((result, sampleIndex) => {
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
          const focused = (!options.focusCpg && !options.focusAllC) ||
            (options.focusCpg && cpg[global]) || (options.focusAllC && reference[global] === "C");
          context.fillStyle = focused ? blue(value) : "#f7f8f8";
          context.fillRect(x, y, cellWidth, cellHeight);
          context.strokeStyle = "#dde4e5";
          context.lineWidth = 0.7;
          context.strokeRect(x, y, cellWidth, cellHeight);
          if (Number.isFinite(value) && value >= 0.05 && focused) {
            context.fillStyle = value > 0.56 ? "#ffffff" : COLORS.ink;
            context.font = `700 ${options.chunkSize > 70 ? 8 : 9}px Arial`;
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
      if (options.highlightTarget && targetStart >= 0 && global >= targetStart && global < targetEnd) {
        context.save();
        context.strokeStyle = COLORS.purple;
        context.setLineDash([4, 3]);
        context.lineWidth = 1.8;
        context.strokeRect(labelWidth + local * cellWidth + 2, originY + top - 3, cellWidth - 4, results.length * 4 * cellHeight + 6);
        context.restore();
      }
      context.fillStyle = cpg[global] ? COLORS.yellow : nonCpg[global] ? COLORS.nonCpg : COLORS.ink;
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

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }, "image/png");
}
