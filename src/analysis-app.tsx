"use client";

import {
  Activity,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  Dna,
  Download,
  FileArchive,
  FileDown,
  FlaskConical,
  Info,
  LoaderCircle,
  LockKeyhole,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Table2,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeFile,
  BASES,
  createCpgRows,
  createCpnRows,
  mergeAnalysisResults,
  parseTargetSequences,
  sanitizeSequence,
  type AnalysisFailure,
  type AnalysisResult,
  type CpgRow,
} from "./analysis-engine";
import { renderHeatmap } from "./heatmap";
import { createHeatmapDownload, downloadImageFile } from "./heatmap-export";

const DEFAULT_REFERENCE = "";
const DEFAULT_TARGET = "";

type Notice = { tone: "error" | "success" | "info"; message: string } | null;

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle" aria-hidden="true"><span /></span>
    </label>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`metric${accent ? " metric-accent" : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function downloadText(content: string, filename: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function cpgCsv(rows: CpgRow[]) {
  const multipleTargets = new Set(rows.map((row) => row.targetNumber)).size > 1;
  const lines = [multipleTargets
    ? "Target_Number,Target_Sequence,Target_Start,CpG_Position,Distance_to_Target_Center,Average_C_Ratio,Measured_Samples"
    : "CpG_Position,Distance_to_Target_Center,Average_C_Ratio,Measured_Samples"];
  rows.forEach((row) => lines.push([
    ...(multipleTargets ? [row.targetNumber, row.targetSequence, row.targetStart === null ? "" : row.targetStart + 1] : []),
    row.position,
    row.distance,
    row.averageC === null ? "" : row.averageC.toFixed(6),
    row.measuredSamples,
  ].join(",")));
  return `\uFEFF${lines.join("\n")}`;
}

function cpnCsv(rows: CpgRow[]) {
  const multipleTargets = new Set(rows.map((row) => row.targetNumber)).size > 1;
  const lines = [multipleTargets
    ? "Target_Number,Original_Target_Sequence,Target_Start,CpN_Position,Distance_to_Target_Center,Average_C_Ratio,Measured_Samples"
    : "CpN_Position,Distance_to_Target_Center,Average_C_Ratio,Measured_Samples"];
  rows.forEach((row) => lines.push([
    ...(multipleTargets ? [row.targetNumber, row.targetSequence, row.targetStart === null ? "" : row.targetStart + 1] : []),
    row.position, row.distance, row.averageC === null ? "" : row.averageC.toFixed(6), row.measuredSamples,
  ].join(",")));
  return `\uFEFF${lines.join("\n")}`;
}

function niceTickStep(range: number, targetTicks: number) {
  const roughStep = range / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, Number.EPSILON)));
  const normalized = roughStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function Chart({ rows, label = "CpG" }: { rows: CpgRow[]; label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth);
      const height = Math.round(canvas.clientHeight);
      if (!width || !height) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#fbfcfc";
      context.fillRect(0, 0, width, height);
      const padding = { left: 58, right: 24, top: 20, bottom: 58 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = height - padding.top - padding.bottom;
      const measured = rows.filter((row) => row.averageC !== null);
      const minDistance = Math.min(...measured.map((row) => row.distance), -1);
      const maxDistance = Math.max(...measured.map((row) => row.distance), 1);
      const distanceRange = Math.max(1, maxDistance - minDistance);
      const x = (distance: number) => padding.left + ((distance - minDistance) / distanceRange) * chartWidth;
      const y = (value: number) => padding.top + (1 - value) * chartHeight;

      context.font = "12px Arial";
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (let tick = 0; tick <= 4; tick += 1) {
        const value = tick / 4;
        const yy = y(value);
        context.strokeStyle = "#e0e7e8";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(padding.left, yy);
        context.lineTo(width - padding.right, yy);
        context.stroke();
        context.fillStyle = "#6d7d82";
        context.fillText(`${Math.round(value * 100)}%`, padding.left - 9, yy);
      }

      const xStep = niceTickStep(distanceRange, Math.max(3, Math.floor(chartWidth / 72)));
      const firstTick = Math.ceil(minDistance / xStep) * xStep;
      const decimals = xStep < 1 ? Math.min(2, Math.ceil(-Math.log10(xStep))) : 0;
      context.textAlign = "center";
      context.textBaseline = "top";
      context.font = "11px Arial";
      for (let tick = firstTick; tick <= maxDistance + xStep * 0.001; tick += xStep) {
        const normalizedTick = Math.abs(tick) < xStep * 0.001 ? 0 : tick;
        const xx = x(normalizedTick);
        context.strokeStyle = "#aebbbc";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(xx, y(0));
        context.lineTo(xx, y(0) + 5);
        context.stroke();
        context.fillStyle = "#5f7176";
        context.fillText(normalizedTick.toFixed(decimals), xx, y(0) + 8);
      }

      if (minDistance < 0 && maxDistance > 0) {
        context.strokeStyle = "#8a72b5";
        context.setLineDash([5, 4]);
        context.beginPath();
        context.moveTo(x(0), padding.top);
        context.lineTo(x(0), padding.top + chartHeight);
        context.stroke();
        context.setLineDash([]);
      }
      context.strokeStyle = "#176d78";
      context.lineWidth = 2;
      context.beginPath();
      measured.forEach((row, index) => {
        const xx = x(row.distance);
        const yy = y(row.averageC ?? 0);
        if (index === 0) context.moveTo(xx, yy);
        else context.lineTo(xx, yy);
      });
      context.stroke();
      measured.forEach((row) => {
        context.beginPath();
        context.fillStyle = "#f4b942";
        context.strokeStyle = "#835f13";
        context.lineWidth = 1.5;
        context.arc(x(row.distance), y(row.averageC ?? 0), 4.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      });
      context.fillStyle = "#596b70";
      context.font = "12px Arial";
      context.textAlign = "center";
      context.textBaseline = "bottom";
      context.fillText("距靶点中心距离（bp）", padding.left + chartWidth / 2, height - 7);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [rows]);
  return <canvas ref={canvasRef} className="distance-chart" aria-label={`${label} distance analysis chart`} />;
}

export default function AnalysisApp() {
  const [referenceInput, setReferenceInput] = useState(DEFAULT_REFERENCE);
  const [targetInput, setTargetInput] = useState(DEFAULT_TARGET);
  const [cpnEnabled, setCpnEnabled] = useState(false);
  const [cpnDialogOpen, setCpnDialogOpen] = useState(false);
  const [cpnReferenceInput, setCpnReferenceInput] = useState("");
  const [cpnTargetInput, setCpnTargetInput] = useState("");
  const [cpnMode, setCpnMode] = useState<"together" | "alone">("together");
  const [cpnRun, setCpnRun] = useState<{ reference: string; targets: string[];
    rawResults: AnalysisResult[]; failures: AnalysisFailure[] } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [highlightTarget, setHighlightTarget] = useState(true);
  const [focusCpg, setFocusCpg] = useState(false);
  const [focusAllC, setFocusAllC] = useState(false);
  const [chunkSize, setChunkSize] = useState(50);
  const [trimActive, setTrimActive] = useState(false);
  const [mergeSegments, setMergeSegments] = useState(false);
  const [qualityThreshold, setQualityThreshold] = useState(20);
  const [windowSize, setWindowSize] = useState(20);
  const [positions, setPositions] = useState("47");
  const [rawResults, setRawResults] = useState<AnalysisResult[]>([]);
  const [failures, setFailures] = useState<AnalysisFailure[]>([]);
  const [running, setRunning] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(null);
  const exportingRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [dragging, setDragging] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const rawPreviewRef = useRef<HTMLDivElement>(null);
  const cpnPreviewRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reference = useMemo(() => sanitizeSequence(referenceInput), [referenceInput]);
  const targets = useMemo(() => parseTargetSequences(targetInput), [targetInput]);
  const cpnReference = useMemo(() => sanitizeSequence(cpnReferenceInput), [cpnReferenceInput]);
  const cpnTargets = useMemo(() => parseTargetSequences(cpnTargetInput), [cpnTargetInput]);
  const targetSites = useMemo(() => targets.map((sequence, index) => {
    const start = reference.indexOf(sequence);
    return { number: index + 1, sequence, start };
  }), [reference, targets]);
  const results = useMemo(() => (
    mergeSegments && rawResults.length
      ? [mergeAnalysisResults(`合并样本（${rawResults.length} 个分段）`, rawResults)]
      : rawResults
  ), [mergeSegments, rawResults]);
  const cpgRows = useMemo(() => createCpgRows(reference, results, targets), [reference, results, targets]);
  const cpnResults = useMemo(() => cpnRun?.rawResults.length
    ? mergeSegments ? [mergeAnalysisResults(`合并样本（${cpnRun.rawResults.length} 个分段）`, cpnRun.rawResults)] : cpnRun.rawResults
    : [], [cpnRun, mergeSegments]);
  const cpnRows = useMemo(() => cpnRun ? createCpnRows(cpnRun.reference, cpnResults, cpnRun.targets) : [],
    [cpnRun, cpnResults]);
  const cpnGroups = useMemo(() => {
    const groups = new Map<number, CpgRow[]>();
    cpnRows.forEach((row) => groups.set(row.targetNumber, [...(groups.get(row.targetNumber) ?? []), row]));
    return [...groups.values()];
  }, [cpnRows]);
  const cpgGroups = useMemo(() => {
    const groups = new Map<number, CpgRow[]>();
    cpgRows.forEach((row) => {
      const group = groups.get(row.targetNumber);
      if (group) group.push(row);
      else groups.set(row.targetNumber, [row]);
    });
    return [...groups.values()];
  }, [cpgRows]);
  const foundTargetCount = targetSites.filter((site) => site.start >= 0).length;

  const addFiles = (incoming: File[]) => {
    setCpnRun(null);
    const accepted = incoming.filter((file) => file.name.toLowerCase().endsWith(".ab1"));
    setFiles((current) => {
      const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...accepted.filter((file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`))];
    });
    if (accepted.length !== incoming.length) setNotice({ tone: "info", message: "已忽略非 .ab1 文件。" });
  };

  const runAnalysis = async () => {
    const runCpg = !cpnEnabled || cpnMode === "together";
    if (runCpg && !reference) {
      setNotice({ tone: "error", message: "请输入有效的参考序列。" });
      return;
    }
    if (cpnEnabled && (!cpnReference || !cpnTargets.length || cpnTargets.some((target) =>
      cpnReference.indexOf(target) < 0 || cpnReference.indexOf(target) !== cpnReference.lastIndexOf(target)))) {
      setNotice({ tone: "error", message: "请在 CpN 窗口输入原始参考序列，并确保每条原始靶序列在其中恰好出现一次。" });
      setCpnDialogOpen(true);
      return;
    }
    if (!files.length) {
      setNotice({ tone: "error", message: "请至少上传一个 AB1 文件。" });
      return;
    }
    setRunning(true);
    setProgress(0);
    setNotice(null);
    setRawResults([]);
    setFailures([]);
    setCpnRun(null);
    const successes: AnalysisResult[] = [];
    const errors: AnalysisFailure[] = [];
    const cpnSuccesses: AnalysisResult[] = [];
    const cpnErrors: AnalysisFailure[] = [];
    for (let index = 0; index < files.length; index += 1) {
      if (runCpg) {
        try { successes.push(await analyzeFile(files[index], reference, trimActive, qualityThreshold, windowSize)); }
        catch (error) { errors.push({ name: files[index].name, message: error instanceof Error ? error.message : "未知解析错误" }); }
      }
      if (cpnEnabled) {
        try { cpnSuccesses.push(await analyzeFile(files[index], cpnReference, trimActive, qualityThreshold, windowSize)); }
        catch (error) { cpnErrors.push({ name: files[index].name, message: error instanceof Error ? error.message : "未知解析错误" }); }
      }
      setProgress(Math.round(((index + 1) / files.length) * 100));
      await new Promise((resolve) => window.setTimeout(resolve, 12));
    }
    setRawResults(successes);
    setFailures(errors);
    if (cpnEnabled) setCpnRun({ reference: cpnReference, targets: cpnTargets,
      rawResults: cpnSuccesses, failures: cpnErrors });
    setRunning(false);
    setNotice(successes.length || cpnSuccesses.length
      ? { tone: "success", message: cpnEnabled
        ? `分析完成：CpG ${successes.length} 个、CpN ${cpnSuccesses.length} 个 AB1 分段成功。`
        : `分析完成：${successes.length} 个 AB1 分段成功${mergeSegments ? "，已合并为 1 个样本" : ""}${errors.length ? `，${errors.length} 个失败` : ""}。` }
      : { tone: "error", message: "没有文件成功完成分析，请检查 AB1 文件和参考序列。" });
  };

  useEffect(() => {
    if (!cpnResults.length || !cpnRun || !cpnPreviewRef.current) return;
    cpnPreviewRef.current.replaceChildren(renderHeatmap(cpnRun.reference, cpnResults, {
      chunkSize, focusCpg: false, focusAllC: false, focusCpn: true,
      highlightTarget, targetSequences: cpnRun.targets, preview: true,
    }));
  }, [cpnResults, cpnRun, chunkSize, highlightTarget]);

  const downloadCpnHeatmap = async () => {
    if (!cpnRun || !cpnResults.length || exportingRef.current) return;
    exportingRef.current = true;
    setExportProgress({ completed: 0, total: 1 });
    try {
      const file = await createHeatmapDownload(cpnRun.reference, cpnResults, {
        chunkSize, focusCpg: false, focusAllC: false, focusCpn: true,
        highlightTarget, targetSequences: cpnRun.targets,
      }, (completed, total) => setExportProgress({ completed, total }));
      downloadImageFile(file.blob, `CpN_${file.filename}`);
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "CpN 热图导出失败。" });
    } finally { exportingRef.current = false; setExportProgress(null); }
  };

  useEffect(() => {
    if (!results.length || !previewRef.current) return;
    previewRef.current.replaceChildren(renderHeatmap(reference, results, {
      chunkSize,
      focusCpg,
      focusAllC,
      highlightTarget,
      targetSequences: targets,
      preview: true,
    }));
  }, [results, reference, targets, chunkSize, focusCpg, focusAllC, highlightTarget]);

  useEffect(() => {
    if (!mergeSegments || !segmentsOpen || !rawResults.length || !rawPreviewRef.current) return;
    rawPreviewRef.current.replaceChildren(renderHeatmap(reference, rawResults, {
      chunkSize,
      focusCpg,
      focusAllC,
      highlightTarget,
      targetSequences: targets,
      preview: true,
    }));
  }, [mergeSegments, segmentsOpen, rawResults, reference, targets, chunkSize, focusCpg, focusAllC, highlightTarget]);

  const downloadFullHeatmap = async () => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExportProgress({ completed: 0, total: 1 });
    try {
      const file = await createHeatmapDownload(reference, results, {
        chunkSize, focusCpg, focusAllC, highlightTarget, targetSequences: targets,
      }, (completed, total) => setExportProgress({ completed, total }));
      downloadImageFile(file.blob, file.filename);
      if (file.pageCount > 1) setNotice({ tone: "success", message: `图片较大，已生成包含 ${file.pageCount} 张原分辨率 PNG 的 ZIP，保留全部样本和参考位置。` });
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "图片导出失败，请重试。" });
    } finally {
      exportingRef.current = false;
      setExportProgress(null);
    }
  };

  const sitePositions = positions.split(",").map((value) => Number.parseInt(value.trim(), 10)).filter((value) => Number.isFinite(value));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><Dna size={21} strokeWidth={2.2} /></div>
        <div className="brand-copy">
          <strong>Young Methy</strong>
          <span>Sanger Efficiency Analysis</span>
        </div>
        <div className="topbar-spacer" />
        <div className="privacy-note"><LockKeyhole size={14} /> 文件仅在本机浏览器处理</div>
        <a className="icon-button" href="#method" title="分析说明" aria-label="分析说明"><CircleHelp size={18} /></a>
      </header>

      <div className="workspace">
        <aside className="control-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Analysis setup</span><h1>分析设置</h1></div>
            <Settings2 size={19} />
          </div>

          <section className="control-section">
            <div className="section-label"><span>01</span> 序列输入</div>
            <label className="field-label" htmlFor="reference">参考序列 <em>{reference.length} bp</em></label>
            <textarea id="reference" value={referenceInput} onChange={(event) => setReferenceInput(event.target.value)} placeholder="粘贴参考 DNA 序列…" rows={6} spellCheck={false} />
            <label className="field-label" htmlFor="target">靶点 / sgRNA 序列 <em>{targets.length} 个</em></label>
            <input id="target" value={targetInput} onChange={(event) => setTargetInput(event.target.value)} placeholder="可选；多个靶点用逗号、空格或换行分隔" spellCheck={false} />
            {targetSites.length ? <div className="target-status-list">{targetSites.map((site) => <div className={`inline-status ${site.start >= 0 ? "found" : "missing"}`} key={`${site.number}:${site.sequence}`}>{site.start >= 0 ? <Check size={13} /> : <Info size={13} />}<span><strong>靶点 {site.number}</strong> {site.start >= 0 ? `位于 ${site.start + 1}–${site.start + site.sequence.length}` : "未在参考序列中找到"}</span></div>)}</div> : null}
          </section>

          <section className="control-section">
            <div className="section-label"><span>02</span> AB1 文件</div>
            <div className={`dropzone${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); }} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") inputRef.current?.click(); }}>
              <UploadCloud size={24} />
              <strong>拖放 AB1 文件</strong>
              <span>或点击选择，可多选</span>
              <input ref={inputRef} type="file" multiple accept=".ab1" onChange={(event) => addFiles([...(event.target.files ?? [])])} />
            </div>
            {files.length ? <div className="file-list">
              <div className="file-list-head"><span>{files.length} 个文件</span><button type="button" onClick={() => { setFiles([]); setCpnRun(null); }}>清空</button></div>
              {files.slice(0, 5).map((file, index) => <div className="file-item" key={`${file.name}:${file.lastModified}`}><FileArchive size={14} /><span title={file.name}>{file.name}</span><small>{(file.size / 1024).toFixed(0)} KB</small><button type="button" title="移除" aria-label={`移除 ${file.name}`} onClick={() => { setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index)); setCpnRun(null); }}><X size={13} /></button></div>)}
              {files.length > 5 ? <div className="more-files">另有 {files.length - 5} 个文件</div> : null}
            </div> : null}
          </section>

          <section className="control-section compact">
            <Toggle checked={cpnEnabled} onChange={(value) => {
              setCpnEnabled(value); setCpnRun(null); if (value) setCpnDialogOpen(true);
            }} label="可选 CpN 分析" hint="使用同一批 AB1，另用未转化的原始参考序列比对" />
            {cpnEnabled ? <button className="secondary-button" type="button" onClick={() => setCpnDialogOpen(true)}>
              设置原始参考与展示方式
            </button> : null}
          </section>

          <section className="control-section compact">
            <button className="section-disclosure" type="button" onClick={() => setAdvancedOpen((value) => !value)}><span><span className="section-label"><span>03</span> 显示与质控</span></span><ChevronDown size={17} className={advancedOpen ? "rotated" : ""} /></button>
            {advancedOpen ? <div className="advanced-controls">
              <Toggle checked={highlightTarget} onChange={setHighlightTarget} label="高亮靶点区域" />
              <Toggle checked={focusCpg} onChange={setFocusCpg} label="聚焦 CpG 位点" />
              <Toggle checked={focusAllC} onChange={setFocusAllC} label="聚焦全部 C 位点" />
              <div className="range-field"><div><strong>每块碱基数</strong><output>{chunkSize}</output></div><input type="range" min="20" max="100" step="10" value={chunkSize} onChange={(event) => setChunkSize(Number(event.target.value))} /></div>
              <Toggle checked={mergeSegments} onChange={setMergeSegments} label="合并分段测序" hint="按参考坐标合并，重叠位点逐碱基采用更高 Phred 分数" />
              <Toggle checked={trimActive} onChange={setTrimActive} label="剪切低质量末端" hint="基于滑动窗口 Phred 均值" />
              {trimActive ? <div className="paired-fields"><label>Phred 阈值<input type="number" min="1" max="60" value={qualityThreshold} onChange={(event) => setQualityThreshold(Number(event.target.value))} /></label><label>窗口大小<input type="number" min="2" max="100" value={windowSize} onChange={(event) => setWindowSize(Number(event.target.value))} /></label></div> : null}
            </div> : null}
          </section>

          <button className="run-button" type="button" onClick={runAnalysis} disabled={running}>
            {running ? <LoaderCircle className="spinning" size={18} /> : <Play size={17} fill="currentColor" />}
            {running ? `正在分析 ${progress}%` : "运行分析"}
          </button>
          {running ? <div className="progress-track"><span style={{ width: `${progress}%` }} /></div> : null}
        </aside>

        <section className="results-panel">
          <div className="results-header">
            <div><span className="eyebrow">Workspace</span><h2>分析结果</h2></div>
          {results.length || cpnRun ? <button className="secondary-button" type="button" onClick={() => { setRawResults([]); setFailures([]); setCpnRun(null); setNotice(null); setSegmentsOpen(false); }}><RotateCcw size={15} /> 重置结果</button> : null}
          </div>

          {notice ? <div className={`notice ${notice.tone}`}>{notice.tone === "success" ? <Check size={17} /> : notice.tone === "error" ? <Info size={17} /> : <Info size={17} />}<span>{notice.message}</span></div> : null}

          {!results.length && !cpnRun && !running ? <div className="empty-state">
            <div className="empty-visual"><Dna size={46} /><span /><span /></div>
            <h3>等待测序数据</h3>
            <p>输入参考序列并上传 AB1 文件后运行分析。结果包含峰信号比例、双向局部比对、CpG 距离统计与可下载图表。</p>
            <div className="empty-steps"><span><b>1</b>参考序列</span><i /><span><b>2</b>AB1 文件</span><i /><span><b>3</b>分析导出</span></div>
          </div> : null}

          {running ? <div className="processing-state"><div className="processing-ring"><Activity size={30} /></div><h3>正在处理测序文件</h3><p>解析荧光通道并计算正向与反向互补比对</p><div className="large-progress"><span style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong></div> : null}

          {results.length ? <div className="results-stack">
            <section className="summary-strip">
              <Metric value={String(results.length)} label={mergeSegments ? "合并样本" : "成功样本"} accent />
              <Metric value={String(failures.length)} label="失败样本" />
              <Metric value={String(reference.length)} label="参考长度 / bp" />
              <Metric value={String(cpgGroups[0]?.length ?? 0)} label="CpG 位点" />
              <Metric value={targetSites.length === 1 && targetSites[0].start >= 0 ? `${targetSites[0].start + 1}–${targetSites[0].start + targetSites[0].sequence.length}` : targetSites.length ? `${foundTargetCount}/${targetSites.length}` : "—"} label={targetSites.length > 1 ? "已定位靶点" : "靶点区间"} />
            </section>

            <section className="result-section">
              <div className="result-title"><div className="title-icon"><BarChart3 size={18} /></div><div><h3>比对热图预览</h3><p>{mergeSegments ? `已将 ${rawResults.length} 个 AB1 分段合并为一个样本；` : "显示前 3 个样本、"}前 5 个分块；数值为各碱基峰信号占比（%）</p></div><button className="primary-action" type="button" onClick={downloadFullHeatmap} disabled={exportProgress !== null} aria-busy={exportProgress !== null}>{exportProgress ? <LoaderCircle size={16} className="spinning" /> : <Download size={16} />}{exportProgress ? `生成图片 ${exportProgress.completed}/${exportProgress.total}` : "下载完整 PNG"}</button></div>
              <div className="legend"><span><i className="legend-box match" />匹配</span><span><i className="legend-box mismatch" />错配</span><span><i className="legend-line target" />靶点</span><span><i className="legend-letter cpg">CG</i>CpG</span></div>
              <div className="heatmap-viewport" ref={previewRef} />
              {mergeSegments ? <div className="raw-segments">
                <button className="raw-segments-toggle" type="button" onClick={() => setSegmentsOpen((value) => !value)} aria-expanded={segmentsOpen}>
                  <span><FileArchive size={15} /> 原始分段预览（{rawResults.length}）</span>
                  <ChevronDown size={17} className={segmentsOpen ? "rotated" : ""} />
                </button>
                {segmentsOpen ? <div className="raw-segments-body"><p>显示前 3 个原始分段、前 5 个分块；合并结果不受预览数量限制。</p><div className="heatmap-viewport raw-heatmap" ref={rawPreviewRef} /></div> : null}
              </div> : null}
            </section>

            {mergeSegments ? <section className="result-section">
              <div className="result-title"><div className="title-icon amber"><Info size={18} /></div><div><h3>分段映射质控</h3><p>仅报告现有比对的范围与质量，不改变或自动剔除比对结果</p></div></div>
              {results[0]?.mergeSummary ? <div className="merge-summary"><span><strong>{results[0].mergeSummary.segmentCount}</strong> 个分段</span><span><strong>{results[0].mergeSummary.coveredPositions}</strong> bp 覆盖</span><span><strong>{results[0].mergeSummary.overlapPositions}</strong> 个重叠位点</span><span><strong>{results[0].mergeSummary.conflictingPositions}</strong> 个碱基冲突</span></div> : null}
              <div className="table-wrap mapping-table-wrap"><table className="mapping-table"><thead><tr><th>AB1 分段</th><th>参考区间</th><th>方向</th><th>有效比对</th><th>匹配率</th><th>得分</th><th>质控提示</th></tr></thead><tbody>{rawResults.map((result, index) => <tr key={`${result.name}:${index}`}><td title={result.name}><strong>{result.name}</strong></td><td>{result.mapping.referenceStart ?? "—"}–{result.mapping.referenceEnd ?? "—"}</td><td>{result.orientation === "reverse" ? "反向" : "正向"}</td><td>{result.mapping.alignedBases} / {result.mapping.queryLength} bp</td><td>{(result.mapping.identity * 100).toFixed(1)}%</td><td>{result.score.toFixed(0)}</td><td className={result.mapping.warnings.length ? "mapping-warning" : "mapping-pass"}>{result.mapping.warnings.length ? result.mapping.warnings.join("；") : "通过"}</td></tr>)}</tbody></table></div>
            </section> : null}

            <section className="result-section">
              <div className="result-title"><div className="title-icon amber"><Table2 size={18} /></div><div><h3>CpG 距离分析</h3><p>{mergeSegments ? "相对靶点中心的 CpG 位置与合并结果 C/(C+T)" : "相对靶点中心的 CpG 位置与各样本 C/(C+T) 的平均值"}</p></div><button className="secondary-button" type="button" onClick={() => downloadText(cpgCsv(cpgRows), "CpG_Distance_Analysis.csv")} disabled={!cpgRows.length}><FileDown size={16} /> 下载 CSV</button></div>
              {cpgRows.length ? <div className="target-analysis-list">{cpgGroups.map((rows) => <div className="target-analysis" key={rows[0].targetNumber}>
                {targets.length > 1 ? <div className="target-analysis-head"><strong>靶点 {rows[0].targetNumber}</strong><span title={rows[0].targetSequence}>{rows[0].targetSequence}</span><em>{rows[0].targetStart === null ? "未定位，按参考序列中心计算" : `参考位置 ${rows[0].targetStart + 1}–${rows[0].targetStart + rows[0].targetSequence.length}`}</em></div> : null}
                <div className="cpg-grid"><div className="table-wrap"><table><thead><tr><th>CpG 位置</th><th>距离 / bp</th><th>{mergeSegments ? "C/(C+T)" : "平均 C/(C+T)"}</th><th>样本数</th></tr></thead><tbody>{rows.slice(0, 8).map((row) => <tr key={`${row.targetNumber}:${row.position}`}><td><strong>{row.position}</strong></td><td>{row.distance > 0 ? "+" : ""}{row.distance}</td><td>{row.averageC === null ? "—" : `${(row.averageC * 100).toFixed(1)}%`}</td><td>{row.measuredSamples}</td></tr>)}</tbody></table>{rows.length > 8 ? <div className="table-foot">预览 8 / {rows.length} 个位点，完整数据请下载 CSV</div> : null}</div><Chart rows={rows} /></div>
              </div>)}</div> : <div className="mini-empty">参考序列中未检测到 CpG 位点</div>}
            </section>

            <section className="result-section">
              <div className="result-title"><div className="title-icon coral"><Search size={18} /></div><div><h3>任意位点查询</h3><p>输入一个或多个 1-based 位点，以逗号分隔</p></div></div>
              <div className="site-search"><input value={positions} onChange={(event) => setPositions(event.target.value)} placeholder="例如：47, 68, 102" /><span>{sitePositions.length} 个位点</span></div>
              <div className="site-results">{sitePositions.map((position) => {
                const valid = position >= 1 && position <= reference.length;
                return <div className="position-block" key={position}><div className="position-head"><strong>位置 {position}</strong><span>{valid ? `参考碱基 ${reference[position - 1]}` : "超出范围"}</span></div>{valid ? <div className="position-table"><div className="position-row header"><span>样本</span>{BASES.map((base) => <span key={base}>{base}</span>)}</div>{results.map((result) => <div className="position-row" key={result.name}><span title={result.name}>{result.name}</span>{BASES.map((base) => { const value = result.matrix[base][position - 1]; return <span key={base}>{Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—"}</span>; })}</div>)}</div> : null}</div>;
              })}</div>
            </section>

            {failures.length ? <section className="result-section failures"><div className="result-title"><div className="title-icon coral"><Info size={18} /></div><div><h3>未完成的文件</h3><p>以下文件未能解析或映射</p></div></div>{failures.map((failure) => <div className="failure-row" key={failure.name}><span>{failure.name}</span><small>{failure.message}</small></div>)}</section> : null}
          </div> : null}

          {cpnRun ? <div className="results-stack cpn-results">
            {cpnResults.length ? <section className="result-section">
              <div className="result-title"><div className="title-icon amber"><Dna size={18} /></div><div><h3>CpN 原始参考比对热图</h3><p>同一批 AB1 独立比对到未转化参考；绿色 C 是参考非 CpG 且测序判读为 C 的位点</p></div>
                <button className="primary-action" type="button" onClick={() => void downloadCpnHeatmap()} disabled={exportProgress !== null}><Download size={16} /> 下载完整 PNG</button></div>
              <div className="heatmap-viewport" ref={cpnPreviewRef} />
            </section> : null}
            <section className="result-section">
              <div className="result-title"><div className="title-icon amber"><Table2 size={18} /></div><div><h3>CpN 距离分析</h3><p>原始参考非 CpG C 且 AB1 在同位点判读为 C；按现有 CpG 逻辑计算 C/(C+T)</p></div>
                <button className="secondary-button" type="button" onClick={() => downloadText(cpnCsv(cpnRows), "CpN_Distance_Analysis.csv")} disabled={!cpnRows.length}><FileDown size={16} /> 下载 CSV</button></div>
              {cpnGroups.length ? <div className="target-analysis-list">{cpnGroups.map((rows) => <div className="target-analysis" key={rows[0].targetNumber}>
                {cpnRun.targets.length > 1 ? <div className="target-analysis-head"><strong>原始靶点 {rows[0].targetNumber}</strong><span>{rows[0].targetSequence}</span><em>参考位置 {Number(rows[0].targetStart) + 1}–{Number(rows[0].targetStart) + rows[0].targetSequence.length}</em></div> : null}
                <div className="cpg-grid"><div className="table-wrap"><table><thead><tr><th>CpN 位置</th><th>距离 / bp</th><th>{mergeSegments ? "C/(C+T)" : "平均 C/(C+T)"}</th><th>样本数</th></tr></thead><tbody>
                  {rows.map((row) => <tr key={`${row.targetNumber}:${row.position}`}><td><strong>{row.position}</strong></td><td>{row.distance > 0 ? "+" : ""}{row.distance}</td><td>{((row.averageC ?? 0) * 100).toFixed(1)}%</td><td>{row.measuredSamples}</td></tr>)}
                </tbody></table></div><Chart rows={rows} label="CpN" /></div>
              </div>)}</div> : <div className="mini-empty">原始参考中没有同时满足条件的 CpN 位点</div>}
            </section>
            {cpnRun.failures.length ? <section className="result-section failures"><h3>CpN 未完成的文件</h3>{cpnRun.failures.map((failure) => <div className="failure-row" key={failure.name}><span>{failure.name}</span><small>{failure.message}</small></div>)}</section> : null}
          </div> : null}

          <footer id="method"><FlaskConical size={16} /><span>Local alignment: match +5 · mismatch −4 · gap open −20 · gap extend −2</span><span className="footer-divider" /><span>ABIF DATA9–12 · PLOC2 · PBAS2</span></footer>
        </section>
      </div>
      {cpnDialogOpen ? <div className="cpn-dialog-backdrop"><div className="cpn-dialog" role="dialog" aria-modal="true" aria-labelledby="cpn-dialog-title">
        <div className="result-title"><div><h3 id="cpn-dialog-title">CpN 独立比对设置</h3><p>与 CpG 共用已上传 AB1；输入未经过 bisulfite 转化的参考和靶序列</p></div>
          <button className="icon-button" type="button" aria-label="关闭 CpN 设置" onClick={() => setCpnDialogOpen(false)}><X size={18} /></button></div>
        <label className="field-label" htmlFor="cpn-reference">原始参考序列</label>
        <textarea id="cpn-reference" value={cpnReferenceInput} onChange={(event) => { setCpnReferenceInput(event.target.value); setCpnRun(null); }} rows={6} placeholder="未转化的原始 DNA 序列" spellCheck={false} />
        <label className="field-label" htmlFor="cpn-target">原始靶序列</label>
        <input id="cpn-target" value={cpnTargetInput} onChange={(event) => { setCpnTargetInput(event.target.value); setCpnRun(null); }} placeholder="多个原始靶点可用逗号或空格分隔" spellCheck={false} />
        <div className="cpn-mode"><label><input type="radio" name="cpn-mode" checked={cpnMode === "together"} onChange={() => { setCpnMode("together"); setCpnRun(null); }} /> 与常规 CpG 一起呈现</label>
          <label><input type="radio" name="cpn-mode" checked={cpnMode === "alone"} onChange={() => { setCpnMode("alone"); setCpnRun(null); }} /> 仅分析并呈现 CpN</label></div>
        <button className="run-button" type="button" onClick={() => setCpnDialogOpen(false)}>保存设置</button>
      </div></div> : null}
    </main>
  );
}
