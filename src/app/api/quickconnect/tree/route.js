import { quickConnectListFolders } from "@/lib/synology-quickconnect";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json();
    const session = body?.session || {};
    const data = await quickConnectListFolders({
      baseUrl: session.baseUrl,
      sid: session.sid,
      path: body?.path || "/",
    });

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error?.message || "Cannot load folder tree via QuickConnect.",
      },
      { status: 400 },
    );
  }
}
