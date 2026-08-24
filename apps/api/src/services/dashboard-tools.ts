import type { ToolDef } from "@xtiand/mjane-core";

const BASE = process.env["XTIANOS_DASHBOARD_API"] ?? "http://127.0.0.1:3001";

async function dashboardGet(pathname: string): Promise<string> {
  const res = await fetch(`${BASE}${pathname}`, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return `ERROR dashboard API ${pathname} -> ${res.status}`;
  return res.text();
}

/** Tools that let mjane see and manage the xtianOS homelab dashboard (port 3001). */
export function dashboardTools(): ToolDef[] {
  return [
    {
      name: "dashboard_hosts",
      description:
        "List all homelab hosts from the xtianOS dashboard with their status, IP, role and nested services (name/status/url). Use for questions like 'which hosts are down' or 'is proxmox healthy'.",
      scopes: ["read"],
      params: [],
      run: async () => {
        const raw = await dashboardGet("/api/hosts");
        if (raw.startsWith("ERROR")) return raw;
        try {
          const hosts = JSON.parse(raw) as Array<Record<string, unknown>>;
          const summary = hosts.map((h) => ({
            host: h.name,
            role: h.role,
            status: h.status,
            ip: h.ipAddress,
            services: (h.services as Array<Record<string, unknown>> | undefined)?.map((s) => ({
              name: s.name,
              status: s.status,
              url: s.url,
            })),
          }));
          return JSON.stringify(summary, null, 2);
        } catch {
          return raw.slice(0, 4000);
        }
      },
    },
    {
      name: "dashboard_alerts",
      description:
        "List alerts from the xtianOS dashboard. Pass activeOnly=true for unresolved alerts, or false to include resolved history.",
      scopes: ["read"],
      params: [
        {
          name: "activeOnly",
          type: "boolean",
          description: "only unresolved alerts when true",
          required: false,
        },
      ],
      run: async (args: Record<string, unknown>) => {
        const raw = await dashboardGet("/api/alerts");
        if (raw.startsWith("ERROR")) return raw;
        try {
          let alerts = JSON.parse(raw) as Array<Record<string, unknown>>;
          if (args["activeOnly"] === true) alerts = alerts.filter((a) => a.active === true);
          return JSON.stringify(
            alerts.map((a) => ({
              severity: a.severity,
              message: a.message,
              active: a.active,
              createdAt: a.createdAt,
            })),
            null,
            2,
          );
        } catch {
          return raw.slice(0, 4000);
        }
      },
    },
  ];
}
