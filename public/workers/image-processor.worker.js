const RATIO_1_1 = 1;
const RATIO_4_5 = 4 / 5;
const RATIO_16_9 = 16 / 9;

function hexToRgb(hex) {
  let h = String(hex || "#ffffff")
    .replace("#", "")
    .trim();
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = Number.parseInt(h, 16);
  if (Number.isNaN(num)) return { r: 255, g: 255, b: 255 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function getTargetRatio(ratio) {
  if (ratio === "4:5") return RATIO_4_5;
  return ratio === "16:9" ? RATIO_16_9 : RATIO_1_1;
}

function getOutputInfo(fileName, fileType, ratio) {
  const base = fileName.replace(/\.[^/.]+$/, "");
  const suffix = ratio === "16:9" ? "16x9" : ratio === "4:5" ? "4x5" : "1x1";

  let ext = "jpg";
  let mimeType = "image/jpeg";

  if (fileType === "image/png") {
    ext = "png";
    mimeType = "image/png";
  } else if (fileType === "image/webp") {
    ext = "webp";
    mimeType = "image/webp";
  }

  return {
    fileName: `${base}_border_${suffix}.${ext}`,
    mimeType,
  };
}

function getPreviewType() {
  return "image/webp";
}

function getCanvasSize(width, height, ratio, extraPx) {
  const targetRatio = getTargetRatio(ratio);

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

async function processImage(file, options) {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "This browser does not support createImageBitmap in Web Workers.",
    );
  }

  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("This browser does not support OffscreenCanvas.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const { width: canvasW, height: canvasH } = getCanvasSize(
      bitmap.width,
      bitmap.height,
      options.ratio,
      options.extraPx,
    );

    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Cannot create canvas context.");

    const bg = hexToRgb(options.borderColor);
    ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
    ctx.fillRect(0, 0, canvasW, canvasH);

    const left = Math.floor((canvasW - bitmap.width) / 2);
    const top = Math.floor((canvasH - bitmap.height) / 2);
    ctx.drawImage(bitmap, left, top);

    const outInfo = getOutputInfo(
      file.name || "image.jpg",
      file.type,
      options.ratio,
    );
    const blob = await canvas.convertToBlob({
      type: outInfo.mimeType,
      quality: outInfo.mimeType === "image/jpeg" ? 1 : undefined,
    });

    return {
      fileName: outInfo.fileName,
      mimeType: outInfo.mimeType,
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

async function buildPreview(file, options) {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "This browser does not support createImageBitmap in Web Workers.",
    );
  }

  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("This browser does not support OffscreenCanvas.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const { width: canvasW, height: canvasH } = getCanvasSize(
      bitmap.width,
      bitmap.height,
      options.ratio,
      options.extraPx,
    );

    const fullCanvas = new OffscreenCanvas(canvasW, canvasH);
    const fullCtx = fullCanvas.getContext("2d", { alpha: false });
    if (!fullCtx) throw new Error("Cannot create canvas context.");

    const bg = hexToRgb(options.borderColor);
    fullCtx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
    fullCtx.fillRect(0, 0, canvasW, canvasH);

    const left = Math.floor((canvasW - bitmap.width) / 2);
    const top = Math.floor((canvasH - bitmap.height) / 2);
    fullCtx.drawImage(bitmap, left, top);

    const previewMaxEdge = Math.max(
      120,
      Math.floor(Number(options.previewMaxEdge) || 300),
    );
    const scale = Math.min(1, previewMaxEdge / Math.max(canvasW, canvasH));
    const previewW = Math.max(1, Math.round(canvasW * scale));
    const previewH = Math.max(1, Math.round(canvasH * scale));

    const previewCanvas = new OffscreenCanvas(previewW, previewH);
    const previewCtx = previewCanvas.getContext("2d", { alpha: false });
    if (!previewCtx) throw new Error("Cannot create preview canvas context.");

    previewCtx.drawImage(fullCanvas, 0, 0, previewW, previewH);

    const mimeType = getPreviewType();
    let blob;
    try {
      blob = await previewCanvas.convertToBlob({
        type: mimeType,
        quality: 0.72,
      });
    } catch {
      blob = await previewCanvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.75,
      });
    }

    return {
      mimeType: blob.type || "image/jpeg",
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || (message.type !== "PROCESS" && message.type !== "PREVIEW"))
    return;

  const { id, file, options } = message;

  try {
    if (message.type === "PROCESS") {
      const result = await processImage(file, options || {});
      self.postMessage(
        {
          type: "DONE",
          id,
          fileName: result.fileName,
          mimeType: result.mimeType,
          arrayBuffer: result.arrayBuffer,
        },
        [result.arrayBuffer],
      );
      return;
    }

    const preview = await buildPreview(file, options || {});
    self.postMessage(
      {
        type: "DONE",
        id,
        index: Number(message.index),
        mimeType: preview.mimeType,
        arrayBuffer: preview.arrayBuffer,
      },
      [preview.arrayBuffer],
    );
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      id,
      error:
        error instanceof Error ? error.message : "Image processing failed.",
    });
  }
});
