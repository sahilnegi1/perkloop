const $ = s => document.querySelector(s);
const api = async (p, o = {}) => {
  const t = localStorage.getItem('pl_token');
  const r = await fetch(p, { headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, credentials: 'include', ...o });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ? `${j.error}${j.message ? ': ' + j.message : ''}` : 'request_failed');
  return j;
};
const CATS = [['cafe','Cafes'],['restaurant','Restaurants'],['salon','Salons'],['bakery','Bakeries'],['supermarket','Supermarkets'],['retail','Retail'],['gym','Gyms'],['laundry','Laundry'],['other','Other']];

function route() {
  const h = location.hash || '#';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  if (h.startsWith('#discover')) { $('#view-discover').classList.add('active'); loadDiscover(); }
  else if (h.startsWith('#category/')) { $('#view-discover').classList.add('active'); loadDiscover(h.split('/')[1] || ''); }
  else if (h.startsWith('#wallet')) { $('#view-wallet').classList.add('active'); loadWallet(); }
  else if (h.startsWith('#auth')) { $('#view-auth').classList.add('active'); const m = h.match(/role=(\w+)/); if (m) $('#aRole').value = m[1]; }
  else if (h.startsWith('#merchant')) { $('#view-merchant').classList.add('active'); loadMerchant(); }
  else if (h.startsWith('#legal')) { $('#view-legal').classList.add('active'); showLegal(h.split('/')[1] || 'privacy'); }
  else if (h.startsWith('#marketing')) { $('#view-marketing').classList.add('active'); }
  else if (h.startsWith('#scan/')) { $('#view-wallet').classList.add('active'); $('#scanToken').value = decodeURIComponent(h.split('/')[1] || ''); loadWallet(); checkQr(); }
  else if (h.startsWith('#outlet/')) { $('#view-wallet').classList.add('active'); loadWallet(); resolveOutlet(decodeURIComponent(h.split('/')[1] || '')); }
  else $('#view-home').classList.add('active');
  const active = document.querySelector('.view.active h1, .view.active h2');
  if (active) { active.setAttribute('tabindex', '-1'); try { active.focus({ preventScroll: true }); } catch {} }
  refreshMe();
}
window.addEventListener('hashchange', route);

async function refreshMe() {
  try { const { user } = await api('/api/me'); $('#navAuth').textContent = user ? (user.name || user.email || user.phone || 'Account') : 'Sign in'; }
  catch {}
}

async function boot() {
  try {
    const cfg = await api('/api/config');
    $('#cfgNote').textContent = `${cfg.smsConfigured ? 'SMS ready' : 'SMS setup required'} • ${cfg.mapsConfigured ? 'Maps ready' : 'Maps: manual address mode'}`;
    if (!cfg.mapsConfigured) $('#setupNote').innerHTML = `<div class="ok">Map integration requires setup — manual addresses shown. Add GOOGLE_MAPS_BROWSER_KEY to enable autocomplete.</div>`;
  } catch {}
  const mk = (el) => { el.innerHTML = `<button class="cat active" data-c="">All</button>` + CATS.map(([v, l]) => `<button class="cat" data-c="${v}">${l}</button>`).join(''); };
  mk($('#cats')); mk($('#homeCats'));
  document.querySelectorAll('.cat').forEach(b => b.onclick = () => { location.hash = '#discover'; loadDiscover(b.dataset.c); });
  try {
    const { categories } = await api('/api/categories');
    const map = Object.fromEntries(categories.map(c => [c.slug, c.count]));
    document.querySelectorAll('.cat[data-c]').forEach(b => { if (b.dataset.c && map[b.dataset.c] != null) b.textContent += ` (${map[b.dataset.c]})`; });
  } catch {}
  $('#btnSearch').onclick = () => loadDiscover();
  $('#btnOtp').onclick = requestOtp; $('#btnVerify').onclick = verifyOtp;
  $('#btnScan').onclick = checkQr;
  $('#btnCam').onclick = startCameraScan;
  $('#qrFile').onchange = scanFile; loadMyRedemptions(); loadNotif();
  await loadHome(); route();
}

async function loadHome() {
  try {
    const { businesses } = await api('/api/businesses');
    $('#homeBiz').innerHTML = businesses.slice(0, 6).map(b => bizCard(b)).join('') || '<div class="muted">No businesses yet — be the first in Noida!</div>';
    const cats = await api('/api/categories').catch(() => null);
    const total = cats ? cats.categories.reduce((a, c) => a + c.count, 0) : businesses.length;
    const el = $('#trustCounts');
    if (el) el.innerHTML = `<b>${total}</b>&nbsp;live ${total === 1 ? 'business' : 'businesses'} • real app data`;
  }
  catch { $('#homeBiz').innerHTML = '<div class="err">Cannot reach API. Start server: npm start</div>'; }
}
const bizCard = b => `<div class="card"><span class="tag">${b.category}</span><h3 style="margin:6px 0">${b.name}</h3><div class="muted">${b.address}, ${b.city} ${b.pincode}</div><div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="openBiz('${b.id}')">View loyalty program</button></div></div>`;
window.openBiz = async (id) => {
  const d = await api('/api/businesses/' + id);
  let mine = '', fb = '';
  try { const w = await api('/api/wallet'); const b = w.balances.find(x => x.business_id === id); if (b) mine = `<div class="ok">Your balance here: <b>${b.points} pts • ${b.stamps} stamps</b> (${b.visits} visits)</div>`; } catch {}
  try {
    const f = await api('/api/businesses/' + id + '/feedback');
    fb = `<h4>Customer feedback (${f.count || 0}${f.avg ? ` • avg ${f.avg}★` : ''})</h4>` + (f.recent.map(x => `<div>• ${x.rating}★ — ${String(x.text || '').slice(0, 140)} <span class="muted">${x.created_at}</span></div>`).join('') || '<div class="muted">No feedback yet — no fake reviews.</div>');
  } catch {}
  $('#bizDetail').innerHTML = `<div class="card"><h3>${d.business.name}</h3><div class="muted">${d.business.address}, ${d.business.city}</div>
    ${d.business.description ? `<div style="margin-top:6px">${d.business.description}</div>` : ''}
    ${mine}
    <h4>Loyalty programs</h4>${d.programs.map(p => `<div>• <b>${p.name}</b> (${p.type}) <span class="muted">${JSON.stringify(p.rules)}</span></div>`).join('') || '<div class="muted">No active program yet.</div>'}
    <h4>Rewards</h4>${d.rewards.map(r => `<div>• <b>${r.title}</b> — ${r.cost_points} pts / ${r.cost_stamps} stamps <button class="btn btn-sm btn-warm" onclick="redeem('${r.id}')">Redeem</button></div>`).join('') || '<div class="muted">No rewards yet.</div>'}
    ${fb}
    <div class="muted" style="margin-top:8px">${d.business.lat ? `<a href="https://www.google.com/maps/search/?api=1&query=${d.business.lat},${d.business.lng}" target="_blank" rel="noopener">Open in Maps</a> • ` : ''}Manual address mode${d.business.lat ? '' : ' (maps setup required for live pins)'}. Directions: search “${d.business.name} ${d.business.city}” in your maps app.</div></div>`;
  $('#bizDetail').scrollIntoView();
};
window.redeem = async (id) => {
  try { const r = await api(`/api/rewards/${id}/redeem`, { method: 'POST' }); alert(`Request ${r.code} — show to merchant for approval.`); loadWallet(); }
  catch (e) { alert('Redeem failed: ' + e.message); }
};

let activeCat = '';
async function loadDiscover(cat) {
  if (cat !== undefined) activeCat = cat;
  document.querySelectorAll('#cats .cat').forEach(b => b.classList.toggle('active', b.dataset.c === activeCat));
  const q = $('#q').value || '';
  const { businesses } = await api(`/api/businesses?category=${encodeURIComponent(activeCat)}&q=${encodeURIComponent(q)}`);
  $('#bizList').innerHTML = businesses.map(bizCard).join('') || '<div class="card">No matches. Try another area or category.</div>';
}

async function loadWallet() {
  let box = $('#walletBox'); box.innerHTML = 'Loading…';
  try {
    const w = await api('/api/wallet');
    if (!w.balances.length) box.innerHTML = `<div class="card">No loyalty balances yet. Visit a business and scan their bill QR. ${w.legacy?.points ? `<div class="muted">Legacy balance preserved: ${w.legacy.points} pts (not redeemable directly).</div>` : ''}</div>` + txnHtml(w);
    else box.innerHTML = `<div class="card"><b>Informational total: ${w.totalPointsDisplayOnly} pts</b><div class="muted">${w.notice}</div>${w.legacy?.points ? `<div class="muted">Legacy: ${w.legacy.points} pts preserved separately.</div>` : ''}</div>
      <div class="grid c3" style="margin-top:10px">${w.balances.map(b => `<div class="card"><b>${b.business_name}</b> <span class="tag">${b.category}</span><div class="kpi">${b.points} pts • ${b.stamps} stamps</div><div class="muted">${b.visits} visits • Rs.${(b.total_spent / 100).toFixed(0)} spent</div><button class="btn btn-ghost btn-sm" onclick="openBiz('${b.business_id}')">Rewards</button></div>`).join('')}</div>` + txnHtml(w);
  } catch (e) { box.innerHTML = `<div class="err">Login required to see wallet. <a href="#auth">Sign in</a> (${e.message})</div>`; }
  loadNotif();
}
const txnHtml = w => `<h3>Recent activity</h3>${w.recentTransactions.map(t => `<div class="card" style="margin:6px 0">• ${t.business_name || t.business_id} — ${t.type} ${t.points_delta} pts ${t.amount ? `(Rs.${(t.amount / 100).toFixed(2)})` : ''} <span class="muted">${t.created_at}</span></div>`).join('') || '<div class="muted">No transactions yet.</div>'}
  <h3>Available rewards at your shops</h3>${w.availableRewards.map(r => `<div class="card" style="margin:6px 0"><b>${r.business_name}</b>: ${r.title} — ${r.cost_points} pts <button class="btn btn-sm btn-warm" onclick="redeem('${r.id}')">Redeem</button></div>`).join('') || '<div class="muted">No rewards yet.</div>'}`;

async function checkQr() {
  const tok = $('#scanToken').value.trim(); if (!tok) return;
  const out = $('#scanOut'); out.innerHTML = 'Validating…';
  try {
    const info = await api('/api/qr/' + encodeURIComponent(tok) + '/info');
    out.innerHTML = `<div class="card"><b>${info.business.name}</b> — pay Rs.${info.amountRupees}<div class="muted">One-time code, expires ${info.expiresAt}. Points credit to this business only.</div><button class="btn btn-warm" id="btnConfirm">Confirm & earn</button></div>`;
    $('#btnConfirm').onclick = async () => {
      const r = await api('/api/transactions/confirm', { method: 'POST', body: JSON.stringify({ token: tok, idempotencyKey: crypto.randomUUID() }) });
      out.innerHTML = `<div class="ok">Earned ${r.earned.points} pts + ${r.earned.stamps} stamps at ${info.business.name}. <a href="#wallet">Refresh wallet</a></div>` + feedbackHtml(info);
      loadWallet();
    };
  } catch (e) { out.innerHTML = `<div class="err">QR rejected: ${e.message} (expired / already-used / invalid are rejected — no points issued).</div>`; }
}

// Phase 4: camera scan via native BarcodeDetector, file fallback via jsQR CDN.
let camStream = null;
function tokenFromText(t) {
  t = String(t || '').trim();
  const m1 = t.match(/#scan\/([A-Za-z0-9\-_]+)/); if (m1) return m1[1];
  const m2 = t.match(/#outlet\/([A-Za-z0-9\-_]+)/); if (m2) return m2[1];
  return t.split('/').pop();
}
async function startCameraScan() {
  const v = $('#camVideo'), out = $('#scanOut');
  if (!('BarcodeDetector' in window)) { out.innerHTML = '<div class="err">Camera barcode detection not supported here. Paste the token or upload a QR photo.</div>'; return; }
  try {
    camStream?.getTracks().forEach(t => t.stop());
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    v.srcObject = camStream; v.style.display = 'block'; await v.play();
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    out.innerHTML = '<div class="muted">Point camera at the QR…</div>';
    const loop = async () => {
      if (!camStream) return;
      try {
        const codes = await det.detect(v);
        if (codes.length) {
          const tok = tokenFromText(codes[0].rawValue);
          camStream.getTracks().forEach(t => t.stop()); camStream = null; v.style.display = 'none';
          $('#scanToken').value = tok;
          if (tok.startsWith('ST-')) resolveOutlet(tok); else checkQr();
          return;
        }
      } catch {}
      setTimeout(loop, 400);
    };
    loop();
    setTimeout(() => { if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; v.style.display = 'none'; out.innerHTML += '<div class="muted">Camera stopped (timeout). Try again or paste token.</div>'; } }, 60000);
  } catch { out.innerHTML = '<div class="err">Camera permission denied. Paste the token or upload a photo.</div>'; }
}
async function scanFile(e) {
  const f = e.target.files?.[0]; if (!f) return;
  const out = $('#scanOut'); out.innerHTML = 'Reading photo…';
  try {
    if (!window.jsQR) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const code = window.jsQR(d.data, d.width, d.height);
    if (!code) { out.innerHTML = '<div class="err">No QR found in photo.</div>'; return; }
    const tok = tokenFromText(code.data);
    $('#scanToken').value = tok;
    if (tok.startsWith('ST-')) resolveOutlet(tok); else checkQr();
  } catch { out.innerHTML = '<div class="err">Could not read photo. Paste the token instead.</div>'; }
}
async function resolveOutlet(tok) {
  const out = $('#scanOut'); out.innerHTML = 'Resolving outlet…';
  try {
    const r = await api('/api/outlets/static/' + encodeURIComponent(tok));
    out.innerHTML = `<div class="card"><b>${r.business.name}</b> <span class="tag">${r.business.category}</span><div class="muted">Outlet: ${r.outlet.name}. Static QR identifies the shop only — ask staff for a bill QR to earn.</div><button class="btn btn-ghost btn-sm" onclick="openBiz('${r.business.id}')">View programs</button></div>`;
  } catch (e) { out.innerHTML = `<div class="err">Outlet QR invalid: ${e.message}</div>`; }
}
async function loadNotif() {
  try {
    const { notifications, unread } = await api('/api/notifications');
    const el = $('#notifBox');
    if (el && notifications.length) el.innerHTML = `<h3>Notifications ${unread ? `(${unread} new)` : ''}</h3>` + notifications.slice(0, 10).map(n => `<div class="card" style="margin:6px 0"><b>${n.title}</b><div class="muted">${n.body}</div>${!n.read_at ? `<button class="btn btn-ghost btn-sm" onclick="markRead('${n.id}')">Mark read</button>` : ''}</div>`).join('');
  } catch {}
}
window.markRead = async (id) => { await api('/api/notifications/' + id + '/read', { method: 'POST' }); loadNotif(); };
async function loadMyRedemptions() {
  try {
    const { redemptions } = await api('/api/redemptions/mine');
    const el = $('#myRedemptions');
    if (el && redemptions.length) el.innerHTML = `<h3>My redemptions</h3>` + redemptions.slice(0, 10).map(r => `<div class="card" style="margin:6px 0"><b>${r.business_name}</b>: ${r.reward_title} — <span class="tag">${r.status}</span> <span class="muted">${r.code}</span></div>`).join('');
  } catch {}
}
const feedbackHtml = info => `<div class="card" style="margin-top:8px"><b>Optional feedback</b><div style="display:flex;gap:6px;margin:6px 0">${[1, 2, 3, 4, 5].map(n => `<button class="btn btn-ghost btn-sm" onclick="sendFb('${info.business.id ?? ''}','${info.token}',${n})">${n}★</button>`).join('')}</div><div class="muted">Skipping never loses rewards.</div></div>`;
window.sendFb = async (bid, _tok, rating) => {
  // business id lookup simplified: use wallet business list
  try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ businessId: bid, rating }) }); alert('Thanks!'); }
  catch (e) { alert('Feedback needs a valid business page — open it from Discover first.'); }
};

async function requestOtp() {
  const out = $('#authOut'); out.innerHTML = 'Sending…';
  try {
    const r = await api('/api/auth/request-otp', { method: 'POST', body: JSON.stringify({ identifier: $('#aId').value, channel: $('#aChannel').value, name: $('#aName').value, role: $('#aRole').value }) });
    out.innerHTML = `<div class="ok">Code generated (${r.delivered}). ${r.devHint || ''}</div>`;
  } catch (e) { out.innerHTML = `<div class="err">${e.message}</div>`; }
}
async function verifyOtp() {
  const out = $('#authOut');
  try {
    const r = await api('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ identifier: $('#aId').value, channel: $('#aChannel').value, code: $('#aCode').value, name: $('#aName').value, role: $('#aRole').value }) });
    localStorage.setItem('pl_token', r.token);
    out.innerHTML = `<div class="ok">Welcome, ${r.user.role}! <a href="${r.user.role === 'merchant' ? '#merchant' : '#wallet'}">Continue →</a></div>`;
    refreshMe();
  } catch (e) { out.innerHTML = `<div class="err">${e.message} — we never report success unless the server verifies the code.</div>`; }
}

async function loadMerchant() {
  const box = $('#mBox'); box.innerHTML = 'Loading…';
  try {
    const { businesses } = await api('/api/merchant/overview');
    if (!businesses.length) box.innerHTML = `<div class="card"><b>No business yet.</b><div class="muted">Register one to get outlet QR + programs.</div>
      <div class="grid c2" style="margin-top:8px"><input id="bName" placeholder="Business name"><select id="bCat">${CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <input id="bAddr" placeholder="Address"><input id="bPin" placeholder="PIN code (6 digits)"></div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-primary" id="btnBiz">Create business</button><button class="btn btn-ghost btn-sm" id="btnGeo">Geocode address</button></div><div id="geoOut" class="muted" style="font-size:12px"></div></div>`;
    else {
      const b = businesses[0];
      box.innerHTML = `<div class="card"><b>${b.business.name}</b> <span class="tag">${b.business.category}</span><div class="muted">${b.stats.txns} txns • ${b.stats.pts} pts issued • ${b.members} customers</div></div>
      <div class="grid c2" style="margin-top:10px">
      <div class="card"><b>New program</b><input id="pName" placeholder="e.g. Coffee stamps"><select id="pType"><option value="points">Points (per Rs.100)</option><option value="visit">Visit stamps</option><option value="count">Service count</option><option value="star">Stars</option><option value="spend">Spend threshold</option><option value="custom">Custom offer</option></select><input id="pRules" placeholder='Rules JSON e.g. {"pointsPer100Rs":10}'><button class="btn btn-primary btn-sm" id="btnProg">Create (active)</button></div>
      <div class="card"><b>Bill QR (one-time)</b><input id="qrAmt" type="number" placeholder="Amount Rs. e.g. 250"><button class="btn btn-warm btn-sm" id="btnQr">Generate QR</button><div id="qrOut" style="margin-top:8px"></div><div class="muted">Merchant-reported amount. Single-use, ${300}s expiry.</div></div>
      </div><div class="card" style="margin-top:10px"><b>New reward</b><div class="grid c2"><input id="rTitle" placeholder="Free cappuccino"><input id="rCost" type="number" placeholder="Cost (pts or stamps)"><select id="rKind"><option value="points">points</option><option value="stamps">stamps</option></select></div><button class="btn btn-primary btn-sm" id="btnRw" style="margin-top:8px">Create reward</button><div class="muted" style="font-size:12px">Limits/dates via API; visual editor in final polish.</div></div>
      <div class="card" style="margin-top:10px"><b>Programs</b><div id="progList" class="muted">Loading…</div></div>
      <div class="card" style="margin-top:10px"><b>Pending redemptions</b><div id="rdList" class="muted">Loading…</div></div>
      <div class="card" style="margin-top:10px"><b>Outlets & static QR</b><div id="outList" class="muted">Loading…</div></div>
      <div class="card" style="margin-top:10px"><b>Analytics (real data)</b><div id="anaBox" class="muted">Loading…</div><div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" onclick="dlExport('transactions')">Transactions CSV</button><button class="btn btn-ghost btn-sm" onclick="dlExport('customers')">Customers CSV</button><button class="btn btn-ghost btn-sm" onclick="dlExport('ledger')">Ledger CSV</button><button class="btn btn-ghost btn-sm" onclick="dlExport('redemptions')">Redemptions CSV</button></div></div>
      <div class="card" style="margin-top:10px"><b>Customer feedback</b><div id="mFb" class="muted">Loading…</div></div>
      <div class="muted" style="margin-top:8px">Outlet static QR identifies the shop only — never awards points by itself.</div>`;
      wireMerchant(b.business.id);
      return;
    }
    window._geo = null;
    $('#btnGeo').onclick = async () => {
      try {
        const g = await api('/api/maps/geocode?address=' + encodeURIComponent($('#bAddr').value + ', ' + $('#bPin').value));
        window._geo = g; $('#geoOut').textContent = `Located: ${g.formatted} (${g.lat}, ${g.lng})`;
      } catch (e) { $('#geoOut').textContent = 'Geocode unavailable (' + e.message + ') — manual address works.'; }
    };
    $('#btnBiz').onclick = async () => {
      await api('/api/businesses', { method: 'POST', body: JSON.stringify({ name: $('#bName').value, category: $('#bCat').value, address: $('#bAddr').value, pincode: $('#bPin').value, lat: window._geo?.lat, lng: window._geo?.lng }) });
      loadMerchant();
    };
  } catch (e) { box.innerHTML = `<div class="err">Merchant login required. <a href="#auth?role=merchant">Sign in as business</a> (${e.message})</div>`; }
}
async function wireMerchant(bid) {
  const outlets = (await api('/api/businesses/' + bid)).outlets;
  const outletId = outlets[0]?.id;
  const examples = { points: '{"pointsPer100Rs":10}', visit: '{"stampsToReward":5}', count: '{"stampsToReward":5}', star: '{"stampsToReward":5}', spend: '{"thresholdPaise":50000,"bonusPoints":20}', custom: '{"flatPoints":10,"flatStamps":0}' };
  $('#pType').onchange = (e) => { $('#pRules').placeholder = 'Rules JSON e.g. ' + (examples[e.target.value] || '{}'); };
  $('#btnProg').onclick = async () => {
    let rules = {}; try { rules = JSON.parse($('#pRules').value || '{}'); } catch { return alert('Bad JSON'); }
    await api('/api/merchant/programs', { method: 'POST', body: JSON.stringify({ businessId: bid, name: $('#pName').value, type: $('#pType').value, rules, status: 'active' }) });
    alert('Program created'); loadMerchant();
  };
  $('#btnQr').onclick = async () => {
    const r = await api('/api/merchant/qr/transaction', { method: 'POST', body: JSON.stringify({ businessId: bid, outletId, amountRupees: Number($('#qrAmt').value) }) });
    $('#qrOut').innerHTML = `<img class="qr" src="${r.qrDataUrl}"><pre class="code">${r.token}</pre><div class="muted">Customer: copy token into Wallet → Scan, or open #scan/${r.token}</div>`;
  };
  $('#btnRw').onclick = async () => {
    const kind = $('#rKind').value, cost = Number($('#rCost').value);
    await api('/api/merchant/rewards', { method: 'POST', body: JSON.stringify({ businessId: bid, title: $('#rTitle').value, cost_points: kind === 'points' ? cost : 0, cost_stamps: kind === 'stamps' ? cost : 0 }) });
    alert('Reward created'); loadMerchant();
  };
  loadProgList(bid); loadRdList(bid); loadOutList(bid); loadAna(bid); loadMFb(bid);
  window._bid = bid;
}
window.dlExport = async (type) => {
  const t = localStorage.getItem('pl_token');
  const r = await fetch(`/api/merchant/businesses/${window._bid}/export?type=${type}`, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  if (!r.ok) return alert('Export failed');
  const blob = await r.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${type}.csv`; a.click();
};
async function loadAna(bid) {
  try {
    const a = await api('/api/merchant/businesses/' + bid + '/analytics');
    $('#anaBox').innerHTML = a.totalCustomers === 0 ? `<div class="muted">${a.honest}</div>` : `<div>${a.totalCustomers} customers • ${a.repeatCustomers} repeat (${a.repeatRatePct}%) • ${a.pointsIssued} issued • ${a.pointsRedeemed} redeemed</div><div class="muted">Last 30d: ${a.daily.map(d => `${d.d}:${d.txns}`).join(' ') || '—'}</div>`;
  } catch { const el = $('#anaBox'); if (el) el.innerHTML = 'Login required.'; }
}
async function loadMFb(bid) {
  try {
    const { feedback } = await api('/api/merchant/businesses/' + bid + '/feedback');
    $('#mFb').innerHTML = feedback.slice(0, 20).map(f => `<div>• ${f.rating}★ — ${String(f.text || '').slice(0, 140)} <span class="muted">${f.created_at}</span></div>`).join('') || 'No feedback yet.';
  } catch {}
}
window.setProgStatus = async (id, status) => {
  await api('/api/merchant/programs/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
  loadMerchant();
};
window.decideRd = async (id, act) => {
  await api(`/api/merchant/redemptions/${id}/${act}`, { method: 'POST' });
  loadMerchant();
};
async function loadProgList(bid) {
  try {
    const { programs } = await api('/api/merchant/programs?businessId=' + bid);
    $('#progList').innerHTML = programs.map(p => `<div>• <b>${p.name}</b> (${p.type}, ${p.status}) <span class="muted">${p.rules_json}</span> ${p.status === 'active' ? `<button class="btn btn-ghost btn-sm" onclick="setProgStatus('${p.id}','paused')">Pause</button>` : `<button class="btn btn-ghost btn-sm" onclick="setProgStatus('${p.id}','active')">Activate</button>`}</div>`).join('') || 'No programs.';
  } catch (e) { const el = $('#progList'); if (el) el.innerHTML = 'Owner-only or login required.'; }
}
async function loadRdList(bid) {
  try {
    const { redemptions } = await api('/api/merchant/redemptions?businessId=' + bid + '&status=pending');
    $('#rdList').innerHTML = redemptions.map(r => `<div>• <b>${r.code}</b> <span class="muted">${r.customer_id.slice(0, 8)}</span> <button class="btn btn-warm btn-sm" onclick="decideRd('${r.id}','approve')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="decideRd('${r.id}','reject')">Reject</button></div>`).join('') || 'No pending redemptions.';
  } catch (e) { const el = $('#rdList'); if (el) el.innerHTML = 'Login required.'; }
}
async function loadOutList(bid) {
  try {
    const { outlets } = await api('/api/businesses/' + bid);
    $('#outList').innerHTML = (outlets || []).map(o => `<div>• <b>${o.name}</b> <button class="btn btn-ghost btn-sm" onclick="showStaticQr('${o.id}')">Static QR</button><span id="sq-${o.id}"></span></div>`).join('');
  } catch {}
}
window.showStaticQr = async (oid) => {
  const r = await api('/api/merchant/outlets/' + oid + '/static-qr');
  const el = document.querySelector('#sq-' + oid);
  if (el) el.innerHTML = `<br><img class="qr" src="${r.qrDataUrl}"><pre class="code">${r.staticToken}</pre>`;
};

function showLegal(k) {
  const T = { privacy: ['Privacy Policy', 'We store name, email/phone, per-business loyalty balances and transactions. Contact details are never shown to other merchants. OTP codes are hashed. No sale of data. Delete: email support@perploop.in.'], terms: ['Terms & Conditions', 'Per-business balances only; display totals are not redeemable across shops. QR codes are single-use and expiring. Merchant-reported amounts are not payment-verified. Rewards subject to each shop’s terms and dates.'], support: ['Support & Contact', 'Launch area: Noida, Greater Noida, NCR. Email: support@perploop.in. For SMS/Maps setup, see deployment notes (honest setup-required states).'] };
  $('#legalTitle').textContent = (T[k] || T.privacy)[0]; $('#legalBody').textContent = (T[k] || T.privacy)[1];
}
boot();
