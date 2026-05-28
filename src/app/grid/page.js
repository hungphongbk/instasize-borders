"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const GRID_OPTIONS = [
  { value: "1:2", cols: 1, rows: 2, label: "1 x 2 (2 ảnh)" },
  { value: "1:3", cols: 1, rows: 3, label: "1 x 3 (3 ảnh)" },
  { value: "2:2", cols: 2, rows: 2, label: "2 x 2 (4 ảnh)" },
  { value: "2:3", cols: 2, rows: 3, label: "2 x 3 (6 ảnh)" },
];

const OUTPUT_RATIO_OPTIONS = [
  { value: "4:5", label: "4 : 5 (1080 x 1350)" },
  { value: "9:16", label: "9 : 16 (1080 x 1920)" },
];

const OUTPUT_TYPE_OPTIONS = [
  { value: "image/jpeg", label: "JPEG" },
  { value: "image/png", label: "PNG" },
  { value: "image/webp", label: "WEBP" },
];

function TemplatePreview({ cols, rows }) {
  const total = cols * rows;
  return (
    <div
      className="rounded-lg border border-slate-200 bg-slate-50 p-1.5"
      style={{ width: 52, height: 52 }}
    >
      <div
        className="h-full w-full"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          gap: "4px",
        }}
      >
        {Array.from({ length: total }).map((_, idx) => (
          <div
            key={idx}
            className="rounded-sm border border-slate-300 bg-gradient-to-br from-slate-200 to-slate-300"
          />
        ))}
      </div>
    </div>
  );
}

function RatioPreview({ value }) {
  const [wRaw, hRaw] = String(value).split(":").map(Number);
  const w = wRaw || 4;
  const h = hRaw || 5;
  const scale = 28 / Math.max(w, h);

  return (
    <div
      className="grid place-items-center rounded-lg border border-slate-200 bg-slate-50"
      style={{ width: 52, height: 52 }}
    >
      <div
        className="rounded border border-slate-500 bg-slate-200"
        style={{
          width: `${Math.max(10, Math.round(w * scale))}px`,
          height: `${Math.max(10, Math.round(h * scale))}px`,
        }}
      />
    </div>
  );
}

function parseRatio(value) {
  const [w, h] = String(value).split(":").map(Number);
  if (!w || !h) return 4 / 5;
  return w / h;
}

function requestWorker(worker, payload) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const onMessage = (event) => {
      const message = event.data;
      if (!message || message.id !== id) return;

      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);

      if (message.type === "DONE") {
        resolve(message);
        return;
      }

      reject(new Error(message.error || "Worker processing failed."));
    };

    const onError = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      reject(new Error("Worker crashed during processing."));
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ ...payload, id });
  });
}

export default function GridPage() {
  const [items, setItems] = useState([]);
  const [grid, setGrid] = useState("1:2");
  const [outputRatio, setOutputRatio] = useState("9:16");
  const [outputType, setOutputType] = useState("image/jpeg");
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [gap, setGap] = useState(12);
  const [padding, setPadding] = useState(12);
  const [status, setStatus] = useState("idle");
  const [dragFromIndex, setDragFromIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const inputRef = useRef(null);

  useEffect(() => {
    return () => {
      items.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [items]);

  const gridConfig = useMemo(
    () => GRID_OPTIONS.find((option) => option.value === grid) || GRID_OPTIONS[0],
    [grid],
  );
  const requiredCount = gridConfig.cols * gridConfig.rows;
  const usedItems = items.slice(0, requiredCount);
  const missingCount = Math.max(0, requiredCount - usedItems.length);

  const onFiles = (files) => {
    if (!files) return;

    const next = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      next.push({
        file,
        url: URL.createObjectURL(file),
      });
    }

    if (!next.length) return;

    setItems((prev) => [...prev, ...next]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeItem = (index) => {
    setItems((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return next;
    });
  };

  const moveItem = (fromIndex, toIndex) => {
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex === toIndex
    ) {
      return;
    }

    setItems((prev) => {
      if (fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const beginDrag = (index) => (event) => {
    setDragFromIndex(index);
    setDragOverIndex(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  };

  const onDragOverItem = (index) => (event) => {
    event.preventDefault();
    if (dragOverIndex !== index) setDragOverIndex(index);
    event.dataTransfer.dropEffect = "move";
  };

  const onDropItem = (index) => (event) => {
    event.preventDefault();
    const fromText = event.dataTransfer.getData("text/plain");
    const from = Number.parseInt(fromText, 10);
    moveItem(from, index);
    setDragFromIndex(null);
    setDragOverIndex(null);
  };

  const onDragEnd = () => {
    setDragFromIndex(null);
    setDragOverIndex(null);
  };

  const clearAll = () => {
    setItems((prev) => {
      prev.forEach((item) => URL.revokeObjectURL(item.url));
      return [];
    });
  };

  const exportGrid = async () => {
    if (usedItems.length < requiredCount) {
      alert(`Cần đủ ${requiredCount} ảnh để export layout ${gridConfig.label}.`);
      return;
    }

    setStatus("processing");
    let worker;

    try {
      worker = new Worker("/workers/image-processor.worker.js");
      const out = await requestWorker(worker, {
        type: "GRID_PROCESS",
        files: usedItems.map((item) => item.file),
        options: {
          grid,
          outputRatio,
          outputType,
          backgroundColor,
          gap,
          padding,
        },
      });

      const blob = new Blob([out.arrayBuffer], {
        type: out.mimeType || outputType,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.fileName || `grid_${grid.replace(":", "x")}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("done");
    } catch (error) {
      alert(`Export grid failed: ${error.message}`);
      setStatus("idle");
      return;
    } finally {
      if (worker) worker.terminate();
    }

    window.setTimeout(() => setStatus("idle"), 1200);
  };

  const previewAspect = parseRatio(outputRatio);

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Insta Tools</p>
              <h1 className="text-2xl font-semibold text-slate-900">Grid Layout Composer</h1>
              <p className="mt-1 text-sm text-slate-600">
                Tạo ảnh layout kiểu Instagram Story với các template 1:2, 1:3, 2:2, 2:3.
                Xuất ảnh cuối theo tỉ lệ 4:5 hoặc 9:16.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Home
              </Link>
              <Link
                href="/border"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Border
              </Link>
              <Link
                href="/scrl"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                SCRL
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <p className="text-sm font-medium text-slate-700">Grid template</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {GRID_OPTIONS.map((option) => {
                  const selected = grid === option.value;
                  return (
                    <button
                      key={option.value}
                      onClick={() => setGrid(option.value)}
                      className={`rounded-xl border px-2 py-2 text-center transition-all ${
                        selected
                          ? "border-cyan-500 bg-cyan-50 shadow-sm"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                      style={{ width: 86 }}
                      title={`Chọn layout ${option.label}`}
                    >
                      <div className="grid place-items-center">
                        <TemplatePreview cols={option.cols} rows={option.rows} />
                      </div>
                      <p className="mt-1 text-[11px] font-medium text-slate-800">{option.value}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <p className="text-sm font-medium text-slate-700">Tỉ lệ output</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {OUTPUT_RATIO_OPTIONS.map((option) => {
                  const selected = outputRatio === option.value;
                  return (
                    <button
                      key={option.value}
                      onClick={() => setOutputRatio(option.value)}
                      className={`rounded-xl border px-2 py-2 text-center transition-all ${
                        selected
                          ? "border-cyan-500 bg-cyan-50 shadow-sm"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                      style={{ width: 86 }}
                    >
                      <div className="grid place-items-center">
                        <RatioPreview value={option.value} />
                      </div>
                      <p className="mt-1 text-[11px] font-medium text-slate-800">{option.value}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-4">
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Định dạng output</span>
              <select
                value={outputType}
                onChange={(event) => setOutputType(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {OUTPUT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Gap: {gap}px</span>
              <input
                type="range"
                min={0}
                max={80}
                step={1}
                value={gap}
                onChange={(event) => setGap(Math.max(0, Math.min(80, Number(event.target.value) || 0)))}
                className="w-full"
              />
            </label>
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Padding: {padding}px</span>
              <input
                type="range"
                min={0}
                max={120}
                step={1}
                value={padding}
                onChange={(event) =>
                  setPadding(Math.max(0, Math.min(120, Number(event.target.value) || 0)))
                }
                className="w-full"
              />
            </label>
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Background</span>
              <input
                type="color"
                value={backgroundColor}
                onChange={(event) => setBackgroundColor(event.target.value)}
                className="h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white px-2 py-1"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="rounded-full bg-slate-200 px-3 py-1">
              Cần {requiredCount} ảnh cho layout {gridConfig.label}
            </span>
            <span className="rounded-full bg-slate-200 px-3 py-1">
              Đã có {usedItems.length}/{requiredCount} ảnh dùng để ghép
            </span>
            {items.length > requiredCount && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-900">
                {items.length - requiredCount} ảnh dư sẽ không dùng
              </span>
            )}
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => onFiles(event.target.files)}
              className="hidden"
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Upload ảnh
            </button>
            <button
              onClick={clearAll}
              disabled={!items.length || status === "processing"}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 disabled:opacity-40"
            >
              Clear
            </button>
            <button
              onClick={exportGrid}
              disabled={status === "processing" || usedItems.length < requiredCount}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-40"
            >
              {status === "processing"
                ? "Đang export..."
                : status === "done"
                  ? "Đã export"
                  : "Export ảnh grid"}
            </button>
          </div>

          {missingCount > 0 && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Thiếu {missingCount} ảnh để export.
            </p>
          )}

          <div
            className="mx-auto w-full max-w-md overflow-hidden rounded-xl border border-slate-300 bg-slate-200"
            style={{ aspectRatio: `${previewAspect}` }}
          >
            <div
              className="h-full w-full"
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${gridConfig.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${gridConfig.rows}, minmax(0, 1fr))`,
                gap: `${gap}px`,
                padding: `${padding}px`,
                backgroundColor,
              }}
            >
              {Array.from({ length: requiredCount }).map((_, index) => {
                const item = usedItems[index];

                return (
                  <div key={index} className="relative overflow-hidden rounded-md bg-slate-300">
                    {item ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.url}
                          alt={`Grid slot ${index + 1}`}
                          className={`h-full w-full object-cover transition-opacity ${
                            dragFromIndex === index ? "opacity-70" : "opacity-100"
                          }`}
                          draggable
                          onDragStart={beginDrag(index)}
                          onDragOver={onDragOverItem(index)}
                          onDrop={onDropItem(index)}
                          onDragEnd={onDragEnd}
                        />
                        {dragOverIndex === index && dragFromIndex !== null && (
                          <div className="pointer-events-none absolute inset-0 border-2 border-cyan-400" />
                        )}
                        <button
                          onClick={() => removeItem(index)}
                          className="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] text-slate-700"
                          title="Remove image"
                        >
                          X
                        </button>
                      </>
                    ) : (
                      <div className="grid h-full place-items-center text-xs text-slate-500">
                        Slot {index + 1}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {!!items.length && (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((item, index) => (
                <div key={`${item.file.name}_${index}`} className="relative rounded-lg border border-slate-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.url}
                    alt={item.file.name}
                    className={`aspect-square w-full rounded-lg object-cover transition-opacity ${
                      dragFromIndex === index ? "opacity-70" : "opacity-100"
                    }`}
                    draggable
                    onDragStart={beginDrag(index)}
                    onDragOver={onDragOverItem(index)}
                    onDrop={onDropItem(index)}
                    onDragEnd={onDragEnd}
                  />
                  {dragOverIndex === index && dragFromIndex !== null && (
                    <div className="pointer-events-none absolute inset-0 rounded-lg border-2 border-cyan-400" />
                  )}
                  <button
                    onClick={() => removeItem(index)}
                    className="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] text-slate-700"
                    title="Remove image"
                  >
                    X
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
