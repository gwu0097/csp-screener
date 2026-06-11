import { NextResponse } from "next/server";
import { authErrorResponse, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Identity for the client shell (sidebar chip, role-aware banners).
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ user });
  } catch (e) {
    return authErrorResponse(e);
  }
}
