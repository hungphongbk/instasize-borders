import { quickConnectDiagnostics } from "@/lib/synology-quickconnect";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json();
    const data = await quickConnectDiagnostics({
      quickConnectId: body?.quickConnectId,
      username: body?.username,
      password: body?.password,
      otpCode: body?.otpCode,
    });

    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error?.message || "QuickConnect diagnostics failed.",
      },
      { status: 400 },
    );
  }
}
