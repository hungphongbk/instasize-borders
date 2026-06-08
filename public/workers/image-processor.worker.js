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

function getCropResizeOutputInfo(fileName, suffix) {
  const base = (fileName || "image").replace(/\.[^/.]+$/, "");
  return {
    fileName: `${base}_${suffix}.png`,
    mimeType: "image/png",
  };
}

function getOutputFormat(fileType, fileName) {
  const sourceName = fileName || "image";
  const sourceExt = sourceName.includes(".")
    ? sourceName.slice(sourceName.lastIndexOf(".") + 1).toLowerCase()
    : "png";

  if (!String(fileType || "").startsWith("image/")) {
    return { mimeType: "image/png", extension: sourceExt || "png" };
  }

  if (fileType === "image/jpg") {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }

  return {
    mimeType: fileType,
    extension: (fileType.split("/")[1] || sourceExt || "png").toLowerCase(),
  };
}

function getFillStyle(hex) {
  const bg = hexToRgb(hex);
  return `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
}

function getGridConfig(grid) {
  if (grid === "1:3") return { cols: 1, rows: 3, key: "1x3" };
  if (grid === "2:2") return { cols: 2, rows: 2, key: "2x2" };
  if (grid === "2:3") return { cols: 2, rows: 3, key: "2x3" };
  return { cols: 1, rows: 2, key: "1x2" };
}

function getGridOutputSize(outputRatio) {
  if (outputRatio === "9:16") {
    return { width: 1080, height: 1920, key: "9x16" };
  }
  return { width: 1080, height: 1350, key: "4x5" };
}

function getGridOutputType(type) {
  if (type === "image/png") {
    return { mimeType: "image/png", ext: "png" };
  }
  if (type === "image/webp") {
    return { mimeType: "image/webp", ext: "webp" };
  }
  return { mimeType: "image/jpeg", ext: "jpg" };
}

function drawCoverImage(ctx, bitmap, left, top, width, height) {
  const sx = Math.max(1e-6, width / bitmap.width);
  const sy = Math.max(1e-6, height / bitmap.height);
  const scale = Math.max(sx, sy);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  const drawLeft = left + (width - drawWidth) / 2;
  const drawTop = top + (height - drawHeight) / 2;
  ctx.drawImage(bitmap, drawLeft, drawTop, drawWidth, drawHeight);
}

async function processGrid(files, options) {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "This browser does not support createImageBitmap in Web Workers.",
    );
  }

  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("This browser does not support OffscreenCanvas.");
  }

  const inputFiles = Array.isArray(files) ? files : [];
  if (!inputFiles.length) {
    throw new Error("No files provided for grid processing.");
  }

  const grid = getGridConfig(options.grid);
  const outputSize = getGridOutputSize(options.outputRatio);
  const outputType = getGridOutputType(options.outputType);

  const gap = Math.max(0, Math.floor(Number(options.gap) || 0));
  const padding = Math.max(0, Math.floor(Number(options.padding) || 0));
  const fillStyle = getFillStyle(options.backgroundColor || "#ffffff");

  const innerWidth =
    outputSize.width - padding * 2 - gap * Math.max(0, grid.cols - 1);
  const innerHeight =
    outputSize.height - padding * 2 - gap * Math.max(0, grid.rows - 1);

  if (innerWidth <= 0 || innerHeight <= 0) {
    throw new Error("Grid spacing is too large for selected output size.");
  }

  const baseCellW = Math.floor(innerWidth / grid.cols);
  const baseCellH = Math.floor(innerHeight / grid.rows);
  const usedFiles = inputFiles.slice(0, grid.cols * grid.rows);
  const bitmaps = await Promise.all(
    usedFiles.map((file) => createImageBitmap(file)),
  );

  try {
    const canvas = new OffscreenCanvas(outputSize.width, outputSize.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Cannot create grid canvas context.");

    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, outputSize.width, outputSize.height);

    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const slotIndex = row * grid.cols + col;
        const bitmap = bitmaps[slotIndex];
        if (!bitmap) continue;

        const cellX = padding + col * (baseCellW + gap);
        const cellY = padding + row * (baseCellH + gap);
        const cellW =
          col === grid.cols - 1
            ? outputSize.width - padding - cellX
            : baseCellW;
        const cellH =
          row === grid.rows - 1
            ? outputSize.height - padding - cellY
            : baseCellH;

        ctx.save();
        ctx.beginPath();
        ctx.rect(cellX, cellY, cellW, cellH);
        ctx.clip();
        drawCoverImage(ctx, bitmap, cellX, cellY, cellW, cellH);
        ctx.restore();
      }
    }

    const blob = await canvas.convertToBlob({
      type: outputType.mimeType,
      quality:
        outputType.mimeType === "image/jpeg" ||
        outputType.mimeType === "image/webp"
          ? 0.95
          : undefined,
    });

    const base = (inputFiles[0]?.name || "image").replace(/\.[^/.]+$/, "");
    return {
      fileName: `${base}_grid_${grid.key}_${outputSize.key}.${outputType.ext}`,
      mimeType: blob.type || outputType.mimeType,
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    bitmaps.forEach((bitmap) => {
      if (typeof bitmap.close === "function") bitmap.close();
    });
  }
}

async function processScrl(file, options) {
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
    const frameCount = Math.max(1, Math.floor(Number(options.frameCount) || 1));
    const framePixelWidth = Math.max(
      1,
      Math.floor(Number(options.framePixelWidth) || 1),
    );
    const framePixelHeight = Math.max(
      1,
      Math.floor(Number(options.framePixelHeight) || 1),
    );
    const frameW = Number(options.frameW) || 1;
    const stripW = Number(options.stripW) || frameW * frameCount;
    const imageCenterDisplayX =
      Number(options.imageCenterDisplayX) || stripW / 2;
    const imageCenterDisplayY = Number(options.imageCenterDisplayY) || 0;
    const renderScale = Number(options.renderScale) || 1;
    const rotationRad = Number(options.rotationRad) || 0;
    const fillStyle = getFillStyle(options.fillColor || "#0f172a");

    const out = getOutputFormat(file.type, file.name || "image");
    const baseName = (file.name || "image").replace(/\.[^/.]+$/, "");

    const canvas = new OffscreenCanvas(framePixelWidth, framePixelHeight);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Cannot create SCRL canvas context.");

    const frames = [];

    for (let i = 0; i < frameCount; i += 1) {
      ctx.fillStyle = fillStyle;
      ctx.fillRect(0, 0, framePixelWidth, framePixelHeight);

      const frameStartX = i * frameW;
      const centerXInFrame = (imageCenterDisplayX - frameStartX) / renderScale;
      const centerYInFrame = imageCenterDisplayY / renderScale;

      ctx.save();
      ctx.translate(centerXInFrame, centerYInFrame);
      ctx.rotate(rotationRad);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      ctx.restore();

      const blob = await canvas.convertToBlob({
        type: out.mimeType,
        quality:
          out.mimeType === "image/jpeg" || out.mimeType === "image/webp"
            ? 1
            : undefined,
      });

      const arrayBuffer = await blob.arrayBuffer();
      frames.push({
        fileName: `${baseName}_scrl_${String(i + 1).padStart(2, "0")}.${out.extension}`,
        mimeType: out.mimeType,
        arrayBuffer,
      });
    }

    return frames;
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
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

function assertCanvasLimits(width, height) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 0));
  const safeHeight = Math.max(1, Math.floor(Number(height) || 0));

  if (
    safeWidth > 16384 ||
    safeHeight > 16384 ||
    safeWidth * safeHeight > 268435456
  ) {
    throw new Error(
      "Output region exceeds browser canvas limits for worker-only processing.",
    );
  }
}

async function buildCropResizePreview(file, options) {
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
    const previewMaxEdge = Math.max(
      120,
      Math.floor(Number(options.previewMaxEdge) || 1800),
    );
    const scale = Math.min(
      1,
      previewMaxEdge / Math.max(bitmap.width, bitmap.height),
    );
    const previewWidth = Math.max(1, Math.round(bitmap.width * scale));
    const previewHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(previewWidth, previewHeight);
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Cannot create crop preview canvas context.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, previewWidth, previewHeight);

    let blob;
    try {
      blob = await canvas.convertToBlob({
        type: getPreviewType(),
        quality: 0.82,
      });
    } catch {
      blob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.85,
      });
    }

    return {
      width: bitmap.width,
      height: bitmap.height,
      previewWidth,
      previewHeight,
      estimatedRawBytes: bitmap.width * bitmap.height * 4,
      mimeType: blob.type || "image/jpeg",
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

function normalizeCropRect(cropRect, bitmap) {
  const width = Math.min(
    bitmap.width,
    Math.max(1, Math.round(Number(cropRect?.width) || 0)),
  );
  const height = Math.min(
    bitmap.height,
    Math.max(1, Math.round(Number(cropRect?.height) || 0)),
  );
  const left = Math.min(
    Math.max(0, Math.round(Number(cropRect?.left) || 0)),
    Math.max(0, bitmap.width - width),
  );
  const top = Math.min(
    Math.max(0, Math.round(Number(cropRect?.top) || 0)),
    Math.max(0, bitmap.height - height),
  );

  return { left, top, width, height };
}

function calculateLuminance(r, g, b) {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

async function buildHistogramForFile(file) {
  if (!file) return null;

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
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!ctx) throw new Error("Cannot create histogram canvas context.");

    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const { data } = imageData;

    const bins = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      const luminance = calculateLuminance(data[i], data[i + 1], data[i + 2]);
      bins[luminance] += 1;
    }

    let min = 0;
    while (min < 255 && bins[min] === 0) min += 1;

    let max = 255;
    while (max > 0 && bins[max] === 0) max -= 1;

    if (min > max) {
      min = 0;
      max = 255;
    }

    return {
      bins: Array.from(bins),
      min,
      max,
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

async function buildComparisonHistogram(options) {
  const leftFile = options?.leftFile || null;
  const rightFile = options?.rightFile || null;

  if (!leftFile && !rightFile) {
    return {
      leftBins: null,
      rightBins: null,
      globalBlack: 0,
      globalWhite: 255,
    };
  }

  const [leftHistogram, rightHistogram] = await Promise.all([
    buildHistogramForFile(leftFile),
    buildHistogramForFile(rightFile),
  ]);

  let globalBlack = 255;
  let globalWhite = 0;
  let hasData = false;

  if (leftHistogram) {
    hasData = true;
    globalBlack = Math.min(globalBlack, leftHistogram.min);
    globalWhite = Math.max(globalWhite, leftHistogram.max);
  }

  if (rightHistogram) {
    hasData = true;
    globalBlack = Math.min(globalBlack, rightHistogram.min);
    globalWhite = Math.max(globalWhite, rightHistogram.max);
  }

  if (!hasData) {
    globalBlack = 0;
    globalWhite = 255;
  }

  return {
    leftBins: leftHistogram?.bins || null,
    rightBins: rightHistogram?.bins || null,
    globalBlack,
    globalWhite,
  };
}

function getComparisonOutputInfo(leftFile, rightFile) {
  const leftBase = (leftFile?.name || "left").replace(/\.[^/.]+$/, "");
  const rightBase = (rightFile?.name || "right").replace(/\.[^/.]+$/, "");
  return {
    fileName: `comparison_${leftBase}_vs_${rightBase}.png`,
    mimeType: "image/png",
  };
}

function getComparisonLayout(options) {
  const gap = Math.max(0, Math.floor(Number(options.gap) || 0));
  const leftWidth = Math.max(
    1,
    Math.floor(Number(options.leftViewport?.width) || 1),
  );
  const leftHeight = Math.max(
    1,
    Math.floor(Number(options.leftViewport?.height) || 1),
  );
  const rightWidth = Math.max(
    1,
    Math.floor(Number(options.rightViewport?.width) || 1),
  );
  const rightHeight = Math.max(
    1,
    Math.floor(Number(options.rightViewport?.height) || 1),
  );

  return {
    gap,
    leftWidth,
    leftHeight,
    rightWidth,
    rightHeight,
    outputWidth: leftWidth + rightWidth + gap,
    outputHeight: Math.max(leftHeight, rightHeight),
  };
}

function getHistogramValueLinear(bins, toneIndex) {
  const safeIndex = Math.min(255, Math.max(0, toneIndex));
  const left = Math.floor(safeIndex);
  const right = Math.min(255, left + 1);
  const mix = safeIndex - left;
  const leftValue = Number(bins[left] || 0);
  const rightValue = Number(bins[right] || 0);
  return leftValue + (rightValue - leftValue) * mix;
}

function drawSmoothHistogramOverlay(ctx, options) {
  const bins = Array.isArray(options?.bins) ? options.bins : null;
  if (!bins || !bins.length) return;

  const paneWidth = Math.max(1, Math.floor(Number(options.paneWidth) || 1));
  const paneHeight = Math.max(1, Math.floor(Number(options.paneHeight) || 1));
  const title = String(options?.title || "Histogram");

  const globalBlack = Math.max(
    0,
    Math.min(255, Math.floor(Number(options?.globalBlack) || 0)),
  );
  const globalWhite = Math.max(
    0,
    Math.min(255, Math.ceil(Number(options?.globalWhite) || 255)),
  );
  const start = Math.min(globalBlack, globalWhite);
  const end = Math.max(globalBlack, globalWhite);

  const overlayPadding = 12;
  const overlayWidth = Math.min(paneWidth - overlayPadding * 2, 260);
  const overlayHeight = Math.min(paneHeight - overlayPadding * 2, 92);
  if (overlayWidth < 120 || overlayHeight < 56) return;

  const x = overlayPadding;
  const y = overlayPadding;
  const innerPad = 8;
  const graphX = x + innerPad;
  const graphY = y + 20;
  const graphWidth = Math.max(16, overlayWidth - innerPad * 2);
  const graphHeight = Math.max(14, overlayHeight - 38);
  const baselineY = graphY + graphHeight;

  const range = Math.max(1, end - start);
  const sampleCount = Math.max(512, graphWidth * 6);

  let maxValue = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const tone = start + (i / (sampleCount - 1)) * range;
    maxValue = Math.max(maxValue, getHistogramValueLinear(bins, tone));
  }
  maxValue = Math.max(1, maxValue);

  ctx.save();
  ctx.fillStyle = "rgba(15, 23, 42, 0.64)";
  ctx.fillRect(x, y, overlayWidth, overlayHeight);

  ctx.fillStyle = "rgba(241, 245, 249, 0.95)";
  ctx.font = "600 10px sans-serif";
  ctx.fillText(title, graphX, y + 12);

  ctx.strokeStyle = "rgba(241, 245, 249, 0.45)";
  ctx.strokeRect(graphX - 0.5, graphY - 0.5, graphWidth + 1, graphHeight + 1);

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / (sampleCount - 1);
    const tone = start + t * range;
    const value = getHistogramValueLinear(bins, tone);
    const normalized = Math.pow(value / maxValue, 0.62);
    const px = graphX + t * graphWidth;
    const py = baselineY - normalized * graphHeight;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }

  ctx.lineTo(graphX + graphWidth, baselineY);
  ctx.lineTo(graphX, baselineY);
  ctx.closePath();

  ctx.fillStyle = "rgba(56, 189, 248, 0.42)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / (sampleCount - 1);
    const tone = start + t * range;
    const value = getHistogramValueLinear(bins, tone);
    const normalized = Math.pow(value / maxValue, 0.62);
    const px = graphX + t * graphWidth;
    const py = baselineY - normalized * graphHeight;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = "rgba(125, 211, 252, 0.95)";
  ctx.lineWidth = 1.25;
  ctx.stroke();

  ctx.fillStyle = "rgba(226, 232, 240, 0.88)";
  ctx.font = "500 10px sans-serif";
  ctx.fillText(`B ${start} | W ${end}`, graphX, y + overlayHeight - 8);
  ctx.restore();
}

function calcComparisonPaneTransform(bitmap, viewport, zoom, pan) {
  if (!bitmap || !viewport.width || !viewport.height) return null;

  const fitScale = Math.min(
    viewport.width / bitmap.width,
    viewport.height / bitmap.height,
  );
  const effectiveScale = fitScale * Math.max(0.01, Number(zoom) || 1);
  const drawWidth = bitmap.width * effectiveScale;
  const drawHeight = bitmap.height * effectiveScale;

  const minX = Math.min(0, viewport.width - drawWidth);
  const minY = Math.min(0, viewport.height - drawHeight);

  const panX = Number(pan?.x);
  const panY = Number(pan?.y);
  const safePanX = Number.isFinite(panX) ? panX : 0.5;
  const safePanY = Number.isFinite(panY) ? panY : 0.5;

  const rawX = viewport.width / 2 - safePanX * drawWidth;
  const rawY = viewport.height / 2 - safePanY * drawHeight;

  const tx =
    drawWidth <= viewport.width
      ? (viewport.width - drawWidth) / 2
      : Math.min(0, Math.max(minX, rawX));
  const ty =
    drawHeight <= viewport.height
      ? (viewport.height - drawHeight) / 2
      : Math.min(0, Math.max(minY, rawY));

  return {
    drawWidth,
    drawHeight,
    tx,
    ty,
  };
}

function drawComparisonPane(ctx, bitmap, viewport, zoom, pan) {
  if (!bitmap) return;

  const transform = calcComparisonPaneTransform(bitmap, viewport, zoom, pan);
  if (!transform) return;

  ctx.drawImage(
    bitmap,
    transform.tx,
    transform.ty,
    transform.drawWidth,
    transform.drawHeight,
  );
}

async function exportComparison(options) {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "This browser does not support createImageBitmap in Web Workers.",
    );
  }

  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("This browser does not support OffscreenCanvas.");
  }

  const layout = getComparisonLayout(options || {});
  assertCanvasLimits(layout.outputWidth, layout.outputHeight);

  const leftFile = options?.leftFile || null;
  const rightFile = options?.rightFile || null;
  const includeHistogram = Boolean(options?.includeHistogram);
  const leftLabel = String(options?.leftLabel || "Ảnh A").trim() || "Ảnh A";
  const rightLabel = String(options?.rightLabel || "Ảnh B").trim() || "Ảnh B";

  if (!leftFile && !rightFile) {
    throw new Error("No images provided for comparison export.");
  }

  let histogram = null;
  if (includeHistogram) {
    const hasProvidedBins =
      Array.isArray(options?.leftBins) || Array.isArray(options?.rightBins);

    if (hasProvidedBins) {
      histogram = {
        leftBins: Array.isArray(options?.leftBins) ? options.leftBins : null,
        rightBins: Array.isArray(options?.rightBins) ? options.rightBins : null,
        globalBlack: Math.max(
          0,
          Math.min(255, Number(options?.globalBlack) || 0),
        ),
        globalWhite: Math.max(
          0,
          Math.min(255, Number(options?.globalWhite) || 255),
        ),
      };
    } else {
      histogram = await buildComparisonHistogram({ leftFile, rightFile });
    }
  }

  const [leftBitmap, rightBitmap] = await Promise.all([
    leftFile ? createImageBitmap(leftFile) : Promise.resolve(null),
    rightFile ? createImageBitmap(rightFile) : Promise.resolve(null),
  ]);

  try {
    const canvas = new OffscreenCanvas(layout.outputWidth, layout.outputHeight);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Cannot create comparison canvas context.");

    const pageBg = getFillStyle(options?.backgroundColor || "#f1f5f9");
    const stageBg = getFillStyle(options?.stageBackgroundColor || "#f1f5f9");

    ctx.fillStyle = pageBg;
    ctx.fillRect(0, 0, layout.outputWidth, layout.outputHeight);

    ctx.save();
    ctx.translate(0, 0);
    ctx.fillStyle = stageBg;
    ctx.fillRect(0, 0, layout.leftWidth, layout.leftHeight);
    ctx.beginPath();
    ctx.rect(0, 0, layout.leftWidth, layout.leftHeight);
    ctx.clip();
    drawComparisonPane(
      ctx,
      leftBitmap,
      { width: layout.leftWidth, height: layout.leftHeight },
      options?.zoom,
      options?.pan,
    );
    if (includeHistogram && histogram?.leftBins) {
      drawSmoothHistogramOverlay(ctx, {
        bins: histogram.leftBins,
        globalBlack: histogram.globalBlack,
        globalWhite: histogram.globalWhite,
        paneWidth: layout.leftWidth,
        paneHeight: layout.leftHeight,
        title: leftLabel,
      });
    }
    ctx.restore();

    ctx.save();
    ctx.translate(layout.leftWidth + layout.gap, 0);
    ctx.fillStyle = stageBg;
    ctx.fillRect(0, 0, layout.rightWidth, layout.rightHeight);
    ctx.beginPath();
    ctx.rect(0, 0, layout.rightWidth, layout.rightHeight);
    ctx.clip();
    drawComparisonPane(
      ctx,
      rightBitmap,
      { width: layout.rightWidth, height: layout.rightHeight },
      options?.zoom,
      options?.pan,
    );
    if (includeHistogram && histogram?.rightBins) {
      drawSmoothHistogramOverlay(ctx, {
        bins: histogram.rightBins,
        globalBlack: histogram.globalBlack,
        globalWhite: histogram.globalWhite,
        paneWidth: layout.rightWidth,
        paneHeight: layout.rightHeight,
        title: rightLabel,
      });
    }
    ctx.restore();

    const output = getComparisonOutputInfo(leftFile, rightFile);
    const blob = await canvas.convertToBlob({ type: output.mimeType });

    return {
      fileName: output.fileName,
      mimeType: output.mimeType,
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    if (leftBitmap && typeof leftBitmap.close === "function")
      leftBitmap.close();
    if (rightBitmap && typeof rightBitmap.close === "function")
      rightBitmap.close();
  }
}

async function exportCropResizeResize(file, options) {
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
    const maxEdge = Math.max(1, Math.floor(Number(options.maxEdge) || 2048));
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const outputWidth = Math.max(1, Math.round(bitmap.width * scale));
    const outputHeight = Math.max(1, Math.round(bitmap.height * scale));
    assertCanvasLimits(outputWidth, outputHeight);

    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Cannot create resize canvas context.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, outputWidth, outputHeight);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const output = getCropResizeOutputInfo(file.name, "resize_2048");

    return {
      fileName: output.fileName,
      mimeType: output.mimeType,
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

async function exportCropResizeCrop(file, options) {
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
    const crop = normalizeCropRect(options.cropRect, bitmap);
    assertCanvasLimits(crop.width, crop.height);

    const canvas = new OffscreenCanvas(crop.width, crop.height);
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Cannot create crop canvas context.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      bitmap,
      crop.left,
      crop.top,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const zoomLabel = String(options.zoomLabel || "10x").replace(
      /[^0-9a-zA-Z_-]+/g,
      "",
    );
    const aspectLabel = String(options.aspectLabel || "4x5").replace(
      /[^0-9a-zA-Z_-]+/g,
      "",
    );
    const output = getCropResizeOutputInfo(
      file.name,
      `crop_${zoomLabel}_${aspectLabel}`,
    );

    return {
      fileName: output.fileName,
      mimeType: output.mimeType,
      arrayBuffer: await blob.arrayBuffer(),
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (
    !message ||
    (message.type !== "PROCESS" &&
      message.type !== "PREVIEW" &&
      message.type !== "SCRL_PROCESS" &&
      message.type !== "GRID_PROCESS" &&
      message.type !== "CROP_RESIZE_PREVIEW" &&
      message.type !== "CROP_RESIZE_EXPORT_RESIZE" &&
      message.type !== "CROP_RESIZE_EXPORT_CROP" &&
      message.type !== "COMPARISON_HISTOGRAM" &&
      message.type !== "COMPARISON_EXPORT")
  )
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

    if (message.type === "SCRL_PROCESS") {
      const frames = await processScrl(file, options || {});
      const transferables = frames.map((f) => f.arrayBuffer);
      self.postMessage(
        {
          type: "DONE",
          id,
          frames,
        },
        transferables,
      );
      return;
    }

    if (message.type === "GRID_PROCESS") {
      const result = await processGrid(message.files, options || {});
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

    if (message.type === "CROP_RESIZE_PREVIEW") {
      const result = await buildCropResizePreview(file, options || {});
      self.postMessage(
        {
          type: "DONE",
          id,
          width: result.width,
          height: result.height,
          previewWidth: result.previewWidth,
          previewHeight: result.previewHeight,
          estimatedRawBytes: result.estimatedRawBytes,
          mimeType: result.mimeType,
          arrayBuffer: result.arrayBuffer,
        },
        [result.arrayBuffer],
      );
      return;
    }

    if (message.type === "CROP_RESIZE_EXPORT_RESIZE") {
      const result = await exportCropResizeResize(file, options || {});
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

    if (message.type === "CROP_RESIZE_EXPORT_CROP") {
      const result = await exportCropResizeCrop(file, options || {});
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

    if (message.type === "COMPARISON_EXPORT") {
      const result = await exportComparison(options || {});
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

    if (message.type === "COMPARISON_HISTOGRAM") {
      const result = await buildComparisonHistogram(options || {});
      self.postMessage({
        type: "DONE",
        id,
        leftBins: result.leftBins,
        rightBins: result.rightBins,
        globalBlack: result.globalBlack,
        globalWhite: result.globalWhite,
      });
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
