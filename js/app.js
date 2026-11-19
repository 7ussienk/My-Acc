/* حساباتي — الواجهة. تقرأ من HS.store (النسخة المحلية) وتحسب عبر HS.compute، والمزامنة تجري في الخلفية. */
(function () {
'use strict';
const S = HS.store, C = HS.compute, NOPART = C.NOPART;
const $ = id => document.getElementById(id);
const $$ = s => Array.from(document.querySelectorAll(s));
const ls = {
  get(k, d) { try { const v = localStorage.getItem('ui:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ui:' + k, JSON.stringify(v)); } catch (e) { } }
};
const storageOK = (() => { try { localStorage.setItem('_t', '1'); localStorage.removeItem('_t'); return true; } catch (e) { return false; } })();
const TYPES = [{ v: 'payment', l: 'دفعة بند' }, { v: 'claim', l: 'دفعت عن غيري' }, { v: 'repay', l: 'استرجعت' }, { v: 'income', l: 'دخل' }];
const typeLabel = v => (TYPES.filter(t => t.v === v)[0] || {}).l || v;
const pick = { type: ls.get('lastType', 'payment'), item: ls.get('lastItem', ''), acc: ls.get('lastAcc', ''), party: ls.get('lastParty', ''), src: ls.get('lastSrc', ''), tf: '', tt: '' };
let view = null, page = 'home', repKey = null, toastTimer = null, mgMode = 'accounts';

/* ---------- أدوات ---------- */
const fmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = x => (x < 10 ? '0' : '') + x;
const bal = n => '<b class="bal">' + fmt(n) + '</b>';
function fmtDT(t) { const d = new Date(t), h = d.getHours(); return '⁦' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + (h % 12 || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM') + '⁩'; }
function hhmm(t) { const d = new Date(t), h = d.getHours(); return '⁦' + (h % 12 || 12) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM') + '⁩'; }
function todayStr() { const n = new Date(); return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()); }
function normDigits(v) { return String(v || '').replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0); }
function parseNum(v) { return parseFloat(normDigits(v).replace('،', '.').replace(',', '.').replace(/\s+/g, '')); }
function amountOf(id) { const a = parseNum($(id).value); if (!(a > 0)) throw new Error('اكتب المبلغ'); return C.r2(a); }
/** وقت الحركة: الآن، أو اليوم المختار مع الوقت الحالي */
function whenOf(dateId) {
  const d = new Date(), v = $(dateId).value;
  if (v) { const p = v.split('-').map(Number); d.setFullYear(p[0], p[1] - 1, p[2]); }
  return d.toISOString();
}
function openDlg(id) { const d = $(id); if (d.open) return; if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
function closeDlg(id) { const d = $(id); if (d.close) d.close(); else d.removeAttribute('open'); }

/* ---------- رسائل ---------- */
function toast(msg, opts) {
  opts = opts || {};
  [['accDlg', 'accMsg'], ['addDlg', 'aMsg'], ['mgDlg', 'mgMsg']].forEach(x => { const d = $(x[0]); if (d && d.open) { const m = $(x[1]); m.textContent = msg; m.className = 'msg' + (opts.err ? ' err' : ''); } });
  const el = $('toast'), b = $('toastBtn'); $('toastTxt').textContent = msg;
  el.classList.toggle('err', !!opts.err);
  if (opts.action) { b.textContent = opts.action.label; b.classList.remove('hidden'); b.onclick = () => { el.classList.remove('on'); opts.action.run(); }; }
  else { b.classList.add('hidden'); b.onclick = null; }
  el.classList.add('on'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), opts.ms || (opts.action ? 9000 : 3500));
}
let cfmCb = null;
function confirmBox(txt, yes, cb) { $('cfmTxt').textContent = txt; $('cfmYes').textContent = yes || 'نعم'; cfmCb = cb; openDlg('cfm'); }
$('cfmNo').addEventListener('click', () => { cfmCb = null; closeDlg('cfm'); });
$('cfmYes').addEventListener('click', () => { const f = cfmCb; cfmCb = null; closeDlg('cfm'); if (f) f(); });

/* ================= الدخول والقفل ================= */
let locked = false, hiddenAt = 0, fails = 0, blockedUntil = 0, blockTimer = null;
let lockPin = ls.get('lockPin', ''), lockSec = Number(ls.get('lockSec', 30));
const showScreen = (id, on) => $(id).classList.toggle('hidden', !on);
function showLogin() {
  showScreen('lock', false); showScreen('setup', true); locked = false;
  $('cfgWarn').classList.toggle('hidden', S.configured());
  $('loginBtn').disabled = !S.configured(); $('loginErr').textContent = ''; $('lgPass').value = '';
}
$('loginForm').addEventListener('submit', e => {
  e.preventDefault();
  const email = $('lgEmail').value.trim(), pass = $('lgPass').value;
  if (!email || !pass) { $('loginErr').textContent = 'اكتب الإيميل وكلمة السر'; return; }
  const b = $('loginBtn'); b.disabled = true; $('loginErr').textContent = '';
  S.signIn(email, pass).then(() => { $('lgPass').value = ''; showScreen('setup', false); render(); return S.sync(); })
    .then(() => { if (S.session) toast('تم الدخول ✓'); })
    .catch(er => { $('loginErr').textContent = er.message; }).then(() => { b.disabled = false; });
});
function lockApp() {
  if (!lockPin || !S.session) return;
  locked = true; showScreen('lock', true);
  const i = $('lockPin'); i.value = ''; i.setAttribute('inputmode', /^\d+$/.test(lockPin) ? 'numeric' : 'text');
  $('lockErr').textContent = '';
  setTimeout(() => { try { i.focus(); } catch (e) { } }, 50);
}
function tryUnlock(auto) {
  if (Date.now() < blockedUntil) return;
  const v = normDigits($('lockPin').value).replace(/\s+/g, '');
  if (!v) return;
  if (v === lockPin) { locked = false; fails = 0; showScreen('lock', false); $('lockPin').value = ''; S.sync(); return; }
  if (auto && v.length < lockPin.length) return;
  fails++; $('lockPin').value = '';
  if (fails >= 5) {
    blockedUntil = Date.now() + 30000; fails = 0; $('lockBtn').disabled = true;
    clearInterval(blockTimer);
    blockTimer = setInterval(() => {
      const s = Math.ceil((blockedUntil - Date.now()) / 1000);
      if (s <= 0) { clearInterval(blockTimer); $('lockBtn').disabled = false; $('lockErr').textContent = ''; }
      else $('lockErr').textContent = 'محاولات كثيرة، انتظر ' + s + ' ثانية';
    }, 500);
  } else $('lockErr').textContent = 'الرقم غير صحيح';
}
$('lockForm').addEventListener('submit', e => { e.preventDefault(); tryUnlock(false); });
$('lockPin').addEventListener('input', () => { if (Date.now() >= blockedUntil) $('lockErr').textContent = ''; tryUnlock(true); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); ls.set('seen', hiddenAt); return; }
  if (hiddenAt && !locked && lockPin && (Date.now() - hiddenAt) / 1000 >= lockSec) lockApp();
  hiddenAt = 0;
  if (!locked) S.sync();
});
window.addEventListener('online', () => S.sync());

/* ================= التنقل ================= */
const standalone = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
function fitViewport() {
  const h = window.innerHeight, root = document.documentElement;
  root.style.setProperty('--vh', h + 'px');
  const full = Math.max(screen.width, screen.height);
  const shortView = standalone && h > window.innerWidth && (full - h) > 4;
  root.style.setProperty('--sab', shortView ? '0px' : 'env(safe-area-inset-bottom,0px)');
  root.style.setProperty('--sat', shortView ? '0px' : 'env(safe-area-inset-top,0px)');
  placePill(false);
}
['resize', 'orientationchange', 'pageshow'].forEach(ev => window.addEventListener(ev, () => setTimeout(fitViewport, 60)));
document.addEventListener('focusin', e => { if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) document.body.classList.add('kb'); });
document.addEventListener('focusout', () => setTimeout(() => { const a = document.activeElement; if (!a || !/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) document.body.classList.remove('kb'); }, 120));
const ORDER = ['home', 'report', 'settings'];
function placePill(anim) {
  const pill = $('pill'), cur = document.querySelector('.nb[aria-current="page"] .ic'), nav = pill.parentNode;
  pill.style.opacity = cur ? '' : '0';
  if (!cur) return;
  const a = cur.getBoundingClientRect(), n = nav.getBoundingClientRect();
  if (!a.width) return;
  if (!anim) pill.style.transition = 'none';
  pill.style.transform = 'translate(' + Math.round(a.left - n.left - 1) + 'px,' + Math.round(a.top - n.top - 1) + 'px)';
  if (!anim) { void pill.offsetWidth; pill.style.transition = ''; }
}
function setPage(p) {
  const old = page; page = p; ls.set('page', p);
  const dir = ORDER.indexOf(p) > ORDER.indexOf(old) ? -26 : 26;
  $$('.pg').forEach(s => { const on = s.id === 'pg-' + p; if (on && s.id !== 'pg-' + old) s.style.setProperty('--dx', dir + 'px'); s.classList.toggle('on', on); });
  $$('.nb').forEach(b => { if (b.getAttribute('data-page') === p) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('scroll').scrollTop = 0;
  placePill(true);
  if (p === 'report') drawReport();
  if (p === 'settings') renderSettings();
}
window.addEventListener('load', () => placePill(false));
$$('.nb').forEach(b => b.addEventListener('click', () => setPage(b.getAttribute('data-page'))));
$('hSet').addEventListener('click', () => setPage('settings'));

/* ================= العرض ================= */
function render() {
  view = C.state(S.db);
  $('hBal').textContent = fmt(view.balance);
  renderPending(); renderHome(); renderAccounts(); renderDues(); renderAdd(); renderSettings();
  if (page === 'report') drawReport();
  if ($('mgDlg').open) renderManage();
}
function delBtn(x, lbl) { return '<button class="x" aria-label="حذف" data-del="' + x.id + '" data-lbl="' + esc(lbl) + '">✕</button>'; }
function barRow(name, v, max, sub) {
  return '<div class="cat"><div class="r"><span>' + esc(name) + (sub ? ' <span style="color:var(--mute);font-size:12px">' + esc(sub) + '</span>' : '') + '</span><b>' + fmt(v) + '</b></div><div class="bar thin acc"><i style="width:' + (max > 0 ? Math.round(v / max * 100) : 0) + '%"></i></div></div>';
}
function partsHtml(it) {
  if (!it.parts.length) return '';
  return '<div class="parts">' + it.parts.map(p => '<div class="part"><span>' + esc(p.name) + '</span><b>' + fmt(p.amount) + '</b></div>').join('') + '</div>';
}
function itemHtml(i) {
  const hasB = i.budget != null && i.budget > 0, pct = hasB ? Math.min(100, Math.round(i.paid / i.budget * 100)) : 0, over = hasB && i.paid > i.budget;
  const last = i.last.slice(0, 3);
  return '<details class="it"><summary><div class="ihead"><b style="font-size:15px">' + esc(i.name) + '</b><span style="font-size:13px"><b>' + fmt(i.paid) + '</b>' + (hasB ? ' / ' + fmt(i.budget) : '') + '</span></div>' +
    (hasB ? '<div class="bar thin ' + (over ? 'bad' : 'acc') + '"><i style="width:' + pct + '%"></i></div>' : '') +
    '<div class="sm"><span>' + (i.monthPaid ? ('هذا الشهر ' + fmt(i.monthPaid)) : '') + '</span><span>' + (hasB ? (over ? ('تجاوز الميزانية بـ ' + fmt(i.paid - i.budget)) : ('المتبقي ' + fmt(i.budget - i.paid))) : '') + '</span></div></summary>' +
    (i.parts.length ? partsHtml(i) : '<div class="empty">ما فيه دفعات بعد.</div>') +
    (last.length ? '<div class="sm2" style="margin-top:6px">آخر الدفعات</div><div class="parts" style="margin-top:4px">' + last.map(p =>
      '<div class="part"><span>' + (p.pending ? '⏳ ' : '') + esc(fmtDT(p.t)) + (p.category ? ' · ' + esc(p.category) : '') + '</span><b>' + fmt(p.amount) + '</b></div>').join('') + '</div>' : '') + '</details>';
}
function renderHome() {
  const s = view, m = s.month;
  $('homeAcc').innerHTML = s.accounts.length ? s.accounts.map((a, i) =>
    '<div class="accrow"><div class="ar"><span>' + esc(a.name) + '</span><span>' + bal(a.balance) + ' <small>ر.س</small></span></div>' +
    '<button class="link" type="button" data-rec="' + i + '" style="padding:4px 0">طابق مع الرصيد الفعلي</button>' +
    '<div class="recbox hidden" id="rb' + i + '"><input id="ri' + i + '" inputmode="decimal" placeholder="كم في الحساب الآن؟" aria-label="الرصيد الفعلي في ' + esc(a.name) + '"><button class="sub" type="button" data-save="' + a.id + '" data-i="' + i + '">طابق</button></div></div>').join('') +
    '<div class="tot"><span>الإجمالي</span>' + bal(s.balance) + '</div>'
    : '<div class="empty">ما فيه حسابات بعد. أضف حساباتك من الإعدادات ← إدارة الحسابات، أو رحّل بياناتك من Google Sheets من الإعدادات.</div>';
  const its = s.items.filter(i => !i.archived && (i.paid > 0 || i.budget));
  let tp = 0, tb = 0; its.forEach(i => { tp += i.paid; tb += i.budget || 0; });
  $('itTot').textContent = 'المدفوع ' + fmt(tp) + (tb ? ' من ' + fmt(tb) : '');
  $('homeItems').innerHTML = its.length ? its.map(itemHtml).join('') : '<div class="empty">ما فيه دفعات بعد. اضغط + وسجّل أول دفعة.</div>';
  $('hMonth').textContent = m.label;
  const mx = Math.max(m.monthly, m.payments, m.claims);
  $('hBreak').innerHTML = barRow('دفعات البنود', m.payments, mx) + barRow('مصروف عام', m.monthly, mx, 'من مطابقة الرصيد') + barRow('دفعت عن غيري', m.claims, mx, 'ترجع لك') +
    '<div class="sum-row" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px"><span>الدخل <b>' + fmt(m.income) + '</b></span><span>استرجعت <b>' + fmt(m.repaid) + '</b></span></div>';
}
function chips(id, list, key) {
  $(id).innerHTML = list.map(o => '<button type="button" class="chip" data-k="' + key + '" data-v="' + esc(o.v) + '" aria-pressed="' + (pick[key] === o.v) + '">' + esc(o.l) + '</button>').join('');
}
function resetPick() { $$('.chip[data-k]').forEach(x => x.setAttribute('aria-pressed', String(pick[x.getAttribute('data-k')] === x.getAttribute('data-v')))); }
const opt = a => a.map(x => ({ v: x.id, l: x.name }));

/* ---------- المستحقات ---------- */
function duesDetail(d) {
  let h = '';
  d.parties.forEach(p => {
    h += '<div class="sum-top" style="margin-top:12px"><span class="sum-month">' + esc(p.name) + '</span><span class="badge ' + (p.remaining > 0 ? 'warn' : 'ok') + '">' + (p.remaining > 0 ? 'باقي ' + fmt(p.remaining) : 'مسدَّدة') + '</span></div>';
    h += '<div class="sum-row"><span>دفعتُ عنهم <b>' + fmt(p.claimed) + '</b></span><span>استرجعتُ <b>' + fmt(p.repaid) + '</b></span></div>';
    if (p.open.length) h += '<div class="parts">' + p.open.map(o =>
      '<div class="part"><span>' + esc(o.note || '') + (o.pending ? ' · ⏳' : '') + (o.left < o.amount ? ' · باقي ' + fmt(o.left) : '') + '</span><b>' + fmt(o.amount) + '</b>' + delBtn(o, (o.note || 'مستحق') + ' — ' + fmt(o.amount)) + '</div>').join('') + '</div>';
    if (p.repayments.length) h += '<div class="sm2" style="margin-top:6px">آخر ما استرجعته من ' + esc(p.name) + '</div><div class="parts">' + p.repayments.map(o =>
      '<div class="part"><span>' + esc(view.accName[o.account_id] || '') + ' · ' + (o.pending ? '⏳' : esc(fmtDT(o.t))) + '</span><b>+' + fmt(o.amount) + '</b>' + delBtn(o, 'استرجاع ' + fmt(o.amount)) + '</div>').join('') + '</div>';
  });
  return h;
}
function renderDues() {
  const d = view.dues, ps = d.parties.filter(p => p.remaining > 0);
  let h = '<div class="sum-top"><h2 class="t" style="margin:0">لي عند الناس</h2>' + (d.parties.length && !(d.remaining > 0) ? '<span class="badge ok">مسدَّدة</span>' : '') + '</div>';
  if (!d.parties.length) { $('duesCard').innerHTML = h + '<div class="empty">ما فيه مستحقات. لما تدفع عن أحد أو تعطيه مبلغ بيرجع لك، سجّله من زر +.</div>'; return; }
  h += '<div class="accrow" style="border-top:0">' + ps.map(p => '<div class="ar" style="padding:4px 0"><span>' + esc(p.name) + '</span><span>' + bal(p.remaining) + ' <small>ر.س</small></span></div>').join('') + '</div>';
  h += '<div class="tot"><span>الإجمالي</span>' + bal(d.remaining) + '</div>';
  h += '<details class="it" style="margin-top:8px"><summary><span class="link" style="display:inline-block;padding:6px 0">التفاصيل ▾</span></summary>' + duesDetail(d) + '</details>';
  $('duesCard').innerHTML = h;
}

/* ---------- نافذة التسجيل (+) ---------- */
function renderAdd() {
  const accs = view.allAccounts.filter(a => !a.archived), items = view.items.filter(i => !i.archived), parties = view.dues.all;
  const has = (l, id) => l.some(x => x.id === id);
  if (!has(accs, pick.acc)) pick.acc = accs.length ? accs[0].id : '';
  if (!has(items, pick.item)) pick.item = items.length === 1 ? items[0].id : '';
  if (!$('dParty').value && !has(parties, pick.party)) pick.party = parties.length === 1 ? parties[0].id : '';
  if (!TYPES.some(t => t.v === pick.type)) pick.type = 'payment';
  chips('typeChips', TYPES, 'type');
  chips('accChipsA', opt(accs), 'acc');
  chips('itemChips', opt(items), 'item');
  $('itemChips').insertAdjacentHTML('beforeend', '<button type="button" class="chip" id="btnNewItem">＋ بند جديد</button>');
  chips('partyChipsD', opt(parties), 'party');
  if (!$('aSrc').value && view.sources.indexOf(pick.src) < 0) pick.src = view.sources.length === 1 ? view.sources[0] : '';
  chips('srcChips', view.sources.map(x => ({ v: x, l: x })), 'src');
  updateAdd();
}
function renderPartChips() {
  const it = view.items.filter(x => x.id === pick.item)[0];
  const names = it ? it.parts.map(p => p.name).filter(n => n !== NOPART) : [];
  $('partChips').innerHTML = names.map(n => '<button type="button" class="chip sm" data-part="' + esc(n) + '">' + esc(n) + '</button>').join('');
}
function updateAdd() {
  const t = pick.type, out = (t === 'payment' || t === 'claim');
  $('aItemBox').classList.toggle('hidden', t !== 'payment');
  $('aPartyBox').classList.toggle('hidden', t !== 'claim' && t !== 'repay');
  $('aSrcBox').classList.toggle('hidden', t !== 'income');
  $('aAccLbl').textContent = out ? 'من أي حساب؟' : 'دخل في أي حساب؟';
  $('aNote').placeholder = t === 'claim' ? 'على إيش؟ (مثال: علاج)' : (t === 'payment' ? 'مدفوع لمن / ملاحظة (اختياري)' : 'ملاحظة (اختياري)');
  $('aBtn').textContent = 'حفظ: ' + typeLabel(t);
  renderPartChips();
}
$('btnAdd').addEventListener('click', () => {
  if (!view.allAccounts.some(a => !a.archived)) { toast('أضف حسابًا أول من الإعدادات ← إدارة الحسابات', { err: true, ms: 5000 }); return; }
  $('aMsg').textContent = ''; $('newItemBox').classList.add('hidden');
  openDlg('addDlg'); setTimeout(() => { try { $('aAmt').focus(); } catch (e) { } }, 60);
});
$('aClose').addEventListener('click', () => closeDlg('addDlg'));
$('btnCancelItem').addEventListener('click', () => $('newItemBox').classList.add('hidden'));
$('dParty').addEventListener('input', () => { pick.party = ''; resetPick(); });
$('aSrc').addEventListener('input', () => { pick.src = ''; resetPick(); });

/** يسجّل حركة محليًا فورًا ثم يزامن في الخلفية */
function addTx(row, okMsg) {
  const r = S.put('transactions', row);
  render(); S.sync();
  toast(okMsg || 'تم التسجيل ✓', { action: { label: 'تراجع', run() { S.remove('transactions', r.id); render(); S.sync(); toast('تم التراجع'); } } });
  return r;
}
function refByName(table, name) {
  const ex = S.db[table].filter(r => !r.deleted_at && r.name === name)[0];
  return ex ? ex.id : S.put(table, { name: name }).id;
}
$('fa').addEventListener('submit', e => {
  e.preventDefault();
  try {
    const t = pick.type, note = $('aNote').value.trim();
    const row = { kind: t, amount: amountOf('aAmt'), account_id: pick.acc, note: note, occurred_at: whenOf('aDate') };
    if (!pick.acc) throw new Error('اختر الحساب');
    if (t === 'payment') {
      if (!pick.item) throw new Error('اختر البند');
      row.item_id = pick.item; row.category = $('aPart').value.trim();
    } else if (t === 'income') {
      const src = $('aSrc').value.trim() || pick.src;
      if (!src) throw new Error('اختر المصدر أو اكتبه');
      row.category = src; pick.src = src; ls.set('lastSrc', src);
    } else {
      const nm = $('dParty').value.trim();
      if (!nm && !pick.party) throw new Error('اختر الجهة أو اكتب اسمها');
      row.party_id = nm ? refByName('parties', nm) : pick.party;
      pick.party = row.party_id; ls.set('lastParty', pick.party);
    }
    ['aAmt', 'aNote', 'aPart', 'dParty', 'aSrc', 'aDate'].forEach(i => { $(i).value = ''; });
    $('aDate').classList.add('hidden'); closeDlg('addDlg');
    addTx(row);
  } catch (er) { toast(er.message, { err: true }); }
});
$('btnSaveItem').addEventListener('click', () => {
  const name = $('niName').value.trim(), b = $('niBudget').value.trim();
  if (!name) { toast('اكتب اسم البند', { err: true }); return; }
  if (S.db.items.some(i => !i.deleted_at && i.name === name)) { toast('البند موجود مسبقًا', { err: true }); return; }
  const budget = b ? parseNum(b) : null;
  if (b && !(budget >= 0)) { toast('الميزانية غير صحيحة', { err: true }); return; }
  const it = S.put('items', { name: name, budget: budget, sort: S.db.items.length });
  pick.item = it.id; ls.set('lastItem', it.id);
  $('niName').value = ''; $('niBudget').value = ''; $('newItemBox').classList.add('hidden');
  render(); S.sync(); toast('انضاف البند ✓');
});

/* ---------- نقرات عامة ---------- */
document.addEventListener('click', e => {
  const t = e.target; if (!t.closest) return;
  if (t.closest('#btnNewItem')) { const nb = $('newItemBox'); nb.classList.toggle('hidden'); if (!nb.classList.contains('hidden')) $('niName').focus(); return; }
  const pc = t.closest('[data-part]'); if (pc) { $('aPart').value = pc.getAttribute('data-part'); return; }
  const db = t.closest('[data-date]');
  if (db) { const d = $(db.getAttribute('data-date')); d.classList.toggle('hidden'); if (!d.classList.contains('hidden')) { d.value = todayStr(); d.focus(); } else d.value = ''; return; }
  const dl = t.closest('[data-del]');
  if (dl) { const id = dl.getAttribute('data-del'); confirmBox('حذف «' + dl.getAttribute('data-lbl') + '»؟', 'حذف', () => { S.remove('transactions', id); render(); S.sync(); toast('تم الحذف'); }); return; }
  const rc = t.closest('[data-rec]');
  if (rc) { const i = rc.getAttribute('data-rec'), b = $('rb' + i); b.classList.toggle('hidden'); if (!b.classList.contains('hidden')) { $('ri' + i).value = ''; $('ri' + i).focus(); } return; }
  const sv = t.closest('[data-save]');
  if (sv) { match(sv.getAttribute('data-save'), sv.getAttribute('data-i')); return; }
  const c = t.closest('.chip[data-k]'); if (!c) return;
  const k = c.getAttribute('data-k'), v = c.getAttribute('data-v');
  pick[k] = v;
  if (k === 'acc') ls.set('lastAcc', v);
  if (k === 'type') { ls.set('lastType', v); updateAdd(); }
  if (k === 'item') { ls.set('lastItem', v); renderPartChips(); }
  if (k === 'src') { $('aSrc').value = ''; ls.set('lastSrc', v); }
  if (k === 'party') { $('dParty').value = ''; ls.set('lastParty', v); }
  const AL = view.allAccounts.filter(a => !a.archived);
  if ((k === 'tf' || k === 'tt') && AL.length === 2) { const other = AL.filter(x => x.id !== v)[0].id; if (k === 'tf') pick.tt = other; else pick.tf = other; }
  resetPick();
});
/** مطابقة الرصيد: تكتب الرصيد الفعلي، والفرق يتسجل حركة (مصروف عام لو نقص، تسوية لو زاد) */
function match(accId, i) {
  const v = parseNum($('ri' + i).value);
  if (!isFinite(v) || v < 0) { toast('اكتب الرصيد الفعلي', { err: true }); return; }
  const a = view.allAccounts.filter(x => x.id === accId)[0]; if (!a) return;
  const diff = C.r2(a.balance - v);
  if (Math.abs(diff) < 0.005) { $('rb' + i).classList.add('hidden'); toast('الرصيد مطابق ✓'); return; }
  if (diff > 0) addTx({ kind: 'expense', amount: diff, account_id: accId, category: 'مطابقة الرصيد', note: 'مصروف عام (مطابقة الرصيد)' }, 'انسجل ' + fmt(diff) + ' مصروف عام ✓');
  else addTx({ kind: 'adjust', amount: -diff, account_id: accId, note: 'تسوية: الرصيد الفعلي أعلى من المسجّل' }, 'الفعلي أعلى بـ ' + fmt(-diff) + '، انسجلت تسوية. لو كان دخل، تراجع وسجّله من +');
}

/* ================= الحسابات والتحويل ================= */
function txTitle(x, V) {
  const A = V.accName, P = V.partyName[x.party_id] || '';
  switch (x.kind) {
    case 'payment': return (V.itemName[x.item_id] || 'بند') + (x.category ? ' — ' + x.category : '');
    case 'expense': return x.note || x.category || 'مصروف عام';
    case 'income': return x.note || x.category || 'دخل';
    case 'transfer': return 'من ' + (A[x.account_id] || '') + ' إلى ' + (A[x.to_account_id] || '');
    case 'claim': return 'دفعتُ عن ' + P + (x.note ? ': ' + x.note : '');
    case 'repay': return 'استرجعتُ من ' + P + (x.note ? ': ' + x.note : '');
    default: return x.note || 'تسوية رصيد';
  }
}
function txSub(x, V) {
  const bits = [];
  if (x.kind !== 'transfer') bits.push(V.accName[x.account_id] || '');
  if (x.kind === 'income' && x.note && x.category) bits.push(x.category);
  if ((x.kind === 'payment' || x.kind === 'transfer') && x.note) bits.push(x.note);
  bits.push(x.pending ? '⏳ ينتظر المزامنة' : fmtDT(x.t));
  return bits.filter(Boolean).join(' · ');
}
function txRow(x, V) {
  const plus = x.kind === 'income' || x.kind === 'repay' || (x.kind === 'adjust' && x.amount > 0), title = txTitle(x, V);
  return '<div class="rec"><div class="t"><b>' + esc(title) + '</b><span>' + esc(txSub(x, V)) + '</span></div><div class="a ' + (plus ? 'pos' : '') + '">' + (plus ? '+' : '') + fmt(x.amount) + '</div>' + delBtn(x, title + ' — ' + fmt(x.amount)) + '</div>';
}
function renderAccounts() {
  const s = view, accs = opt(s.allAccounts.filter(a => !a.archived));
  const rows = s.accounts.map(a => '<div class="accrow"><div class="ar"><span>' + esc(a.name) + '</span><span>' + bal(a.balance) + ' <small>ر.س</small></span></div></div>').join('');
  $('accList').innerHTML = rows; $('accTotal').textContent = fmt(s.balance);
  chips('tfFrom', accs, 'tf'); chips('tfTo', accs, 'tt');
  $('tfRecent').innerHTML = s.recentTransfers.length ? s.recentTransfers.map(x => txRow(x, s)).join('') : '<div class="empty">ما فيه تحويلات.</div>';
}
$('hBalBtn').addEventListener('click', () => { $('accMsg').textContent = ''; openDlg('accDlg'); });
$('btnAccOpen2').addEventListener('click', () => { $('accMsg').textContent = ''; openDlg('accDlg'); });
$('accClose').addEventListener('click', () => closeDlg('accDlg'));
$('tfBtn').addEventListener('click', () => {
  try {
    const amt = amountOf('tfAmt');
    if (!pick.tf) throw new Error('اختر الحساب المحوَّل منه');
    if (!pick.tt) throw new Error('اختر الحساب المحوَّل إليه');
    if (pick.tf === pick.tt) throw new Error('اختر حسابين مختلفين');
    addTx({ kind: 'transfer', amount: amt, account_id: pick.tf, to_account_id: pick.tt, note: $('tfNotes').value.trim() }, 'تم التحويل ✓');
    $('tfAmt').value = ''; $('tfNotes').value = '';
  } catch (er) { toast(er.message, { err: true }); }
});

/* ================= المعلّق ================= */
function pendDesc(p) {
  const r = p.row;
  if (p.table === 'transactions') return (r.deleted_at ? 'حذف: ' : '') + typeOrKind(r.kind) + ' ' + fmt(r.amount);
  const what = { accounts: 'حساب', items: 'بند', parties: 'جهة' }[p.table];
  return (r.deleted_at ? 'حذف ' : (r._new ? 'إضافة ' : 'تعديل ')) + what + ': ' + r.name;
}
function typeOrKind(k) { return ({ payment: 'دفعة بند', claim: 'دفعت عن غيري', repay: 'استرجاع', income: 'دخل', expense: 'مصروف عام', transfer: 'تحويل', adjust: 'تسوية رصيد' })[k] || k; }
function renderPending() {
  const d = S.dirty(), bad = d.filter(p => p.row._err).length, el = $('pending');
  el.classList.toggle('on', d.length > 0);
  if (d.length) $('pendingTxt').textContent = bad ? ('فيه ' + bad + ' تسجيل رفضته القاعدة') : ('فيه ' + d.length + ' تسجيل ينتظر المزامنة');
  if ($('pendDlg').open) renderPendList();
}
function renderPendList() {
  const d = S.dirty();
  $('pendList').innerHTML = d.length ? d.map((p, i) =>
    '<div class="rec"><div class="t"><b>' + esc(pendDesc(p)) + '</b><span' + (p.row._err ? ' style="color:var(--red)"' : '') + '>' + esc(p.row._err || 'ينتظر الاتصال') + '</span></div>' +
    (p.row._new ? '<button class="x" aria-label="إلغاء" data-qdel="' + i + '">✕</button>' : '') + '</div>').join('') : '<div class="empty">ما فيه شيء معلّق.</div>';
}
$('btnPendList').addEventListener('click', () => { renderPendList(); openDlg('pendDlg'); });
$('pendClose').addEventListener('click', () => closeDlg('pendDlg'));
$('pendList').addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-qdel]'); if (!b) return;
  const p = S.dirty()[Number(b.getAttribute('data-qdel'))]; if (!p) return;
  const used = p.table !== 'transactions' && S.db.transactions.some(x => !x.deleted_at && (x.account_id === p.row.id || x.to_account_id === p.row.id || x.item_id === p.row.id || x.party_id === p.row.id));
  if (used) { toast('فيه حركات مرتبطة به، احذفها أول'); return; }
  S.remove(p.table, p.row.id); render();
  if (!S.dirty().length) closeDlg('pendDlg');
});
$('btnRetry').addEventListener('click', () => {
  S.db.accounts.concat(S.db.items, S.db.parties, S.db.transactions).forEach(r => { delete r._err; });     // محاولة جديدة للمرفوض
  S.sync().then(() => toast(S.status.online === false ? 'ما فيه اتصال' : (S.dirty().length ? 'بعض التسجيلات ما انرفعت' : 'تمت المزامنة ✓'), { err: S.status.online === false }));
});

/* ================= السجل (تقرير الشهر) ================= */
const kpi = (l, v, c) => '<div class="kpi"><span>' + l + '</span><b class="' + c + '">' + v + '</b></div>';
function listSec(title, arr, r) {
  let h = '<details class="sec"><summary><span>' + title + ' <span style="color:var(--mute);font-weight:600">(' + arr.length + ')</span></span><span>▾</span></summary><div>';
  h += arr.length ? arr.map(x => txRow(x, r)).join('') : '<div class="empty">لا شيء في هذا الشهر.</div>';
  return h + '</div></details>';
}
function drawReport() {
  const r = C.report(S.db, repKey); repKey = r.month.key;
  const sel = $('mSel');
  sel.innerHTML = r.months.slice().reverse().map(m => '<option value="' + m.key + '">' + esc(m.label) + '</option>').join('');
  sel.value = r.month.key;
  const idx = r.months.findIndex(m => m.key === r.month.key);
  $('mPrev').disabled = idx <= 0; $('mNext').disabled = idx >= r.months.length - 1;
  const T = r.sum, mx = Math.max(T.monthly, T.payments, T.claims);
  let h = '<div class="kpis">' + kpi('الدخل', fmt(T.income), 'pos') + kpi('إجمالي الصرف', fmt(T.out), '') + kpi('استرجعت', fmt(T.repaid), 'pos') + kpi('الصافي', (T.net > 0 ? '+' : '') + fmt(T.net), T.net >= 0 ? 'pos' : 'neg') + '</div>';
  h += '<section class="card"><h2 class="t">وين راحت الفلوس؟</h2>' + barRow('دفعات البنود', T.payments, mx) + barRow('مصروف عام', T.monthly, mx) + barRow('دفعت عن غيري (مستحقات)', T.claims, mx, 'ترجع لك') + '</section>';
  const pm = r.items.filter(i => i.monthPaid > 0).sort((a, b) => b.monthPaid - a.monthPaid);
  if (pm.length) h += '<section class="card"><h2 class="t">دفعات البنود هذا الشهر</h2>' + pm.map(i => barRow(i.name, i.monthPaid, pm[0].monthPaid)).join('') + '</section>';
  if (r.accounts.length) h += '<section class="card"><h2 class="t">الحسابات</h2>' + r.accounts.map(a =>
    '<div class="accrow"><div class="ar"><span>' + esc(a.name) + '</span><span>' + bal(a.balance) + ' <small>ر.س</small></span></div><div class="sm2">هذا الشهر: دخل ' + fmt(a.inn) + ' · خرج ' + fmt(a.out) + '</div></div>').join('') +
    '<div class="tot"><span>الإجمالي الآن</span>' + bal(r.balance) + '</div></section>';
  const shown = r.items.filter(i => i.paid > 0 || i.budget);
  h += '<section class="card"><h2 class="t">البنود (كل الفترة)</h2>' + (shown.length ? shown.map(itemHtml).join('') +
    '<div class="sum-row" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px"><span>الميزانيات <b>' + fmt(r.itemsTotal.budget) + '</b></span><span>المدفوع <b>' + fmt(r.itemsTotal.paid) + '</b></span></div>' : '<div class="empty">ما فيه بنود.</div>') + '</section>';
  h += listSec('الدفعات', r.payments, r) + listSec('المصروف العام', r.expenses, r) + listSec('المستحقات (دفعت عن غيري / استرجعت)', r.claims, r) +
    listSec('المداخيل', r.incomes, r) + listSec('التحويلات', r.transfers, r) + (r.adjusts.length ? listSec('تسويات الرصيد', r.adjusts, r) : '');
  h += '<section class="card"><h2 class="t">كل الأشهر</h2><div class="tblw"><table><thead><tr><th>الشهر</th><th>الدخل</th><th>الصرف</th><th>بنود</th><th>الصافي</th></tr></thead><tbody>' +
    r.all.slice().reverse().map(a => '<tr' + (a.key === r.month.key ? ' class="cur"' : '') + '><td>' + esc(a.label) + '</td><td>' + fmt(a.income) + '</td><td>' + fmt(a.out) + '</td><td>' + fmt(a.payments) + '</td><td class="' + (a.net >= 0 ? 'pos' : 'neg') + '">' + fmt(a.net) + '</td></tr>').join('') +
    '</tbody></table></div></section>';
  $('repBody').innerHTML = h;
  $('mPrev').onclick = () => { if (idx > 0) { repKey = r.months[idx - 1].key; drawReport(); } };
  $('mNext').onclick = () => { if (idx < r.months.length - 1) { repKey = r.months[idx + 1].key; drawReport(); } };
}
$('mSel').addEventListener('change', function () { repKey = this.value; drawReport(); });

/* ================= الإعدادات ================= */
function renderSettings() {
  const st = S.status, dot = $('cDot'), tx = $('cTxt'), n = S.dirty().length;
  if (!S.session) { dot.className = 'dot bad'; tx.textContent = 'غير مسجّل الدخول'; }
  else if (st.error) { dot.className = 'dot bad'; tx.textContent = 'خطأ في المزامنة: ' + st.error; }
  else if (st.online === false) { dot.className = 'dot bad'; tx.textContent = 'لا يوجد اتصال — تعمل من النسخة المحفوظة على الجوال'; }
  else if (st.last) { dot.className = 'dot ok'; tx.textContent = 'متزامن · آخر مزامنة ' + hhmm(st.last); }
  else { dot.className = 'dot'; tx.textContent = 'جارٍ المزامنة…'; }
  $('cUser').textContent = (S.session ? S.session.email : '') + (n ? ' · ' + n + ' ينتظر المزامنة' : '');
  $('lockSel').value = String(lockSec);
  $('lockState').textContent = lockPin ? 'القفل مفعّل على هذا الجوال.' : 'القفل غير مفعّل.';
  $('storeWarn').classList.toggle('hidden', storageOK);
}
$('btnSync').addEventListener('click', function () {
  const b = this; b.disabled = true;
  S.sync().then(() => toast(S.status.error ? S.status.error : (S.status.online === false ? 'ما فيه اتصال' : 'تمت المزامنة ✓'), { err: !!S.status.error || S.status.online === false })).then(() => { b.disabled = false; });
});
$('lockSel').addEventListener('change', function () { lockSec = Number(this.value); ls.set('lockSec', lockSec); toast('تم الحفظ ✓'); });
$('btnLockSave').addEventListener('click', () => {
  const v = normDigits($('lockNew').value).replace(/\s+/g, '');
  if (v && v.length < 4) { toast('رقم القفل لازم 4 خانات على الأقل', { err: true }); return; }
  lockPin = v; ls.set('lockPin', v); $('lockNew').value = ''; renderSettings();
  toast(v ? 'تم تفعيل القفل ✓' : 'تم إلغاء القفل');
});
$('btnSignOut').addEventListener('click', () => {
  const n = S.dirty().length;
  confirmBox(n ? ('فيه ' + n + ' تسجيل ما انرفع وبيضيع. تسجيل الخروج؟') : 'تسجيل الخروج من هذا الجوال؟ بياناتك باقية في القاعدة.', 'خروج', () => { S.signOut(); });
});
$('btnLegacy').addEventListener('click', function () {
  const url = $('lgUrl').value.trim(), pin = normDigits($('lgPin').value).replace(/\s+/g, ''), msg = $('lgMsg'), b = this;
  const say = (t, err) => { msg.textContent = t; msg.className = 'msg' + (err ? ' err' : ''); };
  if (!/^https:\/\/|^http:\/\/localhost|^\//.test(url)) { say('الصق رابط Apps Script (ينتهي بـ /exec)', true); return; }
  if (!pin) { say('اكتب الرقم السري القديم', true); return; }
  b.disabled = true;
  HS.legacy.run(url, pin, say).then(r => {
    $('lgPin').value = ''; render();
    say('تم ترحيل ' + r.count + ' حركة من ' + r.months + ' شهر ✓' + (r.capped ? ' (تنبيه: شهر فيه أكثر من 300 سجل في قائمة واحدة، وما زاد عنها ما انتقل)' : ''));
    return S.sync();
  }).catch(er => say(er.message, true)).then(() => { b.disabled = false; });
});

/* ---------- إدارة الحسابات والبنود ---------- */
function renderManage() {
  const acc = mgMode === 'accounts', rows = (acc ? view.allAccounts : view.items);
  $('mgTitle').textContent = acc ? 'إدارة الحسابات' : 'إدارة البنود';
  $('mgName').placeholder = acc ? 'اسم حساب جديد' : 'اسم بند جديد';
  $('mgNum').placeholder = acc ? 'رصيده الآن (اختياري)' : 'الميزانية (اختياري)';
  $('mgList').innerHTML = rows.length ? rows.map(r =>
    '<div class="recbox"' + (r.archived ? ' style="opacity:.55"' : '') + '><input data-mgn="' + r.id + '" value="' + esc(r.name) + '" maxlength="60" aria-label="الاسم">' +
    (acc ? '' : '<input data-mgb="' + r.id + '" inputmode="decimal" value="' + (r.budget == null ? '' : r.budget) + '" placeholder="الميزانية" aria-label="الميزانية" style="max-width:110px">') +
    '<button class="sub" type="button" data-mga="' + r.id + '">' + (r.archived ? 'إرجاع' : 'أرشفة') + '</button></div>').join('')
    : '<div class="empty">ما فيه شيء بعد.</div>';
}
function openManage(mode) { mgMode = mode; $('mgMsg').textContent = ''; $('mgName').value = ''; $('mgNum').value = ''; renderManage(); openDlg('mgDlg'); }
$('btnMgAcc').addEventListener('click', () => openManage('accounts'));
$('btnMgItems').addEventListener('click', () => openManage('items'));
$('mgClose').addEventListener('click', () => closeDlg('mgDlg'));
$('mgList').addEventListener('change', e => {
  const t = e.target, id = t.getAttribute('data-mgn') || t.getAttribute('data-mgb'); if (!id) return;
  if (t.hasAttribute('data-mgn')) {
    const name = t.value.trim();
    if (!name || S.db[mgMode].some(r => !r.deleted_at && r.id !== id && r.name === name)) { toast(name ? 'الاسم مستخدم' : 'الاسم ما يكون فاضي', { err: true }); renderManage(); return; }
    S.put(mgMode, { id: id, name: name });
  } else {
    const b = t.value.trim() ? parseNum(t.value) : null;
    if (b !== null && !(b >= 0)) { toast('الميزانية غير صحيحة', { err: true }); renderManage(); return; }
    S.put('items', { id: id, budget: b });
  }
  render(); S.sync(); toast('تم الحفظ ✓');
});
$('mgList').addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-mga]'); if (!b) return;
  const row = S.find(mgMode, b.getAttribute('data-mga'));
  S.put(mgMode, { id: row.id, archived: !row.archived }); render(); S.sync();
});
$('mgAdd').addEventListener('click', () => {
  const name = $('mgName').value.trim(), raw = $('mgNum').value.trim(), num = raw ? parseNum(raw) : null;
  if (!name) { toast('اكتب الاسم', { err: true }); return; }
  if (S.db[mgMode].some(r => !r.deleted_at && r.name === name)) { toast('الاسم مستخدم', { err: true }); return; }
  if (raw && !isFinite(num)) { toast('الرقم غير صحيح', { err: true }); return; }
  if (mgMode === 'accounts') {
    const a = S.put('accounts', { name: name, sort: S.db.accounts.length });
    if (num) S.put('transactions', { kind: 'adjust', amount: C.r2(num), account_id: a.id, note: 'رصيد افتتاحي' });
  } else S.put('items', { name: name, budget: num !== null && num >= 0 ? C.r2(num) : null, sort: S.db.items.length });
  $('mgName').value = ''; $('mgNum').value = '';
  render(); S.sync(); toast('تمت الإضافة ✓');
});

/* ================= تشغيل ================= */
if (window.HESABATI && HESABATI.legacyUrl) $('lgUrl').value = HESABATI.legacyUrl;
S.on(() => { if (!S.session && $('setup').classList.contains('hidden')) showLogin(); render(); });
S.init().then(() => {
  const saved = ls.get('page', 'home');
  fitViewport(); setPage(ORDER.indexOf(saved) >= 0 ? saved : 'home');
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placePill(false));
  render();
  if (!S.session) { showLogin(); return; }
  const seen = Number(ls.get('seen', 0));
  if (lockPin && !(seen && (Date.now() - seen) / 1000 < lockSec)) lockApp();
  S.sync();
});
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
})();
