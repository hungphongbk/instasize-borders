"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

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

function downloadWorkerOutput(result, fallbackName) {
  const blob = new Blob([result.arrayBuffer], {
    type: result.mimeType || "image/png",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.fileName || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatZoom(zoom) {
  if (!Number.isFinite(zoom)) return "1x";
  const rounded = Math.round(zoom * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

function readImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error("Khong the doc kich thuoc anh."));
    image.src = url;
  });
}

async function prepareImageFile(file) {
  const objectUrl = URL.createObjectURL(file);

  try {
    let width = 0;
    let height = 0;

    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      if (typeof bitmap.close === "function") bitmap.close();
    } else {
      const size = await readImageDimensions(objectUrl);
      width = size.width;
      height = size.height;
    }

    return {
      file,
      url: objectUrl,
      width,
      height,
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function buildTransform(image, viewport, zoom, pan) {
  if (!image || !viewport.width || !viewport.height) {
    return {
      width: 0,
      height: 0,
      transform: "translate3d(0,0,0)",
      displayWidth: 0,
      displayHeight: 0,
    };
  }

  const fitScale = Math.min(
    viewport.width / image.width,
    viewport.height / image.height,
  );
  const effectiveScale = fitScale * zoom;
  const displayWidth = image.width * effectiveScale;
  const displayHeight = image.height * effectiveScale;

  const minX = Math.min(0, viewport.width - displayWidth);
  const minY = Math.min(0, viewport.height - displayHeight);

  const rawX = viewport.width / 2 - pan.x * displayWidth;
  const rawY = viewport.height / 2 - pan.y * displayHeight;

  const tx =
    displayWidth <= viewport.width
      ? (viewport.width - displayWidth) / 2
      : clamp(rawX, minX, 0);
  const ty =
    displayHeight <= viewport.height
      ? (viewport.height - displayHeight) / 2
      : clamp(rawY, minY, 0);

  return {
    width: displayWidth,
    height: displayHeight,
    transform: `translate3d(${tx}px, ${ty}px, 0)`,
    displayWidth,
    displayHeight,
  };
}

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <circle
        cx="11"
        cy="11"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M11 8v6M8 11h6M16.5 16.5L21 21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <circle
        cx="11"
        cy="11"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8 11h6M16.5 16.5L21 21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function OneToOneIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8 12h8M12 8v8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ComparisonPage() {
  const [leftImage, setLeftImage] = useState(null);
  const [rightImage, setRightImage] = useState(null);
  const [leftLabel, setLeftLabel] = useState("Ảnh A");
  const [rightLabel, setRightLabel] = useState("Ảnh B");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0.5, y: 0.5 });
  const [notice, setNotice] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [includeHistogramOnExport, setIncludeHistogramOnExport] =
    useState(true);
  const [loadState, setLoadState] = useState({
    left: { isLoading: false, progress: 0, step: "" },
    right: { isLoading: false, progress: 0, step: "" },
  });
  const [histogramState, setHistogramState] = useState({
    leftBins: null,
    rightBins: null,
    globalBlack: 0,
    globalWhite: 255,
    isLoading: false,
  });
  const [leftViewport, setLeftViewport] = useState({ width: 0, height: 0 });
  const [rightViewport, setRightViewport] = useState({ width: 0, height: 0 });

  const leftStageRef = useRef(null);
  const rightStageRef = useRef(null);
  const loadTokenRef = useRef({ left: 0, right: 0 });
  const dragRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    startPanX: 0.5,
    startPanY: 0.5,
    displayWidth: 0,
    displayHeight: 0,
  });

  useEffect(() => {
    const leftElement = leftStageRef.current;
    const rightElement = rightStageRef.current;
    if (!leftElement || !rightElement) return undefined;

    const observer = new ResizeObserver(() => {
      setLeftViewport({
        width: leftElement.clientWidth,
        height: leftElement.clientHeight,
      });
      setRightViewport({
        width: rightElement.clientWidth,
        height: rightElement.clientHeight,
      });
    });

    observer.observe(leftElement);
    observer.observe(rightElement);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (leftImage?.url) URL.revokeObjectURL(leftImage.url);
      if (rightImage?.url) URL.revokeObjectURL(rightImage.url);
    };
  }, [leftImage?.url, rightImage?.url]);

  useEffect(() => {
    if (!leftImage?.file && !rightImage?.file) {
      setHistogramState({
        leftBins: null,
        rightBins: null,
        globalBlack: 0,
        globalWhite: 255,
        isLoading: false,
      });
      return undefined;
    }

    const worker = new Worker("/workers/image-processor.worker.js");
    let active = true;

    setHistogramState((prev) => ({ ...prev, isLoading: true }));

    requestWorker(worker, {
      type: "COMPARISON_HISTOGRAM",
      options: {
        leftFile: leftImage?.file || null,
        rightFile: rightImage?.file || null,
      },
    })
      .then((result) => {
        if (!active) return;
        setHistogramState({
          leftBins: result.leftBins || null,
          rightBins: result.rightBins || null,
          globalBlack: clamp(Number(result.globalBlack) || 0, 0, 255),
          globalWhite: clamp(Number(result.globalWhite) || 255, 0, 255),
          isLoading: false,
        });
      })
      .catch(() => {
        if (!active) return;
        setHistogramState((prev) => ({ ...prev, isLoading: false }));
      })
      .finally(() => {
        worker.terminate();
      });

    return () => {
      active = false;
      worker.terminate();
    };
  }, [leftImage?.file, rightImage?.file]);

  const leftTransform = useMemo(
    () => buildTransform(leftImage, leftViewport, zoom, pan),
    [leftImage, leftViewport, pan, zoom],
  );
  const rightTransform = useMemo(
    () => buildTransform(rightImage, rightViewport, zoom, pan),
    [rightImage, rightViewport, pan, zoom],
  );

  const canDrag = Boolean((leftImage || rightImage) && zoom > MIN_ZOOM);

  const updateLoadState = (side, next) => {
    setLoadState((prev) => ({
      ...prev,
      [side]: {
        ...prev[side],
        ...next,
      },
    }));
  };

  const onPickImage = async (side, file) => {
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      setNotice("Chỉ hỗ trợ tệp hình ảnh hợp lệ.");
      return;
    }

    loadTokenRef.current[side] += 1;
    const token = loadTokenRef.current[side];

    updateLoadState(side, {
      isLoading: true,
      progress: 12,
      step: "Đang mở tệp...",
    });

    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));

      updateLoadState(side, {
        isLoading: true,
        progress: 58,
        step: "Đang đọc metadata...",
      });

      const nextImage = await prepareImageFile(file);
      if (token !== loadTokenRef.current[side]) {
        URL.revokeObjectURL(nextImage.url);
        return;
      }

      setNotice("");
      setPan({ x: 0.5, y: 0.5 });

      if (side === "left") {
        setLeftImage((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return nextImage;
        });
      } else {
        setRightImage((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return nextImage;
        });
      }

      updateLoadState(side, {
        isLoading: true,
        progress: 100,
        step: "Sẵn sàng",
      });

      setTimeout(() => {
        if (token !== loadTokenRef.current[side]) return;
        updateLoadState(side, {
          isLoading: false,
          progress: 0,
          step: "",
        });
      }, 220);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Không thể đọc dữ liệu ảnh.",
      );
      if (token === loadTokenRef.current[side]) {
        updateLoadState(side, {
          isLoading: false,
          progress: 0,
          step: "",
        });
      }
    }
  };

  const getActiveDisplaySize = (side) => {
    if (side === "left") {
      return {
        width: leftTransform.displayWidth,
        height: leftTransform.displayHeight,
      };
    }
    return {
      width: rightTransform.displayWidth,
      height: rightTransform.displayHeight,
    };
  };

  const beginDrag = (side, event) => {
    if (!canDrag) return;

    const size = getActiveDisplaySize(side);
    if (!size.width || !size.height) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
      displayWidth: size.width,
      displayHeight: size.height,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!isDragging || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    const nextPanX = clamp(drag.startPanX - dx / drag.displayWidth, 0, 1);
    const nextPanY = clamp(drag.startPanY - dy / drag.displayHeight, 0, 1);

    setPan({ x: nextPanX, y: nextPanY });
  };

  const endDrag = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current.pointerId = null;
    setIsDragging(false);
  };

  const zoomIn = () => setZoom((prev) => clamp(prev + 1, MIN_ZOOM, MAX_ZOOM));
  const zoomOut = () => setZoom((prev) => clamp(prev - 1, MIN_ZOOM, MAX_ZOOM));

  const zoomOneToOne = () => {
    const referenceImage = leftImage || rightImage;
    const referenceViewport = leftImage ? leftViewport : rightViewport;

    if (
      !referenceImage ||
      !referenceViewport.width ||
      !referenceViewport.height
    ) {
      setNotice("Hãy tải ít nhất một ảnh để dùng chế độ 1:1.");
      return;
    }

    const fitScale = Math.min(
      referenceViewport.width / referenceImage.width,
      referenceViewport.height / referenceImage.height,
    );

    const oneToOneZoom = clamp(1 / fitScale, MIN_ZOOM, MAX_ZOOM);
    setZoom(oneToOneZoom);
    setNotice("Đã chuyển về 1:1: 1 pixel ảnh tương ứng 1 pixel màn hình.");
  };

  const exportComparison = async () => {
    if (!leftImage && !rightImage) {
      setNotice("Cần tải ít nhất một ảnh trước khi xuất tệp.");
      return;
    }

    const worker = new Worker("/workers/image-processor.worker.js");
    setIsExporting(true);
    setNotice("Đang dựng ảnh xuất bằng worker...");

    try {
      const result = await requestWorker(worker, {
        type: "COMPARISON_EXPORT",
        options: {
          leftFile: leftImage?.file || null,
          rightFile: rightImage?.file || null,
          zoom,
          pan,
          leftViewport,
          rightViewport,
          gap: 0,
          backgroundColor: "#f1f5f9",
          stageBackgroundColor: "#f1f5f9",
          includeHistogram: includeHistogramOnExport,
          leftBins: histogramState.leftBins,
          rightBins: histogramState.rightBins,
          globalBlack: histogramState.globalBlack,
          globalWhite: histogramState.globalWhite,
          leftLabel: leftLabel.trim() || "Ảnh A",
          rightLabel: rightLabel.trim() || "Ảnh B",
        },
      });

      downloadWorkerOutput(result, "comparison_export.png");
      setNotice("Xuất ảnh thành công. Tệp đã được tải xuống.");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `Xuất ảnh thất bại: ${error.message}`
          : "Xuất ảnh thất bại.",
      );
    } finally {
      worker.terminate();
      setIsExporting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#e0f2fe_0%,#f8fafc_45%,#f1f5f9_100%)] px-4 py-6 sm:px-6 sm:py-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="rounded-3xl border border-black/10 bg-white/85 p-5 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.45)] backdrop-blur sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Mô-đun So sánh
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900 sm:text-4xl">
                So sánh ảnh
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-600 sm:text-base">
                Tải hai phiên bản ảnh để so sánh trực quan. Zoom theo từng bước
                1x, kéo ở bất kỳ khung nào để đồng bộ vùng quan sát và phát hiện
                sai khác nhanh hơn.
              </p>
            </div>
            <Link
              href="/"
              className="inline-flex items-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Về Trang chủ
            </Link>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span className="font-medium">Nhãn bên trái</span>
              <input
                type="text"
                value={leftLabel}
                onChange={(event) => setLeftLabel(event.target.value)}
                placeholder="Ví dụ: Ảnh A"
                maxLength={40}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none ring-sky-200 focus:ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              <span className="font-medium">Nhãn bên phải</span>
              <input
                type="text"
                value={rightLabel}
                onChange={(event) => setRightLabel(event.target.value)}
                placeholder="Ví dụ: Ảnh B"
                maxLength={40}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none ring-sky-200 focus:ring"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoom <= MIN_ZOOM}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-300 bg-white text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              title="Thu nhỏ"
              aria-label="Thu nhỏ"
            >
              <ZoomOutIcon />
            </button>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoom >= MAX_ZOOM}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-300 bg-white text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
              title="Phóng to"
              aria-label="Phóng to"
            >
              <ZoomInIcon />
            </button>
            <button
              type="button"
              onClick={zoomOneToOne}
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-100"
              title="Tỉ lệ 1:1"
              aria-label="Tỉ lệ 1:1"
            >
              <OneToOneIcon />
              1:1
            </button>
            <span className="inline-flex h-11 items-center rounded-2xl bg-slate-900 px-4 text-sm font-semibold text-white">
              {formatZoom(zoom)}
            </span>
            <button
              type="button"
              onClick={exportComparison}
              disabled={isExporting || (!leftImage && !rightImage)}
              className="inline-flex h-11 items-center rounded-2xl border border-slate-900 bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isExporting ? "Đang xuất..." : "Xuất PNG"}
            </button>
          </div>

          <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includeHistogramOnExport}
              onChange={(event) =>
                setIncludeHistogramOnExport(event.target.checked)
              }
              className="h-4 w-4 rounded border-slate-300 text-slate-900"
            />
            Đính kèm histogram khi xuất ảnh
          </label>

          {notice ? (
            <p className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {notice}
            </p>
          ) : null}
        </header>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <article className="rounded-3xl border border-black/10 bg-white p-4 shadow-[0_16px_45px_-32px_rgba(15,23,42,0.55)] sm:p-5">
            <UploaderTitle
              sideLabel="Trái"
              customLabel={leftLabel}
              image={leftImage}
              onChange={(file) => onPickImage("left", file)}
              loadInfo={loadState.left}
            />
            <div
              ref={leftStageRef}
              className={`relative mt-4 h-[52vh] min-h-[340px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 ${canDrag ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"}`}
              onPointerDown={(event) => beginDrag("left", event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ touchAction: "none" }}
            >
              {leftImage ? (
                <img
                  src={leftImage.url}
                  alt="Left uploaded reference"
                  draggable={false}
                  className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
                  style={{
                    width: `${leftTransform.width}px`,
                    height: `${leftTransform.height}px`,
                    transform: leftTransform.transform,
                  }}
                />
              ) : (
                <EmptyStage label="Tải ảnh cho khung bên trái" />
              )}
              <HistogramOverlay
                title={leftLabel.trim() || "Ảnh A"}
                bins={histogramState.leftBins}
                globalBlack={histogramState.globalBlack}
                globalWhite={histogramState.globalWhite}
                isLoading={histogramState.isLoading}
              />
              <LoadProgressOverlay
                isLoading={loadState.left.isLoading}
                progress={loadState.left.progress}
                step={loadState.left.step}
              />
            </div>
          </article>

          <article className="rounded-3xl border border-black/10 bg-white p-4 shadow-[0_16px_45px_-32px_rgba(15,23,42,0.55)] sm:p-5">
            <UploaderTitle
              sideLabel="Phải"
              customLabel={rightLabel}
              image={rightImage}
              onChange={(file) => onPickImage("right", file)}
              loadInfo={loadState.right}
            />
            <div
              ref={rightStageRef}
              className={`relative mt-4 h-[52vh] min-h-[340px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 ${canDrag ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"}`}
              onPointerDown={(event) => beginDrag("right", event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ touchAction: "none" }}
            >
              {rightImage ? (
                <img
                  src={rightImage.url}
                  alt="Right uploaded reference"
                  draggable={false}
                  className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
                  style={{
                    width: `${rightTransform.width}px`,
                    height: `${rightTransform.height}px`,
                    transform: rightTransform.transform,
                  }}
                />
              ) : (
                <EmptyStage label="Tải ảnh cho khung bên phải" />
              )}
              <HistogramOverlay
                title={rightLabel.trim() || "Ảnh B"}
                bins={histogramState.rightBins}
                globalBlack={histogramState.globalBlack}
                globalWhite={histogramState.globalWhite}
                isLoading={histogramState.isLoading}
              />
              <LoadProgressOverlay
                isLoading={loadState.right.isLoading}
                progress={loadState.right.progress}
                step={loadState.right.step}
              />
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}

function UploaderTitle({ sideLabel, customLabel, image, onChange, loadInfo }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          {customLabel?.trim() || `Ảnh ${sideLabel}`}
        </h2>
        <p className="mt-0.5 text-xs uppercase tracking-[0.08em] text-slate-500">
          Khung {sideLabel}
        </p>
        <p className="mt-1 text-xs text-slate-600">
          {image
            ? `${image.file.name} - ${image.width} x ${image.height}px`
            : "Chưa có ảnh"}
        </p>
        {loadInfo?.isLoading ? (
          <p className="mt-1 text-xs font-medium text-sky-700">
            {loadInfo.step || "Đang tải..."} ({Math.round(loadInfo.progress)}%)
          </p>
        ) : null}
      </div>
      <label className="inline-flex cursor-pointer items-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
        Tải ảnh
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => onChange(event.target.files?.[0] || null)}
        />
      </label>
    </div>
  );
}

function LoadProgressOverlay({ isLoading, progress, step }) {
  if (!isLoading) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-slate-900/28">
      <div className="w-[240px] rounded-xl border border-white/35 bg-white/85 p-3 shadow-lg backdrop-blur">
        <p className="text-xs font-semibold text-slate-800">
          {step || "Đang tải ảnh..."}
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-sky-500 transition-all"
            style={{ width: `${clamp(progress, 0, 100)}%` }}
          />
        </div>
        <p className="mt-1 text-[11px] text-slate-600">
          {Math.round(clamp(progress, 0, 100))}%
        </p>
      </div>
    </div>
  );
}

function EmptyStage({ label }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6 text-center">
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-5 py-6 text-sm text-slate-600">
        {label}
      </div>
    </div>
  );
}

function HistogramOverlay({
  title,
  bins,
  globalBlack,
  globalWhite,
  isLoading,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(15, 23, 42, 0.35)";
    ctx.fillRect(0, 0, width, height);

    if (!bins || !bins.length) {
      ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
      ctx.font = "11px sans-serif";
      ctx.fillText(
        isLoading ? "Đang phân tích..." : "Chưa có histogram",
        8,
        24,
      );
      return;
    }

    const start = clamp(Math.floor(globalBlack), 0, 255);
    const end = clamp(Math.ceil(globalWhite), 0, 255);
    const range = Math.max(1, end - start + 1);
    const horizontalPadding = 2;
    const barCount = Math.max(16, width - horizontalPadding * 2);
    const bars = new Array(barCount).fill(0);

    for (let i = 0; i < barCount; i += 1) {
      const from = start + Math.floor((i * range) / barCount);
      const to = start + Math.floor(((i + 1) * range) / barCount);
      let sum = 0;
      for (let x = from; x < to; x += 1) {
        sum += Number(bins[x] || 0);
      }
      bars[i] = sum;
    }

    const maxValue = bars.reduce((acc, value) => Math.max(acc, value), 1);
    const baseY = height - 2;

    ctx.fillStyle = "rgba(125, 211, 252, 0.95)";
    for (let i = 0; i < barCount; i += 1) {
      const barHeight = Math.max(
        1,
        Math.round((bars[i] / maxValue) * (height - 8)),
      );
      ctx.fillRect(horizontalPadding + i, baseY - barHeight, 1, barHeight);
    }

    ctx.strokeStyle = "rgba(248, 250, 252, 0.65)";
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }, [bins, globalBlack, globalWhite, isLoading]);

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20">
      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-100 [text-shadow:0_1px_2px_rgba(15,23,42,0.9)]">
        {title}
      </p>
      <canvas
        ref={canvasRef}
        width={196}
        height={58}
        className="mt-1 h-[58px] w-[196px] rounded border border-white/15"
      />
      <p className="mt-1 text-[10px] text-slate-200 [text-shadow:0_1px_2px_rgba(15,23,42,0.9)]">
        B {Math.round(globalBlack)} | W {Math.round(globalWhite)}
      </p>
    </div>
  );
}
