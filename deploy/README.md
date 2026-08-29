# Deploying xtiandOS behind trusted HTTPS

The web app already reaches your phone over the LAN, but its self-signed cert
`basic-ssl` is not "trustworthy" in Chrome/Android, so **camera, microphone and
the PWA service worker are disabled on the phone**. Caddy fixes that by
terminating real TLS in front of one origin that serves both the built app and
the API — everything keeps working (auth, SSE chat streams, voice) with zero
app changes.

```
Phone ──https (trusted)──▶ Caddy (443) ──apps/web/dist (static)
                                        └─/api, /health ──▶ API :3101
```

## Prerequisites
- The repo is already installed and the API runs normally, e.g.
  `npm run dev -w apps/api` (or your usual start).
- **Caddy**:
  - Windows: `winget install Caddy.Caddy`, or drop `caddy.exe` from
    https://caddyserver.com/download on your PATH.
  - Linux: `sudo apt install caddy` (add the Caddy repo for the newest build).
- **A domain** pointing at this machine (A record → your public IP) with
  **TCP 80 and 443 forwarded** to the PC. Free DNS options: DuckDNS.
  (No domain? Use the Cloudflare quick tunnel below instead.)

## Quick start (Windows PowerShell)
```powershell
# from the repo root
$env:XT_APP_DOMAIN = "xtiandos.example.com"   # your real domain
npm run build -w apps/web
caddy run --config deploy/Caddyfile
```
Caddy fetches a Let's Encrypt certificate automatically on first request and
auto-renews it. Open `https://xtiandos.example.com` from any device — the padlock
is valid, so `getUserMedia` (camera/mic), `speechSynthesis`, and the PWA/SW all
activate on the phone.

## Linux
```bash
XT_APP_DOMAIN=xtiandos.example.com npm run build -w apps/web
caddy run --config deploy/Caddyfile
```

## Configuration overrides
| Env var        | Default              | Meaning                          |
|----------------|----------------------|----------------------------------|
| `XT_APP_DOMAIN`| `xtiandos.example.com`| hostname + auto TLS              |
| `XT_SITE_ROOT` | `apps/web/dist`      | built web app directory          |
| `XT_API_PORT`  | `3101`               | API server port                  |
Set these in your shell or hard-code them in `deploy/Caddyfile`.

## Installing on the phone
1. Open the HTTPS URL in Chrome.
2. Address bar → **Install app** (or iOS Share → *Add to Home Screen*).
3. It launches full-screen (standalone); camera, mic and speaker work through
   the trusted origin; the service worker makes the shell load instantly.

## No domain / strict NAT? Cloudflare Quick Tunnel
Requires just the `cloudflared` binary (`winget install Cloudflare.cloudflared`). It gives
you a public `https://*.trycloudflare.com` URL with zero port-forwarding:
```powershell
# dev server already proxies /api, /health, and voice to :3101
cloudflared tunnel --no-tls-verify --url https://localhost:5174
```
The URL changes on each restart — fine for demos.

## Cloudflare Tunnel with your own domain (recommended for bossayan.com)
**Already live on this machine**: a Windows service named `Cloudflared` has been
publishing `xtiand.bossayan.com → https://127.0.0.1:5174` (the dev server, which
proxies `/api` and `/health` to `:3101`) since the original setup. Cloudflare
terminates TLS, so the phone gets a browser-trusted padlock and camera/mic/PWA
all work — **no router port-forwarding or public static IP required**. The live
config lives at `C:\Users\Christian\.cloudflared\config.yml` and is mirrored in
`deploy/cloudflared.yml`.

- Change the backend (e.g. point at a production build) → edit
  `C:\Users\Christian\.cloudflared\config.yml`, then as Administrator:
  `sc.exe stop Cloudflared` and `sc.exe start Cloudflared`.
- Ad-hoc foreground run instead of the service:
  `powershell -ExecutionPolicy Bypass -File deploy/tunnel.ps1`
- First-time on a fresh machine: `cloudflared tunnel login`, `tunnel create
  bossayan-os`, `tunnel route dns bossayan-os xtiand.bossayan.com`, `service
  install`, then start the service.

To serve the **production build** (instead of the dev server) behind the same
tunnel, run a local plain-HTTP Caddy on :8080 and repoint the ingress
(commented block in `deploy/cloudflared.yml`).