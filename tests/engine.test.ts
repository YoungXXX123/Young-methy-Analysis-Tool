import assert from "node:assert/strict";
import test from "node:test";
import {
  createCpgRows,
  mapToReference,
  mergeAnalysisResults,
  parseAbi,
  parseTargetSequences,
  sanitizeSequence,
  trimLowQuality,
  type Base,
  type BaseProportion,
} from "../src/analysis-engine";
import { fitLabel } from "../src/heatmap";

const BASES: Base[] = ["A", "C", "G", "T"];

function record(sequence: string, quality = Array(sequence.length).fill(30)) {
  const proportions = [...sequence].map((calledBase) => {
    const result = { calledBase: calledBase as Base, A: 0, C: 0, G: 0, T: 0 };
    result[calledBase as Base] = 1;
    return result as BaseProportion;
  });
  return { sequence, quality, proportions };
}

test("maps an exact forward read at the original scoring scale", () => {
  const result = mapToReference("GGACGTCGATCC", record("ACGTCGAT"));
  assert.equal(result.orientation, "forward");
  assert.equal(result.score, 40);
  assert.deepEqual(result.matchStatus.slice(2, 10), Array(8).fill(true));
  assert.ok(Number.isNaN(result.matrix.A[0]));
});

test("chooses reverse complement and complements signal proportions", () => {
  const reference = "ATGCCGTAGCTA";
  const result = mapToReference(reference, record("TAGCTACGGCAT", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.equal(result.orientation, "reverse");
  assert.equal(result.score, 60);
  assert.deepEqual(result.matchStatus, Array(reference.length).fill(true));
  assert.equal(result.mappedQuality.get(0), 12);
  assert.equal(result.mapping.referenceStart, 1);
  assert.equal(result.mapping.referenceEnd, 12);
  assert.equal(result.mapping.identity, 1);
  reference.split("").forEach((base, index) => {
    assert.equal(result.matrix[base as Base][index], 1);
  });
});

test("retains mismatches and affine-gap mapping", () => {
  const mismatch = mapToReference("ACGTCGAT", record("ACGTTGAT"));
  assert.equal(mismatch.score, 31);
  assert.equal(mismatch.matchStatus[4], false);

  const reference = "ACGTTGCACTGATCGATGCTAGCA";
  const gapped = mapToReference(reference, record("ACGTTGCACTGACGATGCTAGCA"));
  assert.equal(gapped.score, 95);
  assert.equal(gapped.matchStatus.filter((value) => value === true).length, 23);
  assert.equal(gapped.matchStatus.filter((value) => value === null).length, 1);
});

test("matches sliding-window quality trimming and CpG calculations", () => {
  const input = record("AACCGGTT", [5, 5, 30, 30, 30, 30, 5, 5]);
  const trimmed = trimLowQuality(input, 20, 2);
  assert.equal(trimmed.sequence, "CCGG");
  assert.equal(trimmed.proportions.length, 4);
  assert.equal(sanitizeSequence(" ac-gU t\n"), "ACGT");

  const mapped = { name: "sample.ab1", ...mapToReference("AACGTT", record("AACGTT")) };
  const rows = createCpgRows("AACGTT", [mapped], "CG");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].position, 3);
  assert.equal(rows[0].averageC, 1);
  assert.equal(rows[0].targetNumber, 1);
  assert.equal(rows[0].targetStart, 2);
});

test("creates a separate CpG distance series for every target site", () => {
  const reference = "AACGTTCCGAA";
  const mapped = { name: "sample.ab1", ...mapToReference(reference, record(reference)) };
  const targets = parseTargetSequences("AACGTT, CCGAA\nAACGTT");
  const rows = createCpgRows(reference, [mapped], targets);

  assert.deepEqual(targets, ["AACGTT", "CCGAA"]);
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((row) => row.targetNumber))], [1, 2]);
  assert.deepEqual([...new Set(rows.filter((row) => row.targetNumber === 1).map((row) => row.targetStart))], [0]);
  assert.deepEqual([...new Set(rows.filter((row) => row.targetNumber === 2).map((row) => row.targetStart))], [6]);
  assert.notEqual(rows[0].distance, rows[2].distance);
});

test("averages each independent sample's C/(C+T), excluding absent C/T signal", () => {
  const reference = "AACGTT";
  const sample = (name: string, c: number, t: number, quality = 30) => {
    const input = record(reference, Array(reference.length).fill(quality));
    input.proportions[2] = { calledBase: "C", A: 1 - c - t, C: c, G: 0, T: t };
    return { name, ...mapToReference(reference, input) };
  };
  const first = sample("first", 0.2, 0.3, 10);
  const second = sample("second", 0.1, 0.1, 40);
  const noSignal = sample("no-signal", 0, 0);
  const missing = sample("missing", Number.NaN, Number.NaN);
  const rows = createCpgRows(reference, [first, second, noSignal, missing], ["AAC", "GTT"]);
  rows.forEach((row) => {
    assert.ok(Math.abs(row.averageC! - 0.45) < 1e-12);
    assert.equal(row.measuredSamples, 2);
  });
  const merged = mergeAnalysisResults("merged", [first, second]);
  const mergedRow = createCpgRows(reference, [merged], "AAC")[0];
  assert.equal(mergedRow.averageC, 0.5);
  assert.equal(mergedRow.measuredSamples, 1);
  assert.equal(first.matrix.C[2], 0.2);
  assert.equal(second.matrix.C[2], 0.1);
  const emptyRow = createCpgRows(reference, [noSignal, missing], "AAC")[0];
  assert.equal(emptyRow.averageC, null);
  assert.equal(emptyRow.measuredSamples, 0);
  assert.equal(createCpgRows(reference, [sample("only-t", 0, 0.5)], "AAC")[0].averageC, 0);
});

test("merges non-overlapping Sanger segments at their mapped reference coordinates", () => {
  const reference = "TTTACGTCGATGGGCCGTAACGTTAAA";
  const first = { name: "sample_part1.ab1", ...mapToReference(reference, record("ACGTCGAT")), score: 10 };
  const second = { name: "sample_part2.ab1", ...mapToReference(reference, record("CCGTAACG")), score: 100 };
  const merged = mergeAnalysisResults("merged sample", [first, second]);

  assert.equal(merged.mapping.referenceStart, 4);
  assert.equal(merged.mapping.referenceEnd, 22);
  assert.equal(merged.matrix.A[3], 1);
  assert.equal(merged.matrix.C[14], 1);
  assert.ok(Number.isNaN(merged.matrix.A[11]));
  assert.equal(merged.mergeSummary?.segmentCount, 2);
  assert.equal(merged.mergeSummary?.coveredPositions, 16);
  assert.equal(merged.mergeSummary?.overlapPositions, 0);
  const distantCpg = createCpgRows(reference, [merged], "ACGTCGAT").find((row) => row.position === 16);
  assert.equal(distantCpg?.averageC, 1);
  assert.ok((distantCpg?.distance ?? 0) > 0);
});

test("selects every overlapping base by its own Phred score", () => {
  const reference = "ACGTCGAT";
  const firstRecord = record(reference, [40, 10, 30, 30, 30, 30, 30, 30]);
  const secondRecord = record(reference, [10, 40, 20, 20, 20, 20, 20, 20]);
  firstRecord.proportions[0] = { calledBase: "T", A: 0.2, C: 0, G: 0, T: 0.8 };
  secondRecord.proportions[1] = { calledBase: "A", A: 0.8, C: 0.2, G: 0, T: 0 };
  const first = { name: "first.ab1", ...mapToReference(reference, firstRecord), score: 10 };
  const second = { name: "second.ab1", ...mapToReference(reference, secondRecord), score: 100 };
  const merged = mergeAnalysisResults("merged sample", [first, second]);

  assert.equal(merged.mappedQuality.get(0), 40);
  assert.equal(merged.mappedQuality.get(1), 40);
  assert.equal(merged.matrix.T[0], 0.8);
  assert.equal(merged.matrix.A[1], 0.8);
  assert.equal(merged.matchStatus[0], false);
  assert.equal(merged.matchStatus[1], false);
  assert.equal(merged.mergeSummary?.overlapPositions, reference.length);
  assert.equal(merged.mergeSummary?.conflictingPositions, 2);
});

function writeAscii(view: DataView, offset: number, value: string) {
  [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
}

function syntheticAbi() {
  const entries = [
    ["PBAS", 2, 2, 1, 4, "ACGT"],
    ["PLOC", 2, 4, 2, 4, [1, 2, 3, 4]],
    ["FWO_", 1, 2, 1, 4, "GATC"],
    ["PCON", 2, 1, 1, 4, [30, 30, 30, 30]],
    ["DATA", 9, 4, 2, 6, [0, 5, 5, 90, 5, 0]],
    ["DATA", 10, 4, 2, 6, [0, 90, 5, 5, 5, 0]],
    ["DATA", 11, 4, 2, 6, [0, 5, 5, 5, 90, 0]],
    ["DATA", 12, 4, 2, 6, [0, 5, 90, 5, 5, 0]],
  ] as const;
  const directoryOffset = 34;
  const directorySize = entries.length * 28;
  let payloadOffset = directoryOffset + directorySize;
  const buffer = new ArrayBuffer(payloadOffset + 128);
  const view = new DataView(buffer);
  writeAscii(view, 0, "ABIF");
  view.setUint16(4, 100, false);

  const writeDirectory = (offset: number, tag: string, number: number, type: number, elementSize: number, elements: number, dataSize: number, dataOffset: number) => {
    writeAscii(view, offset, tag);
    view.setUint32(offset + 4, number, false);
    view.setUint16(offset + 8, type, false);
    view.setUint16(offset + 10, elementSize, false);
    view.setUint32(offset + 12, elements, false);
    view.setUint32(offset + 16, dataSize, false);
    view.setUint32(offset + 20, dataOffset, false);
  };

  writeDirectory(6, "tdir", 1, 1023, 28, entries.length, directorySize, directoryOffset);
  entries.forEach(([tag, number, type, elementSize, elements, data], index) => {
    const entryOffset = directoryOffset + index * 28;
    const dataSize = elementSize * elements;
    const inline = dataSize <= 4;
    writeDirectory(entryOffset, tag, number, type, elementSize, elements, dataSize, inline ? 0 : payloadOffset);
    const start = inline ? entryOffset + 20 : payloadOffset;
    if (typeof data === "string") writeAscii(view, start, data);
    else data.forEach((value, itemIndex) => {
      if (elementSize === 1) view.setUint8(start + itemIndex, value);
      else view.setInt16(start + itemIndex * 2, value, false);
    });
    if (!inline) payloadOffset += dataSize;
  });
  return buffer.slice(0, payloadOffset);
}

test("parses ABIF channel order, peaks, sequence, and quality", () => {
  const parsed = parseAbi(syntheticAbi());
  assert.equal(parsed.sequence, "ACGT");
  assert.deepEqual(parsed.quality, [30, 30, 30, 30]);
  assert.deepEqual(parsed.proportions.map((item) => item.calledBase), BASES);
  parsed.proportions.forEach((item) => {
    const total = BASES.reduce((sum, base) => sum + item[base], 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  });
});

test("truncates long heatmap labels from the end", () => {
  const context = { measureText: (text: string) => ({ width: text.length }) };
  assert.equal(fitLabel(context, "635-01_C12_long_sample.ab1", 14), "635-01_C12_lo…");
});
