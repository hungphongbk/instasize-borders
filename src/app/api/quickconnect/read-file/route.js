import { quickConnectReadFileStream } from "@/lib/synology-quickconnect";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json();
    const session = body?.session || {};

    const result = await quickConnectReadFileStream({
      baseUrl: session.baseUrl,
      sid: session.sid,
      path: body?.path || "/",
    });

    if (!result.body) {
      throw new Error("Cannot stream NAS file.");
    }

    const headers = {
      "Content-Type": result.contentType,
      "Content-Disposition": `inline; filename="${result.fileName}"`,
      "Cache-Control": "no-store",
    };

    if (result.contentLength) {
      headers["Content-Length"] = result.contentLength;
    }

    return new NextResponse(result.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error?.message || "Cannot read NAS file via QuickConnect.",
      },
      { status: 400 },
    );
  }
}
