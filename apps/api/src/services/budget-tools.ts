import type { ToolDef } from "@xtiand/mjane-core";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";

// Shared budget summary logic (mirrors routes/budget.ts /dashboard but runs
// in-process via Prisma so mjane needs no JWT/HTTP round-trip).

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : Number.parseInt(String(v ?? ""), 10) || fallback;

const cents = (v: unknown): number => Math.round(num(v) * 100);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optStr = (v: unknown): string | null => {
  const s = str(v);
  return s === "" ? null : s;
};

const KNOWN_CURRENCIES = new Set(["PHP", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "SGD", "AED"]);

async function getSetting(): Promise<{ baseCurrency: string; rates: Record<string, number> }> {
  let s = await prisma.budgetSetting.findUnique({ where: { id: 1 } });
  if (!s) {
    s = await prisma.budgetSetting.create({ data: { id: 1, baseCurrency: "PHP", rates: {} } });
  }
  let rates: Record<string, number> = {};
  if (s.rates && typeof s.rates === "object" && !Array.isArray(s.rates)) {
    rates = s.rates as Record<string, number>;
  }
  return { baseCurrency: s.baseCurrency || "PHP", rates };
}

// How many BASE units 1 unit of `currency` buys. Missing/unset rate => 1:1.
const makeRate = (base: string, rates: Record<string, number>) => (c: string): number => {
  if (!c || c === base) return 1;
  const r = rates[c];
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 1;
};

async function summaryPayload(month?: number, year?: number) {
  const m = month || new Date().getMonth() + 1;
  const y = year || new Date().getFullYear();
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);

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

  const toBase = (amountCents: number, currency: string): number =>
    Math.round(amountCents * rate(currency));

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
  for (const c of categories) byCategory.set(c.id, { budgeted: c.budgetCents, spent: 0, txns: 0 });
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
      remainingCents: e.budgeted - e.spent,
      txns: e.txns,
    };
  });

  const recentTxns = allTxns
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 20)
    .map((t) => ({
      id: t.id,
      accountName: t.account.name,
      accountCurrency: t.account.currency,
      categoryName: t.category?.name ?? null,
      amountCents: t.amountCents,
      date: t.date.toISOString(),
      description: t.description,
      payee: t.payee,
    }));

  const currencies = { ...setting.rates };
  currencies[baseCurrency] = 1;

  return {
    month: m,
    year: y,
    baseCurrency,
    currencies,
    totalBalanceCents,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balanceCents: a.balanceCents,
      isClosed: a.isClosed,
    })),
    spendingByCategory,
    recentTxns,
  };
}

/** Tools that let mjane read and manage the xtiandOS Budget system (same DB the Budget web page uses). */
export function budgetTools(): ToolDef[] {
  return [
    {
      name: "budget_dashboard",
      description:
        "Get a budget summary for a month: total balance, income/expense, per-category budget vs spent, and recent transactions. Use for 'how much money do I have', 'what did I spend this month', or 'am I over budget'. Optionally pass month (1-12) and year.",
      scopes: ["read"],
      params: [
        { name: "month", type: "number", description: "1-12, defaults to current month", required: false },
        { name: "year", type: "number", description: "4-digit year, defaults to current year", required: false },
      ],
      run: async (args: Record<string, unknown>) => {
        const month = num(args["month"]);
        const year = num(args["year"]);
        const payload = await summaryPayload(month || undefined, year || undefined);
        return JSON.stringify(payload, null, 2);
      },
    },
    {
      name: "budget_transactions",
      description:
        "List budized transactions, newest first. Optionally filter to a month (month 1-12 + year) — omit month/year for all transactions.",
      scopes: ["read"],
      params: [
        { name: "month", type: "number", description: "1-12 to filter by month", required: false },
        { name: "year", type: "number", description: "4-digit year to filter by month", required: false },
      ],
      run: async (args: Record<string, unknown>) => {
        const where: Record<string, unknown> = {};
        const month = num(args["month"]);
        const year = num(args["year"]);
        if (month && year) {
          const start = new Date(year, month - 1, 1);
          const end = new Date(year, month, 1);
          where["date"] = { gte: start, lt: end };
        }
        const rows = await prisma.budgetTransaction.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          include: { account: true, category: true },
        });
        return JSON.stringify(
          rows.slice(0, 200).map((t) => ({
            id: t.id,
            accountName: t.account.name,
            accountCurrency: t.account.currency,
            categoryName: t.category?.name ?? null,
            amountCents: t.amountCents,
            date: t.date.toISOString().slice(0, 10),
            description: t.description,
            payee: t.payee,
          })),
          null,
          2,
        );
      },
    },
    {
      name: "budget_accounts",
      description:
        "List all budget accounts with their current balance and currency. Use for 'how much is in my checking', or to find an account id before logging a transaction.",
      scopes: ["read"],
      params: [],
      run: async () => {
        const rows = await prisma.budgetAccount.findMany({ orderBy: [{ isClosed: "asc" }, { id: "asc" }] });
        return JSON.stringify(
          rows.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            currency: a.currency,
            balanceCents: a.balanceCents,
            isClosed: a.isClosed,
          })),
          null,
          2,
        );
      },
    },
    {
      name: "budget_add_transaction",
      description:
        "Log a new budget transaction. amountCents is in the account's currency and is signed: positive = income, negative = expense. Provide an existing accountId (use budget_accounts) and optional categoryId (use budget_dashboard or the categories list). Audited and requires prior human approval.",
      scopes: ["exec"],
      params: [
        { name: "accountId", type: "number", description: "existing account id", required: true },
        { name: "amountCents", type: "number", description: "signed amount in cents; negative is an expense", required: true },
        { name: "description", type: "string", description: "what the transaction was for", required: true },
        { name: "categoryId", type: "number", description: "optional category id", required: false },
        { name: "payee", type: "string", description: "optional payee", required: false },
        { name: "date", type: "string", description: "optional ISO date (defaults to today)", required: false },
      ],
      run: async (args: Record<string, unknown>, ctx: import("@xtiand/mjane-core").ToolContext) => {
        const accountId = num(args["accountId"]);
        if (!accountId) return "ERROR accountId required";
        const account = await prisma.budgetAccount.findUnique({ where: { id: accountId } });
        if (!account) return `ERROR no account with id ${accountId}`;

        await audit(
          "tool:budget_add_transaction",
          JSON.stringify({ accountId, amountCents: cents(args["amountCents"]), description: str(args["description"]) }).slice(0, 1500),
        );

        const transaction = await prisma.budgetTransaction.create({
          data: {
            accountId,
            categoryId: args["categoryId"] ? num(args["categoryId"]) : null,
            amountCents: cents(args["amountCents"]),
            description: str(args["description"]) || "Untitled",
            payee: optStr(args["payee"]),
            date: args["date"] ? new Date(String(args["date"])) : new Date(),
          },
          include: { account: true, category: true },
        });
        ctx.emit({ type: "status", data: `logged ${transaction.description}` });
        return JSON.stringify(
          {
            id: transaction.id,
            accountName: transaction.account.name,
            categoryName: transaction.category?.name ?? null,
            amountCents: transaction.amountCents,
            date: transaction.date.toISOString().slice(0, 10),
            description: transaction.description,
          },
          null,
          2,
        );
      },
    },
  ];
}
