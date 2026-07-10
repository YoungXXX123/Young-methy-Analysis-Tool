# Young Methy Analysis Tool

Public, browser-based Sanger methylation efficiency analysis for ABI/AB1 files.

## Features

- Parse ABIF `PBAS2`, `PLOC2`, `FWO_1`, and `DATA9`-`DATA12` records.
- Optional sliding-window Phred quality trimming.
- Forward and reverse-complement local alignment using match `+5`, mismatch `-4`, gap open `-20`, and gap extension `-2`.
- Per-base A/C/G/T signal proportions and match/mismatch heatmaps.
- CpG distance table, chart, CSV export, and full-resolution PNG export.
- Arbitrary 1-based position lookup across all samples.
- Local-only file processing: uploaded AB1 files never leave the browser.

## Development

```bash
npm install
npm run dev
```

Build and validate:

```bash
npm test
```

## Deployment

Pushes to `main` are built and published automatically with GitHub Actions and GitHub Pages.

The original desktop Python script is not included or modified. This repository contains an independent browser implementation derived from its analysis behavior.
