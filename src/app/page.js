"use client";

import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_WORKERS = 6;

function parseRatio(ratio) {
  if (ratio === "4:5") return 4 / 5;
  return ratio === "16:9" ? 16 / 9 : 1;
}

function buildTargetSize(width, height, ratio, extraPx) {
  const targetRatio = parseRatio(ratio);

  let canvasW = Math.max(width, Math.ceil(height * targetRatio));
  let canvasH = Math.max(height, Math.ceil(width / targetRatio));

  if (Math.abs(canvasW / canvasH - targetRatio) > 1e-6) {
    if (canvasW / canvasH > targetRatio)
      canvasH = Math.ceil(canvasW / targetRatio);
    else canvasW = Math.ceil(canvasH * targetRatio);
  }

  const extra = Math.max(0, Math.floor(Number(extraPx) || 0));
  return {
    width: canvasW + extra * 2,
    height: canvasH + extra * 2,
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
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

async function runWorkerPool(tasks, workerCount, onProgress) {
  const workers = Array.from(
    { length: workerCount },
    () => new Worker("/workers/image-processor.worker.js"),
  );

  const results = new Array(tasks.length);
  let nextIndex = 0;
  let completed = 0;

  async function consume(worker) {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= tasks.length) return;

      results[current] = await tasks[current](worker);
      completed += 1;
      onProgress(completed, tasks.length);
    }
  }

  try {
    await Promise.all(workers.map((worker) => consume(worker)));
    return results;
  } finally {
    workers.forEach((worker) => worker.terminate());
  }
}

export default function HomePage() {
  const [items, setItems] = useState([]);
  const [globalRatio, setGlobalRatio] = useState("1:1");
  const [borderColor, setBorderColor] = useState("#ffffff");
  const [extraPx, setExtraPx] = useState(0);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [isOffline, setIsOffline] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [previewStatus, setPreviewStatus] = useState("idle");
  const [previewTick, setPreviewTick] = useState(0);
  const [canPickDirectory, setCanPickDirectory] = useState(false);
  const inputRef = useRef(null);
  const itemsRef = useRef([]);
  const previewGenerationRef = useRef(0);

  useEffect(() => {
    const updateOnlineState = () => setIsOffline(!window.navigator.onLine);
    updateOnlineState();

    const onInstalled = () => setIsInstalled(true);
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setIsInstalled(true);
    }

    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setCanPickDirectory(
      typeof window.showDirectoryPicker === "function" &&
        window.isSecureContext,
    );
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((it) => {
        URL.revokeObjectURL(it.sourceUrl);
        if (it.hasRenderedPreview) URL.revokeObjectURL(it.previewUrl);
      });
    };
  }, []);

  const workerCount = useMemo(() => {
    if (typeof window === "undefined") return 1;
    const hw = window.navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(MAX_WORKERS, hw - 1));
  }, []);

  const onFiles = (files) => {
    if (!files) return;
    const next = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const sourceUrl = URL.createObjectURL(f);
      next.push({
        file: f,
        sourceUrl,
        previewUrl: sourceUrl,
        borderColor,
        extraPx,
        ratio: globalRatio,
        hasRenderedPreview: false,
      });
    }
    setItems((prev) => [...prev, ...next]);
    setPreviewTick((v) => v + 1);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onGlobalRatioChange = (value) => {
    setGlobalRatio(value);
    setItems((prev) => prev.map((it) => ({ ...it, ratio: value })));
    setPreviewTick((v) => v + 1);
  };

  const removeItem = (idx) => {
    setItems((prev) => {
      URL.revokeObjectURL(prev[idx].sourceUrl);
      if (prev[idx].hasRenderedPreview)
        URL.revokeObjectURL(prev[idx].previewUrl);
      const arr = [...prev];
      arr.splice(idx, 1);
      return arr;
    });
  };

  const buildOptions = (it) => ({
    ratio: it.ratio,
    borderColor: it.borderColor,
    extraPx: it.extraPx,
  });

  const refreshPreviews = useCallback(
    async (snapshot, generation) => {
      if (!snapshot.length) {
        setPreviewStatus("idle");
        return;
      }

      setPreviewStatus("rendering");

      const previewWorkers = Math.max(1, Math.min(3, workerCount));
      const tasks = snapshot.map(
        (it, index) => async (worker) =>
          requestWorker(worker, {
            type: "PREVIEW",
            file: it.file,
            index,
            options: {
              ratio: it.ratio,
              borderColor: it.borderColor,
              extraPx: it.extraPx,
              previewMaxEdge: 340,
            },
          }),
      );

      try {
        const results = await runWorkerPool(tasks, previewWorkers, () => {});
        if (previewGenerationRef.current !== generation) {
          return;
        }

        const nextPreviewMap = new Map();
        results.forEach((res) => {
          if (!res || !res.arrayBuffer) return;
          const blob = new Blob([res.arrayBuffer], {
            type: res.mimeType || "image/jpeg",
          });
          nextPreviewMap.set(Number(res.index), URL.createObjectURL(blob));
        });

        setItems((prev) =>
          prev.map((item, idx) => {
            const nextPreviewUrl = nextPreviewMap.get(idx);
            if (!nextPreviewUrl) return item;

            if (item.hasRenderedPreview) URL.revokeObjectURL(item.previewUrl);
            return {
              ...item,
              previewUrl: nextPreviewUrl,
              hasRenderedPreview: true,
            };
          }),
        );
      } catch {
        // Keep fallback original preview if preview rendering fails.
      } finally {
        if (previewGenerationRef.current === generation) {
          setPreviewStatus("idle");
        }
      }
    },
    [workerCount],
  );

  const processSingleDownload = async (it) => {
    setStatus("single");
    setProgress({ done: 0, total: 1 });

    let worker;

    try {
      worker = new Worker("/workers/image-processor.worker.js");
      const out = await requestWorker(worker, {
        type: "PROCESS",
        file: it.file,
        options: buildOptions(it),
      });

      const outBlob = new Blob([out.arrayBuffer], { type: out.mimeType });

      const url = URL.createObjectURL(outBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setProgress({ done: 1, total: 1 });
    } catch (error) {
      alert(`Download failed: ${error.message}`);
    } finally {
      if (worker) worker.terminate();
      setStatus("idle");
      setProgress({ done: 0, total: 0 });
    }
  };

  const processAndDownload = async () => {
    if (!items.length) return;

    setStatus("batch");
    setProgress({ done: 0, total: items.length });

    try {
      const zip = new JSZip();
      const tasks = items.map(
        (it) => async (worker) =>
          requestWorker(worker, {
            type: "PROCESS",
            file: it.file,
            options: {
              ratio: it.ratio,
              borderColor: it.borderColor,
              extraPx: it.extraPx,
            },
          }),
      );

      const processed = await runWorkerPool(
        tasks,
        workerCount,
        (done, total) => {
          setProgress({ done, total });
        },
      );

      processed.forEach((out) => {
        zip.file(
          out.fileName,
          new Blob([out.arrayBuffer], { type: out.mimeType }),
        );
      });

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bordered_images.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      alert(`Processing failed: ${error.message}`);
    } finally {
      setStatus("idle");
      setProgress({ done: 0, total: 0 });
    }
  };

  const processAndSaveAsFiles = async () => {
    if (!items.length) return;
    if (!canPickDirectory) {
      alert(
        "Your browser does not support folder save. Falling back to ZIP download.",
      );
      await processAndDownload();
      return;
    }

    let directoryHandle;
    try {
      directoryHandle = await window.showDirectoryPicker({
        mode: "readwrite",
      });
    } catch {
      return;
    }

    setStatus("batch");
    setProgress({ done: 0, total: items.length });

    try {
      const tasks = items.map(
        (it) => async (worker) =>
          requestWorker(worker, {
            type: "PROCESS",
            file: it.file,
            options: {
              ratio: it.ratio,
              borderColor: it.borderColor,
              extraPx: it.extraPx,
            },
          }),
      );

      const processed = await runWorkerPool(
        tasks,
        workerCount,
        (done, total) => {
          setProgress({ done, total });
        },
      );

      for (const out of processed) {
        const blob = new Blob([out.arrayBuffer], { type: out.mimeType });
        const fileHandle = await directoryHandle.getFileHandle(out.fileName, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      }
    } catch (error) {
      alert(`Saving files failed: ${error.message}`);
    } finally {
      setStatus("idle");
      setProgress({ done: 0, total: 0 });
    }
  };

  const totalCount = items.length;
  const isBusy = status !== "idle";
  const totalInputBytes = useMemo(
    () => items.reduce((sum, item) => sum + (item.file.size || 0), 0),
    [items],
  );
  useEffect(() => {
    if (previewTick === 0 || isBusy) return;

    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;

    const snapshot = itemsRef.current.map((it) => ({
      file: it.file,
      ratio: it.ratio,
      borderColor: it.borderColor,
      extraPx: it.extraPx,
    }));

    if (!snapshot.length) return;

    const timer = window.setTimeout(() => {
      refreshPreviews(snapshot, generation);
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
  }, [previewTick, isBusy, workerCount, refreshPreviews]);

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl p-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">
            InstaSize Borders Offline (1:1 / 4:5 / 16:9)
          </h1>
          <p className="text-sm text-gray-600">
            Images are processed directly in your browser with local CPU
            workers. No upload to server is needed, so this can run offline
            after first load.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span
              className={`rounded-full px-3 py-1 ${
                isOffline
                  ? "bg-amber-100 text-amber-900"
                  : "bg-emerald-100 text-emerald-900"
              }`}
            >
              {isOffline ? "Offline mode" : "Online"}
            </span>
            <span className="rounded-full bg-blue-100 px-3 py-1 text-blue-900">
              {workerCount} worker{workerCount > 1 ? "s" : ""}
            </span>
            <span className="rounded-full bg-slate-200 px-3 py-1 text-slate-800">
              Input size: {formatBytes(totalInputBytes)}
            </span>
            {previewStatus === "rendering" && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-900">
                Updating previews...
              </span>
            )}
            {isInstalled && (
              <span className="rounded-full bg-violet-100 px-3 py-1 text-violet-900">
                Installed app
              </span>
            )}
          </div>
        </header>

        <div className="mb-6 rounded-lg border-2 border-dashed border-gray-300 bg-white p-6">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => onFiles(e.target.files)}
            disabled={isBusy}
            className="block w-full text-sm"
          />
          <p className="mt-2 text-xs text-gray-500">
            Tip: You can re-upload more images; they’ll be appended.
          </p>
        </div>

        {/* Global border color & extra border controls */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
          <div>
            <label className="block text-sm font-medium mb-1">
              Aspect ratio (all images)
            </label>
            <select
              value={globalRatio}
              disabled={isBusy}
              onChange={(e) => onGlobalRatioChange(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
            >
              <option value="1:1">1 : 1</option>
              <option value="4:5">4 : 5</option>
              <option value="16:9">16 : 9</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Border color
            </label>
            <input
              type="color"
              value={borderColor}
              disabled={isBusy}
              onChange={(e) => {
                setBorderColor(e.target.value);
                setItems((prev) =>
                  prev.map((it) => ({ ...it, borderColor: e.target.value })),
                );
                setPreviewTick((v) => v + 1);
              }}
              className="h-8 w-16 cursor-pointer rounded"
              aria-label="Border color"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium mb-1">
              Extra border (px)
            </label>
            <input
              type="number"
              min={0}
              max={2000}
              value={extraPx}
              disabled={isBusy}
              onChange={(e) => {
                const val = Math.max(
                  0,
                  Math.min(2000, Number(e.target.value) || 0),
                );
                setExtraPx(val);
                setItems((prev) => prev.map((it) => ({ ...it, extraPx: val })));
                setPreviewTick((v) => v + 1);
              }}
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              Optional extra padding added beyond what’s required to reach the
              ratio.
            </p>
          </div>
        </div>

        {totalCount > 0 && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-gray-700">
                {totalCount} image{totalCount > 1 ? "s" : ""} ready
              </p>
              <button
                onClick={processAndDownload}
                className="rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800"
                disabled={isBusy}
                title="Process locally and download ZIP"
              >
                {status === "batch"
                  ? "Processing..."
                  : "Process & Download ZIP"}
              </button>
              <button
                onClick={processAndSaveAsFiles}
                className="rounded-md bg-white px-4 py-2 text-black border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                disabled={isBusy}
                title={
                  canPickDirectory
                    ? "Pick a folder once, then save every processed image as a separate file"
                    : "Folder save is not available in this browser"
                }
              >
                Save All Files (One Folder Pick)
              </button>
            </div>

            {isBusy && (
              <div className="mb-4 rounded-md bg-white p-3 text-sm shadow-sm border">
                <div className="mb-2 flex items-center justify-between">
                  <span>
                    {status === "batch"
                      ? "Batch processing"
                      : "Single image processing"}
                  </span>
                  <span>
                    {progress.done} / {progress.total}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-gray-200">
                  <div
                    className="h-full bg-black"
                    style={{
                      width: `${
                        progress.total > 0
                          ? Math.round((progress.done / progress.total) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((it, idx) => (
                <li
                  key={idx}
                  className="rounded-lg border bg-white p-3 shadow-sm"
                >
                  <div className="relative mb-3">
                    <div
                      className={`w-full overflow-hidden rounded-md border border-gray-200 ${
                        it.ratio === "16:9"
                          ? "aspect-[16/9]"
                          : it.ratio === "4:5"
                            ? "aspect-[4/5]"
                            : "aspect-square"
                      } bg-[repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6_8px,#e5e7eb_8px,#e5e7eb_16px)]`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={it.previewUrl}
                        alt={it.file.name}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <button
                      onClick={() => removeItem(idx)}
                      disabled={isBusy}
                      className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-xs shadow hover:bg-white"
                      title="Remove this image"
                    >
                      X
                    </button>
                    <button
                      onClick={() => processSingleDownload(it)}
                      disabled={isBusy}
                      className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-1 text-xs shadow hover:bg-white border border-gray-300"
                      title="Download this image with border"
                    >
                      Save
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="text-[11px] text-gray-500">
                      Preview: compressed thumbnail (for fast UI)
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">Aspect ratio</span>
                      <span className="rounded bg-gray-100 px-2 py-1 text-xs">
                        {globalRatio}
                      </span>
                    </div>

                    <div className="text-[11px] text-gray-500">
                      File: {it.file.name}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
