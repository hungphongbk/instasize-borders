import { quickConnectLogin } from "@/lib/synology-quickconnect";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json();
    const result = await quickConnectLogin({
      quickConnectId: body?.quickConnectId,
      username: body?.username,
      password: body?.password,
      otpCode: body?.otpCode,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          requiresOtp: Boolean(result.requiresOtp),
          otpInvalid: Boolean(result.otpInvalid),
          message: result.message,
          errorCode: result.errorCode || null,
          resolved: result.resolved || null,
        },
        { status: 401 },
      );
    }

    return NextResponse.json({
      ok: true,
      session: {
        type: "quickconnect",
        quickConnectId: result.resolved.quickConnectId,
        baseUrl: result.resolved.baseUrl,
        sid: result.sid,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error?.message || "QuickConnect login failed.",
      },
      { status: 400 },
    );
  }
}
