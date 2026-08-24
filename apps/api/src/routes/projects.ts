import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { TASK_STATUSES, type TaskStatus } from "@xtiand/shared";

export const projectsRouter = Router();
export const tasksRouter = Router();

projectsRouter.get("/", async (_req, res): Promise<void> => {
  const rows = await prisma.project.findMany({
    orderBy: { id: "desc" },
    include: { tasks: { orderBy: { position: "asc" } } },
  });
  res.json(rows);
});

projectsRouter.post("/", async (req, res): Promise<void> => {
  const name = typeof req.body?.["name"] === "string" ? req.body["name"].trim() : "";
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const project = await prisma.project.create({
    data: {
      name,
      goal: typeof req.body?.["goal"] === "string" ? req.body["goal"] : null,
    },
  });
  res.json(project);
});

projectsRouter.delete("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.project.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

tasksRouter.get("/", async (req, res): Promise<void> => {
  const projectId = req.query["projectId"];
  const where =
    typeof projectId === "string" && !Number.isNaN(Number.parseInt(projectId, 10))
      ? { projectId: Number.parseInt(projectId, 10) }
      : {};
  const rows = await prisma.task.findMany({ where, orderBy: [{ status: "asc" }, { position: "asc" }] });
  res.json(
    rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      status: TASK_STATUSES.includes(row.status as TaskStatus)
        ? (row.status as TaskStatus)
        : ("inbox" as TaskStatus),
    })),
  );
});

tasksRouter.post("/", async (req, res): Promise<void> => {
  const title = typeof req.body?.["title"] === "string" ? req.body["title"].trim() : "";
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  const projectIdRaw = req.body?.["projectId"];
  const projectId =
    typeof projectIdRaw === "number" && !Number.isNaN(projectIdRaw) ? projectIdRaw : null;
  const task = await prisma.task.create({
    data: { title, projectId, notes: typeof req.body?.["notes"] === "string" ? req.body["notes"] : null },
  });
  res.json(task);
});

tasksRouter.patch("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const data: Record<string, unknown> = {};
  if (
    typeof req.body?.["status"] === "string" &&
    TASK_STATUSES.includes(req.body["status"] as TaskStatus)
  ) {
    data["status"] = req.body["status"];
  }
  if (typeof req.body?.["title"] === "string") data["title"] = req.body["title"];
  if (typeof req.body?.["notes"] === "string") data["notes"] = req.body["notes"];
  if (typeof req.body?.["position"] === "number") data["position"] = req.body["position"];
  const task = await prisma.task.update({ where: { id }, data }).catch(() => null);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(task);
});

tasksRouter.delete("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.task.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});
