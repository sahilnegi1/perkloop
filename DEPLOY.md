# Perk Loop — Deployment Guide (MVP)

## 1. What you are deploying
Node + Express + SQLite (`better-sqlite3`). Frontend is static `public/` served by the same process. No build step.

## 2. Prerequisites
- Ubuntu 22.04+ (or macOS for staging), Node 20+, `sqlite3` CLI, nginx, certbot.
- Ports: app `3001` internal, nginx `80/443` public.

## 3. Environment
```bash
cd perk-loop
cp .env.example .env
# edit .env:
# PORT=3001 NODE_ENV=production
# DATABASE_PATH=/var/lib/perkloop/perkloop.db
# SESSION_SECRET=<openssl rand -hex 32>
# APP_BASE_URL=https://yourdomain.in
# SMTP_* (production email OTP delivery)
# TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SID (SMS)
# GOOGLE_MAPS_BROWSER_KEY (HTTP-referrer restricted: your domain; APIs: Maps JavaScript + Places)
# GOOGLE_MAPS_SERVER_KEY (IP restricted: server IP; API: Geocoding)
```
Never commit `.env`. Never put server keys in frontend code.

## 4. Install & migrate
```bash
npm install --omit=dev --no-audit --no-fund
npm run migrate
npm run seed   # optional; only for demo shops
npm test && npm run test:e2e
PORT=3001 NODE_ENV=production node src/server.js
```

## 5. Run as a service (systemd)
```ini
[Unit]
Description=Perk Loop
After=network.target
[Service]
WorkingDirectory=/opt/perk-loop
EnvironmentFile=/opt/perk-loop/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
[Install]
WantedBy=multi-user.target
```

## 6. nginx + HTTPS
Proxy `https://yourdomain.in` → `http://127.0.0.1:3001`, `certbot --nginx`. Force HTTPS; `Secure` cookies activate automatically when `NODE_ENV=production`.

## 7. Backups (do this before every deploy)
```bash
sqlite3 /var/lib/perkloop/perkloop.db ".backup '/backups/perkloop-$(date +%F).db'"
```
Keep 7 daily + 4 weekly. Test restore on staging. Rollback = restore backup + redeploy previous tag.

## 8. Smoke test after deploy
```bash
curl https://yourdomain.in/api/health
curl https://yourdomain.in/api/config   # expect smsConfigured/mapsConfigured false until keys added
```

## 9. Known limits (honest)
- Email OTP needs SMTP in production (dev prints to console).
- SMS needs Twilio Verify; otherwise honest 503.
- Maps needs keys; otherwise manual addresses + setup notice.
- Amounts are merchant-reported unless POS/payment verified.
- No automatedAdvertising: no promo sends without consent (WhatsApp future/modular).
