import { quickConnectMirrorCreate } from "@/lib/synology-quickconnect";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json();
    const session = body?.session || {};

    const data = await quickConnectMirrorCreate({
      baseUrl: session.baseUrl,
      sid: session.sid,
      leftRoot: body?.leftRoot,
      rightRoot: body?.rightRoot,
      parentRelative: body?.parentRelative,
      folderName: body?.folderName,
    });

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error?.message || "Mirror create via QuickConnect failed.",
      },
      { status: 400 },
    );
  }
}
