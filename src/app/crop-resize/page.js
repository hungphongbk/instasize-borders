"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const PREVIEW_MAX_EDGE = 1800;
const WARNING_WORKING_SET_BYTES = 768 * 1024 * 1024;
const ZOOM_OPTIONS = [10, 30, 100];
const ASPECT_OPTIONS = [
  {
    value: "4:5",
    label: "4 : 5",
    detail: "Portrait feed",
  },
  {
    value: "9:16",
    label: "9 : 16",
    detail: "Story / Reels",
  },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseAspectRatio(value) {
  const [width, height] = String(value).split(":").map(Number);
  if (!width || !height) return 4 / 5;
  return width / height;
}

function buildCropSize(imageWidth, imageHeight, aspectRatio, zoomLevel) {
  const imageAspect = imageWidth / imageHeight;
  let maxWidth = imageWidth;
  let maxHeight = imageHeight;

  if (imageAspect > aspectRatio) {
    maxWidth = imageHeight * aspectRatio;
  } else {
    maxHeight = imageWidth / aspectRatio;
  }

  return {
    width: Math.max(1, maxWidth / zoomLevel),
    height: Math.max(1, maxHeight / zoomLevel),
  };
}

function buildCropRect(imageWidth, imageHeight, aspectRatio, zoomLevel, center) {
  const size = buildCropSize(imageWidth, imageHeight, aspectRatio, zoomLevel);
  const desiredCenterX = clamp((center?.x ?? 0.5) * imageWidth, 0, imageWidth);
  const desiredCenterY = clamp((center?.y ?? 0.5) * imageHeight, 0, imageHeight);

  const left = clamp(desiredCenterX - size.width / 2, 0, imageWidth - size.width);
  const top = clamp(desiredCenterY - size.height / 2, 0, imageHeight - size.height);

  return {
    left,
    top,
    width: size.width,
    height: size.height,
    centerX: left + size.width / 2,
    centerY: top + size.height / 2,
  };
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

function getNoticeStyle(tone) {
  if (tone === "error") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (tone === "success") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (tone === "warn") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function getFormatLabel(file) {
  const subtype = String(file?.type || "").split("/")[1] || "";
  return subtype ? subtype.toUpperCase().replace("JPEG", "JPG") : "";
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

function buildReadyNotice(file, info) {
  const estimatedRawBytes = Number(info?.estimatedRawBytes) || 0;

  if (estimatedRawBytes >= WARNING_WORKING_SET_BYTES) {
    return {
      tone: "warn",
      text: `Preview đã sẵn sàng. Ảnh này giải nén thô khoảng ${formatBytes(estimatedRawBytes)}; vì toàn bộ xử lý chạy trong browser, export có thể fail trên máy hoặc tab có ít RAM.`,
    };
  }

  return {
    tone: "success",
    text: `Preview đã sẵn sàng. File đang nằm hoàn toàn ở máy bạn, không upload lên server. Kích thước file gốc: ${formatBytes(file.size)}.`,
  };
}

export default function CropResizePage() {
  const [sourceFile, setSourceFile] = useState(null);
  const [imageInfo, setImageInfo] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [zoomLevel, setZoomLevel] = useState(10);
  const [aspectRatio, setAspectRatio] = useState("4:5");
  const [cropCenter, setCropCenter] = useState({ x: 0.5, y: 0.5 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [uploadState, setUploadState] = useState("idle");
  const [actionState, setActionState] = useState("idle");
  const [dropActive, setDropActive] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState({ tone: "neutral", text: "" });

  const fileInputRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef({
    active: false,
    pointerX: 0,
    pointerY: 0,
    centerX: 0.5,
    centerY: 0.5,
  });

  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (!imageInfo || !stageRef.current) {
      setStageSize({ width: 0, height: 0 });
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [imageInfo]);

  const aspectValue = useMemo(() => parseAspectRatio(aspectRatio), [aspectRatio]);

  const cropRect = useMemo(() => {
    if (!imageInfo?.width || !imageInfo?.height) return null;

    return buildCropRect(
      imageInfo.width,
      imageInfo.height,
      aspectValue,
      zoomLevel,
      cropCenter,
    );
  }, [aspectValue, cropCenter, imageInfo, zoomLevel]);

  const stageCropRect = useMemo(() => {
    if (!cropRect || !imageInfo?.width || !imageInfo?.height) return null;
    if (!stageSize.width || !stageSize.height) return null;

    const scaleX = stageSize.width / imageInfo.width;
    const scaleY = stageSize.height / imageInfo.height;

    return {
      left: cropRect.left * scaleX,
      top: cropRect.top * scaleY,
      width: cropRect.width * scaleX,
      height: cropRect.height * scaleY,
    };
  }, [cropRect, imageInfo, stageSize.height, stageSize.width]);

  const zoomPreviewStyle = useMemo(() => {
    if (!cropRect || !previewUrl || !imageInfo?.previewWidth || !imageInfo?.previewHeight) {
      return null;
    }

    const scaleX = imageInfo.previewWidth / imageInfo.width;
    const scaleY = imageInfo.previewHeight / imageInfo.height;
    const previewRect = {
      left: cropRect.left * scaleX,
      top: cropRect.top * scaleY,
      width: cropRect.width * scaleX,
      height: cropRect.height * scaleY,
    };

    const positionX =
      imageInfo.previewWidth <= previewRect.width
        ? 50
        : clamp(
            (previewRect.left / (imageInfo.previewWidth - previewRect.width)) * 100,
            0,
            100,
          );
    const positionY =
      imageInfo.previewHeight <= previewRect.height
        ? 50
        : clamp(
            (previewRect.top / (imageInfo.previewHeight - previewRect.height)) * 100,
            0,
            100,
          );

    return {
      backgroundImage: `url(${previewUrl})`,
      backgroundSize: `${(imageInfo.previewWidth / previewRect.width) * 100}% auto`,
      backgroundPosition: `${positionX}% ${positionY}%`,
      backgroundRepeat: "no-repeat",
    };
  }, [cropRect, imageInfo, previewUrl]);

  const cropOutputLabel = useMemo(() => {
    if (!cropRect) return "";
    return `${Math.round(cropRect.width)} x ${Math.round(cropRect.height)} px`;
  }, [cropRect]);

  const resizeSummary = useMemo(() => {
    if (!imageInfo?.width || !imageInfo?.height) return "";

    const maxEdge = Math.max(imageInfo.width, imageInfo.height);
    if (maxEdge <= 2048) {
      return "Ảnh hiện tại đã <= 2048px ở cạnh dài, export resize sẽ giữ nguyên kích thước đó.";
    }

    const scale = 2048 / maxEdge;
    return `${Math.round(imageInfo.width * scale)} x ${Math.round(imageInfo.height * scale)} px`;
  }, [imageInfo]);

  const isBusy = uploadState === "uploading" || actionState !== "idle";

  const clearCurrentImage = () => {
    setSourceFile(null);
    setImageInfo(null);
    setPreviewUrl("");
    setCropCenter({ x: 0.5, y: 0.5 });
    setUploadState("idle");
    setActionState("idle");
    setNotice({ tone: "neutral", text: "" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const uploadFile = async (file) => {
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      setNotice({ tone: "error", text: "Chỉ hỗ trợ upload file ảnh." });
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setNotice({
        tone: "error",
        text: "Worker-only mode đang chặn file lớn hơn 1GB. Hãy giảm file đầu vào hoặc chuyển qua luồng desktop/backend khác.",
      });
      return;
    }

    const previousHadImage = Boolean(sourceFile);
    let worker;

    setUploadState("uploading");
    setActionState("idle");
    setNotice({
      tone: "neutral",
      text: "Đang đọc file cục bộ và dựng preview trong Web Worker...",
    });

    try {
      worker = new Worker("/workers/image-processor.worker.js");
      const payload = await requestWorker(worker, {
        type: "CROP_RESIZE_PREVIEW",
        file,
        options: {
          previewMaxEdge: PREVIEW_MAX_EDGE,
        },
      });

      const nextPreviewUrl = URL.createObjectURL(
        new Blob([payload.arrayBuffer], {
          type: payload.mimeType || "image/jpeg",
        }),
      );

      setSourceFile(file);
      setImageInfo({
        fileName: file.name || "image",
        sizeBytes: file.size,
        width: payload.width,
        height: payload.height,
        previewWidth: payload.previewWidth,
        previewHeight: payload.previewHeight,
        estimatedRawBytes: payload.estimatedRawBytes,
        format: getFormatLabel(file),
      });
      setPreviewUrl(nextPreviewUrl);
      setCropCenter({ x: 0.5, y: 0.5 });
      setUploadState("ready");
      setNotice(buildReadyNotice(file, payload));

      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      setUploadState(previousHadImage ? "ready" : "idle");
      setNotice({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Không thể decode file này trong worker. Máy hoặc browser có thể không đủ tài nguyên.",
      });
    } finally {
      if (worker) worker.terminate();
    }
  };

  const onFileInput = async (event) => {
    const nextFile = event.target.files?.[0];
    await uploadFile(nextFile);
  };

  const onDropZone = async (event) => {
    event.preventDefault();
    setDropActive(false);

    const nextFile = Array.from(event.dataTransfer.files || []).find((file) =>
      String(file.type || "").startsWith("image/"),
    );

    await uploadFile(nextFile);
  };

  const withStagePoint = (event) => {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds || !bounds.width || !bounds.height) return null;

    const localX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const localY = clamp(event.clientY - bounds.top, 0, bounds.height);

    return {
      x: localX / bounds.width,
      y: localY / bounds.height,
      localX,
      localY,
    };
  };

  const onStagePointerDown = (event) => {
    if (!imageInfo || !cropRect || !stageCropRect) return;

    const point = withStagePoint(event);
    if (!point) return;

    const isInsideCurrentRect =
      point.localX >= stageCropRect.left &&
      point.localX <= stageCropRect.left + stageCropRect.width &&
      point.localY >= stageCropRect.top &&
      point.localY <= stageCropRect.top + stageCropRect.height;

    const startCenter = isInsideCurrentRect
      ? {
          x: cropRect.centerX / imageInfo.width,
          y: cropRect.centerY / imageInfo.height,
        }
      : { x: point.x, y: point.y };

    if (!isInsideCurrentRect) {
      setCropCenter(startCenter);
    }

    dragRef.current = {
      active: true,
      pointerX: point.x,
      pointerY: point.y,
      centerX: startCenter.x,
      centerY: startCenter.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onStagePointerMove = (event) => {
    if (!dragRef.current.active) return;

    const point = withStagePoint(event);
    if (!point) return;

    setCropCenter({
      x: dragRef.current.centerX + (point.x - dragRef.current.pointerX),
      y: dragRef.current.centerY + (point.y - dragRef.current.pointerY),
    });
  };

  const onStagePointerUp = (event) => {
    dragRef.current.active = false;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const exportResize = async () => {
    if (!sourceFile) return;

    let worker;

    setActionState("resizing");
    setNotice({
      tone: "neutral",
      text: "Đang resize trực tiếp trong worker trên máy bạn...",
    });

    try {
      worker = new Worker("/workers/image-processor.worker.js");
      const result = await requestWorker(worker, {
        type: "CROP_RESIZE_EXPORT_RESIZE",
        file: sourceFile,
        options: {
          maxEdge: 2048,
        },
      });

      downloadWorkerOutput(result, "resize_2048.png");
      setNotice({
        tone: "success",
        text: "Resize export hoàn tất. File được render hoàn toàn client-side.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Resize export failed.",
      });
    } finally {
      if (worker) worker.terminate();
      setActionState("idle");
    }
  };

  const exportCrop = async () => {
    if (!sourceFile || !cropRect) return;

    let worker;

    setActionState("cropping");
    setNotice({
      tone: "neutral",
      text: "Đang crop trực tiếp trong worker trên máy bạn...",
    });

    try {
      worker = new Worker("/workers/image-processor.worker.js");
      const result = await requestWorker(worker, {
        type: "CROP_RESIZE_EXPORT_CROP",
        file: sourceFile,
        options: {
          cropRect: {
            left: cropRect.left,
            top: cropRect.top,
            width: cropRect.width,
            height: cropRect.height,
          },
          zoomLabel: `${zoomLevel}x`,
          aspectLabel: aspectRatio.replace(":", "x"),
        },
      });

      downloadWorkerOutput(
        result,
        `crop_${zoomLevel}x_${aspectRatio.replace(":", "x")}.png`,
      );
      setNotice({
        tone: "success",
        text: "Crop export hoàn tất. File được render hoàn toàn client-side.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Crop export failed.",
      });
    } finally {
      if (worker) worker.terminate();
      setActionState("idle");
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#fff4eb_0%,#fff8f1_24%,#eef6ff_62%,#f8fafc_100%)] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-[32px] border border-black/10 bg-white/85 p-6 shadow-[0_18px_48px_-28px_rgba(15,23,42,0.38)] backdrop-blur sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="inline-flex rounded-full border border-black/10 bg-slate-900 px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-white">
                Crop & Resize
              </p>
              <h1 className="mt-3 text-3xl font-semibold text-slate-950 sm:text-4xl">
                Resize nhẹ hoặc crop zoom từ một ảnh gốc cực lớn
              </h1>
              <p className="mt-3 max-w-3xl text-sm text-slate-600 sm:text-base">
                Toàn bộ feature chạy client-side. Ảnh không rời khỏi máy bạn; browser sẽ dựng preview trong Web Worker rồi export resize hoặc crop trực tiếp từ file gốc. Hard cap hiện tại là 1GB mỗi file và kết quả thực tế còn phụ thuộc RAM của máy.
              </p>
            </div>

            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              <span aria-hidden>{"<"}</span>
              Back to home
            </Link>
          </div>

          <div className="flex flex-wrap gap-2 text-xs text-slate-600">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
              Worker-only client side
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
              Hard cap 1GB / file
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
              Không upload lên server
            </span>
          </div>
        </header>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,420px)]">
          <div className="flex flex-col gap-6">
            <div className="rounded-[28px] border border-black/10 bg-white p-5 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.45)] sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Upload ảnh gốc</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Chọn một ảnh, browser sẽ đọc file cục bộ và sinh preview nhẹ trong worker để bạn thao tác crop.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadState === "uploading"}
                    className="inline-flex items-center rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    {uploadState === "uploading" ? "Đang đọc file..." : "Chọn ảnh"}
                  </button>

                  {imageInfo ? (
                    <button
                      type="button"
                      onClick={() => void clearCurrentImage()}
                      disabled={isBusy}
                      className="inline-flex items-center rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Xoá ảnh hiện tại
                    </button>
                  ) : null}
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void onFileInput(event)}
              />

              <label
                onDragEnter={() => setDropActive(true)}
                onDragLeave={() => setDropActive(false)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropActive(true);
                }}
                onDrop={(event) => void onDropZone(event)}
                className={`mt-5 flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-[24px] border-2 border-dashed px-5 py-8 text-center transition ${
                  dropActive
                    ? "border-slate-900 bg-slate-50"
                    : "border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]"
                }`}
              >
                <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-slate-500">
                  Single Image Upload
                </span>
                <strong className="mt-4 text-lg font-semibold text-slate-900">
                  Kéo thả ảnh vào đây hoặc bấm để chọn file
                </strong>
                <span className="mt-2 max-w-xl text-sm text-slate-600">
                  Chế độ này không có backend. Preview sẽ nhẹ hơn ảnh gốc để kéo crop mượt hơn, nhưng file lớn vẫn phụ thuộc trực tiếp vào RAM của browser.
                </span>
              </label>

              {imageInfo ? (
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    {imageInfo.fileName}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    {imageInfo.width} x {imageInfo.height}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    {formatBytes(imageInfo.sizeBytes)}
                  </span>
                  {imageInfo.format ? (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 uppercase">
                      {imageInfo.format}
                    </span>
                  ) : null}
                  {imageInfo.estimatedRawBytes ? (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                      Raw decode ~ {formatBytes(imageInfo.estimatedRawBytes)}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="rounded-[28px] border border-black/10 bg-white p-5 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.45)] sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Crop trên ảnh gốc</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Click để đặt tâm crop, drag để rê khung crop. Khung bên dưới là preview nhẹ; lúc export worker sẽ decode lại file gốc ngay trên máy bạn.
                  </p>
                </div>

                {cropOutputLabel ? (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
                    Crop output: {cropOutputLabel}
                  </span>
                ) : null}
              </div>

              {imageInfo ? (
                <div className="mt-5">
                  <div
                    ref={stageRef}
                    style={{ aspectRatio: `${imageInfo.width} / ${imageInfo.height}` }}
                    className="relative overflow-hidden rounded-[24px] border border-slate-200 bg-slate-100"
                  >
                    <img
                      src={previewUrl}
                      alt={imageInfo.fileName || "Uploaded preview"}
                      draggable={false}
                      className="h-full w-full select-none object-contain"
                    />

                    <button
                      type="button"
                      onPointerDown={onStagePointerDown}
                      onPointerMove={onStagePointerMove}
                      onPointerUp={onStagePointerUp}
                      onPointerCancel={onStagePointerUp}
                      className={`absolute inset-0 touch-none bg-transparent ${
                        isDragging ? "cursor-grabbing" : "cursor-crosshair"
                      }`}
                    >
                      <span className="sr-only">Move crop frame</span>
                    </button>

                    {stageCropRect ? (
                      <div
                        className="pointer-events-none absolute rounded-[24px] border-2 border-white shadow-[0_0_0_9999px_rgba(15,23,42,0.42)]"
                        style={{
                          left: `${stageCropRect.left}px`,
                          top: `${stageCropRect.top}px`,
                          width: `${stageCropRect.width}px`,
                          height: `${stageCropRect.height}px`,
                        }}
                      >
                        <div className="absolute left-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-900">
                          {zoomLevel}x · {aspectRatio}
                        </div>
                        <div className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-white/30 backdrop-blur" />
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-5 py-12 text-center text-sm text-slate-500">
                  Upload ảnh để hiển thị khung crop tương tác.
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="rounded-[28px] border border-black/10 bg-white p-5 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.45)] sm:p-6">
              <h2 className="text-xl font-semibold text-slate-950">Crop controls</h2>

              <div className="mt-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Zoom level
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {ZOOM_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setZoomLevel(option)}
                      disabled={!imageInfo}
                      className={`rounded-2xl px-3 py-3 text-sm font-medium transition ${
                        zoomLevel === option
                          ? "bg-slate-950 text-white"
                          : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-950"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {option}x
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Crop aspect
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  {ASPECT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setAspectRatio(option.value)}
                      disabled={!imageInfo}
                      className={`rounded-[22px] border px-4 py-4 text-left transition ${
                        aspectRatio === option.value
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-950"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <div className="text-lg font-semibold">{option.label}</div>
                      <div className="mt-1 text-xs uppercase tracking-[0.18em] opacity-75">
                        {option.detail}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-5 rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                {imageInfo ? (
                  <div className="space-y-2">
                    <p>
                      Khung crop hiện tại tương đương <strong>{cropOutputLabel}</strong> trên ảnh gốc.
                    </p>
                    <p>
                        10x lấy vùng lớn nhất, 30x và 100x thu nhỏ khung theo cùng aspect ratio để zoom sâu hơn. Export mặc định ra PNG để tránh thêm một vòng nén lossy trong browser.
                    </p>
                  </div>
                ) : (
                  <p>Upload ảnh trước khi chọn crop zoom và aspect ratio.</p>
                )}
              </div>
            </div>

            <div className="rounded-[28px] border border-black/10 bg-white p-5 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.45)] sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Zoom preview</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Phần xem phóng to được dựng từ preview nhẹ để thao tác nhanh.
                  </p>
                </div>

                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
                  {zoomLevel}x · {aspectRatio}
                </span>
              </div>

              <div className="mt-5 overflow-hidden rounded-[24px] border border-slate-200 bg-slate-100">
                <div
                  style={{ aspectRatio: aspectValue }}
                  className="h-full w-full bg-[radial-gradient(circle_at_top,#ffffff_0%,#eef2ff_40%,#dbeafe_100%)]"
                >
                  {zoomPreviewStyle ? (
                    <div className="h-full w-full" style={zoomPreviewStyle} />
                  ) : (
                    <div className="grid h-full w-full place-items-center px-6 text-center text-sm text-slate-500">
                      Upload ảnh để hiển thị bản phóng to vùng crop.
                    </div>
                  )}
                </div>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                Nếu preview thấy đúng, file crop export ra sẽ đúng cùng vị trí. Tuy nhiên mức ổn định còn phụ thuộc tài nguyên browser khi decode lại file gốc.
              </p>
            </div>

            <div className="rounded-[28px] border border-black/10 bg-white p-5 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.45)] sm:p-6">
              <h2 className="text-xl font-semibold text-slate-950">Export</h2>

              <div className="mt-5 grid gap-4">
                <div className="rounded-[22px] border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">Resize</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Xuất bản nhẹ hơn với cạnh dài tối đa 2048px. Chế độ worker-only hiện export PNG để tránh nén thêm trong browser.
                      </p>
                    </div>
                    {resizeSummary ? (
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
                        {resizeSummary}
                      </span>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => void exportResize()}
                    disabled={!imageInfo || isBusy}
                    className="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    {actionState === "resizing" ? "Đang export resize..." : "Export resize 2048px"}
                  </button>
                </div>

                <div className="rounded-[22px] border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">Crop zoom</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Xuất đúng vùng crop đang chọn. File cũng được render ở client-side và mặc định ra PNG để tránh nén lossy thêm một lần nữa.
                      </p>
                    </div>
                    {cropOutputLabel ? (
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
                        {cropOutputLabel}
                      </span>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => void exportCrop()}
                    disabled={!imageInfo || isBusy}
                    className="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-4 py-3 text-sm font-medium text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:from-slate-400 disabled:via-slate-400 disabled:to-slate-400"
                  >
                    {actionState === "cropping" ? "Đang export crop..." : `Export crop ${zoomLevel}x / ${aspectRatio}`}
                  </button>
                </div>
              </div>

              {notice.text ? (
                <div className={`mt-4 rounded-[20px] border px-4 py-3 text-sm ${getNoticeStyle(notice.tone)}`}>
                  {notice.text}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}