import assert from "node:assert/strict";
import test from "node:test";
import {
  createCpgRows,
  mapToReference,
  parseAbi,
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
  const result = mapToReference(reference, record("TAGCTACGGCAT"));
  assert.equal(result.orientation, "reverse");
  assert.equal(result.score, 60);
  assert.deepEqual(result.matchStatus, Array(reference.length).fill(true));
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
