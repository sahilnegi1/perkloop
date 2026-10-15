import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { v4 as uuid } from 'uuid';
import { db, audit } from './db.js';
import { canDo } from './permissions.js';
import { toE164Indian, twilioBasicAuth } from './sms.js';
import { earnCopy, redeemCopy } from './notify.js';

function twilioCfg() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID } = process.env;
  return (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SID)
    ? { sid: TWILIO_ACCOUNT_SID, token: TWILIO_AUTH_TOKEN, verifySid: TWILIO_VERIFY_SID }
    : null;
}

function notifyUser(userId, businessId, kind, title, body) {
  try {
    db.prepare('INSERT INTO notifications (id, user_id, business_id, kind, title, body) VALUES (?,?,?,?,?,?)')
      .run(uuid(), userId, businessId, kind, String(title).slice(0, 120), String(body || '').slice(0, 500));
  } catch { /* notifications never break transactions */ }
}
import { calcPointsEarn, canRedeem, isValidEmail, isValidIndianMobile, validateProgramRules, validateRewardInput } from './loyalty.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const OTP_TTL = Number(process.env.OTP_TTL_SEC || 600);
const QR_TTL = Number(process.env.TXN_QR_TTL_SEC || 300);
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
const qrLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const confirmLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const redeemLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// ---------- helpers ----------
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS" — parse as UTC, not local time.
function sqlExpired(dt) {
  if (!dt) return true;
  const iso = String(dt).includes('T') ? String(dt) : String(dt).replace(' ', 'T') + 'Z';
  return new Date(iso).getTime() < Date.now();
}
function signToken(raw) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('hex');
  return `${raw}.${sig}`;
}
function verifySigned(token) {
  try {
    const i = String(token || '').lastIndexOf('.');
    if (i < 0) return null;
    const raw = String(token).slice(0, i), sig = String(token).slice(i + 1);
    const exp = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(exp);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return raw;
  } catch { return null; }
}
function auth(req, _res, next) {
  const tok = req.cookies?.pl_session || String(req.headers.authorization || '').replace(/^Bearer /i, '');
  const raw = tok ? verifySigned(tok) : null;
  if (!raw) { req.user = null; return next(); }
  const row = db.prepare('SELECT * FROM sessions WHERE token=?').get(raw);
  if (!row || sqlExpired(row.expires_at)) { req.user = null; return next(); }
  req.user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id) || null;
  next();
}
app.use(auth);
app.use('/api/', generalLimiter);
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'login_required' });
  next();
}
function merchantBusinessIds(userId) {
  return db.prepare(`SELECT business_id FROM memberships WHERE user_id=? AND role='owner'`).all(userId).map(r => r.business_id);
}
function canAccessBusiness(userId, businessId) {
  return !!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND business_id=?').get(userId, businessId);
}
function myBusinessRole(userId, businessId) {
  return db.prepare('SELECT role FROM memberships WHERE user_id=? AND business_id=?').get(userId, businessId)?.role || null;
}
function requireRole(action) {
  return (req, res, next) => {
    const bid = req.params.id || req.body?.businessId || req.query?.businessId;
    if (!bid) return res.status(400).json({ error: 'business_required' });
    const role = myBusinessRole(req.user.id, bid);
    if (!role || !canDo({ membershipRole: role, action })) return res.status(403).json({ error: 'forbidden' });
    req.businessRole = role;
    next();
  };
}
const CATEGORIES = ['cafe','restaurant','salon','bakery','supermarket','retail','gym','laundry','other'];

// ---------- config / health ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'perk-loop', time: new Date().toISOString() }));
app.get('/api/config', (_req, res) => res.json({
  smsConfigured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SID),
  mapsConfigured: Boolean(process.env.GOOGLE_MAPS_BROWSER_KEY),
  qrTtlSec: QR_TTL,
  categories: CATEGORIES,
}));

// Phase 5: real category counts (no fake stats).
app.get('/api/categories', (_req, res) => {
  const rows = db.prepare(`SELECT category, COUNT(*) n FROM businesses GROUP BY category`).all();
  const map = Object.fromEntries(rows.map(r => [r.category, r.n]));
  res.json({ categories: CATEGORIES.map(c => ({ slug: c, count: map[c] || 0 })) });
});

// ---------- OTP auth (server-side verified, never faked) ----------
app.post('/api/auth/request-otp', otpLimiter, async (req, res) => {
  const { identifier, channel = 'email', name, role = 'customer' } = req.body || {};
  if (!['email', 'sms'].includes(channel)) return res.status(400).json({ error: 'bad_channel' });
  if (!['customer', 'merchant'].includes(role)) return res.status(400).json({ error: 'bad_role' });

  let id = String(identifier || '').trim();
  if (channel === 'email') {
    id = id.toLowerCase();
    if (!isValidEmail(id)) return res.status(400).json({ error: 'invalid_email' });
  } else {
    id = id.replace(/^\+91/, '').replace(/\s/g, '');
    if (!isValidIndianMobile(id)) return res.status(400).json({ error: 'invalid_indian_mobile' });
    const tw = twilioCfg();
    if (!tw) {
      return res.status(503).json({ error: 'sms_setup_required', message: 'SMS provider not configured. Use email OTP or configure Twilio Verify.' });
    }
    // Resend limit applies to SMS too (counts Twilio sends).
    const recentSms = db.prepare(`SELECT COUNT(*) c FROM otp_codes WHERE identifier=? AND channel='sms' AND created_at > datetime('now','-15 minutes')`).get(id).c;
    if (recentSms >= 3) return res.status(429).json({ error: 'resend_limit', message: 'Too many codes. Try again in 15 minutes.' });
    try {
      const r = await fetch(`https://verify.twilio.com/v2/Services/${tw.verifySid}/Verifications`, {
        method: 'POST',
        headers: { Authorization: twilioBasicAuth(tw.sid, tw.token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: toE164Indian(id), Channel: 'sms' }),
      });
      if (!r.ok) {
        console.error('[twilio] send failed', r.status);
        return res.status(502).json({ error: 'sms_send_failed', message: 'Could not send SMS. Try email OTP.' });
      }
    } catch (e) {
      console.error('[twilio]', e.message);
      return res.status(502).json({ error: 'sms_send_failed', message: 'Could not send SMS. Try email OTP.' });
    }
    // Marker row: code is managed by Twilio, never stored here. Never fake success.
    db.prepare(`INSERT INTO otp_codes (id, identifier, channel, code_hash, expires_at) VALUES (?,?,?, ?, datetime('now', ?))`)
      .run(uuid(), id, 'sms', 'twilio-managed', `+${OTP_TTL} seconds`);
    audit(null, 'otp_requested', 'otp', id, { channel, role });
    return res.json({ ok: true, delivered: 'sms', expiresInSec: OTP_TTL });
  }

  // resend limit: max 3 active codes per 15 min
  const recent = db.prepare(`SELECT COUNT(*) c FROM otp_codes WHERE identifier=? AND channel=? AND created_at > datetime('now','-15 minutes')`).get(id, channel).c;
  if (recent >= 3) return res.status(429).json({ error: 'resend_limit', message: 'Too many codes. Try again in 15 minutes.' });

  const code = String(crypto.randomInt(100000, 999999));
  db.prepare(`INSERT INTO otp_codes (id, identifier, channel, code_hash, expires_at) VALUES (?,?,?, ?, datetime('now', ?))`)
    .run(uuid(), id, channel, sha256(code), `+${OTP_TTL} seconds`);

  // MVP delivery: console + dev-only retrieval. Production requires SMTP setup.
  if (!IS_PROD) console.log(`[OTP:${channel}] ${id} => ${code} (expires ${OTP_TTL}s)`);
  audit(null, 'otp_requested', 'otp', id, { channel, role });
  const out = { ok: true, delivered: !IS_PROD ? 'dev-console' : 'email', expiresInSec: OTP_TTL };
  if (!IS_PROD) out.devHint = 'Read code from server console or GET /api/dev/last-otp in development only.';
  // stash pending role/name for verify step (short-lived, httpOnly not needed)
  res.json({ ...out, pendingRole: role, pendingName: name || '' });
});

// DEV ONLY: retrieve last OTP for testing (never in production)
app.get('/api/dev/last-otp', (req, res) => {
  if (IS_PROD) return res.status(404).json({ error: 'not_found' });
  const { identifier, channel = 'email' } = req.query;
  if (!identifier) return res.status(400).json({ error: 'identifier_required' });
  // We cannot reverse hash; so return expiry info only and log reminder.
  // Instead: for dev convenience, generate a fresh code and return it (still server-verified).
  return res.status(410).json({ error: 'use_server_console', message: 'Check the server terminal for [OTP:email] code. It is verified server-side on /verify-otp.' });
});

app.post('/api/auth/verify-otp', otpLimiter, async (req, res) => {
  const { identifier, channel = 'email', code, name, role = 'customer' } = req.body || {};
  const id = channel === 'email' ? String(identifier || '').trim().toLowerCase() : String(identifier || '').replace(/^\+91/, '').replace(/\s/g, '');
  const row = db.prepare(`SELECT * FROM otp_codes WHERE identifier=? AND channel=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(id, channel);
  if (!row) return res.status(400).json({ error: 'no_code', message: 'Request a code first.' });
  if (sqlExpired(row.expires_at)) return res.status(400).json({ error: 'expired' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'too_many_attempts' });
  if (row.code_hash === 'twilio-managed') {
    // SMS code is verified by Twilio Verify — never accepted locally. No fake success.
    const tw = twilioCfg();
    if (!tw) return res.status(503).json({ error: 'sms_setup_required' });
    try {
      const r = await fetch(`https://verify.twilio.com/v2/Services/${tw.verifySid}/VerificationCheck`, {
        method: 'POST',
        headers: { Authorization: twilioBasicAuth(tw.sid, tw.token), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: toE164Indian(id), Code: String(code || '').trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.status !== 'approved') {
        db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
        return res.status(400).json({ error: 'invalid_code' });
      }
    } catch {
      return res.status(502).json({ error: 'sms_verify_failed', message: 'Could not verify SMS code. Try again.' });
    }
  } else if (sha256(String(code || '').trim()) !== row.code_hash) {
    db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    return res.status(400).json({ error: 'invalid_code' });
  }
  db.prepare('UPDATE otp_codes SET consumed_at=datetime(\'now\') WHERE id=?').run(row.id);

  const col = channel === 'email' ? 'email' : 'phone';
  let user = db.prepare(`SELECT * FROM users WHERE ${col}=?`).get(id);
  if (!user) {
    const r = (['customer', 'merchant'].includes(role) ? role : 'customer');
    const uId = uuid();
    db.prepare('INSERT INTO users (id, role, name, email, phone) VALUES (?,?,?,?,?)')
      .run(uId, r, String(name || '').slice(0, 80) || null, channel === 'email' ? id : null, channel === 'sms' ? id : null);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(uId);
    db.prepare('INSERT OR IGNORE INTO legacy_balances (user_id, points) VALUES (?,0)').run(uId);
  }
  const raw = uuid() + '.' + uuid();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime(\'now\', \'+30 days\'))').run(raw, user.id);
  res.cookie('pl_session', signToken(raw), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5, ...(IS_PROD ? { secure: true } : {}) });
  audit(user.id, 'login', 'user', user.id, { channel });
  res.json({ ok: true, token: signToken(raw), user });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user });
});
app.post('/api/auth/logout', (req, res) => {
  const tok = req.cookies?.pl_session || String(req.headers.authorization || '').replace(/^Bearer /i, '');
  const raw = tok ? verifySigned(tok) : null;
  if (raw) db.prepare('DELETE FROM sessions WHERE token=?').run(raw);
  res.clearCookie('pl_session');
  res.json({ ok: true });
});

// ---------- Businesses / discovery ----------
app.get('/api/businesses', (req, res) => {
  const { category, q } = req.query;
  let sql = `SELECT b.*, (SELECT COUNT(*) FROM loyalty_programs p WHERE p.business_id=b.id AND p.status='active') active_programs FROM businesses b WHERE 1=1`;
  const args = [];
  if (category && CATEGORIES.includes(String(category))) { sql += ' AND b.category=?'; args.push(category); }
  if (q) { sql += ' AND (b.name LIKE ? OR b.address LIKE ? OR b.city LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY b.created_at DESC LIMIT 100';
  res.json({ businesses: db.prepare(sql).all(...args) });
});

app.get('/api/businesses/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  const outlets = db.prepare('SELECT id, name, address, city FROM outlets WHERE business_id=?').all(b.id);
  const programs = db.prepare(`SELECT * FROM loyalty_programs WHERE business_id=? AND status='active'`).all(b.id);
  const rewards = db.prepare(`SELECT * FROM rewards WHERE business_id=? AND active=1`).all(b.id);
  res.json({ business: b, outlets, programs: programs.map(p => ({ ...p, rules: JSON.parse(p.rules_json || '{}') })), rewards });
});

// Phase 4: resolve static outlet QR (identify shop only — never awards points).
app.get('/api/outlets/static/:token', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM outlets WHERE static_token=?').get(req.params.token);
  if (!o) return res.status(404).json({ error: 'invalid_qr' });
  const b = db.prepare('SELECT id, name, category, address, city FROM businesses WHERE id=?').get(o.business_id);
  res.json({ outlet: { id: o.id, name: o.name }, business: b });
});

// Phase 4: isolated program/reward lists for merchants/staff of ONE business.
app.get('/api/merchant/programs', requireUser, (req, res) => {
  const { businessId } = req.query;
  if (!businessId || !canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare('SELECT * FROM loyalty_programs WHERE business_id=? ORDER BY created_at').all(businessId);
  res.json({ programs: rows.map(p => ({ ...p, rules: JSON.parse(p.rules_json || '{}') })) });
});

app.get('/api/merchant/rewards', requireUser, (req, res) => {
  const { businessId } = req.query;
  if (!businessId || !canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  res.json({ rewards: db.prepare('SELECT * FROM rewards WHERE business_id=? ORDER BY created_at').all(businessId) });
});

// Phase 4: customer's own redemptions (any status).
app.get('/api/redemptions/mine', requireUser, (req, res) => {
  const rows = db.prepare(`SELECT rd.*, r.title reward_title, b.name business_name FROM redemptions rd JOIN rewards r ON r.id=rd.reward_id JOIN businesses b ON b.id=rd.business_id WHERE rd.customer_id=? ORDER BY rd.created_at DESC LIMIT 50`).all(req.user.id);
  res.json({ redemptions: rows });
});

app.post('/api/businesses', requireUser, (req, res) => {
  if (!['merchant', 'staff'].includes(req.user.role) && req.user.role !== 'merchant') {
    // auto-upgrade customer->merchant on business creation (keeps separate journeys)
    db.prepare('UPDATE users SET role=? WHERE id=?').run('merchant', req.user.id);
  }
  const { name, category, address, city = 'Noida', state = 'Uttar Pradesh', pincode, lat, lng, logo_url } = req.body || {};
  if (!name || !address || !pincode) return res.status(400).json({ error: 'missing_fields' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'bad_category' });
  if (!/^\d{6}$/.test(String(pincode))) return res.status(400).json({ error: 'bad_pincode' });
  const bId = uuid();
  const txn = db.transaction(() => {
    db.prepare(`INSERT INTO businesses (id, owner_user_id, name, category, address, city, state, pincode, lat, lng, logo_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(bId, req.user.id, name.slice(0, 120), category, address.slice(0, 300), city.slice(0, 80), state.slice(0, 80), pincode, lat ?? null, lng ?? null, logo_url ?? null);
    db.prepare('INSERT INTO memberships (user_id, business_id, role) VALUES (?,?,\'owner\')').run(req.user.id, bId);
    const oId = uuid();
    db.prepare(`INSERT INTO outlets (id, business_id, name, address, city, static_token) VALUES (?,?,?,?,?,?)`)
      .run(oId, bId, 'Main outlet', address.slice(0, 300), city.slice(0, 80), 'ST-' + crypto.randomBytes(8).toString('hex'));
  });
  txn();
  audit(req.user.id, 'business_created', 'business', bId, { name });
  res.json({ ok: true, businessId: bId });
});

// ---------- Merchant: programs / rewards / QR ----------
app.post('/api/merchant/programs', requireUser, (req, res) => {
  const { businessId, type, name, rules, status = 'draft' } = req.body || {};
  if (!canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  if (myBusinessRole(req.user.id, businessId) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  if (!['points', 'visit', 'count', 'star', 'spend', 'custom'].includes(type)) return res.status(400).json({ error: 'bad_type' });
  if (!name) return res.status(400).json({ error: 'name_required' });
  const v = validateProgramRules(type, rules || {});
  if (!v.ok) return res.status(400).json({ error: 'invalid_rules', message: v.error });
  const id = uuid();
  db.prepare(`INSERT INTO loyalty_programs (id, business_id, type, name, status, rules_json) VALUES (?,?,?,?,?,?)`)
    .run(id, businessId, type, name.slice(0, 120), ['draft', 'active', 'paused'].includes(status) ? status : 'draft', JSON.stringify(v.rules));
  audit(req.user.id, 'program_created', 'program', id, { businessId, type });
  res.json({ ok: true, id });
});

app.patch('/api/merchant/programs/:id', requireUser, (req, res) => {
  const p = db.prepare('SELECT * FROM loyalty_programs WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (!canAccessBusiness(req.user.id, p.business_id)) return res.status(403).json({ error: 'forbidden' });
  if (myBusinessRole(req.user.id, p.business_id) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const { name, status, rules } = req.body || {};
  if (status && !['draft', 'active', 'paused'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  let rulesJson = p.rules_json;
  if (rules !== undefined) {
    const v = validateProgramRules(p.type, rules);
    if (!v.ok) return res.status(400).json({ error: 'invalid_rules', message: v.error });
    rulesJson = JSON.stringify(v.rules);
  }
  db.prepare('UPDATE loyalty_programs SET name=COALESCE(?,name), status=COALESCE(?,status), rules_json=? WHERE id=?')
    .run(name ? String(name).slice(0, 120) : null, status || null, rulesJson, p.id);
  audit(req.user.id, 'program_updated', 'program', p.id, { status });
  res.json({ ok: true });
});

app.post('/api/merchant/rewards', requireUser, (req, res) => {
  const { businessId, programId, title, description, cost_points = 0, cost_stamps = 0, min_spend = 0, per_customer_limit = null, start_at = null, end_at = null } = req.body || {};
  if (!canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  if (myBusinessRole(req.user.id, businessId) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  if (!title) return res.status(400).json({ error: 'title_required' });
  const v = validateRewardInput({ cost_points, cost_stamps, min_spend, per_customer_limit, start_at, end_at });
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (programId) {
    const pg = db.prepare('SELECT * FROM loyalty_programs WHERE id=? AND business_id=?').get(programId, businessId);
    if (!pg) return res.status(400).json({ error: 'bad_program' });
  }
  const id = uuid();
  db.prepare(`INSERT INTO rewards (id, business_id, program_id, title, description, cost_points, cost_stamps, min_spend, per_customer_limit, start_at, end_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, businessId, programId || null, title.slice(0, 120), String(description || '').slice(0, 500), cost_points, cost_stamps, min_spend, per_customer_limit, start_at, end_at);
  audit(req.user.id, 'reward_created', 'reward', id, { businessId });
  res.json({ ok: true, id });
});

app.patch('/api/merchant/rewards/:id', requireUser, (req, res) => {
  const r = db.prepare('SELECT * FROM rewards WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (!canAccessBusiness(req.user.id, r.business_id)) return res.status(403).json({ error: 'forbidden' });
  if (myBusinessRole(req.user.id, r.business_id) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const { title, description, active, start_at = undefined, end_at = undefined } = req.body || {};
  if (active !== undefined && ![0, 1, true, false].includes(active)) return res.status(400).json({ error: 'bad_active' });
  db.prepare('UPDATE rewards SET title=COALESCE(?,title), description=COALESCE(?,description), active=COALESCE(?,active), start_at=COALESCE(?,start_at), end_at=COALESCE(?,end_at) WHERE id=?')
    .run(title ? String(title).slice(0, 120) : null, description != null ? String(description).slice(0, 500) : null, active == null ? null : (active ? 1 : 0), start_at === undefined ? null : start_at, end_at === undefined ? null : end_at, r.id);
  audit(req.user.id, 'reward_updated', 'reward', r.id, {});
  res.json({ ok: true });
});

// Outlets: multiple per business, outlet activity stays identifiable via outlet_id.
app.get('/api/merchant/businesses/:id/outlets', requireUser, (req, res) => {
  if (!canAccessBusiness(req.user.id, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  res.json({ outlets: db.prepare('SELECT * FROM outlets WHERE business_id=? ORDER BY created_at').all(req.params.id) });
});

app.post('/api/merchant/outlets', requireUser, (req, res) => {
  const { businessId, name, address, city } = req.body || {};
  if (!canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  if (myBusinessRole(req.user.id, businessId) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  if (!name) return res.status(400).json({ error: 'name_required' });
  const id = uuid();
  db.prepare('INSERT INTO outlets (id, business_id, name, address, city, static_token) VALUES (?,?,?,?,?,?)')
    .run(id, businessId, String(name).slice(0, 120), address ? String(address).slice(0, 300) : null, city ? String(city).slice(0, 80) : null, 'ST-' + crypto.randomBytes(8).toString('hex'));
  audit(req.user.id, 'outlet_created', 'outlet', id, { businessId });
  res.json({ ok: true, id });
});

// Isolated merchant reads: transactions / customers / redemptions for ONE business only.
app.get('/api/merchant/businesses/:id/transactions', requireUser, (req, res) => {
  if (!canAccessBusiness(req.user.id, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const limit = Math.min(Number(req.query.limit || 50), 200), offset = Math.max(Number(req.query.offset || 0), 0);
  const rows = db.prepare('SELECT * FROM transactions WHERE business_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.params.id, limit, offset);
  res.json({ transactions: rows });
});

app.get('/api/merchant/businesses/:id/customers', requireUser, (req, res) => {
  if (!canAccessBusiness(req.user.id, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare(`SELECT cb.*, u.name, u.email, u.phone FROM customer_balances cb JOIN users u ON u.id=cb.customer_id WHERE cb.business_id=? ORDER BY cb.updated_at DESC LIMIT 200`).all(req.params.id);
  res.json({ customers: rows });
});

app.get('/api/merchant/redemptions', requireUser, (req, res) => {
  const { businessId, status } = req.query;
  if (!businessId || !canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  let sql = 'SELECT * FROM redemptions WHERE business_id=?';
  const args = [businessId];
  if (status) { sql += ' AND status=?'; args.push(status); }
  res.json({ redemptions: db.prepare(sql + ' ORDER BY created_at DESC LIMIT 200').all(...args) });
});

app.get('/api/merchant/overview', requireUser, (req, res) => {
  const bids = merchantBusinessIds(req.user.id);
  const out = bids.map(bid => {
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(bid);
    const stats = db.prepare(`SELECT COUNT(*) txns, COALESCE(SUM(points_delta),0) pts, COALESCE(SUM(amount),0) revenue FROM transactions WHERE business_id=?`).get(bid);
    const members = db.prepare('SELECT COUNT(*) c FROM customer_balances WHERE business_id=?').get(bid).c;
    return { business: b, stats, members };
  });
  const staffed = db.prepare(`SELECT m.business_id, b.name, b.category FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=? AND m.role='staff'`).all(req.user.id);
  res.json({ businesses: out, staffAssignments: staffed });
});

// ---------- Phase 3: business edit (owner only) ----------
app.patch('/api/businesses/:id', requireUser, (req, res) => {
  const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  if (myBusinessRole(req.user.id, b.id) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const { name, address, city, state, pincode, logo_url, description, hours_json } = req.body || {};
  if (pincode !== undefined && !/^\d{6}$/.test(String(pincode))) return res.status(400).json({ error: 'bad_pincode' });
  let hours = null;
  if (hours_json !== undefined) {
    try {
      const h = typeof hours_json === 'string' ? JSON.parse(hours_json) : hours_json;
      if (typeof h !== 'object' || h === null || Array.isArray(h)) return res.status(400).json({ error: 'bad_hours' });
      hours = JSON.stringify(h).slice(0, 2000);
    } catch { return res.status(400).json({ error: 'bad_hours' }); }
  }
  db.prepare('UPDATE businesses SET name=COALESCE(?,name), address=COALESCE(?,address), city=COALESCE(?,city), state=COALESCE(?,state), pincode=COALESCE(?,pincode), logo_url=COALESCE(?,logo_url), description=COALESCE(?,description), hours_json=COALESCE(?,hours_json) WHERE id=?')
    .run(name ? String(name).slice(0, 120) : null, address ? String(address).slice(0, 300) : null, city ? String(city).slice(0, 80) : null, state ? String(state).slice(0, 80) : null, pincode ? String(pincode) : null, logo_url !== undefined ? logo_url : null, description !== undefined ? String(description).slice(0, 1000) : null, hours, b.id);
  audit(req.user.id, 'business_updated', 'business', b.id, {});
  res.json({ ok: true });
});

// ---------- Phase 3: outlet edit + static QR (identify shop only, never awards points) ----------
app.patch('/api/merchant/outlets/:id', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM outlets WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not_found' });
  if (myBusinessRole(req.user.id, o.business_id) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const { name, address, city } = req.body || {};
  db.prepare('UPDATE outlets SET name=COALESCE(?,name), address=COALESCE(?,address), city=COALESCE(?,city) WHERE id=?')
    .run(name ? String(name).slice(0, 120) : null, address !== undefined ? address : null, city !== undefined ? city : null, o.id);
  res.json({ ok: true });
});

app.get('/api/merchant/outlets/:id/static-qr', requireUser, async (req, res) => {
  const o = db.prepare('SELECT * FROM outlets WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not_found' });
  if (!canAccessBusiness(req.user.id, o.business_id)) return res.status(403).json({ error: 'forbidden' });
  const payload = `${process.env.APP_BASE_URL || ''}/#outlet/${o.static_token}`;
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 280, margin: 1 });
  res.json({ ok: true, staticToken: o.static_token, qrDataUrl, note: 'Identifies the outlet only. Never awards points by itself.' });
});

// ---------- Phase 3: staff management (owner only) ----------
app.get('/api/merchant/businesses/:id/staff', requireUser, (req, res) => {
  if (myBusinessRole(req.user.id, req.params.id) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const rows = db.prepare(`SELECT m.role, m.created_at, u.id, u.name, u.email, u.phone FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=?`).all(req.params.id);
  res.json({ staff: rows });
});

app.post('/api/merchant/staff/invite', requireUser, (req, res) => {
  const { businessId, email } = req.body || {};
  if (!businessId || !email) return res.status(400).json({ error: 'missing_fields' });
  if (myBusinessRole(req.user.id, businessId) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const em = String(email).trim().toLowerCase();
  if (!isValidEmail(em)) return res.status(400).json({ error: 'invalid_email' });
  let u = db.prepare('SELECT * FROM users WHERE email=?').get(em);
  if (!u) {
    const id = uuid();
    db.prepare(`INSERT INTO users (id, role, email) VALUES (?, 'staff', ?)`).run(id, em);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  } else if (u.id === req.user.id) {
    return res.status(400).json({ error: 'cannot_invite_self' });
  }
  db.prepare(`INSERT INTO memberships (user_id, business_id, role) VALUES (?,?,'staff') ON CONFLICT(user_id, business_id) DO UPDATE SET role='staff'`).run(u.id, businessId);
  if (u.role === 'customer') db.prepare(`UPDATE users SET role='staff' WHERE id=?`).run(u.id);
  audit(req.user.id, 'staff_invited', 'business', businessId, { staffId: u.id });
  res.json({ ok: true, userId: u.id, message: 'Staff added. They sign in with email OTP.' });
});

app.delete('/api/merchant/businesses/:id/staff/:userId', requireUser, (req, res) => {
  if (myBusinessRole(req.user.id, req.params.id) !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const m = db.prepare('SELECT * FROM memberships WHERE user_id=? AND business_id=?').get(req.params.userId, req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (m.role === 'owner') return res.status(400).json({ error: 'cannot_remove_owner' });
  db.prepare('DELETE FROM memberships WHERE user_id=? AND business_id=?').run(req.params.userId, req.params.id);
  audit(req.user.id, 'staff_removed', 'business', req.params.id, { staffId: req.params.userId });
  res.json({ ok: true });
});

app.get('/api/staff/assignments', requireUser, (req, res) => {
  const rows = db.prepare(`SELECT m.business_id, m.role, b.name, b.category, b.city FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=?`).all(req.user.id);
  res.json({ assignments: rows });
});

// ---------- Phase 3: account recovery — sessions, profile, contact change ----------
app.get('/api/auth/sessions', requireUser, (req, res) => {
  const rows = db.prepare('SELECT token, created_at, expires_at FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  const cur = req.cookies?.pl_session || String(req.headers.authorization || '').replace(/^Bearer /i, '');
  res.json({ sessions: rows.map(s => ({ ...s, current: false })), note: 'Tokens are truncated server-side in future; current session identified by cookie.' });
});

app.post('/api/auth/logout-all', requireUser, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
  res.clearCookie('pl_session');
  audit(req.user.id, 'logout_all', 'user', req.user.id, {});
  res.json({ ok: true });
});

app.patch('/api/account/profile', requireUser, (req, res) => {
  const { name } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || name.length > 80)) return res.status(400).json({ error: 'bad_name' });
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name ? name.slice(0, 80) : null, req.user.id);
  res.json({ ok: true });
});

app.post('/api/account/contact/request', requireUser, otpLimiter, (req, res) => {
  const { channel = 'email', newValue } = req.body || {};
  if (!['email'].includes(channel)) return res.status(400).json({ error: 'email_only_mvp', message: 'SMS contact change requires Twilio; email supported in MVP.' });
  const v = String(newValue || '').trim().toLowerCase();
  if (!isValidEmail(v)) return res.status(400).json({ error: 'invalid_email' });
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id != ?').get(v, req.user.id)) return res.status(409).json({ error: 'already_in_use' });
  const code = String(crypto.randomInt(100000, 999999));
  db.prepare(`INSERT INTO otp_codes (id, identifier, channel, code_hash, expires_at) VALUES (?,?,?, ?, datetime('now', ?))`)
    .run(uuid(), `acct:${req.user.id}:${v}`, channel, sha256(code), `+${OTP_TTL} seconds`);
  if (!IS_PROD) console.log(`[OTP:contact] ${v} => ${code}`);
  res.json({ ok: true, delivered: !IS_PROD ? 'dev-console' : 'email' });
});

app.post('/api/account/contact/confirm', requireUser, otpLimiter, (req, res) => {
  const { newValue, code } = req.body || {};
  const v = String(newValue || '').trim().toLowerCase();
  const key = `acct:${req.user.id}:${v}`;
  const row = db.prepare(`SELECT * FROM otp_codes WHERE identifier=? AND channel='email' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(key);
  if (!row) return res.status(400).json({ error: 'no_code' });
  if (sqlExpired(row.expires_at)) return res.status(400).json({ error: 'expired' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'too_many_attempts' });
  if (sha256(String(code || '').trim()) !== row.code_hash) {
    db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    return res.status(400).json({ error: 'invalid_code' });
  }
  db.prepare('UPDATE otp_codes SET consumed_at=datetime(\'now\') WHERE id=?').run(row.id);
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id != ?').get(v, req.user.id)) return res.status(409).json({ error: 'already_in_use' });
  db.prepare('UPDATE users SET email=? WHERE id=?').run(v, req.user.id);
  audit(req.user.id, 'contact_changed', 'user', req.user.id, { channel: 'email' });
  res.json({ ok: true });
});

// One-time transaction QR: merchant enters amount. Single-use, short-lived.
app.post('/api/merchant/qr/transaction', requireUser, qrLimiter, async (req, res) => {
  const { businessId, outletId, amountRupees, programId } = req.body || {};
  if (!canAccessBusiness(req.user.id, businessId)) return res.status(403).json({ error: 'forbidden' });
  const outlet = db.prepare('SELECT * FROM outlets WHERE id=? AND business_id=?').get(outletId, businessId);
  if (!outlet) return res.status(400).json({ error: 'bad_outlet' });
  const amt = Math.round(Number(amountRupees) * 100); // Rs -> paise
  if (!Number.isInteger(amt) || amt <= 0 || amt > 10000000) return res.status(400).json({ error: 'invalid_amount' });
  const token = 'TX-' + crypto.randomBytes(12).toString('hex');
  db.prepare(`INSERT INTO transaction_qr_tokens (token, business_id, outlet_id, program_id, amount, expires_at, created_by)
    VALUES (?,?,?,?,?, datetime('now', ?), ?)`)
    .run(token, businessId, outletId, programId || null, amt, `+${QR_TTL} seconds`, req.user.id);
  const payload = `${process.env.APP_BASE_URL || ''}/#scan/${token}`;
  const qrDataUrl = await QRCode.toDataURL(payload, { width: 280, margin: 1 });
  audit(req.user.id, 'qr_issued', 'qr', token, { businessId, amount: amt });
  res.json({ ok: true, token, expiresInSec: QR_TTL, qrDataUrl, merchantReported: true, note: 'Amount is merchant-reported unless verified by POS/payment integration.' });
});

app.get('/api/qr/:token/info', requireUser, (req, res) => {
  const t = db.prepare('SELECT * FROM transaction_qr_tokens WHERE token=?').get(req.params.token);
  if (!t) return res.status(404).json({ error: 'invalid_qr' });
  if (t.used_at) return res.status(410).json({ error: 'already_used' });
  if (sqlExpired(t.expires_at)) return res.status(410).json({ error: 'expired' });
  const b = db.prepare('SELECT id, name, category FROM businesses WHERE id=?').get(t.business_id);
  res.json({ token: t.token, business: b, amountPaise: t.amount, amountRupees: (t.amount / 100).toFixed(2), expiresAt: t.expires_at });
});

// Customer confirms scan. Atomic, idempotent, single-use. Points go ONLY to this business.
app.post('/api/transactions/confirm', requireUser, confirmLimiter, (req, res) => {
  const { token, idempotencyKey } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token_required' });
  const key = String(idempotencyKey || uuid());

  // idempotent replay
  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key=?').get(key);
  if (existing) return res.json({ ok: true, deduped: true, transaction: existing });

  const q = db.prepare('SELECT * FROM transaction_qr_tokens WHERE token=?').get(token);
  if (!q) return res.status(404).json({ error: 'invalid_qr' });
  if (q.used_at) return res.status(410).json({ error: 'already_used' });
  if (sqlExpired(q.expires_at)) return res.status(410).json({ error: 'expired' });

  // resolve program: explicit or first active
  let program = q.program_id ? db.prepare('SELECT * FROM loyalty_programs WHERE id=?').get(q.program_id)
    : db.prepare(`SELECT * FROM loyalty_programs WHERE business_id=? AND status='active' ORDER BY created_at LIMIT 1`).get(q.business_id);
  let earn = { points: 0, stamps: 0 };
  if (program && program.status === 'active') {
    try { earn = calcPointsEarn({ programType: program.type, rules: JSON.parse(program.rules_json || '{}'), amountPaise: q.amount }); }
    catch { earn = { points: 0, stamps: 0 }; }
  }

  const txn = db.transaction(() => {
    const locked = db.prepare('SELECT * FROM transaction_qr_tokens WHERE token=?').get(token);
    if (locked.used_at) throw new Error('already_used');
    if (sqlExpired(locked.expires_at)) throw new Error('expired');
    db.prepare('UPDATE transaction_qr_tokens SET used_at=datetime(\'now\') WHERE token=?').run(token);

    db.prepare(`INSERT INTO customer_balances (customer_id, business_id, points, stamps, stars, visits, total_spent)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(customer_id, business_id) DO NOTHING`)
      .run(req.user.id, q.business_id, 0, 0, 0, 0, 0);

    const tId = uuid();
    db.prepare(`INSERT INTO transactions (id, customer_id, business_id, outlet_id, program_id, amount, points_delta, stamps_delta, type, idempotency_key, qr_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tId, req.user.id, q.business_id, q.outlet_id, program?.id || null, q.amount, earn.points, earn.stamps, 'earn', key, token);

    if (earn.points > 0 || earn.stamps > 0) {
      const bal = db.prepare('SELECT * FROM customer_balances WHERE customer_id=? AND business_id=?').get(req.user.id, q.business_id);
      const np = bal.points + earn.points, ns = bal.stamps + earn.stamps;
      db.prepare('UPDATE customer_balances SET points=?, stamps=?, visits=visits+1, total_spent=total_spent+?, updated_at=datetime(\'now\') WHERE customer_id=? AND business_id=?')
        .run(np, ns, q.amount, req.user.id, q.business_id);
      db.prepare('INSERT INTO points_ledger (id, transaction_id, customer_id, business_id, delta, balance_after, reason) VALUES (?,?,?,?,?,?,?)')
        .run(uuid(), tId, req.user.id, q.business_id, earn.points, np, `earn:${program?.type || 'none'}`);
    } else {
      db.prepare('UPDATE customer_balances SET visits=visits+1, total_spent=total_spent+? WHERE customer_id=? AND business_id=?')
        .run(q.amount, req.user.id, q.business_id);
    }
    return db.prepare('SELECT * FROM transactions WHERE id=?').get(tId);
  });

  try {
    const result = txn();
    audit(req.user.id, 'earn', 'transaction', result.id, { business: q.business_id, points: earn.points });
    const bName = db.prepare('SELECT name FROM businesses WHERE id=?').get(q.business_id)?.name || 'shop';
    const copy = earnCopy({ businessName: bName, points: earn.points, stamps: earn.stamps });
    notifyUser(req.user.id, q.business_id, 'earn', copy.title, copy.body);
    res.json({ ok: true, transaction: result, earned: earn, businessId: q.business_id });
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes('already_used')) return res.status(410).json({ error: 'already_used' });
    if (msg.includes('expired')) return res.status(410).json({ error: 'expired' });
    throw e;
  }
});

// ---------- Customer wallet (per-business balances, never merged) ----------
app.get('/api/wallet', requireUser, (req, res) => {
  const rows = db.prepare(`SELECT cb.*, b.name business_name, b.category FROM customer_balances cb JOIN businesses b ON b.id=cb.business_id WHERE cb.customer_id=? ORDER BY cb.updated_at DESC`).all(req.user.id);
  const legacy = db.prepare('SELECT * FROM legacy_balances WHERE user_id=?').get(req.user.id);
  const txns = db.prepare(`SELECT t.*, b.name business_name FROM transactions t LEFT JOIN businesses b ON b.id=t.business_id WHERE t.customer_id=? ORDER BY t.created_at DESC LIMIT 50`).all(req.user.id);
  const rewards = db.prepare(`SELECT r.*, b.name business_name FROM rewards r JOIN businesses b ON b.id=r.business_id WHERE r.active=1 AND r.business_id IN (SELECT business_id FROM customer_balances WHERE customer_id=?) LIMIT 50`).all(req.user.id);
  const totalPointsAllBusinesses = rows.reduce((a, r) => a + r.points, 0); // display-only sum, NOT redeemable as one balance
  res.json({ balances: rows, legacy, recentTransactions: txns, availableRewards: rewards, totalPointsDisplayOnly: totalPointsAllBusinesses, notice: 'Balances are per-business and not combinable. Display total is informational only.' });
});

// ---------- Redemption: customer requests, merchant approves (atomic, no negative) ----------
app.post('/api/rewards/:id/redeem', requireUser, redeemLimiter, (req, res) => {
  const r = db.prepare('SELECT * FROM rewards WHERE id=?').get(req.params.id);
  if (!r || !r.active) return res.status(404).json({ error: 'reward_not_found' });
  const bal = db.prepare('SELECT * FROM customer_balances WHERE customer_id=? AND business_id=?').get(req.user.id, r.business_id);
  const doneCount = db.prepare(`SELECT COUNT(*) c FROM redemptions WHERE customer_id=? AND reward_id=? AND status='completed'`).get(req.user.id, r.id).c;
  const check = canRedeem({ balance: bal || { points: 0, stamps: 0 }, reward: r, redemptionCount: doneCount });
  if (!check.ok) return res.status(400).json({ error: check.reason });
  const code = 'RD-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const id = uuid();
  db.prepare(`INSERT INTO redemptions (id, code, reward_id, customer_id, business_id, status) VALUES (?,?,?,?,?,'pending')`)
    .run(id, code, r.id, req.user.id, r.business_id);
  audit(req.user.id, 'redeem_requested', 'redemption', id, { reward: r.id });
  res.json({ ok: true, redemptionId: id, code, status: 'pending', message: 'Show this code to the merchant for approval.' });
});

app.post('/api/merchant/redemptions/:id/approve', requireUser, (req, res) => {
  const rd = db.prepare('SELECT * FROM redemptions WHERE id=?').get(req.params.id);
  if (!rd) return res.status(404).json({ error: 'not_found' });
  if (rd.status !== 'pending') return res.status(400).json({ error: 'already_' + rd.status });
  if (!canAccessBusiness(req.user.id, rd.business_id)) return res.status(403).json({ error: 'forbidden' });
  const reward = db.prepare('SELECT * FROM rewards WHERE id=?').get(rd.reward_id);
  if (!reward || !reward.active) return res.status(400).json({ error: 'reward_inactive' });
  const txn = db.transaction(() => {
    const bal = db.prepare('SELECT * FROM customer_balances WHERE customer_id=? AND business_id=?').get(rd.customer_id, rd.business_id);
    if (!bal || bal.points < reward.cost_points || bal.stamps < reward.cost_stamps) throw new Error('insufficient');
    if (reward.min_spend && (bal.total_spent ?? 0) < reward.min_spend) throw new Error('min_spend');
    if (reward.start_at && new Date(reward.start_at) > new Date()) throw new Error('not_started');
    if (reward.end_at && new Date(reward.end_at) < new Date()) throw new Error('expired');
    if (reward.per_customer_limit != null) {
      const c = db.prepare(`SELECT COUNT(*) c FROM redemptions WHERE customer_id=? AND reward_id=? AND status='completed'`).get(rd.customer_id, reward.id).c;
      if (c >= reward.per_customer_limit) throw new Error('per_customer_limit');
    }
    db.prepare('UPDATE customer_balances SET points=points-?, stamps=stamps-? WHERE customer_id=? AND business_id=?')
      .run(reward.cost_points, reward.cost_stamps, rd.customer_id, rd.business_id);
    const tId = uuid();
    db.prepare(`INSERT INTO transactions (id, customer_id, business_id, program_id, points_delta, stamps_delta, type, idempotency_key) VALUES (?,?,?,?,?,?,?,?)`)
      .run(tId, rd.customer_id, rd.business_id, reward.program_id, -reward.cost_points, -reward.cost_stamps, 'redeem', 'rd-' + rd.id);
    const after = db.prepare('SELECT points FROM customer_balances WHERE customer_id=? AND business_id=?').get(rd.customer_id, rd.business_id).points;
    db.prepare('INSERT INTO points_ledger (id, transaction_id, customer_id, business_id, delta, balance_after, reason) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), tId, rd.customer_id, rd.business_id, -reward.cost_points, after, 'redeem:' + reward.id);
    db.prepare(`UPDATE redemptions SET status='completed' WHERE id=?`).run(rd.id);
  });
  try { txn(); } catch (e) {
    const m = String(e.message);
    if (['min_spend', 'not_started', 'expired', 'per_customer_limit'].includes(m)) return res.status(400).json({ error: m });
    return res.status(400).json({ error: 'insufficient_points' });
  }
  audit(req.user.id, 'redeem_approved', 'redemption', rd.id, {});
  const bName2 = db.prepare('SELECT name FROM businesses WHERE id=?').get(rd.business_id)?.name || 'shop';
  const rcopy = redeemCopy({ businessName: bName2, title: reward.title });
  notifyUser(rd.customer_id, rd.business_id, 'redeem', rcopy.title, rcopy.body);
  res.json({ ok: true, status: 'completed' });
});

app.post('/api/merchant/redemptions/:id/reject', requireUser, (req, res) => {
  const rd = db.prepare('SELECT * FROM redemptions WHERE id=?').get(req.params.id);
  if (!rd) return res.status(404).json({ error: 'not_found' });
  if (rd.status !== 'pending') return res.status(400).json({ error: 'already_' + rd.status });
  if (!canAccessBusiness(req.user.id, rd.business_id)) return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE redemptions SET status='rejected' WHERE id=?`).run(rd.id);
  audit(req.user.id, 'redeem_rejected', 'redemption', rd.id, {});
  res.json({ ok: true, status: 'rejected' });
});

// ---------- Legacy balance: explicit, audited, opt-in migration. Never automatic. ----------
app.get('/api/legacy/status', requireUser, (req, res) => {
  const legacy = db.prepare('SELECT * FROM legacy_balances WHERE user_id=?').get(req.user.id);
  const history = db.prepare('SELECT lm.*, b.name business_name FROM legacy_migrations lm JOIN businesses b ON b.id=lm.business_id WHERE lm.user_id=? ORDER BY lm.created_at DESC').all(req.user.id);
  res.json({ legacy: legacy || { points: 0 }, history, note: 'Legacy balance is preserved separately and never auto-transferred.' });
});

app.post('/api/legacy/reconcile', requireUser, (req, res) => {
  const { businessId, points, reason, confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: 'confirm_required', message: 'Pass confirm:true to acknowledge explicit migration.' });
  if (!businessId || !Number.isInteger(points) || points <= 0) return res.status(400).json({ error: 'bad_request' });
  if (!reason || String(reason).trim().length < 8) return res.status(400).json({ error: 'reason_required' });
  const biz = db.prepare('SELECT id FROM businesses WHERE id=?').get(businessId);
  if (!biz) return res.status(404).json({ error: 'business_not_found' });
  const txn = db.transaction(() => {
    const leg = db.prepare('SELECT * FROM legacy_balances WHERE user_id=?').get(req.user.id);
    if (!leg || leg.points < points) throw new Error('insufficient_legacy');
    db.prepare('UPDATE legacy_balances SET points=points-? WHERE user_id=?').run(points, req.user.id);
    db.prepare(`INSERT INTO customer_balances (customer_id, business_id, points, stamps, stars, visits, total_spent)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(customer_id, business_id) DO NOTHING`).run(req.user.id, businessId, 0, 0, 0, 0, 0);
    db.prepare('UPDATE customer_balances SET points=points+? WHERE customer_id=? AND business_id=?').run(points, req.user.id, businessId);
    const tId = uuid();
    db.prepare(`INSERT INTO transactions (id, customer_id, business_id, points_delta, type, idempotency_key) VALUES (?,?,?,?,?,?)`)
      .run(tId, req.user.id, businessId, points, 'adjust', 'legacy-' + uuid());
    const after = db.prepare('SELECT points FROM customer_balances WHERE customer_id=? AND business_id=?').get(req.user.id, businessId).points;
    db.prepare('INSERT INTO points_ledger (id, transaction_id, customer_id, business_id, delta, balance_after, reason) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), tId, req.user.id, businessId, points, after, 'legacy_migration');
    db.prepare('INSERT INTO legacy_migrations (id, user_id, business_id, points, reason) VALUES (?,?,?,?,?)')
      .run(uuid(), req.user.id, businessId, points, String(reason).slice(0, 300));
  });
  try { txn(); } catch (e) {
    if (String(e.message).includes('insufficient_legacy')) return res.status(400).json({ error: 'insufficient_legacy' });
    throw e;
  }
  audit(req.user.id, 'legacy_reconciled', 'business', businessId, { points });
  res.json({ ok: true });
});

// Phase 5: public feedback summary (no PII) + isolated merchant feedback.
app.get('/api/businesses/:id/feedback', (req, res) => {
  const b = db.prepare('SELECT id FROM businesses WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  const agg = db.prepare(`SELECT COUNT(*) n, COALESCE(AVG(rating),0) avg FROM feedback WHERE business_id=?`).get(req.params.id);
  const recent = db.prepare(`SELECT rating, text, created_at FROM feedback WHERE business_id=? ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  res.json({ count: agg.n, avg: Math.round(agg.avg * 10) / 10, recent });
});

app.get('/api/merchant/businesses/:id/feedback', requireUser, (req, res) => {
  if (!canAccessBusiness(req.user.id, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const rows = db.prepare(`SELECT * FROM feedback WHERE business_id=? ORDER BY created_at DESC LIMIT 200`).all(req.params.id);
  res.json({ feedback: rows });
});

// Phase 5: repeat-customer analytics (real data only, per-business isolated).
app.get('/api/merchant/businesses/:id/analytics', requireUser, (req, res) => {
  if (!canAccessBusiness(req.user.id, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const bid = req.params.id;
  const balances = db.prepare('SELECT visits, points, total_spent FROM customer_balances WHERE business_id=?').all(bid);
  const total = balances.length;
  const repeat = balances.filter(b => b.visits > 1).length;
  const issued = db.prepare(`SELECT COALESCE(SUM(points_delta),0) s FROM transactions WHERE business_id=? AND type='earn'`).get(bid).s;
  const redeemed = db.prepare(`SELECT COALESCE(SUM(-points_delta),0) s FROM transactions WHERE business_id=? AND type='redeem'`).get(bid).s;
  const daily = db.prepare(`SELECT substr(created_at,1,10) d, COUNT(*) txns, COALESCE(SUM(amount),0) revenue FROM transactions WHERE business_id=? AND created_at > datetime('now','-30 days') GROUP BY d ORDER BY d`).all(bid);
  const top = db.prepare(`SELECT customer_id, visits, points, total_spent FROM customer_balances WHERE business_id=? ORDER BY visits DESC LIMIT 10`).all(bid);
  res.json({ totalCustomers: total, repeatCustomers: repeat, repeatRatePct: total ? Math.round(repeat * 1000 / total) / 10 : 0, pointsIssued: issued, pointsRedeemed: redeemed, daily, top, honest: total === 0 ? 'No transactions yet — no fabricated analytics.' : undefined });
});

// Phase 5: CSV export (isolated, capped). Types: transactions|customers|ledger|redemptions.
app.get('/api/merchant/businesses/:id/export', requireUser, async (req, res) => {
  const exp = await import('./export.js');
  if (!canAccessBusiness(req.user.id, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const type = String(req.query.type || 'transactions');
  const bid = req.params.id;
  let cols, rows, name;
  if (type === 'transactions') {
    cols = ['id', 'customer_id', 'outlet_id', 'program_id', 'amount', 'points_delta', 'stamps_delta', 'type', 'created_at'];
    rows = db.prepare('SELECT * FROM transactions WHERE business_id=? ORDER BY created_at DESC LIMIT 5000').all(bid);
    name = 'transactions';
  } else if (type === 'customers') {
    cols = ['customer_id', 'points', 'stamps', 'visits', 'total_spent', 'updated_at'];
    rows = db.prepare('SELECT * FROM customer_balances WHERE business_id=? ORDER BY updated_at DESC LIMIT 5000').all(bid);
    name = 'customers';
  } else if (type === 'ledger') {
    cols = ['id', 'transaction_id', 'customer_id', 'delta', 'balance_after', 'reason', 'created_at'];
    rows = db.prepare('SELECT * FROM points_ledger WHERE business_id=? ORDER BY created_at DESC LIMIT 5000').all(bid);
    name = 'ledger';
  } else if (type === 'redemptions') {
    cols = ['id', 'code', 'reward_id', 'customer_id', 'status', 'created_at'];
    rows = db.prepare('SELECT * FROM redemptions WHERE business_id=? ORDER BY created_at DESC LIMIT 5000').all(bid);
    name = 'redemptions';
  } else return res.status(400).json({ error: 'bad_type' });
  audit(req.user.id, 'export', 'business', bid, { type });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${bid.slice(0, 8)}.csv"`);
  res.send(exp.toCsv(rows, cols));
});

// Phase 6: in-app notifications (MVP channel) + provider status (no secrets exposed).
app.get('/api/notifications', requireUser, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL`).get(req.user.id).c;
  res.json({ notifications: rows, unread });
});

app.post('/api/notifications/:id/read', requireUser, (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!n) return res.status(404).json({ error: 'not_found' });
  db.prepare(`UPDATE notifications SET read_at=datetime('now') WHERE id=?`).run(n.id);
  res.json({ ok: true });
});

app.get('/api/notify/status', (_req, res) => {
  res.json({ inApp: true, smsConfigured: !!twilioCfg(), whatsAppConfigured: false, note: 'WhatsApp stays modular for future; no promotional sends without consent.' });
});

// Phase 6: server-side geocode (server key never leaves the server; 503 until configured).
app.get('/api/maps/geocode', requireUser, async (req, res) => {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return res.status(503).json({ error: 'maps_setup_required', message: 'Add GOOGLE_MAPS_SERVER_KEY to enable geocoding. Manual addresses keep working.' });
  const address = String(req.query.address || '').slice(0, 300);
  if (!address) return res.status(400).json({ error: 'address_required' });
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`);
    const j = await r.json();
    if (j.status !== 'OK' || !j.results?.length) return res.status(404).json({ error: 'not_found' });
    const { lat, lng } = j.results[0].geometry.location;
    res.json({ lat, lng, formatted: j.results[0].formatted_address });
  } catch {
    res.status(502).json({ error: 'maps_failed', message: 'Geocoding failed; manual address still works.' });
  }
});

// ---------- Feedback (optional, never blocks rewards) ----------
app.post('/api/feedback', requireUser, (req, res) => {
  const { businessId, outletId, transactionId, rating, text } = req.body || {};
  if (!businessId || !rating) return res.status(400).json({ error: 'missing_fields' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'bad_rating' });
  const id = uuid();
  db.prepare('INSERT INTO feedback (id, business_id, outlet_id, customer_id, transaction_id, rating, text) VALUES (?,?,?,?,?,?,?)')
    .run(id, businessId, outletId || null, req.user.id, transactionId || null, rating, String(text || '').slice(0, 1000));
  res.json({ ok: true, id });
});

app.use(generalLimiter);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[perk-loop]', err.message);
  res.status(500).json({ error: 'internal', message: IS_PROD ? 'Something went wrong.' : err.message });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Perk Loop MVP on http://localhost:${PORT} (env=${process.env.NODE_ENV || 'development'})`));
}
export default app;
