# Publishes xtiandOS to https://xtiand.bossayan.com via Cloudflare Tunnel.
#
# NOTE: this machine ALREADY runs cloudflared as a Windows service ("Cloudflared",
# automatic start) using C:\Users\Christian\.cloudflared\config.yml — you only
# need this script for an ad-hoc foreground tunnel (e.g. after changing the
# ingress) or as a bootstrap reference on a fresh machine.

$ErrorActionPreference = "Stop"

$hostname = "xtiand.bossayan.com"
$tunnel   = "bossayan-os"
$cert     = "$HOME\.cloudflared\cert.pem"

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared not found. Run:  winget install Cloudflare.cloudflared" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $cert)) {
  Write-Host "Logging you into Cloudflare (opens a browser) — authorize the zone bossayan.com:"
  cloudflared tunnel login
  if (-not (Test-Path $cert)) { Write-Host "Login failed. Re-run this script." -ForegroundColor Red; exit 1 }
}

$cred = (Get-ChildItem "$HOME\.cloudflared" -Filter "*.json" | Where-Object { $_.Name -ne "cert.pem" } | Where-Object { $_.Name -match $tunnel } | Select-Object -First 1).FullName
if (-not $cred) { Write-Host "No credentials for tunnel '$tunnel'. Create it with:  cloudflared tunnel create $tunnel" -ForegroundColor Red; exit 1 }

Write-Host "Starting ad-hoc tunnel: https://$hostname  (stop it with Ctrl+C)"
cloudflared tunnel run --config deploy/cloudflared.yml $tunnel