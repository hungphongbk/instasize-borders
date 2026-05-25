"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const RATIO_OPTIONS = [
  { label: "4:5 (Instagram portrait)", value: "4:5" },
  { label: "1:1 (Square)", value: "1:1" },
  { label: "9:16 (Stories/Reels)", value: "9:16" },
];

const FILL_PRESETS = [
  "#0f172a",
  "#111827",
  "#ffffff",
  "#f8fafc",
  "#fde68a",
  "#fecdd3",
  "#bae6fd",
  "#d9f99d",
];

function parseRatio(value) {
  const [w, h] = value.split(":").map(Number);
  if (!w || !h) return 4 / 5;
  return w / h;
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

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
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

export default function ScrlPage() {
  const [file, setFile] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [frameCount, setFrameCount] = useState(3);
  const [ratio, setRatio] = useState("4:5");
  const [zoom, setZoom] = useState(1);
  const [rotateUnits, setRotateUnits] = useState(0);
  const [fillColor, setFillColor] = useState("#0f172a");
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isPinching, setIsPinching] = useState(false);
  const [downloadState, setDownloadState] = useState("idle");
  const [dropActive, setDropActive] = useState(false);
  const [canPickDirectory, setCanPickDirectory] = useState(false);

  const stripRef = useRef(null);
  const stripRectRef = useRef({ width: 0, height: 0 });
  const dragStartRef = useRef({ pointerX: 0, pointerY: 0, offsetX: 0, offsetY: 0 });
  const inputRef = useRef(null);
  const pointersRef = useRef(new Map());
  const interactionRef = useRef({
    mode: "none",
    startDistance: 1,
    startMidX: 0,
    startMidY: 0,
    startZoom: 1,
    startOffsetX: 0,
    startOffsetY: 0,
  });
  const offsetRef = useRef(offset);
  const zoomRef = useRef(zoom);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [imageUrl]);

  useEffect(() => {
    if (!stripRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      stripRectRef.current = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
    });

    observer.observe(stripRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setCanPickDirectory(
      typeof window.showDirectoryPicker === "function" && window.isSecureContext,
    );
  }, []);

  const ratioValue = useMemo(() => parseRatio(ratio), [ratio]);

  const displayMetrics = useMemo(() => {
    if (!stripRectRef.current.width) {
      return { stripW: 1, stripH: 1, frameW: 1, frameH: 1, baseScale: 1 };
    }

    const stripW = stripRectRef.current.width;
    const frameW = stripW / frameCount;
    const frameH = frameW / ratioValue;
    const stripH = frameH;

    const baseScale = imageSize.width && imageSize.height
      ? Math.max(stripW / imageSize.width, stripH / imageSize.height)
      : 1;

    return { stripW, stripH, frameW, frameH, baseScale };
  }, [frameCount, ratioValue, imageSize.width, imageSize.height]);

  const renderScale = displayMetrics.baseScale * zoom;
  const rotationDeg = rotateUnits * 0.1;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const exportFrameSize = useMemo(() => {
    if (!renderScale || !Number.isFinite(renderScale)) return { width: 0, height: 0 };

    return {
      width: Math.max(1, Math.round(displayMetrics.frameW / renderScale)),
      height: Math.max(1, Math.round(displayMetrics.stripH / renderScale)),
    };
  }, [displayMetrics.frameW, displayMetrics.stripH, renderScale]);

  const setZoomClamped = (valueOrUpdater) => {
    setZoom((prev) => {
      const next =
        typeof valueOrUpdater === "function" ? valueOrUpdater(prev) : valueOrUpdater;
      return clamp(next, 0.5, 6);
    });
  };

  const getDistance = (pointA, pointB) => {
    const dx = pointA.x - pointB.x;
    const dy = pointA.y - pointB.y;
    return Math.hypot(dx, dy);
  };

  const getMidpoint = (pointA, pointB) => ({
    x: (pointA.x + pointB.x) / 2,
    y: (pointA.y + pointB.y) / 2,
  });

  const onIncomingFile = (nextFile) => {
    if (!nextFile || !nextFile.type.startsWith("image/")) return;

    if (imageUrl) URL.revokeObjectURL(imageUrl);

    const nextUrl = URL.createObjectURL(nextFile);
    setFile(nextFile);
    setImageUrl(nextUrl);
    setOffset({ x: 0, y: 0 });
    setZoom(1);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDropActive(false);
    const nextFile = event.dataTransfer.files?.[0];
    onIncomingFile(nextFile);
  };

  const onPointerDown = (event) => {
    if (!imageUrl) return;
    const strip = stripRef.current;
    if (!strip) return;

    event.preventDefault();
    strip.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointersRef.current.size === 1) {
      interactionRef.current.mode = "drag";
      dragStartRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        offsetX: offsetRef.current.x,
        offsetY: offsetRef.current.y,
      };
      setIsDragging(true);
      setIsPinching(false);
      return;
    }

    if (pointersRef.current.size === 2) {
      const points = Array.from(pointersRef.current.values());
      const distance = getDistance(points[0], points[1]);
      const midpoint = getMidpoint(points[0], points[1]);
      interactionRef.current = {
        mode: "pinch",
        startDistance: Math.max(distance, 1),
        startMidX: midpoint.x,
        startMidY: midpoint.y,
        startZoom: zoomRef.current,
        startOffsetX: offsetRef.current.x,
        startOffsetY: offsetRef.current.y,
      };
      setIsDragging(false);
      setIsPinching(true);
    }
  };

  const onPointerMove = (event) => {
    if (!pointersRef.current.has(event.pointerId)) return;

    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (interactionRef.current.mode === "pinch" && pointersRef.current.size >= 2) {
      const points = Array.from(pointersRef.current.values());
      const distance = getDistance(points[0], points[1]);
      const midpoint = getMidpoint(points[0], points[1]);
      const ratio = distance / interactionRef.current.startDistance;
      const nextZoom = interactionRef.current.startZoom * ratio;

      setZoomClamped(nextZoom);
      setOffset({
        x:
          interactionRef.current.startOffsetX +
          (midpoint.x - interactionRef.current.startMidX),
        y:
          interactionRef.current.startOffsetY +
          (midpoint.y - interactionRef.current.startMidY),
      });
      return;
    }

    if (interactionRef.current.mode === "drag" && pointersRef.current.size === 1) {
      const dx = event.clientX - dragStartRef.current.pointerX;
      const dy = event.clientY - dragStartRef.current.pointerY;

      setOffset({
        x: dragStartRef.current.offsetX + dx,
        y: dragStartRef.current.offsetY + dy,
      });
    }
  };

  const onPointerUp = (event) => {
    const strip = stripRef.current;
    if (strip?.hasPointerCapture(event.pointerId)) {
      strip.releasePointerCapture(event.pointerId);
    }

    pointersRef.current.delete(event.pointerId);

    if (pointersRef.current.size === 0) {
      interactionRef.current.mode = "none";
      setIsDragging(false);
      setIsPinching(false);
      return;
    }

    if (pointersRef.current.size === 1) {
      const remaining = Array.from(pointersRef.current.values())[0];
      interactionRef.current.mode = "drag";
      dragStartRef.current = {
        pointerX: remaining.x,
        pointerY: remaining.y,
        offsetX: offsetRef.current.x,
        offsetY: offsetRef.current.y,
      };
      setIsDragging(true);
      setIsPinching(false);
    }
  };

  const onWheelZoom = (event) => {
    if (!imageUrl) return;
    if (!event.ctrlKey && !event.metaKey) return;

    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.003);
    setZoomClamped((prev) => prev * factor);
  };

  const resetAlignment = () => {
    setOffset({ x: 0, y: 0 });
    setZoom(1);
    setRotateUnits(0);
  };

  const blobToDownload = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const renderFrames = async (writeFrame) => {
    let worker;
    try {
      const { stripW, stripH, frameW } = displayMetrics;
      const framePixelWidth = Math.max(1, Math.round(frameW / renderScale));
      const framePixelHeight = Math.max(1, Math.round(stripH / renderScale));
      const imageCenterDisplayX = stripW / 2 + offset.x;
      const imageCenterDisplayY = stripH / 2 + offset.y;
      worker = new Worker("/workers/image-processor.worker.js");
      const out = await requestWorker(worker, {
        type: "SCRL_PROCESS",
        file,
        options: {
          frameCount,
          framePixelWidth,
          framePixelHeight,
          frameW,
          stripW,
          imageCenterDisplayX,
          imageCenterDisplayY,
          renderScale,
          rotationRad,
          fillColor,
        },
      });

      const frames = Array.isArray(out.frames) ? out.frames : [];
      for (const frame of frames) {
        const blob = new Blob([frame.arrayBuffer], {
          type: frame.mimeType || "application/octet-stream",
        });
        await writeFrame(blob, frame.fileName || "frame.out");
      }
    } finally {
      if (worker) worker.terminate();
    }
  };

  const exportFrames = async () => {
    if (!file || !imageUrl) return;

    setDownloadState("processing");

    try {
      if (canPickDirectory) {
        let directoryHandle;
        try {
          directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        } catch {
          setDownloadState("idle");
          return;
        }

        await renderFrames(async (blob, fileName) => {
          const fileHandle = await directoryHandle.getFileHandle(fileName, {
            create: true,
          });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
        });
      } else {
        await renderFrames(async (blob, fileName) => {
          blobToDownload(blob, fileName);
        });
      }

      setDownloadState("done");
    } catch (error) {
      alert(`Xuất frame thất bại: ${error.message}`);
      setDownloadState("idle");
      return;
    }

    window.setTimeout(() => {
      setDownloadState("idle");
    }, 1400);
  };

  const imageStyle = useMemo(() => {
    const width = imageSize.width * renderScale;
    const height = imageSize.height * renderScale;

    return {
      width,
      height,
      left: `calc(50% + ${offset.x}px)`,
      top: `calc(50% + ${offset.y}px)`,
      transform: `translate(-50%, -50%) rotate(${rotationDeg}deg)`,
    };
  }, [imageSize.width, imageSize.height, renderScale, offset.x, offset.y, rotationDeg]);

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Insta Tools</p>
              <h1 className="text-2xl font-semibold text-slate-900">SCRL Carousel Splitter</h1>
              <p className="mt-1 text-sm text-slate-600">
                Upload ảnh lớn (100MB+ vẫn được nếu máy đủ RAM), kéo-thả để căn khung,
                rồi xuất các frame liên tiếp theo tỉ lệ bạn chọn.
              </p>
            </div>
            <div className="flex gap-2">
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
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Tỉ lệ frame</span>
              <select
                value={ratio}
                onChange={(event) => setRatio(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                {RATIO_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Số frame (2-10)</span>
              <input
                type="number"
                min={2}
                max={10}
                value={frameCount}
                onChange={(event) => setFrameCount(clamp(Number(event.target.value) || 2, 2, 10))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>

            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Zoom</span>
              <input
                type="range"
                min={0.5}
                max={6}
                step={0.01}
                value={zoom}
                onChange={(event) => setZoomClamped(Number(event.target.value))}
                className="w-full"
              />
              <div className="text-xs text-slate-500">{zoom.toFixed(2)}x</div>
            </label>

            <label className="space-y-1 text-sm text-slate-700">
              <span className="font-medium">Rotate</span>
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                value={rotateUnits}
                onChange={(event) => setRotateUnits(Number(event.target.value))}
                className="w-full"
              />
              <div className="text-xs text-slate-500">{rotationDeg.toFixed(1)}&deg;</div>
            </label>
          </div>

          <div className="mt-3 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-slate-600">
              Fill màu vùng ngoài ảnh
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {FILL_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setFillColor(preset)}
                  className={`h-7 w-7 rounded-full border ${
                    fillColor.toLowerCase() === preset.toLowerCase()
                      ? "border-slate-900 ring-2 ring-slate-300"
                      : "border-slate-300"
                  }`}
                  style={{ backgroundColor: preset }}
                  title={`Fill ${preset}`}
                  aria-label={`Fill ${preset}`}
                />
              ))}
              <label className="ml-1 flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700">
                Picker
                <input
                  type="color"
                  value={fillColor}
                  onChange={(event) => setFillColor(event.target.value)}
                  className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                  aria-label="Pick fill color"
                />
              </label>
              <span className="rounded bg-white px-2 py-1 text-xs text-slate-600">
                {fillColor.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            {file ? (
              <>
                <span className="rounded-full bg-slate-200 px-3 py-1">{file.name}</span>
                <span className="rounded-full bg-slate-200 px-3 py-1">{formatBytes(file.size)}</span>
                <span className="rounded-full bg-slate-200 px-3 py-1">
                  Output/frame: {exportFrameSize.width} x {exportFrameSize.height}
                </span>
                <span className="rounded-full bg-slate-200 px-3 py-1">
                  Rotate: {rotationDeg.toFixed(1)}&deg;
                </span>
              </>
            ) : (
              <span className="rounded-full bg-slate-200 px-3 py-1">Chưa có ảnh</span>
            )}
          </div>
        </header>

        <section
          onDragEnter={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDropActive(false);
          }}
          onDrop={onDrop}
          className={`rounded-2xl border-2 border-dashed p-3 sm:p-5 ${
            dropActive ? "border-cyan-500 bg-cyan-50" : "border-slate-300 bg-white"
          }`}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              onChange={(event) => onIncomingFile(event.target.files?.[0])}
              className="hidden"
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Upload image
            </button>
            <button
              onClick={resetAlignment}
              disabled={!file}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 disabled:opacity-40"
            >
              Reset vị trí/zoom
            </button>
            <button
              onClick={exportFrames}
              disabled={!file || downloadState === "processing"}
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-40"
            >
              {downloadState === "processing"
                ? "Đang xuất..."
                : downloadState === "done"
                  ? "Đã xuất files"
                  : "Export nhiều files"}
            </button>
          </div>

          <p className="mb-3 text-xs text-slate-600">
            Drag & drop ảnh vào vùng này hoặc bấm Upload. Sau đó kéo trực tiếp
            trên ảnh để căn vào lưới frame. Zoom bằng slider, pinch trên màn
            cảm ứng hoặc trackpad (gesture Ctrl/Meta + wheel).
          </p>
          <p className="mb-3 text-xs text-slate-600">
            Export không resize theo width cố định. Mỗi frame giữ nguyên tỷ lệ
            pixel gốc theo vùng cắt hiện tại, và output giữ cùng định dạng với
            input. Nếu trình duyệt hỗ trợ, bạn chỉ cần chọn thư mục 1 lần để
            lưu toàn bộ files.
          </p>

          <div className="overflow-x-auto">
            <div
              ref={stripRef}
              style={{
                aspectRatio: `${frameCount * ratioValue} / 1`,
                touchAction: "none",
              }}
              className={`relative mx-auto min-w-[300px] max-w-5xl overflow-hidden rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#f8fafc_0%,#e2e8f0_100%)] ${
                isPinching ? "cursor-zoom-in" : isDragging ? "cursor-grabbing" : "cursor-grab"
              }`}
              onWheel={onWheelZoom}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerUp}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div
                className="pointer-events-none absolute inset-0"
                style={{ backgroundColor: fillColor }}
              />
              {imageUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl}
                    alt="Uploaded source"
                    draggable={false}
                    onLoad={(event) => {
                      const nextImage = event.currentTarget;
                      setImageSize({
                        width: nextImage.naturalWidth,
                        height: nextImage.naturalHeight,
                      });
                    }}
                    style={imageStyle}
                    className="pointer-events-none absolute max-w-none select-none"
                  />

                  <div className="pointer-events-none absolute inset-0">
                    {Array.from({ length: frameCount - 1 }).map((_, idx) => (
                      <div
                        key={idx}
                        className="absolute top-0 bottom-0 w-[2px] bg-white/90 shadow-[0_0_0_1px_rgba(15,23,42,0.15)]"
                        style={{ left: `${((idx + 1) / frameCount) * 100}%` }}
                      />
                    ))}
                    <div className="absolute inset-0 border-[3px] border-white/90" />
                    <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_24px,rgba(255,255,255,0.2)_24px,rgba(255,255,255,0.2)_25px)]" />
                  </div>
                </>
              ) : (
                <div className="grid h-full place-items-center px-4 text-center text-sm text-slate-500">
                  Chưa có ảnh để preview. Upload hoặc kéo-thả ảnh vào đây.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
