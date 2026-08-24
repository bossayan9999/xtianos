import type { NextFunction, Request, Response } from "express";

import { prisma } from "./db";
import { env } from "./env";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (env.authToken === "" || req.path === "/health") {
    next();
    return;
  }
  const token = req.header("X-Auth-Token");
  if (token !== env.authToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export async function audit(action: string, detail: string): Promise<void> {
  await prisma.auditLog.create({ data: { action, detail: detail.slice(0, 2000) } }).catch(() => undefined);
}
