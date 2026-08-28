import type { NextFunction, Request, Response } from "express";

/**
 * Minimal in-memory sliding-window rate limiter per IP.
 * Good enough for a single-node local API; no external deps.
 */
export function rateLimit(
  windowMs = 60_000,
  max = 30,
  scope = "default",
): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, number[]>();
  return (req, res, next): void => {
    const key = `${scope}:${req.ip ?? "?"}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}