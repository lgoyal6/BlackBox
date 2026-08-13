import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Returns a 401 `Response` when the shared secret is missing, empty, or wrong, and `null` when
 * it matches so the caller proceeds.
 *
 * Call this **before** reading the body. A 401 must not depend on a valid JSON payload.
 */
export function requireSecret(req: Request): Response | null {
  const expected = env.toolSharedSecret;
  const provided = req.headers.get("x-blackbox-secret") ?? "";
  if (!expected || !safeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Length-safe comparison — `timingSafeEqual` throws outright on differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
