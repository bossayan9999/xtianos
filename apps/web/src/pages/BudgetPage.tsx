import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'

// ── Types (mirror the backend budget routes) ────────────────────────────────

interface Account {
  id: number
  name: string
  type: string
  currency: string
  balanceCents: number
  isClosed: boolean
}

interface Category {
  id: number
  name: string
  type: string
  budgetCents: number
  color: string | null
}

interface Transaction {
  id: number
  accountId: number
  categoryId: number | null
  amountCents: number
  date: string
  description: string
  payee: string | null
  account?: { name: string; currency: string }
  category?: Category | null
}

interface Spending {
  id: number
  name: string
  color: string | null
  budgetedCents: number
  spentCents: number
  txns: number
  remainingCents: number
}

interface Dashboard {
  month: number
  year: number
  baseCurrency: string
  currencies: Record<string, number>
  totalBalanceCents: number
  incomeCents: number
  expenseCents: number
  netCents: number
  accounts: Account[]
  categories: Category[]
  spendingByCategory: Spending[]
  recentTxns: (Transaction & { accountName: string; accountCurrency: string; categoryName: string | null })[]
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CURRENCIES = ['PHP', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR', 'SGD', 'AED']

const currencyLocale = (code: string): string =>
  code === 'PHP' ? 'en-PH' : code === 'JPY' ? 'ja-JP' : 'en-US'

const money = (cents: number, currency = 'PHP'): string =>
  (cents / 100).toLocaleString(currencyLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })

const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type Tab = 'overview' | 'accounts' | 'transactions' | 'categories' | 'settings'

interface Settings {
  baseCurrency: string
  rates: Record<string, number>
}

// ── Component ───────────────────────────────────────────────────────────────

export function BudgetPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [month, setMonth] = useState<number>(new Date().getMonth() + 1)
  const [year, setYear] = useState<number>(new Date().getFullYear())

  const [dash, setDash] = useState<Dashboard | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [txns, setTxns] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [d, t, s] = await Promise.all([
        api.get<Dashboard>(`/api/budget/dashboard?month=${month}&year=${year}`),
        api.get<Transaction[]>(`/api/budget/transactions?month=${month}&year=${year}`),
        api.get<Settings>(`/api/budget/settings`),
      ])
      setDash(d)
      setTxns(t)
      setSettings(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load budget')
    } finally {
      setLoading(false)
    }
  }, [month, year])

  useEffect(() => {
    load()
  }, [load])

  const yearOptions: number[] = []
  for (let y = new Date().getFullYear(); y >= 2020; y--) yearOptions.push(y)

  return (
    <div className="page">
      <div className="budget-head">
        <div>
          <h2 style={{ margin: 0 }}>Money · Budget</h2>
          <span className="hint">
            base currency: <b>{settings?.baseCurrency ?? 'PHP'}</b>
          </span>
        </div>
        <div className="budget-month-picker">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {new Date(0, m - 1).toLocaleString('en-US', { month: 'long' })}
              </option>
            ))}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      <nav className="budget-tabs">
        {(['overview', 'accounts', 'transactions', 'categories', 'settings'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'overview'
              ? '📊 Overview'
              : t === 'accounts'
                ? '🏦 Accounts'
                : t === 'transactions'
                  ? '🧾 Transactions'
                  : t === 'categories'
                    ? '🏷️ Categories'
                    : '⚙️ Currency'}
          </button>
        ))}
      </nav>

      {error && <p className="hint" style={{ color: 'var(--red)' }}>{error}</p>}
      {loading && <p className="hint">loading…</p>}
      {!loading && dash && (
        <>
          {tab === 'overview' && <Overview dash={dash} onJump={setTab} />}
          {tab === 'accounts' && (
            <Accounts accounts={dash.accounts} onChange={load} baseCurrency={dash.baseCurrency} />
          )}
          {tab === 'transactions' && (
            <Transactions
              txns={txns}
              accounts={dash.accounts}
              categories={dash.categories}
              baseCurrency={dash.baseCurrency}
              onChange={load}
            />
          )}
          {tab === 'categories' && (
            <Categories
              categories={dash.categories}
              onChange={load}
              baseCurrency={dash.baseCurrency}
            />
          )}
          {tab === 'settings' && settings && (
            <SettingsPanel
              settings={settings}
              onSaved={(s) => {
                setSettings(s)
                load()
              }}
            />
          )}
        </>
      )}
    </div>
  )
}

// ── Overview ────────────────────────────────────────────────────────────────

function Overview({ dash, onJump }: { dash: Dashboard; onJump: (t: Tab) => void }) {
  const base = dash.baseCurrency
  const pct = (spent: number, budgeted: number) =>
    budgeted > 0 ? Math.min(100, Math.round((spent / budgeted) * 100)) : 0

  return (
    <div>
      <div className="budget-summary">
        <div className="budget-stat">
          <span className="budget-stat-label">Total balance ({base})</span>
          <span className="budget-stat-value">{money(dash.totalBalanceCents, base)}</span>
        </div>
        <div className="budget-stat">
          <span className="budget-stat-label">Income · {dash.month}/{dash.year} ({base})</span>
          <span className="budget-stat-value pos">+{money(dash.incomeCents, base)}</span>
        </div>
        <div className="budget-stat">
          <span className="budget-stat-label">Spent · {dash.month}/{dash.year} ({base})</span>
          <span className="budget-stat-value neg">−{money(dash.expenseCents, base)}</span>
        </div>
        <div className="budget-stat">
          <span className="budget-stat-label">Net · {dash.month}/{dash.year} ({base})</span>
          <span className={`budget-stat-value ${dash.netCents >= 0 ? 'pos' : 'neg'}`}>
            {dash.netCents >= 0 ? '+' : '−'}{money(Math.abs(dash.netCents), base)}
          </span>
        </div>
      </div>

      <div className="budget-cols">
        <div className="panel">
          <h2>Spending by category ({base})</h2>
          {dash.spendingByCategory.filter((s) => s.budgetedCents > 0 || s.spentCents > 0).length === 0 && (
            <p className="hint">No categories with budget or spending this month yet.</p>
          )}
          {dash.spendingByCategory
            .filter((s) => s.budgetedCents > 0 || s.spentCents > 0)
            .map((s) => {
              const over = s.remainingCents < 0
              return (
                <div key={s.id} className="budget-bar-row">
                  <div className="budget-bar-head">
                    <span
                      className="budget-dot"
                      style={{ background: s.color ?? 'var(--accent)' }}
                    />
                    <span>{s.name}</span>
                    <span className="hint">
                      {money(s.spentCents, base)} / {money(s.budgetedCents, base)}
                    </span>
                    <span className={`hint ${over ? 'neg' : 'pos'}`}>
                      {over ? 'over ' : ''}{money(Math.abs(s.remainingCents), base)}
                    </span>
                  </div>
                  <div className="budget-bar">
                    <div
                      className={`budget-bar-fill ${over ? 'over' : ''}`}
                      style={{ width: `${pct(s.spentCents, s.budgetedCents)}%` }}
                    />
                  </div>
                </div>
              )
            })}
        </div>

        <div className="panel">
          <h2>Recent transactions</h2>
          <button onClick={() => onJump('transactions')} className="budget-link">
            Manage transactions →
          </button>
          {dash.recentTxns.length === 0 && <p className="hint">No transactions yet.</p>}
          {dash.recentTxns.slice(0, 12).map((t) => (
            <div key={t.id} className="budget-txn-row">
              <span className={`budget-txn-amt ${t.amountCents >= 0 ? 'pos' : 'neg'}`}>
                {t.amountCents >= 0 ? '+' : '−'}{money(Math.abs(t.amountCents), t.accountCurrency)}
              </span>
              <span className="budget-txn-main">
                <span>{t.description}</span>
                <span className="hint">
                  {t.accountName}
                  {t.accountCurrency !== base ? ` (${t.accountCurrency})` : ''}
                  {t.categoryName ? ` · ${t.categoryName}` : ''}
                </span>
              </span>
              <span className="hint">{fmtDate(t.date)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Accounts ────────────────────────────────────────────────────────────────

function Accounts({
  accounts,
  onChange,
  baseCurrency,
}: {
  accounts: Account[]
  onChange: () => void
  baseCurrency: string
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState('checking')
  const [currency, setCurrency] = useState(baseCurrency)
  const [balance, setBalance] = useState('')
  const [busy, setBusy] = useState(false)

  const accountTypes = ['checking', 'savings', 'credit', 'cash', 'investment', 'other']

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await api.post('/api/budget/accounts', {
        name,
        type,
        currency,
        balanceCents: parseFloat(balance || '0') || 0,
      })
      setName('')
      setBalance('')
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const toggleClosed = async (a: Account) => {
    await api.patch(`/api/budget/accounts/${a.id}`, { isClosed: !a.isClosed })
    onChange()
  }

  const remove = async (a: Account) => {
    await api.del(`/api/budget/accounts/${a.id}`)
    onChange()
  }

  return (
    <div className="budget-cols">
      <div className="panel">
        <h2>Add account</h2>
        <div className="budget-form">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {accountTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input
            placeholder={`Starting balance (${currency})`}
            value={balance}
            type="number"
            step="0.01"
            onChange={(e) => setBalance(e.target.value)}
          />
          <button onClick={create} disabled={busy || !name.trim()}>
            Add
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          The main currency is <b>{baseCurrency}</b>. Accounts can hold other currencies — the
          dashboard converts them using the rates in the ⚙️ Currency tab.
        </p>
      </div>

      <div className="panel">
        <h2>Accounts</h2>
        {accounts.length === 0 && <p className="hint">No accounts yet — add one on the left.</p>}
        {accounts.map((a) => (
          <div key={a.id} className={`budget-txn-row ${a.isClosed ? 'closed' : ''}`}>
            <span className="budget-txn-main">
              <span>
                {a.name}
                <span className="hint"> · {a.type} · {a.currency}</span>
                {a.isClosed && <span className="hint"> · closed</span>}
              </span>
            </span>
            <span className="budget-txn-amt">{money(a.balanceCents, a.currency)}</span>
            <button onClick={() => toggleClosed(a)} className="budget-link">
              {a.isClosed ? 'Reopen' : 'Close'}
            </button>
            <button onClick={() => remove(a)} className="budget-link danger">
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Transactions ────────────────────────────────────────────────────────────

function Transactions({
  txns,
  accounts,
  categories,
  baseCurrency,
  onChange,
}: {
  txns: Transaction[]
  accounts: Account[]
  categories: Category[]
  baseCurrency: string
  onChange: () => void
}) {
  const [description, setDescription] = useState('')
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState<number>(accounts[0]?.id ?? 0)
  const [categoryId, setCategoryId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!accountId || !amount) return
    setBusy(true)
    try {
      await api.post('/api/budget/transactions', {
        accountId,
        categoryId: categoryId ? Number(categoryId) : null,
        amountCents: parseFloat(amount) || 0,
        description: description || 'Untitled',
        payee: payee || null,
      })
      setDescription('')
      setPayee('')
      setAmount('')
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (t: Transaction) => {
    await api.del(`/api/budget/transactions/${t.id}`)
    onChange()
  }

  const selectedAcc = accounts.find((a) => a.id === accountId)

  return (
    <div className="budget-cols">
      <div className="panel">
        <h2>Add transaction</h2>
        <div className="budget-form">
          <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <input placeholder="Payee" value={payee} onChange={(e) => setPayee(e.target.value)} />
          <input
            placeholder={`Amount (+, − ${selectedAcc?.currency ?? baseCurrency})`}
            value={amount}
            type="number"
            step="0.01"
            onChange={(e) => setAmount(e.target.value)}
          />
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
            ))}
          </select>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">(no category)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button onClick={create} disabled={busy || !accountId || !amount}>
            Add
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Use a negative amount for spending, positive for income.
        </p>
      </div>

      <div className="panel">
        <h2>Transactions this month</h2>
        {txns.length === 0 && <p className="hint">No transactions this month.</p>}
        {txns
          .slice()
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .map((t) => (
            <div key={t.id} className="budget-txn-row">
              <span className={`budget-txn-amt ${t.amountCents >= 0 ? 'pos' : 'neg'}`}>
                {t.amountCents >= 0 ? '+' : '−'}{money(Math.abs(t.amountCents), t.account?.currency ?? baseCurrency)}
              </span>
              <span className="budget-txn-main">
                <span>{t.description}</span>
                <span className="hint">
                  {t.account?.name ?? '?'}
                  {t.account?.currency && t.account.currency !== baseCurrency ? ` (${t.account.currency})` : ''}
                  {t.category?.name ? ` · ${t.category.name}` : ''}
                  {t.payee ? ` · ${t.payee}` : ''}
                </span>
              </span>
              <span className="hint">{fmtDate(t.date)}</span>
              <button onClick={() => remove(t)} className="budget-link danger">✕</button>
            </div>
          ))}
      </div>
    </div>
  )
}

// ── Categories ──────────────────────────────────────────────────────────────

function Categories({
  categories,
  onChange,
  baseCurrency,
}: {
  categories: Category[]
  onChange: () => void
  baseCurrency: string
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState('expense')
  const [budget, setBudget] = useState('')
  const [color, setColor] = useState('#57d9a3')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await api.post('/api/budget/categories', {
        name,
        type,
        budgetCents: parseFloat(budget || '0') || 0,
        color: color || null,
      })
      setName('')
      setBudget('')
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (c: Category) => {
    await api.del(`/api/budget/categories/${c.id}`)
    onChange()
  }

  return (
    <div className="budget-cols">
      <div className="panel">
        <h2>Add category</h2>
        <div className="budget-form">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="expense">expense</option>
            <option value="income">income</option>
          </select>
          <input
            placeholder={`Monthly budget (${baseCurrency})`}
            value={budget}
            type="number"
            step="0.01"
            onChange={(e) => setBudget(e.target.value)}
          />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Color" />
          <button onClick={create} disabled={busy || !name.trim()}>
            Add
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Categories</h2>
        {categories.length === 0 && <p className="hint">No categories yet.</p>}
        {categories.map((c) => (
          <div key={c.id} className="budget-txn-row">
            <span className="budget-txn-main">
              <span className="budget-dot" style={{ background: c.color ?? 'var(--accent)' }} />
              <span>{c.name}</span>
              <span className="hint"> · {c.type}</span>
            </span>
            <span className="budget-txn-amt">{money(c.budgetCents, baseCurrency)}/mo</span>
            <button onClick={() => remove(c)} className="budget-link danger">Delete</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Currency settings ───────────────────────────────────────────────────────

function SettingsPanel({
  settings,
  onSaved,
}: {
  settings: Settings
  onSaved: (s: Settings) => void
}) {
  const [base, setBase] = useState(settings.baseCurrency)
  const [rates, setRates] = useState<Record<string, string>>(() => {
    const r: Record<string, string> = {}
    for (const c of CURRENCIES) {
      if (c === settings.baseCurrency) continue
      r[c] = settings.rates[c] != null ? String(settings.rates[c]) : ''
    }
    return r
  })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const nextBase = base

  const save = async () => {
    setBusy(true)
    setSaved(false)
    try {
      const out: Record<string, number> = {}
      for (const [c, v] of Object.entries(rates)) {
        if (c === nextBase) continue
        const n = parseFloat(v || '')
        if (Number.isFinite(n) && n > 0) out[c] = n
      }
      const res = await api.put<Settings>('/api/budget/settings', {
        baseCurrency: nextBase,
        rates: out,
      })
      onSaved(res)
      setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="budget-cols">
      <div className="panel">
        <h2>Main / base currency</h2>
        <div className="budget-form">
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          All Overview totals (balance, income, spent) are shown converted into this currency.
          The default is <b>PHP</b> (Philippine Peso).
        </p>
      </div>

      <div className="panel">
        <h2>Conversion rates → {base}</h2>
        <p className="hint" style={{ marginBottom: 10 }}>
          How many {base} units one unit of another currency is worth. Leave blank for 1:1.
        </p>
        <div className="budget-form">
          {CURRENCIES.filter((c) => c !== base).map((c) => (
            <label key={c} className="budget-rate-row">
              <span className="budget-rate-code">{c}</span>
              <input
                type="number"
                step="0.0001"
                min="0"
                value={rates[c] ?? ''}
                placeholder={`1 ${c} = ${base}`}
                onChange={(e) => setRates((r) => ({ ...r, [c]: e.target.value }))}
              />
            </label>
          ))}
          <button onClick={save} disabled={busy}>
            Save currency settings
          </button>
          {saved && <span className="hint pos">Saved ✓</span>}
        </div>
      </div>
    </div>
  )
}
