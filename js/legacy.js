/* حساباتي — ترحيل مرة واحدة من النسخة القديمة (Google Sheets عبر رابط Apps Script).
   يقرأ الحالة وتقارير كل الأشهر من الخلفية القديمة ويحوّلها إلى حركات في الدفتر الجديد.
   المعرّفات مشتقة من السجل الأصلي، فإعادة التشغيل ما تكرر شيئًا. */
(function (G) {
'use strict';
var HS = G.HS = G.HS || {};
var S = HS.store, C = HS.compute;
var UNKNOWN = 'غير محدد (قديم)', OPEN_NOTE = 'رصيد افتتاحي (ترحيل من Google Sheets)';

async function uuid5(s) {
  var h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode('hesabati-legacy:' + s)));
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  var x = Array.prototype.map.call(h.slice(0, 16), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
}

async function run(url, pin, say) {
  say = say || function () { };
  async function get(extra) {
    var r;
    try { r = await fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'pin=' + encodeURIComponent(pin) + (extra || '') + '&_=' + Date.now()); }
    catch (e) { throw new Error('ما قدرت أوصل لرابط Apps Script'); }
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'تعذّرت القراءة من النسخة القديمة');
    return j;
  }
  say('أقرأ الحسابات والبنود…');
  var st = await get(''), first = await get('&action=report'), reps = [], capped = false;
  for (var i = 0; i < first.months.length; i++) {
    var m = first.months[i];
    say('أقرأ ' + m.label + ' (' + (i + 1) + ' من ' + first.months.length + ')…');
    reps.push(m.key === first.month.key ? first : await get('&action=report&month=' + m.key));
  }

  // المراجع: نعيد استخدام الموجود بنفس الاسم، وإلا ننشئه بمعرّف ثابت
  async function ref(table, name, extra) {
    name = String(name || '').trim();
    var ex = S.db[table].filter(function (r) { return !r.deleted_at && r.name === name; })[0];
    if (ex) return ex.id;
    return S.put(table, Object.assign({ id: await uuid5(table + ':' + name), name: name, deleted_at: null }, extra || {})).id;
  }
  var accNames = (st.accounts || []).map(function (a) { return a.name; });
  async function acc(name) { return accNames.indexOf(name) >= 0 ? ref('accounts', name) : ref('accounts', UNKNOWN, { archived: true, sort: 99 }); }
  for (var a = 0; a < accNames.length; a++) await ref('accounts', accNames[a], { sort: a });
  var its = (st.config && st.config.items) || [];
  for (var k = 0; k < its.length; k++) await ref('items', its[k].name, { budget: its[k].budget, sort: k });
  var itemNames = its.map(function (x) { return x.name; });
  async function item(name) { return itemNames.indexOf(name) >= 0 ? ref('items', name) : ref('items', name || UNKNOWN, { archived: true, sort: 99 }); }

  var n = 0;
  async function tx(kind, o, extra) {
    var id = await uuid5(kind + ':' + o.ts + ':' + o.row), old = S.find('transactions', id);
    if (old && !old.deleted_at) return;                       // مرحَّل من قبل
    S.put('transactions', Object.assign({ id: id, kind: kind, amount: Number(o.amount), account_id: await acc(o.account), occurred_at: new Date(Number(o.ts)).toISOString(), deleted_at: null }, extra));
    n++;
  }
  for (var r = 0; r < reps.length; r++) {
    var R = reps[r];
    say('أرحّل ' + R.month.label + '…');
    [R.payments, R.monthlyList, R.incomes, R.transfers, R.claims].forEach(function (l) { if ((l || []).length >= 300) capped = true; });
    for (const o of (R.payments || [])) await tx('payment', o, { item_id: await item(o.item), category: o.part || '', note: [o.method, o.notes].filter(Boolean).join(' · ') });
    for (const o of (R.monthlyList || [])) await tx('expense', o, { category: o.old ? 'مصاريف قديمة' : 'مصروف شهري', note: o.desc || '' });
    for (const o of (R.incomes || [])) await tx('income', o, { category: o.source || '', note: o.desc || '' });
    for (const o of (R.transfers || [])) await tx('transfer', Object.assign({ account: o.from }, o), { to_account_id: await acc(o.to), note: o.notes || '' });
    for (const o of (R.claims || [])) await tx(o.type === 'claim' ? 'claim' : 'repay', o, { party_id: await ref('parties', o.party || 'الشركة'), note: o.desc || '' });
  }

  // رصيد افتتاحي لكل حساب = رصيد الشيت الآن − أثر الحركات المرحَّلة، فتطابق الأرصدة الشيت بالضبط
  var bal = C.balances(C.ledger(S.db));
  for (var b = 0; b < S.db.accounts.length; b++) {
    var A = S.db.accounts[b]; if (A.deleted_at) continue;
    var src = (st.accounts || []).filter(function (x) { return x.name === A.name; })[0];
    if (!src && A.name !== UNKNOWN) continue;
    var oid = await uuid5('open:' + A.name), prev = S.find('transactions', oid);
    var without = C.r2((bal[A.id] || 0) - (prev && !prev.deleted_at ? Number(prev.amount) : 0));
    var need = C.r2((src ? Number(src.balance) : 0) - without);
    if (Math.abs(need) > 0.005) S.put('transactions', { id: oid, kind: 'adjust', amount: need, account_id: A.id, note: OPEN_NOTE, deleted_at: null, occurred_at: (prev && prev.occurred_at) || new Date().toISOString() });
    else if (prev && !prev.deleted_at) S.remove('transactions', oid);
  }
  S.save();
  return { count: n, months: reps.length, capped: capped };
}

HS.legacy = { run: run };
})(window);
