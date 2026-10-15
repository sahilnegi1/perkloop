# Perk Loop MVP — Phase 1 (Foundation)

India-first loyalty platform. Noida / Greater Noida / NCR launch.
Existing FixIn10 game in repo root is untouched. This app lives in `perk-loop/`.

## Phase plan (efficient professional build)
- [x] Phase 1: scaffold, SQLite schema, server APIs, landing + wallet/discover/merchant UI, tests
- [x] Phase 2: isolation hardening + legacy migration tool + rate-limit audit
- [x] Phase 3: staff roles, outlet management, account recovery
- [x] Phase 4: QR camera scan, redemption approval UI, program builder upgrades
- [x] Phase 5: wallet polish, category pages, merchant analytics export
- [x] Phase 6: Twilio Verify send + Google Maps autocomplete (env-gated)
- [x] Phase 7: branding polish, a11y, offline QR print assets
- [x] Phase 8: E2E tests, security review, deploy guide

## Run
```bash
cd perk-loop
cp .env.example .env   # fill secrets; never commit .env
npm install --no-audit --no-fund
npm run migrate
npm run seed   # honest demo shops, labeled as seed
npm test       # 23 unit tests
npm run test:e2e  # 24 end-to-end checks (temp DB, port 3941)
npm start      # http://localhost:3001
```
```

## Truthfulness
- No fake testimonials/partnerships/stats. Seed shops are labeled seed.
- Email OTP is real server-verified (dev code in server console). SMS returns 503 `sms_setup_required` until Twilio Verify is wired — never fakes success.
- Maps: manual addresses work; `mapsConfigured=false` shows setup notice.
- Balances are per-(customer,business). Display total is informational only.
- QR: single-use, 300s expiry, atomic confirm, idempotency keys, audit logs.
- Amounts are merchant-reported unless POS/payment verified (labeled in UI).

## Still required for production
- `SESSION_SECRET`, SMTP creds (or OTP email provider), Twilio Verify SID, `GOOGLE_MAPS_*` keys, HTTPS + `APP_BASE_URL`, backups for `data/perkloop.db`.
- Maps: restrict `GOOGLE_MAPS_BROWSER_KEY` by HTTP referrer (your domain) + only Maps JavaScript + Places APIs; restrict `GOOGLE_MAPS_SERVER_KEY` by IP + only Geocoding API. Never commit keys.
- Twilio: fill `TWILIO_ACCOUNT_SID/AUTH_TOKEN/VERIFY_SID`, then test SMS with a real Indian mobile; failures return honest 502/503, never fake success.

## Tests
`npm test` runs `tests/loyalty.test.js` (slabs, isolation math, no-negative redeem, validators, replay guards are API-level in `src/server.js` transactions).
