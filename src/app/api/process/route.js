import JSZip from "jszip";
import sharp from "sharp";

export const runtime = "nodejs"; // ensure Node (not Edge) for sharp

function hexToRgb(hex) {
  let h = String(hex || "#ffffff").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export async function POST(req) {
  try {
    const form = await req.formData();
    const files = form.getAll("files");
    const optionsRaw = form.get("options");
    if (!files?.length || !optionsRaw) {
      return new Response("Missing files or options.", { status: 400 });
    }

    const options = JSON.parse(String(optionsRaw));
    if (options.length !== files.length) {
      return new Response("Options length mismatch.", { status: 400 });
    }

    const zip = new JSZip();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const opt = options[i];

      const arr = new Uint8Array(await file.arrayBuffer());
      const img = sharp(arr, { failOnError: false });
      const meta = await img.metadata();

      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width === 0 || height === 0) continue;

      const targetRatio = opt.ratio === "1:1" ? 1 : 16 / 9;

      // Minimal canvas with target ratio, each side >= original (InstaSize fit/no-crop)
      let canvasW = Math.max(width, Math.ceil(height * targetRatio));
      let canvasH = Math.max(height, Math.ceil(width / targetRatio));
      if (Math.abs(canvasW / canvasH - targetRatio) > 1e-6) {
        if (canvasW / canvasH > targetRatio) canvasH = Math.ceil(canvasW / targetRatio);
        else canvasW = Math.ceil(canvasH * targetRatio);
      }

      const extra = Math.max(0, Math.floor(opt.extraPx || 0));
      canvasW += extra * 2;
      canvasH += extra * 2;

      const bg = hexToRgb(opt.borderColor);

      let canvas = sharp({
        create: {
          width: canvasW,
          height: canvasH,
          channels: 4,
          background: { ...bg, alpha: 1 }
        }
      });

      const left = Math.floor((canvasW - width) / 2);
      const top = Math.floor((canvasH - height) / 2);

      const overlay = await img.ensureAlpha().toBuffer();
      canvas = canvas.composite([{ input: overlay, left, top }]);

      // Output format based on input
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const base = file.name.replace(/\.[^/.]+$/, "");
      const suffix = opt.ratio === "1:1" ? "1x1" : "16x9";

      switch (ext) {
        case "jpg":
        case "jpeg": {
          const out = await canvas.jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
          zip.file(`${base}_border_${suffix}.jpg`, out);
          break;
        }
        case "webp": {
          const out = await canvas.webp({ lossless: true }).toBuffer();
          zip.file(`${base}_border_${suffix}.webp`, out);
          break;
        }
        case "png": {
          const out = await canvas.png({ compressionLevel: 0 }).toBuffer();
          zip.file(`${base}_border_${suffix}.png`, out);
          break;
        }
        default: {
          const out = await canvas.png({ compressionLevel: 0 }).toBuffer();
          zip.file(`${base}_border_${suffix}.png`, out);
          break;
        }
      }
    }

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
    return new Response(zipBuf, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="bordered_images.zip"`
      }
    });
  } catch (err) {
    console.error(err);
    return new Response(err?.message || "Server error", { status: 500 });
  }
}
