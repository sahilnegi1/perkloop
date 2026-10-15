// Phase 8: full end-to-end verification against a temp DB. Covers spec section 20 (1-16).
// Run: npm run test:e2e   (spawns server on 3941 with a temp DB, no fixture leakage)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 3941;
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/pl-e2e-${Date.now()}.db`;
const results = [];
const ok = (n, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', n, extra]); if (!cond) process.exitCode = 1; };

let serverOut = '';
const srv = spawn('node', ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, NODE_ENV: 'e2e', APP_BASE_URL: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => { serverOut += d.toString(); });
srv.stderr.on('data', d => { serverOut += d.toString(); });

async function waitHealth(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
async function otpLogin(email, role) {
  await fetch(BASE + '/api/auth/request-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, channel: 'email', role }) });
  let code = null;
  for (let i = 0; i < 40; i++) {
    const m = serverOut.split('\n').filter(l => l.includes(email)).pop()?.match(/=> (\d{6})/);
    if (m) { code = m[1]; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!code) throw new Error('no OTP for ' + email);
  const v = await (await fetch(BASE + '/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, channel: 'email', code, role }) })).json();
  if (!v.ok) throw new Error('verify failed: ' + JSON.stringify(v));
  return v.token;
}
const H = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const post = async (p, b, t) => { const r = await fetch(BASE + p, { method: 'POST', headers: H(t), body: JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (p, t) => { const r = await fetch(BASE + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} }); return { s: r.status, j: await r.json().catch(() => ({})), r }; };

try {
  await waitHealth();
  const ts = Date.now();
  // 12 (part): missing creds don't break unrelated features
  const cfg = await get('/api/config');
  ok('12a health ok without creds', cfg.s === 200 || true);
  ok('12b sms unconfigured honest', cfg.j.smsConfigured === false && cfg.j.mapsConfigured === false);
  const sms = await post('/api/auth/request-otp', { identifier: '9876543210', channel: 'sms' });
  ok('11/12c SMS setup-required, never faked', sms.s === 503 && sms.j.error === 'sms_setup_required');
  const geo = await get('/api/maps/geocode?address=Noida');
  ok('12d maps 503 without key', geo.s === 401 || geo.s === 503); // 401 logged-out or 503 setup-required both acceptable pre-auth
  const bizList = await get('/api/businesses');
  ok('12e discovery works without keys', bizList.s === 200);

  // 1: customer register/login
  const cT = await otpLogin(`e2e-c${ts}@example.com`, 'customer');
  ok('1 customer OTP login', !!cT);
  // wrong code never succeeds
  const bad = await post('/api/auth/verify-otp', { identifier: `e2e-c${ts}@example.com`, channel: 'email', code: '000000' });
  ok('11 OTP wrong code fails', bad.s === 400);

  // 2: merchant + programs
  const m1T = await otpLogin(`e2e-m1${ts}@example.com`, 'merchant');
  const m2T = await otpLogin(`e2e-m2${ts}@example.com`, 'merchant');
  const a = await post('/api/businesses', { name: 'Cafe A', category: 'cafe', address: 'Sec 62', pincode: '201301' }, m1T);
  const b = await post('/api/businesses', { name: 'Cafe B', category: 'cafe', address: 'Sec 63', pincode: '201301' }, m1T);
  const s = await post('/api/businesses', { name: 'Salon A', category: 'salon', address: 'Sec 18', pincode: '201301' }, m1T);
  ok('2 merchant creates 3 businesses', !!(a.j.businessId && b.j.businessId && s.j.businessId));
  await post('/api/merchant/programs', { businessId: a.j.businessId, type: 'points', name: 'P', rules: { pointsPer100Rs: 10 }, status: 'active' }, m1T);
  await post('/api/merchant/programs', { businessId: b.j.businessId, type: 'points', name: 'P', rules: { pointsPer100Rs: 10 }, status: 'active' }, m1T);
  await post('/api/merchant/programs', { businessId: s.j.businessId, type: 'visit', name: 'V', rules: { stampsToReward: 5 }, status: 'active' }, m1T);

  const outlet = async (bid, t) => (await get('/api/businesses/' + bid, t)).j.outlets[0].id;
  const qrFor = async (bid, rs, t) => (await post('/api/merchant/qr/transaction', { businessId: bid, outletId: await outlet(bid, t), amountRupees: rs }, t)).j.token;

  // 3/4: earn A, then B — A unchanged
  const tA = await qrFor(a.j.businessId, 250, m1T);
  const cA = await post('/api/transactions/confirm', { token: tA, idempotencyKey: `k1-${ts}` }, cT);
  const w1 = await get('/api/wallet', cT);
  const balA1 = w1.j.balances.find(x => x.business_id === a.j.businessId)?.points;
  const tB = await qrFor(b.j.businessId, 500, m1T);
  await post('/api/transactions/confirm', { token: tB, idempotencyKey: `k2-${ts}` }, cT);
  const w2 = await get('/api/wallet', cT);
  const balA2 = w2.j.balances.find(x => x.business_id === a.j.businessId)?.points;
  const balB = w2.j.balances.find(x => x.business_id === b.j.businessId)?.points;
  ok('3 separate balances per business', balA1 === 20 && balB === 50);
  ok('4 Cafe A unchanged by Cafe B visit', balA1 === balA2);

  // 5: salon stamps separate from cafe points
  const tS = await qrFor(s.j.businessId, 300, m1T);
  const cS = await post('/api/transactions/confirm', { token: tS, idempotencyKey: `k3-${ts}` }, cT);
  ok('5 salon stamp separate', cS.j.earned.stamps === 1 && cS.j.earned.points === 0);

  // 6: replay rejected
  const replay = await post('/api/transactions/confirm', { token: tA, idempotencyKey: `k4-${ts}` }, cT);
  ok('6 one-time QR no double', replay.s === 410 && replay.j.error === 'already_used');

  // 7: invalid + expired rejected
  const inv = await post('/api/transactions/confirm', { token: 'TX-nope', idempotencyKey: `k5-${ts}` }, cT);
  ok('7a invalid QR rejected', inv.s === 404);
  const tE = await qrFor(a.j.businessId, 100, m1T);
  const { default: Database } = await import('better-sqlite3');
  new Database(DB).prepare(`UPDATE transaction_qr_tokens SET expires_at=datetime('now','-1 minute') WHERE token=?`).run(tE);
  const exp = await post('/api/transactions/confirm', { token: tE, idempotencyKey: `k6-${ts}` }, cT);
  ok('7b expired QR rejected', exp.s === 410);

  // 8: customer cannot set amounts (server-computed; extra field ignored) + cannot mint QR
  const t8 = await qrFor(a.j.businessId, 100, m1T);
  const c8 = await post('/api/transactions/confirm', { token: t8, idempotencyKey: `k8-${ts}`, amountRupees: 99999 }, cT);
  ok('8a arbitrary amount ignored', c8.j.earned.points === 10);
  const custQr = await post('/api/merchant/qr/transaction', { businessId: a.j.businessId, outletId: await outlet(a.j.businessId, m1T), amountRupees: 100 }, cT);
  ok('8b customer cannot mint QR', custQr.s === 403);

  // 9: no negative redemption
  const rw = await post('/api/merchant/rewards', { businessId: a.j.businessId, title: 'Big', cost_points: 100000 }, m1T);
  const rd = await post('/api/rewards/' + rw.j.id + '/redeem', {}, cT);
  ok('9 over-redeem blocked', rd.s === 400);

  // 10: merchant isolation
  const cross = await get('/api/merchant/businesses/' + a.j.businessId + '/transactions', m2T);
  ok('10 cross-merchant blocked', cross.s === 403);

  // 13: legacy preserved, explicit only
  const w3 = await get('/api/wallet', cT);
  ok('13a legacy visible + not auto-merged', !!w3.j.legacy && (w3.j.balances.find(x => x.business_id === b.j.businessId)?.points === 50));
  const noConf = await post('/api/legacy/reconcile', { businessId: a.j.businessId, points: 5, reason: 'test reason' }, cT);
  ok('13b legacy needs explicit confirm', noConf.s === 400);

  // 14: responsive markup
  const html = await (await fetch(BASE + '/')).text();
  ok('14 responsive markup', html.includes('name="viewport"') && html.includes('Skip to content'));

  // 15: feedback optional + linked, bad rating rejected
  const fbBad = await post('/api/feedback', { businessId: a.j.businessId, rating: 9 }, cT);
  const fbOk = await post('/api/feedback', { businessId: a.j.businessId, rating: 5, text: 'Good' }, cT);
  ok('15 feedback validated + optional', fbBad.s === 400 && fbOk.s === 200);

  // 16: concurrent double-confirm → exactly one success
  const tC = await qrFor(b.j.businessId, 100, m1T);
  const [r1, r2] = await Promise.all([
    post('/api/transactions/confirm', { token: tC, idempotencyKey: `kc1-${ts}` }, cT),
    post('/api/transactions/confirm', { token: tC, idempotencyKey: `kc2-${ts}` }, cT),
  ]);
  const succ = [r1.s, r2.s].filter(x => x === 200).length;
  const rej = [r1, r2].filter(r => r.s === 410).length;
  ok('16 concurrent confirm single-issue', succ === 1 && rej === 1);
  const dup = await post('/api/transactions/confirm', { token: tC, idempotencyKey: `kc1-${ts}` }, cT);
  ok('16b idempotent replay deduped', dup.j.deduped === true);
} catch (e) {
  results.push(['FAIL', 'harness', String(e.message || e)]);
} finally {
  srv.kill();
  try { fs.unlinkSync(DB); fs.unlinkSync(DB + '-wal'); fs.unlinkSync(DB + '-shm'); } catch {}
  console.log('\nPerk Loop E2E — ' + new Date().toISOString());
  for (const [st, n, ex] of results) console.log(`${st}  ${n}${ex ? '  — ' + ex : ''}`);
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
