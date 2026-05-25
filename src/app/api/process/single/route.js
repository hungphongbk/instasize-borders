import { NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs"; // ensure Node (not Edge) for sharp

export async function POST(req) {
  const formData = await req.formData();
  const file = formData.get("file");
  const options = JSON.parse(formData.get("options") || "{}");
  if (!file) {
    return new NextResponse("No file uploaded", { status: 400 });
  }
  const arrayBuffer = await file.arrayBuffer();
  const inputBuffer = Buffer.from(arrayBuffer);
  const { ratio = "1:1", borderColor = "#ffffff", extraPx = 0 } = options;

  let width, height;
  try {
    const meta = await sharp(inputBuffer).metadata();
    width = meta.width;
    height = meta.height;
  } catch (e) {
    return new NextResponse("Invalid image", { status: 400 });
  }

  let targetW = width,
    targetH = height;
  if (ratio === "1:1") {
    const maxSide = Math.max(width, height);
    targetW = targetH = maxSide;
  } else if (ratio === "16:9") {
    if (width / height > 16 / 9) {
      targetW = width;
      targetH = Math.round((width * 9) / 16);
    } else {
      targetH = height;
      targetW = Math.round((height * 16) / 9);
    }
  }
  targetW += Number(extraPx) * 2;
  targetH += Number(extraPx) * 2;

  let bordered;
  try {
    bordered = await sharp(inputBuffer)
      .extend({
        top: Math.floor((targetH - height) / 2),
        bottom: Math.ceil((targetH - height) / 2),
        left: Math.floor((targetW - width) / 2),
        right: Math.ceil((targetW - width) / 2),
        background: borderColor,
      })
      .toFormat("jpeg")
      .toBuffer();
  } catch (e) {
    return new NextResponse("Failed to process image", { status: 500 });
  }

  return new NextResponse(bordered, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename=bordered_${
        file.name || "image"
      }.jpg`,
    },
  });
}
