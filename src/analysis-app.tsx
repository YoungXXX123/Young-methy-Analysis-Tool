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
  sanitizeSequence,
  type AnalysisFailure,
  type AnalysisResult,
  type CpgRow,
} from "./analysis-engine";
import { downloadCanvas, renderHeatmap } from "./heatmap";

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
  const lines = ["CpG_Position,Distance_to_Target_Center,Average_C_Ratio,Measured_Samples"];
  rows.forEach((row) => lines.push([
    row.position,
    row.distance,
    row.averageC === null ? "" : row.averageC.toFixed(6),
    row.measuredSamples,
  ].join(",")));
  return `\uFEFF${lines.join("\n")}`;
}

function Chart({ rows }: { rows: CpgRow[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = 278;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fbfcfc";
    context.fillRect(0, 0, width, height);
    const padding = { left: 54, right: 24, top: 20, bottom: 42 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const measured = rows.filter((row) => row.averageC !== null);
    const minDistance = Math.min(...measured.map((row) => row.distance), -1);
    const maxDistance = Math.max(...measured.map((row) => row.distance), 1);
    const x = (distance: number) => padding.left + ((distance - minDistance) / Math.max(1, maxDistance - minDistance)) * chartWidth;
    const y = (value: number) => padding.top + (1 - value) * chartHeight;

    context.font = "11px Arial";
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
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillText("距靶点中心距离（bp）", padding.left + chartWidth / 2, height - 6);
  }, [rows]);
  return <canvas ref={canvasRef} className="distance-chart" aria-label="CpG distance analysis chart" />;
}

export default function AnalysisApp() {
  const [referenceInput, setReferenceInput] = useState(DEFAULT_REFERENCE);
  const [targetInput, setTargetInput] = useState(DEFAULT_TARGET);
  const [files, setFiles] = useState<File[]>([]);
  const [highlightTarget, setHighlightTarget] = useState(true);
  const [focusCpg, setFocusCpg] = useState(false);
  const [focusAllC, setFocusAllC] = useState(false);
  const [chunkSize, setChunkSize] = useState(50);
  const [trimActive, setTrimActive] = useState(false);
  const [qualityThreshold, setQualityThreshold] = useState(20);
  const [windowSize, setWindowSize] = useState(20);
  const [positions, setPositions] = useState("47");
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [failures, setFailures] = useState<AnalysisFailure[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [dragging, setDragging] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const previewRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reference = useMemo(() => sanitizeSequence(referenceInput), [referenceInput]);
  const target = useMemo(() => sanitizeSequence(targetInput), [targetInput]);
  const cpgRows = useMemo(() => createCpgRows(reference, results, target), [reference, results, target]);
  const targetPosition = target ? reference.indexOf(target) : -1;

  const addFiles = (incoming: File[]) => {
    const accepted = incoming.filter((file) => file.name.toLowerCase().endsWith(".ab1"));
    setFiles((current) => {
      const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...accepted.filter((file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`))];
    });
    if (accepted.length !== incoming.length) setNotice({ tone: "info", message: "已忽略非 .ab1 文件。" });
  };

  const runAnalysis = async () => {
    if (!reference) {
      setNotice({ tone: "error", message: "请输入有效的参考序列。" });
      return;
    }
    if (!files.length) {
      setNotice({ tone: "error", message: "请至少上传一个 AB1 文件。" });
      return;
    }
    setRunning(true);
    setProgress(0);
    setNotice(null);
    setResults([]);
    setFailures([]);
    const successes: AnalysisResult[] = [];
    const errors: AnalysisFailure[] = [];
    for (let index = 0; index < files.length; index += 1) {
      try {
        successes.push(await analyzeFile(files[index], reference, trimActive, qualityThreshold, windowSize));
      } catch (error) {
        errors.push({ name: files[index].name, message: error instanceof Error ? error.message : "未知解析错误" });
      }
      setProgress(Math.round(((index + 1) / files.length) * 100));
      await new Promise((resolve) => window.setTimeout(resolve, 12));
    }
    setResults(successes);
    setFailures(errors);
    setRunning(false);
    setNotice(successes.length
      ? { tone: "success", message: `分析完成：${successes.length} 个样本成功${errors.length ? `，${errors.length} 个失败` : ""}。` }
      : { tone: "error", message: "没有文件成功完成分析，请检查 AB1 文件和参考序列。" });
  };

  useEffect(() => {
    if (!results.length || !previewRef.current) return;
    previewRef.current.replaceChildren(renderHeatmap(reference, results, {
      chunkSize,
      focusCpg,
      focusAllC,
      highlightTarget,
      targetSequence: target,
      preview: true,
    }));
  }, [results, reference, target, chunkSize, focusCpg, focusAllC, highlightTarget]);

  const downloadFullHeatmap = () => {
    const canvas = renderHeatmap(reference, results, {
      chunkSize,
      focusCpg,
      focusAllC,
      highlightTarget,
      targetSequence: target,
    });
    downloadCanvas(canvas, "Sanger_Full_Alignment_Optimized.png");
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
            <label className="field-label" htmlFor="target">靶点 / sgRNA 序列 <em>{target.length} bp</em></label>
            <input id="target" value={targetInput} onChange={(event) => setTargetInput(event.target.value)} placeholder="可选，用于标记与距离分析" spellCheck={false} />
            {target ? <div className={`inline-status ${targetPosition >= 0 ? "found" : "missing"}`}>{targetPosition >= 0 ? <Check size={13} /> : <Info size={13} />}{targetPosition >= 0 ? `位于参考序列 ${targetPosition + 1}–${targetPosition + target.length}` : "参考序列中未找到该靶点"}</div> : null}
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
              <div className="file-list-head"><span>{files.length} 个文件</span><button type="button" onClick={() => setFiles([])}>清空</button></div>
              {files.slice(0, 5).map((file, index) => <div className="file-item" key={`${file.name}:${file.lastModified}`}><FileArchive size={14} /><span title={file.name}>{file.name}</span><small>{(file.size / 1024).toFixed(0)} KB</small><button type="button" title="移除" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></div>)}
              {files.length > 5 ? <div className="more-files">另有 {files.length - 5} 个文件</div> : null}
            </div> : null}
          </section>

          <section className="control-section compact">
            <button className="section-disclosure" type="button" onClick={() => setAdvancedOpen((value) => !value)}><span><span className="section-label"><span>03</span> 显示与质控</span></span><ChevronDown size={17} className={advancedOpen ? "rotated" : ""} /></button>
            {advancedOpen ? <div className="advanced-controls">
              <Toggle checked={highlightTarget} onChange={setHighlightTarget} label="高亮靶点区域" />
              <Toggle checked={focusCpg} onChange={setFocusCpg} label="聚焦 CpG 位点" />
              <Toggle checked={focusAllC} onChange={setFocusAllC} label="聚焦全部 C 位点" />
              <div className="range-field"><div><strong>每块碱基数</strong><output>{chunkSize}</output></div><input type="range" min="20" max="100" step="10" value={chunkSize} onChange={(event) => setChunkSize(Number(event.target.value))} /></div>
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
            {results.length ? <button className="secondary-button" type="button" onClick={() => { setResults([]); setFailures([]); setNotice(null); }}><RotateCcw size={15} /> 重置结果</button> : null}
          </div>

          {notice ? <div className={`notice ${notice.tone}`}>{notice.tone === "success" ? <Check size={17} /> : notice.tone === "error" ? <Info size={17} /> : <Info size={17} />}<span>{notice.message}</span></div> : null}

          {!results.length && !running ? <div className="empty-state">
            <div className="empty-visual"><Dna size={46} /><span /><span /></div>
            <h3>等待测序数据</h3>
            <p>输入参考序列并上传 AB1 文件后运行分析。结果包含峰信号比例、双向局部比对、CpG 距离统计与可下载图表。</p>
            <div className="empty-steps"><span><b>1</b>参考序列</span><i /><span><b>2</b>AB1 文件</span><i /><span><b>3</b>分析导出</span></div>
          </div> : null}

          {running ? <div className="processing-state"><div className="processing-ring"><Activity size={30} /></div><h3>正在处理测序文件</h3><p>解析荧光通道并计算正向与反向互补比对</p><div className="large-progress"><span style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong></div> : null}

          {results.length ? <div className="results-stack">
            <section className="summary-strip">
              <Metric value={String(results.length)} label="成功样本" accent />
              <Metric value={String(failures.length)} label="失败样本" />
              <Metric value={String(reference.length)} label="参考长度 / bp" />
              <Metric value={String(cpgRows.length)} label="CpG 位点" />
              <Metric value={targetPosition >= 0 ? `${targetPosition + 1}–${targetPosition + target.length}` : "—"} label="靶点区间" />
            </section>

            <section className="result-section">
              <div className="result-title"><div className="title-icon"><BarChart3 size={18} /></div><div><h3>比对热图预览</h3><p>显示前 3 个样本、前 5 个分块；数值为各碱基峰信号占比（%）</p></div><button className="primary-action" type="button" onClick={downloadFullHeatmap}><Download size={16} /> 下载完整 PNG</button></div>
              <div className="legend"><span><i className="legend-box match" />匹配</span><span><i className="legend-box mismatch" />错配</span><span><i className="legend-line target" />靶点</span><span><i className="legend-letter cpg">CG</i>CpG</span><span><i className="legend-letter cytosine">C</i>非 CpG C</span></div>
              <div className="heatmap-viewport" ref={previewRef} />
            </section>

            <section className="result-section">
              <div className="result-title"><div className="title-icon amber"><Table2 size={18} /></div><div><h3>CpG 距离分析</h3><p>相对靶点中心的 CpG 位置与平均 C 峰信号比例</p></div><button className="secondary-button" type="button" onClick={() => downloadText(cpgCsv(cpgRows), "CpG_Distance_Analysis.csv")} disabled={!cpgRows.length}><FileDown size={16} /> 下载 CSV</button></div>
              {cpgRows.length ? <div className="cpg-grid"><div className="table-wrap"><table><thead><tr><th>CpG 位置</th><th>距离 / bp</th><th>平均 C</th><th>样本数</th></tr></thead><tbody>{cpgRows.slice(0, 8).map((row) => <tr key={row.position}><td><strong>{row.position}</strong></td><td>{row.distance > 0 ? "+" : ""}{row.distance}</td><td>{row.averageC === null ? "—" : `${(row.averageC * 100).toFixed(1)}%`}</td><td>{row.measuredSamples}</td></tr>)}</tbody></table>{cpgRows.length > 8 ? <div className="table-foot">预览 8 / {cpgRows.length} 个位点，完整数据请下载 CSV</div> : null}</div><Chart rows={cpgRows} /></div> : <div className="mini-empty">参考序列中未检测到 CpG 位点</div>}
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

          <footer id="method"><FlaskConical size={16} /><span>Local alignment: match +5 · mismatch −4 · gap open −20 · gap extend −2</span><span className="footer-divider" /><span>ABIF DATA9–12 · PLOC2 · PBAS2</span></footer>
        </section>
      </div>
    </main>
  );
}
