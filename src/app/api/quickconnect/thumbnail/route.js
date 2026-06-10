import { quickConnectReadThumbnail } from "@/lib/synology-quickconnect";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json();
    const session = body?.session || {};

    const result = await quickConnectReadThumbnail({
      baseUrl: session.baseUrl,
      sid: session.sid,
      path: body?.path || "/",
      size: body?.size || "small",
    });

    return new NextResponse(Buffer.from(result.arrayBuffer), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `inline; filename="${result.fileName}"`,
        "Cache-Control": "public, max-age=60",
        "X-Nas-Thumbnail-Source": result.source,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error?.message || "Cannot read NAS thumbnail.",
      },
      { status: 400 },
    );
  }
}
