import { Router } from "express";

import { prisma } from "../lib/db";

export const budgetRouter = Router();

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : Number.parseInt(String(v ?? ""), 10) || fallback;

const cents = (v: unknown): number => Math.round(num(v) * 100);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optStr = (v: unknown): string | null => {
  const s = str(v);
  return s === "" ? null : s;
};

const KNOWN_CURRENCIES = new Set(["PHP", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "SGD", "AED"]);

// ── Settings (singleton) ───────────────────────────────────────────────────

const getSetting = async (): Promise<{ baseCurrency: string; rates: Record<string, number> }> => {
  let s = await prisma.budgetSetting.findUnique({ where: { id: 1 } });
  if (!s) {
    s = await prisma.budgetSetting.create({
      data: { id: 1, baseCurrency: "PHP", rates: {} },
    });
  }
  let rates: Record<string, number> = {};
  if (s.rates && typeof s.rates === "object" && !Array.isArray(s.rates)) {
    rates = s.rates as Record<string, number>;
  }
  return { baseCurrency: s.baseCurrency || "PHP", rates };
};

// How many BASE units 1 unit of `currency` buys. Missing/unset rate => treat as 1:1.
const makeRate = (base: string, rates: Record<string, number>) => (c: string): number => {
  if (!c || c === base) return 1;
  const r = rates[c];
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 1;
};

budgetRouter.get("/settings", async (_req, res): Promise<void> => {
  res.json(await getSetting());
});

budgetRouter.put("/settings", async (req, res): Promise<void> => {
  const base = str(req.body?.["baseCurrency"]) || "PHP";
  const rates: Record<string, number> = {};
  const raw = req.body?.["rates"];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === "number" && Number.isFinite(v) ? v : Number.parseFloat(String(v));
      if (Number.isFinite(n) && n > 0) rates[k] = n;
    }
  }
  const settings = await prisma.budgetSetting.upsert({
    where: { id: 1 },
    create: { id: 1, baseCurrency: base, rates },
    update: { baseCurrency: base, rates },
  });
  res.json({ baseCurrency: settings.baseCurrency, rates });
});

// ── Accounts ────────────────────────────────────────────────────────────────

budgetRouter.get("/accounts", async (_req, res): Promise<void> => {
  const rows = await prisma.budgetAccount.findMany({ orderBy: [{ isClosed: "asc" }, { id: "asc" }] });
  res.json(rows);
});

budgetRouter.post("/accounts", async (req, res): Promise<void> => {
  const name = str(req.body?.["name"]);
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  let currency = str(req.body?.["currency"]) || "PHP";
  if (!KNOWN_CURRENCIES.has(currency)) currency = "PHP";
  const account = await prisma.budgetAccount.create({
    data: {
      name,
      type: str(req.body?.["type"]) || "checking",
      currency,
      balanceCents: cents(req.body?.["balanceCents"]),
    },
  });
  res.json(account);
});

budgetRouter.patch("/accounts/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const data: Record<string, unknown> = {};
  if (req.body?.["name"] !== undefined) data["name"] = str(req.body["name"]);
  if (req.body?.["type"] !== undefined) data["type"] = str(req.body["type"]);
  if (req.body?.["currency"] !== undefined) {
    let currency = str(req.body["currency"]);
    if (!KNOWN_CURRENCIES.has(currency)) currency = "PHP";
    data["currency"] = currency;
  }
  if (req.body?.["balanceCents"] !== undefined) data["balanceCents"] = cents(req.body["balanceCents"]);
  if (req.body?.["isClosed"] !== undefined) data["isClosed"] = Boolean(req.body["isClosed"]);
  const account = await prisma.budgetAccount.update({ where: { id }, data });
  res.json(account);
});

budgetRouter.delete("/accounts/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.budgetAccount.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

// ── Categories ──────────────────────────────────────────────────────────────

budgetRouter.get("/categories", async (_req, res): Promise<void> => {
  const rows = await prisma.budgetCategory.findMany({ orderBy: [{ type: "asc" }, { id: "asc" }] });
  res.json(rows);
});

budgetRouter.post("/categories", async (req, res): Promise<void> => {
  const name = str(req.body?.["name"]);
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const category = await prisma.budgetCategory.create({
    data: {
      name,
      type: str(req.body?.["type"]) || "expense",
      budgetCents: cents(req.body?.["budgetCents"]),
      color: optStr(req.body?.["color"]),
    },
  });
  res.json(category);
});

budgetRouter.patch("/categories/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const data: Record<string, unknown> = {};
  if (req.body?.["name"] !== undefined) data["name"] = str(req.body["name"]);
  if (req.body?.["type"] !== undefined) data["type"] = str(req.body["type"]);
  if (req.body?.["budgetCents"] !== undefined) data["budgetCents"] = cents(req.body["budgetCents"]);
  if (req.body?.["color"] !== undefined) data["color"] = optStr(req.body["color"]);
  const category = await prisma.budgetCategory.update({ where: { id }, data });
  res.json(category);
});

budgetRouter.delete("/categories/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.budgetCategory.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

// ── Transactions ────────────────────────────────────────────────────────────

budgetRouter.get("/transactions", async (req, res): Promise<void> => {
  const month = str(req.query["month"]);
  const year = str(req.query["year"]);
  const where: Record<string, unknown> = {};
  if (month && /^\d{1,2}$/.test(month) && year && /^\d{4}$/.test(year)) {
    const m = Number.parseInt(month, 10);
    const y = Number.parseInt(year, 10);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 1);
    where["date"] = { gte: start, lt: end };
  }
  const rows = await prisma.budgetTransaction.findMany({
    where,
    orderBy: [{ date: "desc" }, { id: "desc" }],
    include: { account: true, category: true },
  });
  res.json(rows);
});

budgetRouter.post("/transactions", async (req, res): Promise<void> => {
  const accountId = num(req.body?.["accountId"]);
  if (!accountId) {
    res.status(400).json({ error: "accountId required" });
    return;
  }
  const transaction = await prisma.budgetTransaction.create({
    data: {
      accountId,
      categoryId: req.body?.["categoryId"] ? num(req.body["categoryId"]) : null,
      amountCents: cents(req.body?.["amountCents"]),
      description: str(req.body?.["description"]) || "Untitled",
      payee: optStr(req.body?.["payee"]),
      date: req.body?.["date"]
        ? new Date(String(req.body["date"]))
        : new Date(),
    },
    include: { account: true, category: true },
  });
  res.json(transaction);
});

budgetRouter.patch("/transactions/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const data: Record<string, unknown> = {};
  if (req.body?.["amountCents"] !== undefined) data["amountCents"] = cents(req.body["amountCents"]);
  if (req.body?.["description"] !== undefined) data["description"] = str(req.body["description"]);
  if (req.body?.["payee"] !== undefined) data["payee"] = optStr(req.body["payee"]);
  if (req.body?.["categoryId"] !== undefined)
    data["categoryId"] = req.body["categoryId"] ? num(req.body["categoryId"]) : null;
  if (req.body?.["date"] !== undefined) data["date"] = new Date(String(req.body["date"]));
  const transaction = await prisma.budgetTransaction.update({
    where: { id },
    data,
    include: { account: true, category: true },
  });
  res.json(transaction);
});

budgetRouter.delete("/transactions/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.budgetTransaction.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

// ── Dashboard / summary ─────────────────────────────────────────────────────

budgetRouter.get("/dashboard", async (req, res): Promise<void> => {
  const month = Number.parseInt(str(req.query["month"]), 10) || new Date().getMonth() + 1;
  const year = Number.parseInt(str(req.query["year"]), 10) || new Date().getFullYear();
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const setting = await getSetting();
  const baseCurrency = setting.baseCurrency;
  const rate = makeRate(setting.baseCurrency, setting.rates);

  const [accounts, categories, monthTxns, allTxns] = await Promise.all([
    prisma.budgetAccount.findMany({ orderBy: [{ isClosed: "asc" }, { id: "asc" }] }),
    prisma.budgetCategory.findMany({ orderBy: [{ type: "asc" }, { id: "asc" }] }),
    prisma.budgetTransaction.findMany({
      where: { date: { gte: start, lt: end } },
      include: { category: true, account: true },
    }),
    prisma.budgetTransaction.findMany({ include: { category: true, account: true } }),
  ]);

  // Convert an amount (in an account's own currency) into base-currency minor units.
  const toBase = (amountCents: number, currency: string): number =>
    Math.round(amountCents * rate(currency));

  // Total balance, converted to base currency.
  const totalBalanceCents = accounts
    .filter((a) => !a.isClosed)
    .reduce((s, a) => s + toBase(a.balanceCents, a.currency), 0);

  const incomeCents = monthTxns
    .filter((t) => t.amountCents > 0)
    .reduce((s, t) => s + toBase(t.amountCents, t.account.currency), 0);
  const expenseCents = monthTxns
    .filter((t) => t.amountCents < 0)
    .reduce((s, t) => s + Math.abs(toBase(t.amountCents, t.account.currency)), 0);

  const byCategory = new Map<number, { budgeted: number; spent: number; txns: number }>();
  for (const c of categories) {
    byCategory.set(c.id, { budgeted: c.budgetCents, spent: 0, txns: 0 });
  }
  for (const t of monthTxns) {
    if (t.categoryId == null || t.amountCents >= 0) continue;
    const e = byCategory.get(t.categoryId) ?? { budgeted: 0, spent: 0, txns: 0 };
    e.spent += Math.abs(toBase(t.amountCents, t.account.currency));
    e.txns += 1;
    byCategory.set(t.categoryId, e);
  }
  const spendingByCategory = categories.map((c) => {
    const e = byCategory.get(c.id) ?? { budgeted: 0, spent: 0, txns: 0 };
    return {
      id: c.id,
      name: c.name,
      color: c.color,
      budgetedCents: e.budgeted,
      spentCents: e.spent,
      txns: e.txns,
      remainingCents: e.budgeted - e.spent,
    };
  });

  // Running total across all time per "real" account (posts adjust balances bookkeeping-free).
  const recentTxns = allTxns
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 20)
    .map((t) => ({
      id: t.id,
      accountId: t.accountId,
      accountName: t.account.name,
      accountCurrency: t.account.currency,
      categoryId: t.categoryId,
      categoryName: t.category?.name ?? null,
      amountCents: t.amountCents,
      date: t.date.toISOString(),
      description: t.description,
      payee: t.payee,
    }));

  const currencies = { ...setting.rates };
  currencies[baseCurrency] = 1;

  res.json({
    month,
    year,
    baseCurrency,
    currencies,
    totalBalanceCents,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    accounts,
    categories,
    spendingByCategory,
    recentTxns,
  });
});
