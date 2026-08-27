export type Base = "A" | "C" | "G" | "T";

export type BaseProportion = Record<Base, number> & { calledBase: Base };

export type MappingSummary = {
  referenceStart: number | null;
  referenceEnd: number | null;
  queryLength: number;
  alignedBases: number;
  matches: number;
  identity: number;
  coverageRatio: number;
  warnings: string[];
};

export type MergeSummary = {
  segmentCount: number;
  coveredPositions: number;
  overlapPositions: number;
  conflictingPositions: number;
};

export type AnalysisResult = {
  name: string;
  matrix: Record<Base, number[]>;
  matchStatus: Array<boolean | null>;
  orientation: "forward" | "reverse" | "mixed";
  score: number;
  mappedQuality: Map<number, number>;
  mappedIndices: number[];
  mapping: MappingSummary;
  sourceNames?: string[];
  mergeSummary?: MergeSummary;
};

export type AnalysisFailure = { name: string; message: string };

export type CpgRow = {
  targetNumber: number;
  targetSequence: string;
  targetStart: number | null;
  position: number;
  distance: number;
  averageC: number | null;
  measuredSamples: number;
};

const BASES: Base[] = ["A", "C", "G", "T"];

type AbiDirectory = {
  tag: string;
  number: number;
  elementType: number;
  elementSize: number;
  elements: number;
  dataSize: number;
  dataOffset: number;
  entryOffset: number;
};

type AbiRecord = {
  sequence: string;
  quality: number[];
  proportions: BaseProportion[];
};

function readAscii(view: DataView, offset: number, length: number) {
  let result = "";
  for (let i = 0; i < length; i += 1) {
    const code = view.getUint8(offset + i);
    if (code !== 0) result += String.fromCharCode(code);
  }
  return result;
}

function parseDirectory(view: DataView, offset: number): AbiDirectory {
  return {
    tag: readAscii(view, offset, 4),
    number: view.getUint32(offset + 4, false),
    elementType: view.getUint16(offset + 8, false),
    elementSize: view.getUint16(offset + 10, false),
    elements: view.getUint32(offset + 12, false),
    dataSize: view.getUint32(offset + 16, false),
    dataOffset: view.getUint32(offset + 20, false),
    entryOffset: offset,
  };
}

function dataStart(entry: AbiDirectory) {
  return entry.dataSize <= 4 ? entry.entryOffset + 20 : entry.dataOffset;
}

function readEntryText(view: DataView, entry: AbiDirectory) {
  const start = dataStart(entry);
  let value = readAscii(view, start, entry.dataSize);
  if (entry.elementType === 18 && value.length > 0) value = value.slice(1);
  return value.replace(/\0+$/g, "");
}

function readEntryNumbers(view: DataView, entry: AbiDirectory) {
  const start = dataStart(entry);
  const count = Math.min(entry.elements, Math.floor(entry.dataSize / Math.max(1, entry.elementSize)));
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = start + i * entry.elementSize;
    if (entry.elementSize === 1) values.push(view.getUint8(offset));
    else if (entry.elementSize === 2) {
      values.push(entry.elementType === 4 ? view.getInt16(offset, false) : view.getUint16(offset, false));
    } else if (entry.elementSize === 4) {
      values.push(entry.elementType === 7 ? view.getFloat32(offset, false) : view.getInt32(offset, false));
    }
  }
  return values;
}

function getEntry(entries: Map<string, AbiDirectory>, tag: string, preferredNumber?: number) {
  if (preferredNumber !== undefined) {
    const exact = entries.get(`${tag}${preferredNumber}`);
    if (exact) return exact;
  }
  return [...entries.values()].filter((entry) => entry.tag === tag).sort((a, b) => b.number - a.number)[0];
}

export function parseAbi(buffer: ArrayBuffer): AbiRecord {
  const view = new DataView(buffer);
  if (view.byteLength < 34 || readAscii(view, 0, 4) !== "ABIF") {
    throw new Error("不是有效的 AB1/ABIF 文件");
  }

  const root = parseDirectory(view, 6);
  if (root.dataOffset + root.elements * 28 > view.byteLength) {
    throw new Error("AB1 目录数据不完整");
  }

  const entries = new Map<string, AbiDirectory>();
  for (let i = 0; i < root.elements; i += 1) {
    const entry = parseDirectory(view, root.dataOffset + i * 28);
    entries.set(`${entry.tag}${entry.number}`, entry);
  }

  const sequenceEntry = getEntry(entries, "PBAS", 2);
  const peakEntry = getEntry(entries, "PLOC", 2);
  const orderEntry = getEntry(entries, "FWO_", 1);
  if (!sequenceEntry || !peakEntry || !orderEntry) {
    throw new Error("AB1 缺少 PBAS2、PLOC2 或 FWO_1 数据");
  }

  const sequence = readEntryText(view, sequenceEntry).toUpperCase().replace(/[^ACGTN]/g, "N");
  const peakLocations = readEntryNumbers(view, peakEntry);
  const order = readEntryText(view, orderEntry).toUpperCase().slice(0, 4);
  const qualityEntry = getEntry(entries, "PCON", 2);
  const quality = qualityEntry ? readEntryNumbers(view, qualityEntry) : [];

  if (order.length !== 4 || !BASES.every((base) => order.includes(base))) {
    throw new Error("AB1 荧光通道顺序无效");
  }

  const traces = {} as Record<Base, number[]>;
  for (let channel = 0; channel < 4; channel += 1) {
    const traceEntry = getEntry(entries, "DATA", 9 + channel);
    if (!traceEntry) throw new Error(`AB1 缺少 DATA${9 + channel} 荧光通道`);
    traces[order[channel] as Base] = readEntryNumbers(view, traceEntry);
  }

  const proportions: BaseProportion[] = peakLocations.map((location) => {
    const signals = {} as Record<Base, number>;
    let total = 0;
    BASES.forEach((base) => {
      signals[base] = Math.max(0, traces[base]?.[location] ?? 0);
      total += signals[base];
    });
    const values = {} as Record<Base, number>;
    BASES.forEach((base) => {
      values[base] = total > 0 ? signals[base] / total : 0;
    });
    const calledBase = BASES.reduce((best, base) => (values[base] > values[best] ? base : best), "A");
    return { ...values, calledBase };
  });

  const usableLength = Math.min(sequence.length, proportions.length);
  return {
    sequence: sequence.slice(0, usableLength),
    quality: quality.slice(0, usableLength),
    proportions: proportions.slice(0, usableLength),
  };
}

export function trimLowQuality(record: AbiRecord, threshold: number, windowSize: number): AbiRecord {
  if (!record.quality.length || record.quality.length < windowSize) return record;
  const sequenceLength = record.quality.length;
  let start = 0;
  let end = sequenceLength;

  for (let i = 0; i < sequenceLength - windowSize; i += 1) {
    const average = record.quality.slice(i, i + windowSize).reduce((sum, value) => sum + value, 0) / windowSize;
    if (average >= threshold) {
      start = i;
      break;
    }
  }
  for (let i = sequenceLength; i > windowSize; i -= 1) {
    const average = record.quality.slice(i - windowSize, i).reduce((sum, value) => sum + value, 0) / windowSize;
    if (average >= threshold) {
      end = i;
      break;
    }
  }
  if (start >= end) return record;
  return {
    sequence: record.sequence.slice(start, end),
    quality: record.quality.slice(start, end),
    proportions: record.proportions.slice(start, end),
  };
}

const COMPLEMENT: Record<string, string> = { A: "T", T: "A", C: "G", G: "C", N: "N" };

function reverseComplement(record: AbiRecord): AbiRecord {
  const sequence = [...record.sequence].reverse().map((base) => COMPLEMENT[base] ?? "N").join("");
  const proportions = [...record.proportions].reverse().map((item) => ({
    calledBase: COMPLEMENT[item.calledBase] as Base,
    A: item.T,
    T: item.A,
    C: item.G,
    G: item.C,
  }));
  return { sequence, proportions, quality: [...record.quality].reverse() };
}

type Alignment = { score: number; pairs: Array<[number, number]> };

function localAlign(reference: string, query: string): Alignment {
  const rows = reference.length + 1;
  const columns = query.length + 1;
  const size = rows * columns;
  const match = new Float32Array(size);
  const gapQuery = new Float32Array(size);
  const gapReference = new Float32Array(size);
  const traceMatch = new Uint8Array(size);
  const traceGapQuery = new Uint8Array(size);
  const traceGapReference = new Uint8Array(size);
  let bestScore = 0;
  let bestIndex = 0;
  let bestState = 0;

  const choose = (a: number, b: number, c: number) => {
    if (a >= b && a >= c && a > 0) return [a, 1] as const;
    if (b >= c && b > 0) return [b, 2] as const;
    if (c > 0) return [c, 3] as const;
    return [0, 0] as const;
  };

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const index = i * columns + j;
      const diagonal = (i - 1) * columns + j - 1;
      const up = (i - 1) * columns + j;
      const left = i * columns + j - 1;
      const nucleotideScore = reference[i - 1] === query[j - 1] ? 5 : -4;

      const [mValue, mTrace] = choose(match[diagonal], gapQuery[diagonal], gapReference[diagonal]);
      match[index] = Math.max(0, mValue + nucleotideScore);
      traceMatch[index] = match[index] > 0 ? mTrace : 0;

      const [gqValue, gqTrace] = choose(match[up] - 20, gapQuery[up] - 2, gapReference[up] - 20);
      gapQuery[index] = gqValue;
      traceGapQuery[index] = gqTrace;

      const [grValue, grTrace] = choose(match[left] - 20, gapQuery[left] - 20, gapReference[left] - 2);
      gapReference[index] = grValue;
      traceGapReference[index] = grTrace;

      const candidates = [match[index], gapQuery[index], gapReference[index]];
      for (let state = 0; state < 3; state += 1) {
        if (candidates[state] > bestScore) {
          bestScore = candidates[state];
          bestIndex = index;
          bestState = state + 1;
        }
      }
    }
  }

  let i = Math.floor(bestIndex / columns);
  let j = bestIndex % columns;
  let state = bestState;
  const pairs: Array<[number, number]> = [];

  while (i > 0 && j > 0 && state !== 0) {
    const index = i * columns + j;
    if (state === 1) {
      if (match[index] <= 0) break;
      pairs.push([i - 1, j - 1]);
      state = traceMatch[index];
      i -= 1;
      j -= 1;
    } else if (state === 2) {
      if (gapQuery[index] <= 0) break;
      state = traceGapQuery[index];
      i -= 1;
    } else {
      if (gapReference[index] <= 0) break;
      state = traceGapReference[index];
      j -= 1;
    }
  }
  pairs.reverse();
  return { score: bestScore, pairs };
}

export function mapToReference(reference: string, record: AbiRecord): Omit<AnalysisResult, "name"> {
  const forwardAlignment = localAlign(reference, record.sequence);
  const reverseRecord = reverseComplement(record);
  const reverseAlignment = localAlign(reference, reverseRecord.sequence);
  const useReverse = reverseAlignment.score > forwardAlignment.score;
  const finalRecord = useReverse ? reverseRecord : record;
  const alignment = useReverse ? reverseAlignment : forwardAlignment;
  if (!alignment.pairs.length) throw new Error("比对得分过低，映射失败");

  const matrix = Object.fromEntries(BASES.map((base) => [base, Array(reference.length).fill(Number.NaN)])) as Record<Base, number[]>;
  const matchStatus: Array<boolean | null> = Array(reference.length).fill(null);
  const mappedQuality = new Map<number, number>();
  let matches = 0;
  alignment.pairs.forEach(([referenceIndex, queryIndex]) => {
    const item = finalRecord.proportions[queryIndex];
    if (!item) return;
    BASES.forEach((base) => {
      matrix[base][referenceIndex] = item[base];
    });
    const matched = item.calledBase === reference[referenceIndex];
    matchStatus[referenceIndex] = matched;
    if (matched) matches += 1;
    const quality = finalRecord.quality[queryIndex];
    if (Number.isFinite(quality)) mappedQuality.set(referenceIndex, quality);
  });
  const alignedBases = alignment.pairs.length;
  const identity = alignedBases ? matches / alignedBases : 0;
  const coverageRatio = finalRecord.sequence.length ? alignedBases / finalRecord.sequence.length : 0;
  const warnings: string[] = [];
  if (finalRecord.quality.length < finalRecord.sequence.length) warnings.push("部分或全部位点缺少 Phred 质量值");
  if (finalRecord.sequence.length >= 30 && alignedBases < 30) warnings.push("有效比对长度少于 30 bp");
  if (coverageRatio < 0.5) warnings.push(`仅比对 ${(coverageRatio * 100).toFixed(1)}% 的读段`);
  if (identity < 0.7) warnings.push(`匹配率较低（${(identity * 100).toFixed(1)}%）`);
  return {
    matrix,
    matchStatus,
    orientation: useReverse ? "reverse" : "forward",
    score: alignment.score,
    mappedQuality,
    mappedIndices: alignment.pairs.map(([referenceIndex]) => referenceIndex),
    mapping: {
      referenceStart: alignedBases ? alignment.pairs[0][0] + 1 : null,
      referenceEnd: alignedBases ? alignment.pairs[alignedBases - 1][0] + 1 : null,
      queryLength: finalRecord.sequence.length,
      alignedBases,
      matches,
      identity,
      coverageRatio,
      warnings,
    },
  };
}

function calledBaseAt(matrix: Record<Base, number[]>, index: number) {
  return BASES.reduce((best, base) => (
    matrix[base][index] > matrix[best][index] ? base : best
  ), "A");
}

export function mergeAnalysisResults(name: string, segments: AnalysisResult[]): AnalysisResult {
  if (!segments.length) throw new Error("没有可合并的分段结果");
  const referenceLength = segments[0].matrix.A.length;
  if (segments.some((segment) => segment.matrix.A.length !== referenceLength)) {
    throw new Error("分段结果使用了不同长度的参考序列");
  }

  const matrix = Object.fromEntries(BASES.map((base) => [base, Array(referenceLength).fill(Number.NaN)])) as Record<Base, number[]>;
  const matchStatus: Array<boolean | null> = Array(referenceLength).fill(null);
  const mappedQuality = new Map<number, number>();
  const coveredIndices = new Set<number>();
  const overlapIndices = new Set<number>();
  const conflictingIndices = new Set<number>();

  segments.forEach((segment) => {
    segment.mappedIndices.forEach((index) => {
      if (!Number.isFinite(segment.matrix.A[index])) return;
      const hadValue = Number.isFinite(matrix.A[index]);
      if (hadValue && calledBaseAt(segment.matrix, index) !== calledBaseAt(matrix, index)) {
        conflictingIndices.add(index);
      }
      coveredIndices.add(index);
      if (hadValue) overlapIndices.add(index);

      const incomingQuality = segment.mappedQuality.get(index);
      const selectedQuality = mappedQuality.get(index);
      const shouldReplace = !hadValue || (
        Number.isFinite(incomingQuality) && (!Number.isFinite(selectedQuality) || Number(incomingQuality) > Number(selectedQuality))
      );
      if (!shouldReplace) return;
      BASES.forEach((base) => {
        matrix[base][index] = segment.matrix[base][index];
      });
      matchStatus[index] = segment.matchStatus[index];
      if (Number.isFinite(incomingQuality)) mappedQuality.set(index, Number(incomingQuality));
      else mappedQuality.delete(index);
    });
  });

  const mappedIndices = [...coveredIndices].sort((a, b) => a - b);
  const matches = mappedIndices.filter((index) => matchStatus[index] === true).length;
  const orientations = new Set(segments.map((segment) => segment.orientation));
  return {
    name,
    matrix,
    matchStatus,
    orientation: orientations.size === 1 ? segments[0].orientation : "mixed",
    score: segments.reduce((sum, segment) => sum + segment.score, 0),
    mappedQuality,
    mappedIndices,
    mapping: {
      referenceStart: mappedIndices.length ? mappedIndices[0] + 1 : null,
      referenceEnd: mappedIndices.length ? mappedIndices[mappedIndices.length - 1] + 1 : null,
      queryLength: segments.reduce((sum, segment) => sum + segment.mapping.queryLength, 0),
      alignedBases: mappedIndices.length,
      matches,
      identity: mappedIndices.length ? matches / mappedIndices.length : 0,
      coverageRatio: referenceLength ? mappedIndices.length / referenceLength : 0,
      warnings: [],
    },
    sourceNames: segments.map((segment) => segment.name),
    mergeSummary: {
      segmentCount: segments.length,
      coveredPositions: mappedIndices.length,
      overlapPositions: overlapIndices.size,
      conflictingPositions: conflictingIndices.size,
    },
  };
}

export async function analyzeFile(
  file: File,
  reference: string,
  trim: boolean,
  qualityThreshold: number,
  windowSize: number,
) {
  let record = parseAbi(await file.arrayBuffer());
  if (trim) record = trimLowQuality(record, qualityThreshold, windowSize);
  return { name: file.name, ...mapToReference(reference, record) } satisfies AnalysisResult;
}

export function getCpgMask(reference: string) {
  const mask = Array(reference.length).fill(false);
  for (let i = 0; i < reference.length - 1; i += 1) {
    if (reference[i] === "C" && reference[i + 1] === "G") {
      mask[i] = true;
      mask[i + 1] = true;
    }
  }
  return mask;
}

export function getMeasuredNonCpgCMask(reference: string, results: AnalysisResult[]) {
  const mask = Array(reference.length).fill(false);
  results.forEach((result) => {
    for (let index = 0; index < reference.length; index += 1) {
      if (Number.isNaN(result.matrix.A[index])) continue;
      const calledBase = BASES.reduce((best, base) => (
        result.matrix[base][index] > result.matrix[best][index] ? base : best
      ), "A");
      if (calledBase !== "C") continue;
      if (index + 1 >= reference.length || Number.isNaN(result.matrix.A[index + 1])) {
        mask[index] = true;
        continue;
      }
      const nextCalled = BASES.reduce((best, base) => (
        result.matrix[base][index + 1] > result.matrix[best][index + 1] ? base : best
      ), "A");
      if (nextCalled !== "G") mask[index] = true;
    }
  });
  return mask;
}

export function createCpgRows(reference: string, results: AnalysisResult[], targetSequences: string | string[]): CpgRow[] {
  const targets = (Array.isArray(targetSequences) ? targetSequences : [targetSequences]).filter(Boolean);
  const targetContexts = targets.length ? targets.map((targetSequence, index) => {
    const targetStart = reference.indexOf(targetSequence);
    return {
      targetNumber: index + 1,
      targetSequence,
      targetStart: targetStart >= 0 ? targetStart : null,
      targetCenter: targetStart >= 0 ? targetStart + (targetSequence.length - 1) / 2 : reference.length / 2,
    };
  }) : [{
    targetNumber: 0,
    targetSequence: "",
    targetStart: null,
    targetCenter: reference.length / 2,
  }];
  const rows: CpgRow[] = [];
  targetContexts.forEach((target) => {
    for (let index = 0; index < reference.length - 1; index += 1) {
      if (reference[index] !== "C" || reference[index + 1] !== "G") continue;
      const values = results.map((result) => result.matrix.C[index]).filter((value) => Number.isFinite(value));
      rows.push({
        targetNumber: target.targetNumber,
        targetSequence: target.targetSequence,
        targetStart: target.targetStart,
        position: index + 1,
        distance: Math.round((index - target.targetCenter) * 10) / 10,
        averageC: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        measuredSamples: values.length,
      });
    }
  });
  return rows;
}

export function parseTargetSequences(value: string) {
  const seen = new Set<string>();
  return value.toUpperCase().split(/[\s,;，；]+/).map((item) => item.replace(/[^ACGT]/g, "")).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export function sanitizeSequence(value: string) {
  return value.toUpperCase().replace(/[^ACGT]/g, "");
}

export { BASES };
