/* Brew & Bites Cafe — app logic.
   Flow: name+OTP login → auto table → menu → cart → PLACE ORDER (each
   placement is its own order; the admin is notified with table + items and
   sets an estimated serve time) → order stays OPEN until paid → "Pay your
   bill" totals ALL open orders → UPI payment (deep link / QR / demo) →
   orders marked PAID → admin notified → table freed → customer is logged
   out automatically.

   Static (no backend) build: data lives in localStorage; the admin dashboard
   updates live across tabs/windows on the same device via the storage event,
   and across ANY device when the optional Firebase sync (CAFE.rt) is enabled.
   The admin can set the real UPI ID at runtime (Admin → UPI Settings); with
   Firebase enabled that ID is synced to all customer devices automatically. */

'use strict';

/* ============ helpers ============ */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const store = {
  get(k, d) {
    try { const v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? d : v; }
    catch (e) { return d; }
  },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem(k); }
};

const fmtINR = n => '\u20B9' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();
const fmtTime = iso => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const orderId = () => 'CAF-' + Math.floor(10000 + Math.random() * 89999);

/* ============ state ============ */
const state = {
  user: store.get('cafe_session', null),      // { name, phone, table, loginAt }
  cart: store.get('cafe_cart', {}),           // { itemId: qty } — staging area for the next order batch
  pending: store.get('cafe_pending', null),   // initiated-but-unconfirmed payment
  billOrder: null,                            // combined bill being paid {items, subtotal, tax, total, orderIds}
  lastOrder: null,
  logoutTimer: null,
  otp: null, otpPhone: null, otpName: null,
  adminAuthed: store.get('cafe_admin_authed', false),
  adminTab: 'orders',
  lastSeenPay: store.get('cafe_admin_lastseen', ''),
  lastSeenOrder: store.get('cafe_admin_lastorder', ''),
  activeCat: Object.keys(MENU)[0]
};

const RT = (CAFE.rt && typeof CAFE.rt === 'object') ? CAFE.rt : { enabled: false, url: '' };

/* ============ UPI readiness (real VPA from config / admin override / Firebase) ============ */
const DEFAULT_VPA = 'brewandbites@upi';
let remoteVpa = null; // UPI id synced via Firebase config

async function fetchRemoteVpa() {
  if (!rtEnabled() || remoteVpa !== null) return;
  try {
    const r = await fetch(RT.url + '/config/upiId.json');
    const v = await r.json();
    remoteVpa = v ? String(v) : '';
  } catch (e) { remoteVpa = ''; }
}

function effectiveVpa() {
  const local = store.get('cafe_upi_override', '');
  if (remoteVpa && remoteVpa.includes('@')) return remoteVpa;
  if (local && local.includes('@')) return local;
  return CAFE.upiId;
}

const isDefaultVpa = () => {
  const v = effectiveVpa();
  return !v || !String(v).includes('@') || String(v).trim().toLowerCase() === DEFAULT_VPA;
};
const isMobileUA = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
const isIOSUA = () => /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
const otpMode = () => (CAFE.otp && CAFE.otp.mode) || 'demo';
const otpLen = () => (otpMode() === 'firebase' ? 6 : 4);

function copyText(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return true; }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) { /* clipboard unavailable */ }
  return true;
}

/* ============ tables ============ */
function getTables() {
  let tables = store.get('cafe_tables', null);
  if (!tables) {
    tables = Array.from({ length: CAFE.tables || 12 }, (_, i) => ({ no: i + 1, status: 'free', by: null, assignedAt: null }));
    store.set('cafe_tables', tables);
  }
  return tables;
}
function saveTables(tables) { store.set('cafe_tables', tables); }

function assignTable(name, phone) {
  const tables = getTables();
  const free = tables.find(t => t.status === 'free');
  if (!free) return null;
  free.status = 'occupied';
  free.by = { name, phone };
  free.assignedAt = nowISO();
  saveTables(tables);
  return free.no;
}
function releaseTable(no) {
  const tables = getTables();
  const t = tables.find(x => x.no === no);
  if (t) { t.status = 'free'; t.by = null; t.assignedAt = null; saveTables(tables); }
}

/* ============ menu / cart / bill ============ */
const cartCount = () => Object.values(state.cart).reduce((a, b) => a + b, 0);

function cartItems() {
  const out = [];
  for (const [id, qty] of Object.entries(state.cart)) {
    const item = findItem(id);
    if (item && qty > 0) out.push({ ...item, qty });
  }
  return out;
}

function findItem(id) {
  for (const cat of Object.values(MENU)) {
    const f = cat.items.find(i => i.id === id);
    if (f) return f;
  }
  return null;
}

function bill(items) {
  const list = items || cartItems();
  const subtotal = list.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = Math.round(subtotal * CAFE.gstRate * 100) / 100;
  return { items: list, subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

function mergeItems(a, b) {
  const map = new Map();
  [...a, ...b].forEach(i => {
    const k = i.id || i.itemId;
    if (map.has(k)) map.get(k).qty += i.qty;
    else map.set(k, { ...i });
  });
  return Array.from(map.values());
}

/* ============ orders ============ */
function getOrders() { return store.get('cafe_orders', []); }
function saveOrders(list) { store.set('cafe_orders', list); }

/* every placement is its own order; all of a customer's orders stay OPEN
   until the bill is paid */
function getOpenOrders() {
  return getOrders().filter(o => (o.status === 'open' || o.status === 'accepted' || o.status === 'preparing') && o.phone === state.user.phone);
}

function etaText(o) { return o.etaMin ? o.etaMin + ' min' : 'ETA \u2014'; }

/* progress toward the ETA (0–100%); null when no ETA set yet */
function pctFor(o) {
  if (!o.etaMin) return null;
  const elapsed = Date.now() - new Date(o.updatedAt || o.placedAt).getTime();
  return Math.max(0, Math.min(100, Math.round(elapsed / (o.etaMin * 60000) * 100)));
}

function statusText(o, pct) {
  if (o.status === 'open') return 'Waiting for the kitchen to accept\u2026';
  if (o.status === 'accepted') return 'Accepted \u2014 the kitchen is on it!';
  if (pct === null) return 'Preparing\u2026 ETA ' + etaText(o);
  if (pct >= 100) return 'Almost ready! \uD83D\uDD14';
  return 'Preparing\u2026 ' + pct + '% \u00B7 ETA ' + o.etaMin + ' min';
}

/* auto-accept ~10s after placement (kitchen takes the order) */
function acceptOrder(id) {
  const orders = getOrders();
  const o = orders.find(x => x.id === id);
  if (!o || o.status !== 'open') return;
  o.status = 'accepted';
  o.updatedAt = nowISO();
  saveOrders(orders);
  rtPushOrder(o);
  document.dispatchEvent(new CustomEvent('cafe:order', { detail: { order: o, isNew: false } }));
}

function rtPushOrder(order) {
  if (!rtEnabled()) return;
  try {
    fetch(RT.url + '/orders/' + encodeURIComponent(order.id) + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order)
    }).catch(() => {});
  } catch (e) { /* offline */ }
}

function upsertOrder(order, isNew) {
  const list = getOrders();
  const idx = list.findIndex(o => o.id === order.id);
  if (idx >= 0) list[idx] = order; else list.unshift(order);
  saveOrders(list);
  rtPushOrder(order);
  document.dispatchEvent(new CustomEvent('cafe:order', { detail: { order, isNew } }));
  if (isNew) { toast('Order sent to the kitchen \uD83D\uDC68\u200D\uD83C\uDF73', '\uD83D\uDCE3', 'success'); notifySound(); }
  return order;
}

/* place the cart as a NEW order — the kitchen is notified each time */
function placeOrder() {
  const items = cartItems();
  if (!items.length) { toast('Add something to your cart first', '\u26A0\uFE0F', 'warn'); return; }
  const order = { id: orderId(), table: state.user.table, name: state.user.name || '', phone: state.user.phone, items, status: 'open', placedAt: nowISO(), updatedAt: nowISO() };
  upsertOrder(order, true);
  state.cart = {};
  store.set('cafe_cart', state.cart);
  updateBadge();
  go('#/menu');
}

/* pay the TOTAL of all open orders (auto-including anything still in cart) */
function payBill() {
  const staged = cartItems();
  let orders = getOpenOrders();
  if (staged.length) {
    const o = { id: orderId(), table: state.user.table, name: state.user.name || '', phone: state.user.phone, items: staged, status: 'open', placedAt: nowISO(), updatedAt: nowISO() };
    upsertOrder(o, true);
    orders = getOpenOrders();
    state.cart = {};
    store.set('cafe_cart', state.cart);
    updateBadge();
  }
  if (!orders.length) { toast('Nothing to pay yet', '\u26A0\uFE0F', 'warn'); return; }
  const combined = bill(mergeItems([], orders.flatMap(o => o.items)));
  state.billOrder = { ...combined, orderIds: orders.map(o => o.id) };
  go('#/pay');
}

/* ============ toast + sound ============ */
function toast(msg, icon = '\u2139\uFE0F', type = '') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span class="t-icon">' + icon + '</span><span>' + esc(msg) + '</span>';
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3400);
}

let audioCtx = null;
function beep(freq = 880, dur = 0.18, when = 0) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine'; o.frequency.value = freq;
    const t = audioCtx.currentTime + when;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  } catch (e) { /* audio unavailable */ }
}
function notifySound() { beep(880, 0.16); beep(1174, 0.2, 0.18); beep(1568, 0.28, 0.36); }

/* ============ realtime (optional Firebase RTDB) ============ */
function rtEnabled() { return !!(RT.enabled && RT.url); }

function rtPush(order) {
  if (!rtEnabled()) return;
  try {
    fetch(RT.url + '/payments/' + encodeURIComponent(order.txnId) + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order)
    }).catch(() => {});
  } catch (e) { /* offline */ }
}

function mergeRemote(all) {
  const local = store.get('cafe_payments', []);
  const map = new Map(local.map(p => [p.txnId, p]));
  Object.values(all || {}).forEach(p => { if (p && p.txnId) map.set(p.txnId, p); });
  const merged = Array.from(map.values()).sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
  store.set('cafe_payments', merged);
  return merged;
}

function mergeRemoteOrders(all) {
  const local = getOrders();
  const map = new Map(local.map(o => [o.id, o]));
  Object.values(all || {}).forEach(o => { if (o && o.id) map.set(o.id, o); });
  const merged = Array.from(map.values()).sort((a, b) => new Date(b.updatedAt || b.placedAt) - new Date(a.updatedAt || a.placedAt));
  saveOrders(merged);
  return merged;
}

let rtPulling = false;
async function rtPull() {
  if (!rtEnabled() || rtPulling) return; // re-entrancy guard (drawAdmin → rtPull)
  rtPulling = true;
  try {
    const [pRes, oRes] = await Promise.all([
      fetch(RT.url + '/payments.json'),
      fetch(RT.url + '/orders.json')
    ]);
    const all = await pRes.json();
    if (all) mergeRemote(all);
    const oAll = await oRes.json();
    if (oAll) mergeRemoteOrders(oAll);
    if (state.adminAuthed && (location.hash || '').startsWith('#/admin')) drawAdmin();
  } catch (e) { /* offline */ } finally { rtPulling = false; }
}

let rtSource = null;
function rtSubscribe() {
  if (!rtEnabled() || typeof EventSource === 'undefined') return;
  try {
    if (rtSource) rtSource.close();
    rtSource = new EventSource(RT.url + '/.json');
    rtSource.onmessage = ev => {
      try {
        const snap = JSON.parse(ev.data);
        if (!snap) return;
        if (snap.payments) {
          const merged = mergeRemote(snap.payments);
          const last = merged[0];
          if (last && last.txnId !== state.lastSeenPay) {
            state.lastSeenPay = last.txnId;
            store.set('cafe_admin_lastseen', last.txnId);
            onNewPayment(last);
          }
        }
        if (snap.orders) {
          const merged = mergeRemoteOrders(snap.orders);
          const latest = merged[0];
          if (latest) onOrderEvent({ order: latest, isNew: false });
        }
        if (snap.config && snap.config.upiId) {
          remoteVpa = String(snap.config.upiId);
          if ((location.hash || '').startsWith('#/pay')) router();
        }
      } catch (e) { /* bad frame */ }
    };
    rtSource.onerror = () => { /* EventSource auto-reconnects */ };
  } catch (e) { /* unsupported */ }
}

/* ============ modal ============ */
function openModal(html) {
  const wrap = $('#modalWrap');
  wrap.innerHTML = '<div class="modal-mask" id="modalMask"><div class="modal">' + html + '</div></div>';
  $('#modalMask').addEventListener('click', e => { if (e.target.id === 'modalMask') closeModal(); });
  return wrap.firstElementChild;
}
function closeModal() { $('#modalWrap').innerHTML = ''; }

/* ============ header ============ */
function setHeader(back, title, showCart) {
  const h = $('#appHeader');
  h.classList.remove('hidden');
  $('#backBtn').classList.toggle('hidden', !back);
  $('#cartBtn').classList.toggle('hidden', !showCart);
  $('#headerSpacer').classList.toggle('hidden', !!showCart);
  $('.brand').innerHTML = esc(CAFE.name) + (title ? '<small>' + esc(title) + '</small>' : '');
  updateBadge();
}
function updateBadge() {
  const b = $('#cartBadge');
  const n = cartCount();
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

/* ============ router ============ */
function go(hash) { location.hash = hash; }

function router() {
  const h = (location.hash || '#/').split('?')[0];
  const view = $('#view');
  const footer = $('#appFooter');

  if (h === '#/admin') { footer.classList.add('hidden'); renderAdmin(); return; }

  footer.classList.remove('hidden');
  if (h === '#/menu' || h === '#/cart' || h === '#/pay' || h === '#/receipt' || h === '#/history') {
    if (!state.user) { go('#/'); return; }
    if (!state.user.table) {
      const t = assignTable(state.user.name || 'Guest', state.user.phone);
      if (t) { state.user.table = t; store.set('cafe_session', state.user); }
      else {
        state.user = null; store.del('cafe_session');
        toast('All tables are full right now. Please wait.', '\uD83E\uDEF1', 'warn');
        go('#/'); return;
      }
    }
  }

  if (h === '#/menu') renderMenu(view);
  else if (h === '#/cart') renderCart(view);
  else if (h === '#/pay') renderPay(view);
  else if (h === '#/receipt') renderReceipt(view);
  else if (h === '#/history') renderHistory(view);
  else renderLogin(view);
}

/* ============ LOGIN ============ */
function renderLogin(view) {
  if (state.user) { go('#/menu'); return; }
  setHeader(false, '', false);

  view.innerHTML = `
    <div class="screen auth-card">
      <div class="logo-big">&#9749;</div>
      <div class="auth-title">${esc(CAFE.name)}</div>
      <div class="auth-sub">${esc(CAFE.tagline)} &middot; order from your phone, pay by UPI when you're done</div>
      <div id="stepPhone">
        <div class="field">
          <label>Your name</label>
          <input id="nameInput" class="input" maxlength="40" placeholder="e.g. Rahul" autocomplete="name">
        </div>
        <div class="field">
          <label>Mobile number</label>
          <div class="input-row">
            <span class="prefix">+91</span>
            <input id="phoneInput" class="input" type="tel" inputmode="numeric" maxlength="10" placeholder="98765 43210" autocomplete="tel">
          </div>
        </div>
        <button id="sendOtpBtn" class="btn btn-dark">Send OTP</button>
        <div id="recaptcha-container"></div>
        ${otpMode() === 'firebase'
          ? '<div class="demo-note">Real OTP: a text message will be sent to your number via Firebase.</div>'
          : '<div class="demo-note">Demo mode: the OTP is shown on screen (no real SMS is sent). A free table is assigned to you automatically.</div>'}
      </div>
      <div id="stepOtp" class="hidden">
        <div class="field">
          <label>Hi <span id="otpNameLabel"></span> &mdash; enter the OTP sent to +91 <span id="otpPhoneLabel"></span></label>
          <div class="otp-grid">
            ${Array.from({ length: otpLen() }, (_, i) => '<input class="otp-input" data-i="' + i + '" maxlength="1" inputmode="numeric">').join('')}
          </div>
        </div>
        <button id="verifyOtpBtn" class="btn btn-dark">Verify &amp; Continue</button>
        <button id="resendOtpBtn" class="btn btn-ghost" style="margin-top:10px">Resend OTP</button>
      </div>
      <div class="admin-link"><button id="adminEntryBtn">Admin login</button></div>
    </div>`;

  $('#sendOtpBtn').addEventListener('click', sendOtp);
  $('#adminEntryBtn').addEventListener('click', () => go('#/admin'));
  $('#phoneInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendOtp(); });
  $('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendOtp(); });

  $('#verifyOtpBtn').addEventListener('click', verifyOtp);
  $('#resendOtpBtn').addEventListener('click', sendOtp);

  $$('.otp-input').forEach(inp => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '');
      const n = +inp.dataset.i;
      if (inp.value && n < otpLen() - 1) $$('.otp-input')[n + 1].focus();
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !inp.value && inp.dataset.i > 0) $$('.otp-input')[+inp.dataset.i - 1].focus();
    });
  });
}

function sendOtp() {
  const name = $('#nameInput').value.trim();
  const phone = $('#phoneInput').value.replace(/\D/g, '');
  if (!name) { toast('Please enter your name', '\u26A0\uFE0F', 'warn'); $('#nameInput').focus(); return; }
  if (phone.length !== 10) { toast('Enter a valid 10-digit mobile number', '\u26A0\uFE0F', 'warn'); return; }
  if (otpMode() === 'firebase') { sendOtpFirebase(name, phone); return; }
  state.otp = String(Math.floor(1000 + Math.random() * 9000));
  state.otpPhone = phone;
  state.otpName = name;
  showOtpStep(name, phone);
  toast('Demo OTP: ' + state.otp, '\uD83D\uDCAC');
  beep(660, 0.12);
}

function showOtpStep(name, phone) {
  state.otpPhone = phone;
  state.otpName = name;
  $('#stepPhone').classList.add('hidden');
  $('#stepOtp').classList.remove('hidden');
  $('#otpNameLabel').textContent = name;
  $('#otpPhoneLabel').textContent = phone;
  $$('#stepOtp .otp-input').forEach(i => i.value = '');
  $$('#stepOtp .otp-input')[0].focus();
}

function completeLogin(name, phone) {
  const table = assignTable(name, phone);
  if (!table) {
    toast('All tables are full right now. Please wait a bit.', '\uD83E\uDEF1', 'warn');
    return;
  }
  state.user = { name, phone, table, loginAt: nowISO() };
  store.set('cafe_session', state.user);
  toast('Welcome, ' + name + '! You are at Table ' + table + ' \u2615', '\uD83D\uDC4B', 'success');
  go('#/menu');
}

function verifyOtp() {
  const code = $$('.otp-input').map(i => i.value).join('');
  const len = otpLen();
  if (code.length !== len) { toast('Enter the ' + len + '-digit OTP', '\u26A0\uFE0F', 'warn'); return; }
  if (otpMode() === 'firebase') { verifyOtpFirebase(code); return; }
  if (code !== state.otp) { toast('Wrong OTP, try again', '\u274C', 'warn'); $$('.otp-input').forEach(i => i.value = ''); $$('.otp-input')[0].focus(); return; }
  completeLogin(state.otpName, state.otpPhone);
}

/* ---------- Firebase Phone Auth (real SMS OTP) ---------- */
function loadFirebaseSdk() {
  if (window.firebase && window.firebase.auth && window.firebase.initializeApp) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
    const names = ['firebase-app-compat.js', 'firebase-auth-compat.js'];
    let done = false;
    const timer = setTimeout(() => finish(false), 15000);
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); ok ? resolve() : reject(new Error('Firebase SDK failed to load')); };
    names.forEach(name => {
      const s = document.createElement('script');
      s.src = base + name;
      s.async = true;
      s.onload = () => { if (window.firebase && window.firebase.auth && window.firebase.initializeApp) finish(true); };
      s.onerror = () => finish(false);
      document.head.appendChild(s);
    });
  });
}

function fbOtpError(err) {
  const map = {
    'auth/invalid-phone-number': 'That phone number is not valid.',
    'auth/quota-exceeded': 'SMS quota exceeded for this number - try again later.',
    'auth/missing-verifier': 'reCAPTCHA failed - please retry.',
    'auth/captcha-check-failed': 'reCAPTCHA check failed - please retry.',
    'auth/too-many-requests': 'Too many attempts - wait a minute and retry.',
    'auth/operation-not-allowed': 'Phone sign-in is not enabled in the Firebase Console.',
    'auth/unauthorized-continue-uri': 'Add this domain to Firebase -> Authorized domains.',
    'auth/network-request-failed': 'Network error - check your connection.'
  };
  return (err && map[err.code]) || (err && err.message) || 'OTP failed - try again.';
}

async function sendOtpFirebase(name, phone) {
  const cfg = (CAFE.otp && CAFE.otp.firebaseConfig) || {};
  if (!cfg.apiKey || !cfg.authDomain || !cfg.projectId || !cfg.appId) {
    toast('Firebase is not configured - the admin must fill CAFE.otp.firebaseConfig in js/data.js.', '\u26A0\uFE0F', 'warn');
    return;
  }
  const btn = $('#sendOtpBtn');
  btn.disabled = true;
  btn.textContent = 'Sending OTP...';
  try {
    await loadFirebaseSdk();
    if (!window.__fbApp) window.__fbApp = window.firebase.initializeApp(cfg);
    const auth = window.firebase.auth(window.__fbApp);
    const verifier = new window.firebase.auth.RecaptchaVerifier('recaptcha-container', { size: 'invisible' });
    state.fbConfirm = await auth.signInWithPhoneNumber('+91' + phone, verifier);
    showOtpStep(name, phone);
    toast('OTP sent by SMS to +91 ' + phone, '\uD83D\uDCE9');
  } catch (err) {
    console.error('Firebase OTP send failed', err);
    toast(fbOtpError(err), '\u26A0\uFE0F', 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send OTP';
  }
}

async function verifyOtpFirebase(code) {
  if (!state.fbConfirm) { toast('No OTP in progress - tap Send OTP again', '\u26A0\uFE0F', 'warn'); return; }
  const btn = $('#verifyOtpBtn');
  btn.disabled = true;
  try {
    await state.fbConfirm.confirm(code);
    completeLogin(state.otpName, state.otpPhone);
  } catch (err) {
    toast((err && err.code === 'auth/invalid-verification-code') ? 'Wrong OTP, try again' : fbOtpError(err), '\u274C', 'warn');
    $$('.otp-input').forEach(i => i.value = '');
    $$('.otp-input')[0].focus();
  } finally {
    btn.disabled = false;
  }
}

/* ============ MENU ============ */
function renderMenu(view) {
  setHeader(false, 'Hi ' + esc(state.user.name || 'Guest') + ' · Table ' + state.user.table, true);
  const cats = Object.keys(MENU);
  const oos = getOpenOrders();

  let bar = '';
  if (oos.length) {
    const combined = bill(mergeItems([], oos.flatMap(o => o.items)));
    bar = `
      <div class="open-order-bar">
        <div class="oob-title">\uD83C\uDF73 Your order status</div>
        ${oos.map(o => {
          const pct = pctFor(o);
          const chipMap = {
            open: { cls: 'received', txt: '\u2601\uFE0F Received' },
            accepted: { cls: 'accepted', txt: '\u2705 Accepted' },
            preparing: { cls: 'preparing', txt: '\uD83D\uDD25 Preparing' }
          };
          const chip = chipMap[o.status] || chipMap.open;
          return `
          <div class="oob-order">
            <div class="oob-head">
              <b>\uD83E\uDDFE ${esc(o.id)}</b>
              <span class="oob-chip ${chip.cls}">${chip.txt}</span>
            </div>
            <div class="oob-line2">${o.items.reduce((s, i) => s + i.qty, 0)} item(s) \u00B7 ${etaText(o)}</div>
            <div class="prog ${pct === null ? 'indet' : ''}"><div class="prog-fill" data-prog="${esc(o.id)}" style="width:${pct === null ? '40%' : pct + '%'}"></div></div>
            <div class="oob-status" data-status="${esc(o.id)}">${statusText(o, pct)}</div>
          </div>`;
        }).join('')}
        <div class="oob-line total"><b>Total</b><span>${fmtINR(combined.total)}</span></div>
        <button class="btn btn-sm" id="payBillBtn">Pay Bill ${fmtINR(combined.total)}</button>
      </div>`;
  }

  view.innerHTML = `
    <div class="screen">
      <div class="seat-banner">
        <span>\uD83E\uDEF1 Table ${state.user.table}</span><span style="flex:1"></span>
        <button id="leaveBtn" class="btn btn-sm" style="background:rgba(255,255,255,0.16); box-shadow:none; padding:7px 12px; font-size:12.5px">Leave &amp; log out</button>
      </div>
      ${bar}
      <div class="cat-tabs">${cats.map(c =>
        `<button class="cat-chip ${c === state.activeCat ? 'active' : ''}" data-cat="${c}">${MENU[c].icon} ${esc(MENU[c].name)}</button>`).join('')}
      </div>
      <div id="itemList"></div>
    </div>`;

  if (oos.length) $('#payBillBtn').addEventListener('click', payBill);

  $$('.cat-chip').forEach(chip => chip.addEventListener('click', () => {
    state.activeCat = chip.dataset.cat;
    $$('.cat-chip').forEach(c => c.classList.toggle('active', c === chip));
    drawItems($('#itemList'));
  }));

  $('#leaveBtn').addEventListener('click', leaveSeat);
  drawItems($('#itemList'));
}

function leaveSeat() {
  getOpenOrders().forEach(o => { o.status = 'cancelled'; o.updatedAt = nowISO(); upsertOrder(o, false); });
  releaseTable(state.user.table);
  state.user = null;
  store.del('cafe_session');
  state.cart = {};
  store.set('cafe_cart', state.cart);
  state.billOrder = null;
  updateBadge();
  toast('Table released. See you soon!', '\uD83D\uDC4B');
  go('#/');
}

function drawItems(container) {
  const cat = MENU[state.activeCat];
  container.innerHTML = '<div class="item-grid">' + cat.items.map(item => {
    const q = state.cart[item.id] || 0;
    return `
      <div class="item-card">
        <div class="item-emoji">${item.emoji}</div>
        <div class="item-info">
          <div class="item-name">
            <span class="veg-dot ${item.veg ? 'green' : 'red'}"></span>${esc(item.name)}
          </div>
          <div class="item-desc">${esc(item.desc)}</div>
          <div class="item-foot">
            <span class="price">${fmtINR(item.price)}</span>
            <span class="stepper" data-id="${item.id}">
              <button class="minus ${q === 0 ? 'hidden' : ''}" data-act="dec" aria-label="Remove one">&#8722;</button>
              <span class="qty ${q === 0 ? 'hidden' : ''}">${q}</span>
              <button class="plus" data-act="inc" aria-label="Add one">&#43;</button>
            </span>
          </div>
        </div>
      </div>`;
  }).join('') + '</div>';

  $$('.stepper button', container).forEach(btn => btn.addEventListener('click', () => {
    const id = btn.closest('.stepper').dataset.id;
    setQty(id, btn.dataset.act === 'inc' ? 1 : -1, container);
  }));
}

function setQty(id, delta, container) {
  const cur = state.cart[id] || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) delete state.cart[id]; else state.cart[id] = next;
  store.set('cafe_cart', state.cart);
  updateBadge();
  if (container) drawItems(container);
  else router();
}

/* ============ CART ============ */
function renderCart(view) {
  setHeader(true, 'Your Order', false);
  const b = bill();
  const oos = getOpenOrders();

  if (b.items.length === 0) {
    view.innerHTML = `
      <div class="screen empty-state">
        <div class="big">&#128722;</div>
        <h2>Your cart is empty</h2>
        <p class="sub">Browse the menu and add something tasty.</p>
        ${oos.length ? `<p class="sub" style="margin-top:6px">You have ${oos.length} open order(s) at Table ${state.user.table}.</p>` : ''}
        <button class="btn btn-dark" style="margin-top:18px" id="goMenuBtn">Browse Menu</button>
        ${oos.length ? `<button class="btn" style="margin-top:10px" id="payOpenBtn">Pay your bill now</button>` : ''}
      </div>`;
    $('#goMenuBtn').addEventListener('click', () => go('#/menu'));
    $('#payOpenBtn') && $('#payOpenBtn').addEventListener('click', payBill);
    return;
  }

  view.innerHTML = `
    <div class="screen">
      <h1>Your Order</h1>
      <p class="sub">Review your items, then send them to the kitchen.</p>
      <div class="bill-card" style="margin-top:14px">
        ${b.items.map(i => `
          <div class="cart-item">
            <span class="ci-emoji">${i.emoji}</span>
            <div class="ci-info">
              <div class="ci-name">${esc(i.name)}</div>
              <div class="ci-price">${fmtINR(i.price)} &times; ${i.qty}</div>
            </div>
            <span class="stepper" data-id="${i.id}">
              <button class="minus" data-act="dec">&#8722;</button>
              <span class="qty">${i.qty}</span>
              <button class="plus" data-act="inc">&#43;</button>
            </span>
            <span class="ci-total">${fmtINR(i.price * i.qty)}</span>
          </div>`).join('')}
      </div>
      ${oos.length ? `<div class="demo-note" style="margin-top:12px">You have ${oos.length} open order(s). This batch becomes a <b>new order</b> — place again whenever you want more. Or <a href="#" id="payLink">pay your full bill now</a>.</div>` : ''}
      <div style="margin-top:16px; display:flex; gap:10px">
        <button class="btn btn-ghost" id="clearCartBtn" style="flex:1">Clear</button>
        <button class="btn" id="placeOrderBtn" style="flex:2">Place Order &#10132;</button>
      </div>
      <p class="sub" style="text-align:center; margin-top:10px">Each placement goes to the kitchen. Pay the bill whenever you're done.</p>
    </div>`;

  $$('.stepper button', view).forEach(btn => btn.addEventListener('click', () => {
    const id = btn.closest('.stepper').dataset.id;
    const delta = btn.dataset.act === 'inc' ? 1 : -1;
    const cur = state.cart[id] || 0;
    const next = Math.max(0, cur + delta);
    if (next === 0) delete state.cart[id]; else state.cart[id] = next;
    store.set('cafe_cart', state.cart);
    updateBadge();
    renderCart(view);
  }));

  $('#clearCartBtn').addEventListener('click', () => { state.cart = {}; store.set('cafe_cart', state.cart); renderCart(view); });
  $('#placeOrderBtn').addEventListener('click', placeOrder);
  $('#payLink') && $('#payLink').addEventListener('click', e => { e.preventDefault(); payBill(); });
}

/* ============ PAY ============ */
function makePending(b, method) {
  const ids = (state.billOrder && state.billOrder.orderIds) || [];
  return {
    orderIds: ids,
    orderId: ids[0] || orderId(),
    name: state.user.name || '',
    phone: state.user.phone,
    table: state.user.table || '',
    items: b.items, subtotal: b.subtotal, tax: b.tax, total: b.total,
    method, status: 'pending', initiatedAt: nowISO()
  };
}

function renderPay(view) {
  setHeader(true, 'Checkout', false);

  const pending = state.pending;
  if (pending && pending.phone === state.user.phone) {
    renderPending(view, pending);
    return;
  }

  const src = state.billOrder ? state.billOrder.items : cartItems();
  const b = bill(src);
  if (!b.items.length) {
    view.innerHTML = `<div class="screen empty-state"><div class="big">&#129297;</div><h2>Nothing to pay</h2><p class="sub">Place an order first, then pay your bill here.</p><button class="btn btn-dark" style="margin-top:18px" id="goMenuBtn2">Browse Menu</button></div>`;
    $('#goMenuBtn2').addEventListener('click', () => go('#/menu'));
    return;
  }

  // pull the admin's synced UPI id once (only when realtime is on);
  // re-render once after it resolves so the warning/QR reflect the real ID
  if (rtEnabled() && remoteVpa === null) {
    fetchRemoteVpa().then(() => {
      if ((location.hash || '').startsWith('#/pay')) router();
    });
  }
  const vpa = effectiveVpa();
  const idsText = (state.billOrder && state.billOrder.orderIds && state.billOrder.orderIds.length)
    ? state.billOrder.orderIds.join(', ')
    : null;

  view.innerHTML = `
    <div class="screen">
      <div class="pay-hero">
        <div class="sub">Your total bill${idsText ? ' · Orders ' + esc(idsText) : ''}</div>
        <div class="amount">${fmtINR(b.total)}</div>
        <div class="sub">${b.items.length} item(s) &middot; incl. GST &middot; Table ${state.user.table}</div>
      </div>
      <div class="bill-card" style="margin-bottom:14px">
        <div class="field" style="margin-bottom:8px"><label>Customer</label>
          <div class="input ro-field">${esc(state.user.name || 'Guest')} &middot; +91 ${esc(state.user.phone)}</div>
        </div>
        <div class="field" style="margin-bottom:0"><label>Table (auto-assigned)</label>
          <div class="input ro-field">\uD83E\uDEF1 Table ${state.user.table}</div>
        </div>
      </div>
      <div class="sub" style="margin-bottom:8px; font-weight:700">Pay by UPI to <span class="vpa-inline">${esc(vpa)}</span>
        <button class="btn btn-ghost btn-xs" id="copyVpaBtn" type="button">Copy</button></div>
      <div class="method-card selected" data-m="upi">
        <div class="m-icon">&#128179;</div>
        <div class="m-info"><div class="m-name">UPI App</div><div class="m-desc">GPay / PhonePe / Paytm — pay ${fmtINR(b.total)} in one tap</div></div>
        <div class="radio"></div>
      </div>
      <div class="method-card" data-m="qr">
        <div class="m-icon">&#128247;</div>
        <div class="m-info"><div class="m-name">Scan UPI QR</div><div class="m-desc">Scan with any UPI app on your phone</div></div>
        <div class="radio"></div>
      </div>
      <div class="method-card" data-m="sim">
        <div class="m-icon">&#128225;</div>
        <div class="m-info"><div class="m-name">Simulate UPI (Demo)</div><div class="m-desc">Test the full flow without a real payment</div></div>
        <div class="radio"></div>
      </div>
      <div id="qrArea" class="hidden">
        <div class="qr-box">
          <img id="qrImg" alt="UPI QR code" width="200" height="200">
          <div class="qr-upi">${esc(vpa)}</div>
          <p class="sub" style="margin-top:6px">Scan, pay, then tap <b>I've Paid</b> below.</p>
        </div>
      </div>
      <button class="btn btn-dark" id="payNowBtn" style="margin-top:16px">Pay ${fmtINR(b.total)} Now</button>
      ${isDefaultVpa()
        ? '<div class="demo-note" style="margin-top:10px">\u26A0\uFE0F <b>Demo UPI ID in use:</b> ' + esc(vpa) + ' is not registered, so real UPI apps will show an error. Ask the admin to set the real UPI ID (Admin &rarr; UPI Settings), or use <b>Scan QR</b> / <b>Simulate</b> for now.</div>'
        : ''}
      <p class="sub" style="text-align:center; margin-top:10px">Settle here when you finish — no waiting at the counter.</p>
    </div>`;

  let method = 'upi';
  $$('.method-card', view).forEach(card => card.addEventListener('click', () => {
    method = card.dataset.m;
    $$('.method-card', view).forEach(c => c.classList.toggle('selected', c === card));
    const qa = $('#qrArea');
    if (method === 'qr') {
      qa.classList.remove('hidden');
      // build the raw upi:// payload (vpa unencoded inside — the whole string
      // is encoded once below; double-encoding corrupts the pa value)
      const qrData = 'upi://pay?pa=' + vpa +
        '&pn=' + encodeURIComponent(CAFE.upiName) +
        '&am=' + b.total.toFixed(2) +
        '&cu=INR&mode=02&purpose=00&tn=' + encodeURIComponent('Table ' + state.user.table + ' ' + CAFE.name);
      const img = $('#qrImg');
      img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(qrData);
      img.onerror = () => { /* QR service unreachable — UPI ID text remains */ };
    } else qa.classList.add('hidden');
  }));

  const copyBtn = $('#copyVpaBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => { copyText(vpa); toast('UPI ID copied — paste it in any UPI app'); });

  $('#payNowBtn').addEventListener('click', () => {
    if (method === 'upi') openUpiApp(b);
    else if (method === 'qr') openQrPay(b);
    else openSimModal(b);
  });
}

/* real UPI deep link — guarded so a bad/demo UPI ID never sends the
   customer into a failing UPI app */
function openUpiApp(b) {
  if (isDefaultVpa()) { openUpiConfigModal(b); return; }
  if (!isMobileUA()) { openNoUpiModal(b); return; }
  if (isIOSUA()) { openNoUpiModal(b); return; } // Safari blocks upi:// custom schemes → offer QR / copy instead
  fireUpiLink(b);
}

function fireUpiLink(b) {
  const p = makePending(b, 'UPI App');
  const vpa = effectiveVpa();
  const note = 'Order ' + p.orderId + ' ' + CAFE.name;
  const link = 'upi://pay?pa=' + encodeURIComponent(vpa) +
    '&pn=' + encodeURIComponent(CAFE.upiName) +
    '&am=' + b.total.toFixed(2) +
    '&cu=INR&mode=02&purpose=00&tn=' + encodeURIComponent(note);
  state.pending = p;
  store.set('cafe_pending', p);
  try { location.href = link; } catch (e) { /* custom-scheme blocked — stay on the pending screen */ }
  renderPay($('#view'));
}

function openUpiConfigModal(b) {
  openModal(`
    <button class="close-x" id="cfgClose">&#10005;</button>
    <h3>UPI ID not configured</h3>
    <p class="sub">Real UPI apps reject the demo ID <b>${esc(effectiveVpa())}</b> — that is why you see "something went wrong, please try again later".</p>
    <div class="demo-note">The admin can set the real UPI ID in <b>Admin &rarr; UPI Settings</b> (it syncs to all devices via Firebase when enabled).</div>
    <div style="display:flex; gap:10px; margin-top:14px">
      <button class="btn btn-ghost" id="cfgCancel" style="flex:1">Cancel</button>
      <button class="btn" id="cfgSim" style="flex:1">Simulate instead</button>
    </div>
  `);
  $('#cfgClose').addEventListener('click', closeModal);
  $('#cfgCancel').addEventListener('click', closeModal);
  $('#cfgSim').addEventListener('click', () => { closeModal(); openSimModal(b); });
}

function openNoUpiModal(b) {
  openModal(`
    <button class="close-x" id="noUpiClose">&#10005;</button>
    <h3>No UPI app detected</h3>
    <p class="sub">This looks like a desktop browser. UPI deep links need a phone with GPay / PhonePe / Paytm installed. (iPhone Safari blocks UPI deep links — use the QR or copy the UPI ID below.)</p>
    <div class="demo-note">Open this page on your phone to pay there, or scan the QR with your phone's UPI app.</div>
    <div class="copy-row"><span class="vpa">${esc(effectiveVpa())}</span><button class="btn" id="noUpiCopy" type="button">Copy UPI ID</button></div>
    <div style="display:flex; gap:10px; margin-top:14px">
      <button class="btn btn-ghost" id="noUpiTry" style="flex:1">Try anyway</button>
      <button class="btn" id="noUpiQr" style="flex:1">Scan QR instead</button>
    </div>
  `);
  $('#noUpiClose').addEventListener('click', closeModal);
  $('#noUpiCopy').addEventListener('click', () => { copyText(effectiveVpa()); toast('UPI ID copied — paste it in any UPI app'); });
  $('#noUpiTry').addEventListener('click', () => { closeModal(); fireUpiLink(b); });
  $('#noUpiQr').addEventListener('click', () => { closeModal(); openQrPay(b); });
}

/* scan-to-pay: QR shown, customer scans with any UPI app */
function openQrPay(b) {
  const p = makePending(b, 'UPI QR');
  state.pending = p;
  store.set('cafe_pending', p);
  renderPay($('#view'));
}

function renderPending(view, p) {
  view.innerHTML = `
    <div class="screen">
      <div class="pay-hero">
        <div class="sub">Waiting for payment</div>
        <div class="amount">${fmtINR(p.total)}</div>
        <div class="sub">Order <b>${esc(p.orderId)}</b>${(p.orderIds && p.orderIds.length > 1) ? ' (+' + (p.orderIds.length - 1) + ' more)' : ''} &middot; ${esc(p.method)} &middot; Table ${esc(p.table || '—')}</div>
      </div>
      <div class="bill-card" style="text-align:center; padding:26px 18px">
        <div class="spinner"></div>
        <p>Complete the payment in your UPI app,<br>then confirm below.</p>
        <button class="btn btn-success" id="confirmPaidBtn" style="margin-top:18px">I've Paid &#10003;</button>
        <button class="btn btn-ghost" id="qrFallbackBtn" style="margin-top:10px">Payment didn't open? Try Scan QR</button>
        <button class="btn btn-ghost" id="cancelPayBtn" style="margin-top:10px">Cancel</button>
      </div>
    </div>`;
  $('#confirmPaidBtn').addEventListener('click', () => finalizePayment(p, p.method, 'UPI-' + Date.now().toString().slice(-10)));
  $('#qrFallbackBtn').addEventListener('click', () => { state.pending = null; store.del('cafe_pending'); router(); });
  $('#cancelPayBtn').addEventListener('click', () => { state.pending = null; store.del('cafe_pending'); router(); });
}

/* simulated UPI */
function openSimModal(b) {
  openModal(`
    <button class="close-x" id="simClose">&#10005;</button>
    <h3>Simulated UPI Payment</h3>
    <p class="sub">Pay <b>${fmtINR(b.total)}</b> to <b>${esc(effectiveVpa())}</b> &middot; Table ${state.user.table}</p>
    <div style="background:#fff; border-radius:14px; padding:16px; margin:16px 0">
      <div class="field" style="margin-bottom:10px"><label>UPI ID</label>
        <div class="input" style="background:#F3EBDE; font-weight:700">${esc(effectiveVpa())}</div>
      </div>
      <div class="field" style="margin-bottom:0"><label>Enter UPI PIN (any 4 digits in demo)</label>
        <input id="simPin" class="input" type="password" inputmode="numeric" maxlength="4" placeholder="****">
      </div>
    </div>
    <button class="btn btn-dark" id="simPayBtn">Pay ${fmtINR(b.total)}</button>
  `);
  $('#simClose').addEventListener('click', closeModal);
  $('#simPayBtn').addEventListener('click', () => {
    const pin = $('#simPin').value;
    if (pin.length !== 4) { toast('Enter a 4-digit UPI PIN', '\u26A0\uFE0F', 'warn'); return; }
    const p = makePending(b, 'UPI (Demo)');
    $('#simPayBtn').disabled = true;
    $('#simPayBtn').innerHTML = '<span class="spinner" style="width:22px;height:22px;border-width:3px;margin:0"></span> Processing\u2026';
    setTimeout(() => {
      closeModal();
      finalizePayment(p, 'UPI (Demo)', 'TXN' + Date.now().toString().slice(-8));
    }, 1500);
  });
}

/* finalize: close ALL open orders, record payment, notify admin, free the
   table, then log the customer out automatically */
function finalizePayment(p, method, txnId) {
  const order = { ...p, method, txnId, status: 'paid', paidAt: nowISO() };
  const ids = (p.orderIds && p.orderIds.length) ? p.orderIds : [p.orderId];

  const orders = getOrders();
  const paid = orders.filter(o => ids.includes(o.id) && (o.status === 'open' || o.status === 'accepted' || o.status === 'preparing'));
  paid.forEach(o => {
    o.status = 'paid'; o.method = method; o.txnId = txnId; o.paidAt = nowISO(); o.total = p.total;
    rtPushOrder(o);
    document.dispatchEvent(new CustomEvent('cafe:order', { detail: { order: o, isNew: false } }));
  });
  if (paid.length) saveOrders(orders);

  const payments = store.get('cafe_payments', []);
  payments.unshift(order);
  store.set('cafe_payments', payments);

  state.pending = null;
  store.del('cafe_pending');
  state.cart = {};
  store.set('cafe_cart', state.cart);
  state.billOrder = null;
  state.lastOrder = order;
  updateBadge();

  if (order.table) releaseTable(order.table);

  rtPush(order);
  document.dispatchEvent(new CustomEvent('cafe:payment', { detail: order }));

  notifySound();
  go('#/receipt');
}

/* ============ RECEIPT (auto-logout after payment) ============ */
function autoLogout() {
  if (state.logoutTimer) { clearTimeout(state.logoutTimer); state.logoutTimer = null; }
  state.user = null;
  store.del('cafe_session');
  state.cart = {};
  store.set('cafe_cart', state.cart);
  state.billOrder = null;
  updateBadge();
  go('#/');
}

function renderReceipt(view) {
  setHeader(true, 'Done', false);
  const o = state.lastOrder;
  if (!o) { view.innerHTML = '<div class="screen empty-state"><div class="big">&#129300;</div><h2>No recent order</h2></div>'; return; }
  const ids = (o.orderIds && o.orderIds.length) ? o.orderIds : [o.orderId];

  if (state.logoutTimer) clearTimeout(state.logoutTimer);
  state.logoutTimer = setTimeout(autoLogout, 60000); // auto logout ~1 min after payment

  view.innerHTML = `
    <div class="screen">
      <div class="pay-success">
        <div class="check-circle">
          <svg viewBox="0 0 52 52"><path fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M14 27l8 8 16-18"/></svg>
        </div>
        <h1 style="font-size:22px">Payment Successful!</h1>
        <p class="sub">The admin has been notified. Enjoy your order \u2615</p>
      </div>
      <div class="receipt">
        <div class="r-head">
          <h2>&#9749; ${esc(CAFE.name)}</h2>
          <div class="r-meta"><span>${esc(ids.join(', '))}</span><span>${fmtTime(o.paidAt)}</span></div>
          <div class="r-meta"><span>${esc(o.name || '')} &middot; +91 ${esc(o.phone)}</span><span>Table ${esc(o.table || '—')}</span></div>
        </div>
        ${o.items.map(i => `<div class="r-line"><span>${esc(i.name)} &times; ${i.qty}</span><span>${fmtINR(i.price * i.qty)}</span></div>`).join('')}
        <div class="r-totals">
          <div class="r-line"><span>Subtotal</span><span>${fmtINR(o.subtotal)}</span></div>
          <div class="r-line"><span>GST (${Math.round(CAFE.gstRate * 100)}%)</span><span>${fmtINR(o.tax)}</span></div>
          <div class="r-total"><span>Total</span><span>${fmtINR(o.total)}</span></div>
        </div>
        <div class="r-meta" style="margin-top:10px; justify-content:space-between">
          <span>Paid via ${esc(o.method)}</span><span>${esc(o.txnId)}</span>
        </div>
        <div class="paid-banner">&#10003; PAID — receipt confirmed · Table ${esc(o.table || '—')} is now free</div>
      </div>
      <div class="countdown-note">\u23F3 Payment done \u2014 you'll be logged out automatically in about a minute. Thanks for visiting!</div>
      <div style="display:flex; gap:10px; margin-top:12px" class="no-print">
        <button class="btn btn-ghost" id="printBtn" style="flex:1">&#128424; Print</button>
        <button class="btn" id="logoutNowBtn" style="flex:1">Log out now</button>
      </div>
    </div>`;

  $('#printBtn').addEventListener('click', () => window.print());
  $('#logoutNowBtn').addEventListener('click', autoLogout);
}

/* ============ HISTORY ============ */
function renderHistory(view) {
  setHeader(true, 'My Orders', false);
  const mine = store.get('cafe_payments', []).filter(p => p.phone === state.user.phone);
  if (mine.length === 0) {
    view.innerHTML = `<div class="screen empty-state"><div class="big">&#128203;</div><h2>No orders yet</h2><p class="sub">Your paid orders will show up here.</p><button class="btn btn-dark" style="margin-top:18px" id="hmBtn">Order Now</button></div>`;
    $('#hmBtn').addEventListener('click', () => go('#/menu'));
    return;
  }
  view.innerHTML = `
    <div class="screen">
      <h1>My Orders</h1>
      <p class="sub">${mine.length} order(s) &middot; ${esc(state.user.name || '')} &middot; +91 ${state.user.phone}</p>
      <div style="margin-top:14px">
        ${mine.map(o => `
          <div class="history-item">
            <div class="h-top">
              <span class="h-id">${esc(o.orderId)} <span class="status-pill">PAID</span></span>
              <span class="h-total">${fmtINR(o.total)}</span>
            </div>
            <div class="h-meta">${fmtTime(o.paidAt)} &middot; ${esc(o.method)} &middot; Table ${esc(o.table || '—')} &middot; ${o.items.reduce((s, i) => s + i.qty, 0)} item(s)</div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ============ ADMIN ============ */
function renderAdmin() {
  const view = $('#view');
  setHeader(true, 'Admin', false);
  $('#appFooter').classList.add('hidden');

  if (!state.adminAuthed) {
    view.innerHTML = `
      <div class="screen auth-card admin-wrap">
        <div class="logo-big">&#128274;</div>
        <div class="auth-title">Admin Login</div>
        <div class="auth-sub">Enter the cafe admin passcode to see live orders &amp; payments</div>
        <div class="field">
          <label>Passcode</label>
          <input id="adminPass" class="input" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
        </div>
        <button class="btn btn-dark" id="adminLoginBtn">Unlock Dashboard</button>
        <div class="demo-note">Demo passcode: <b>${esc(CAFE.adminPasscode)}</b></div>
      </div>`;
    $('#adminLoginBtn').addEventListener('click', () => {
      if ($('#adminPass').value === CAFE.adminPasscode) {
        state.adminAuthed = true;
        store.set('cafe_admin_authed', true);
        requestNotifyPermission();
        renderAdmin();
      } else toast('Wrong passcode', '\u26A0\uFE0F', 'warn');
    });
    $('#adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#adminLoginBtn').click(); });
    return;
  }

  requestNotifyPermission();
  drawAdmin();
}

function drawAdmin() {
  const view = $('#view');
  const orders = getOrders();
  const openOrders = orders
    .filter(o => o.status === 'open' || o.status === 'accepted' || o.status === 'preparing')
    .sort((a, b) => new Date(b.updatedAt || b.placedAt) - new Date(a.updatedAt || a.placedAt));
  const payments = store.get('cafe_payments', []);
  const today = new Date().toDateString();
  const todays = payments.filter(p => new Date(p.paidAt).toDateString() === today);
  const rev = todays.reduce((s, p) => s + p.total, 0);

  const live = rtEnabled();
  view.innerHTML = `
    <div class="screen admin-wrap">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px">
        <h1>Dashboard</h1>
        <div style="display:flex; gap:8px; align-items:center">
          <span class="sync-pill ${live ? '' : 'off'}">${live ? '\u26A1 Live sync' : '\uD83D\uDCF1 Demo'}</span>
          <button class="btn btn-ghost btn-sm" id="logoutBtn">Logout</button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="s-num">${fmtINR(rev)}</div><div class="s-label">Today's revenue</div></div>
        <div class="stat-card"><div class="s-num">${openOrders.length}</div><div class="s-label">Open orders</div></div>
        <div class="stat-card"><div class="s-num">${todays.length}</div><div class="s-label">Payments today</div></div>
      </div>
      <div class="bill-card" style="margin-bottom:14px">
        <div class="sub" style="font-weight:800; margin-bottom:8px">\uD83D\uDCB3 UPI Settings — real payments go to this ID</div>
        <div class="input-row">
          <input id="upiVpa" class="input" placeholder="yourname@okhdfcbank" value="${esc(effectiveVpa())}">
          <button class="btn btn-sm" id="saveVpaBtn" style="flex:0 0 auto">Save</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="clearVpaBtn" style="margin-top:8px">Reset to config default</button>
        ${live ? '<p class="sub" style="margin-top:6px">Live sync is ON — saving here also updates every customer device instantly.</p>' : '<p class="sub" style="margin-top:6px">Demo mode: the ID above is used on this device only. Enable Firebase sync (js/data.js &rarr; rt) to push it to all devices.</p>'}
      </div>
      <div style="display:flex; gap:8px; margin-bottom:14px">
        <button class="cat-chip ${state.adminTab === 'orders' ? 'active' : ''}" id="tabOrdersBtn">Open Orders (${openOrders.length})</button>
        <button class="cat-chip ${state.adminTab === 'pays' ? 'active' : ''}" id="tabPaysBtn">Payments (${payments.length})</button>
      </div>
      <div id="secOrders" class="${state.adminTab === 'orders' ? '' : 'hidden'}"></div>
      <div id="secPays" class="${state.adminTab === 'pays' ? '' : 'hidden'}"></div>
      <div class="demo-note" style="margin-top:16px">${live
        ? '&#9889; Real-time sync is ON — new orders and payments from any device appear here instantly (sound + notification).'
        : '&#128225; Keep this tab open — new orders and payments appear instantly with a sound. Enable Firebase sync for cross-device live updates (see README).'}</div>
    </div>`;

  drawOpenOrders($('#secOrders'), openOrders, false);
  drawAdminList($('#secPays'), payments, false);

  $('#logoutBtn').addEventListener('click', () => { state.adminAuthed = false; store.set('cafe_admin_authed', false); renderAdmin(); });
  $('#tabOrdersBtn').addEventListener('click', () => { state.adminTab = 'orders'; drawAdmin(); });
  $('#tabPaysBtn').addEventListener('click', () => { state.adminTab = 'pays'; drawAdmin(); });
  $('#saveVpaBtn').addEventListener('click', saveVpa);
  $('#clearVpaBtn').addEventListener('click', clearVpa);

  rtSubscribe();
  rtPull();
}

function drawOpenOrders(container, orders, isNew) {
  if (!orders.length) {
    container.innerHTML = '<div class="empty-state" style="padding:36px 16px"><div class="big">&#127869;</div><h2>No open orders</h2><p class="sub">New orders appear here the moment they are placed.</p></div>';
    return;
  }
  container.innerHTML = orders.map((o, idx) => `
    <div class="order-card ${idx === 0 && isNew ? 'new-row' : ''}">
      <div class="oc-head">
        <b>${esc(o.id)}</b>
        ${idx === 0 && isNew ? '<span class="new-badge">NEW</span>' : ''}
        <span class="status-pill ${o.status === 'preparing' ? 'warn' : o.status === 'accepted' ? '' : 'info'}">${o.status === 'preparing' ? '\uD83D\uDD25 PREPARING \u00B7 ' + etaText(o) : o.status === 'accepted' ? '\u2705 ACCEPTED' : '\uD83D\uDD25 OPEN'}</span>
        <span class="oc-time">${fmtTime(o.updatedAt || o.placedAt)}</span>
      </div>
      <div class="oc-meta">Table <b>${o.table}</b> &middot; ${esc(o.name || '')} &middot; +91 ${esc(o.phone)}</div>
      <div class="oc-items">${o.items.map(i => `<div class="oc-line"><span>${i.qty} &times; ${esc(i.name)}</span><span>${fmtINR(i.price * i.qty)}</span></div>`).join('')}</div>
      <div class="oc-foot">
        <span class="amt">${fmtINR(bill(o.items).total)}</span>
        <div class="oc-eta">
          <input type="number" min="1" max="180" class="eta-input" data-eta="${esc(o.id)}" value="${o.etaMin || 15}" title="Estimated minutes to serve" aria-label="Estimated minutes">
          <button class="btn btn-sm btn-ghost" data-prep="${esc(o.id)}">${o.status === 'preparing' ? 'Update ETA' : 'Start preparing'}</button>
        </div>
      </div>
    </div>`).join('');

  $$('[data-prep]', container).forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.prep;
    const eta = parseInt($('[data-eta="' + id + '"]').value, 10);
    const orders = getOrders();
    const o = orders.find(x => x.id === id);
    if (o) {
      o.status = 'preparing';
      o.etaMin = (eta > 0 && eta <= 180) ? eta : (o.etaMin || 15);
      o.updatedAt = nowISO();
      saveOrders(orders);
      rtPushOrder(o);
      toast('Order ' + o.id + ': preparing · ETA ' + o.etaMin + ' min', '\uD83D\uDD25', 'success');
      drawAdmin();
    }
  }));
}

function drawAdminList(container, payments, isNew) {
  if (payments.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:36px 16px"><div class="big">&#128227;</div><h2>No payments yet</h2><p class="sub">Paid orders appear here live.</p></div>';
    return;
  }
  container.innerHTML = `
    <table class="pay-table">
      <tr><th>Time</th><th>Order</th><th>Customer</th><th>Items</th><th>Amount</th><th>Status</th></tr>
      ${payments.map((p, idx) => `
        <tr class="${idx === 0 && isNew ? 'new-row' : ''}">
          <td>${fmtTime(p.paidAt)}</td>
          <td><b>${esc(p.orderId)}</b>${idx === 0 && isNew ? '<span class="new-badge">NEW</span>' : ''}</td>
          <td>${esc(p.name || '')} &middot; +91 ${esc(p.phone)}${p.table ? ' · T' + esc(p.table) : ''}</td>
          <td>${p.items.reduce((s, i) => s + i.qty, 0)}</td>
          <td class="amt">${fmtINR(p.total)}</td>
          <td><span class="status-pill">&#10003; PAID</span></td>
        </tr>`).join('')}
    </table>`;
}

/* UPI settings */
function saveVpa() {
  const v = $('#upiVpa').value.trim();
  if (!v.includes('@')) { toast('Enter a valid UPI ID (e.g. name@okhdfcbank)', '\u26A0\uFE0F', 'warn'); return; }
  store.set('cafe_upi_override', v);
  if (rtEnabled()) {
    try {
      fetch(RT.url + '/config/upiId.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).catch(() => {});
    } catch (e) { /* offline */ }
  }
  toast('UPI ID saved: ' + v + '. Customers can now pay to this account.', '\uD83D\uDCB3', 'success');
  drawAdmin();
}
function clearVpa() {
  store.del('cafe_upi_override');
  if (rtEnabled()) {
    try {
      fetch(RT.url + '/config/upiId.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'null' }).catch(() => {});
    } catch (e) { /* offline */ }
  }
  toast('Reset to config default: ' + CAFE.upiId, '\u2139\uFE0F');
  drawAdmin();
}

/* ============ live updates ============ */
function requestNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (e) { /* no-op */ }
}

function pushNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification(title, { body, icon: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="70" font-size="70">☕</text></svg>') });
    }
  } catch (e) { /* no-op */ }
}

function onNewPayment(order) {
  const isAdminScreen = (location.hash || '').startsWith('#/admin') && state.adminAuthed;
  if (isAdminScreen) {
    drawAdmin();
    toast('Payment received: ' + fmtINR(order.total) + ' · ' + order.orderId, '\uD83D\uDD14', 'success');
    notifySound();
  }
  pushNotify('Payment received at ' + CAFE.name, fmtINR(order.total) + ' · Order ' + order.orderId + ' · Table ' + (order.table || '—'));
}

const orderSig = o => o.id + ':' + o.items.reduce((s, i) => s + i.qty, 0) + ':' + (o.updatedAt || o.placedAt) + ':' + (o.etaMin || '');

function onOrderEvent(evt) {
  const { order, isNew } = evt;
  if (!order) return;
  const sig = orderSig(order);
  const isAdminScreen = (location.hash || '').startsWith('#/admin') && state.adminAuthed;
  if (isAdminScreen) drawAdmin();
  else if (state.user && (location.hash || '') === '#/menu') router(); // customer sees status/ETA updates live
  if (sig === state.lastSeenOrder) return;
  state.lastSeenOrder = sig;
  store.set('cafe_admin_lastorder', sig);
  if (order.status === 'paid') return; // payment event handles this
  const verb = isNew ? 'New order' : 'Order updated';
  if (isAdminScreen) {
    toast(verb + ': Table ' + order.table + ' · ' + order.id + ' · ' + order.items.reduce((s, i) => s + i.qty, 0) + ' item(s)', '\uD83C\uDF73');
    notifySound();
  }
  pushNotify(verb + ' at ' + CAFE.name, 'Table ' + order.table + ' · ' + order.id + ' · ' + order.items.map(i => i.qty + '× ' + i.name).join(', '));
}

/* cross-tab sync: admin tab sees orders/payments made in other tabs/windows */
window.addEventListener('storage', e => {
  if (e.key === 'cafe_payments' && e.newValue) {
    let payments;
    try { payments = JSON.parse(e.newValue); } catch (err) { return; }
    const last = payments[0];
    if (last && last.txnId !== state.lastSeenPay) {
      state.lastSeenPay = last.txnId;
      store.set('cafe_admin_lastseen', last.txnId);
      onNewPayment(last);
    }
  }
  if (e.key === 'cafe_orders' && e.newValue) {
    let orders;
    try { orders = JSON.parse(e.newValue); } catch (err) { return; }
    const latest = orders[0];
    if (latest) onOrderEvent({ order: latest, isNew: false });
    // refresh the customer's menu so ETA/status updates appear live
    if (state.user && (location.hash || '') === '#/menu') router();
  }
});

/* same-tab notifications */
document.addEventListener('cafe:payment', e => {
  state.lastSeenPay = e.detail.txnId;
  store.set('cafe_admin_lastseen', e.detail.txnId);
  onNewPayment(e.detail);
});
document.addEventListener('cafe:order', e => onOrderEvent(e.detail));

/* ============ live food-progress animation (customer) ============ */
function updateProgress() {
  if (!state.user || (location.hash || '') !== '#/menu') return;
  const now = Date.now();
  // auto-accept orders whose placement is older than 10 seconds
  getOrders().forEach(o => {
    if (o.status === 'open' && now - new Date(o.placedAt).getTime() >= 10000) acceptOrder(o.id);
  });
  getOpenOrders().forEach(o => {
    const fill = $('[data-prog="' + o.id + '"]');
    const label = $('[data-status="' + o.id + '"]');
    if (!fill || !label) return;
    const pct = pctFor(o);
    if (pct !== null) {
      fill.style.width = pct + '%';
      label.textContent = statusText(o, pct);
      label.classList.toggle('almost', pct >= 100);
    }
  });
}
setInterval(updateProgress, 1000);

/* ============ header wiring ============ */
$('#backBtn').addEventListener('click', () => {
  const h = location.hash || '#/';
  if (h === '#/cart' || h === '#/pay' || h === '#/receipt' || h === '#/history' || h === '#/admin') go('#/menu');
  else go('#/');
});
$('#cartBtn').addEventListener('click', () => go('#/cart'));

/* ============ init ============ */
window.addEventListener('hashchange', router);
router();
