/* حساباتي — محرك الحساب: دوال نقية تحوّل دفتر الحركات إلى أرصدة ومستحقات وتقارير.
   ما فيه شبكة ولا واجهة هنا، فتشتغل بدون نت وتُختبر لوحدها (node). */
(function (G) {
'use strict';
var HS = G.HS = G.HS || {};
var AR_M = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
var NOPART = 'بدون تفصيل';

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function p2(x) { return (x < 10 ? '0' : '') + x; }
function live(a) { return (a || []).filter(function (x) { return !x.deleted_at; }); }
function monthKey(t) { var d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
function monthLabel(k) { var p = k.split('-'); return AR_M[Number(p[1]) - 1] + ' ' + p[0]; }
function sum(a) { return r2(a.reduce(function (t, x) { return t + x.amount; }, 0)); }
function names(a) { var m = {}; (a || []).forEach(function (x) { m[x.id] = x.name; }); return m; }

/** الحركات الحيّة مرتبة من الأقدم، مع وقت رقمي ومفتاح الشهر */
function ledger(db) {
  return live(db.transactions).map(function (x) {
    var t = Date.parse(x.occurred_at);
    return { id: x.id, kind: x.kind, amount: Number(x.amount) || 0, account_id: x.account_id, to_account_id: x.to_account_id,
      item_id: x.item_id, party_id: x.party_id, category: x.category || '', note: x.note || '', t: t, m: monthKey(t), pending: !!x._dirty };
  }).sort(function (a, b) { return a.t - b.t; });
}

/** أثر كل حركة على رصيد الحسابات */
function balances(T) {
  var b = {};
  function add(id, v) { if (id) b[id] = r2((b[id] || 0) + v); }
  T.forEach(function (x) {
    switch (x.kind) {
      case 'income': case 'repay': case 'adjust': add(x.account_id, x.amount); break;
      case 'expense': case 'payment': case 'claim': add(x.account_id, -x.amount); break;
      case 'transfer': add(x.account_id, -x.amount); add(x.to_account_id, x.amount); break;
    }
  });
  return b;
}

function monthSum(T, key) {
  var M = T.filter(function (x) { return x.m === key; });
  function of(k) { return sum(M.filter(function (x) { return x.kind === k; })); }
  var s = { key: key, label: monthLabel(key), income: of('income'), monthly: of('expense'), payments: of('payment'), claims: of('claim'), repaid: of('repay') };
  s.out = r2(s.monthly + s.payments + s.claims);
  s.net = r2(s.income + s.repaid - s.out);
  return s;
}

function itemsDetail(db, T, key) {
  return live(db.items).map(function (it) {
    var pays = T.filter(function (x) { return x.kind === 'payment' && x.item_id === it.id; }), parts = {};
    pays.forEach(function (p) { var k = p.category || NOPART; parts[k] = r2((parts[k] || 0) + p.amount); });
    return {
      id: it.id, name: it.name, budget: it.budget == null ? null : Number(it.budget), archived: !!it.archived, sort: it.sort || 0,
      paid: sum(pays), monthPaid: sum(pays.filter(function (p) { return p.m === key; })),
      parts: Object.keys(parts).map(function (k) { return { name: k, amount: parts[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
      last: pays.slice(-6).reverse()
    };
  }).sort(function (a, b) { return a.sort - b.sort; });
}

/** المستحقات لكل جهة: ما دفعته عنها − ما استرجعته. الاسترجاع يسدّد الأقدم أولًا. */
function dues(db, T) {
  var parties = live(db.parties).map(function (p) {
    var claims = T.filter(function (x) { return x.kind === 'claim' && x.party_id === p.id; });
    var repays = T.filter(function (x) { return x.kind === 'repay' && x.party_id === p.id; });
    var claimed = sum(claims), repaid = sum(repays), pool = repaid;
    var open = claims.map(function (c) {
      var used = Math.min(pool, c.amount); pool = r2(pool - used);
      return { id: c.id, t: c.t, note: c.note, amount: c.amount, left: r2(c.amount - used), account_id: c.account_id, pending: c.pending };
    }).filter(function (c) { return c.left > 0; }).reverse();
    return { id: p.id, name: p.name, claimed: claimed, repaid: repaid, remaining: r2(claimed - repaid), open: open, repayments: repays.slice(-4).reverse() };
  });
  var active = parties.filter(function (p) { return p.claimed || p.repaid; });
  return { claimed: r2(active.reduce(function (t, p) { return t + p.claimed; }, 0)), repaid: r2(active.reduce(function (t, p) { return t + p.repaid; }, 0)),
    remaining: r2(active.reduce(function (t, p) { return t + p.remaining; }, 0)), parties: active, all: parties };
}

function accountsView(db, bal) {
  return live(db.accounts).map(function (a) { return { id: a.id, name: a.name, archived: !!a.archived, sort: a.sort || 0, balance: r2(bal[a.id] || 0) }; })
    .sort(function (a, b) { return a.sort - b.sort; });
}
/** المعروض: غير المؤرشف، أو مؤرشف وباقي فيه رصيد (حتى ما يختفي مبلغ) */
function shown(a) { return !a.archived || Math.abs(a.balance) > 0.005; }

/** حالة الصفحة الرئيسية */
function state(db, now) {
  var T = ledger(db), key = monthKey(now || Date.now()), bal = balances(T);
  var accs = accountsView(db, bal), vis = accs.filter(shown), src = [];
  T.slice().reverse().forEach(function (x) { if (x.kind === 'income' && x.category && src.indexOf(x.category) < 0) src.push(x.category); });
  return {
    month: monthSum(T, key),
    accounts: vis, allAccounts: accs,
    balance: r2(vis.reduce(function (t, a) { return t + a.balance; }, 0)),
    items: itemsDetail(db, T, key),
    dues: dues(db, T),
    sources: src.slice(0, 8),
    recentTransfers: T.filter(function (x) { return x.kind === 'transfer'; }).slice(-5).reverse(),
    accName: names(db.accounts), itemName: names(db.items), partyName: names(db.parties)
  };
}

/** تقرير شهر كامل */
function report(db, keyIn, now) {
  var T = ledger(db), nowKey = monthKey(now || Date.now()), key = /^\d{4}-\d{2}$/.test(keyIn || '') ? keyIn : nowKey;
  var set = {}; T.forEach(function (x) { if (x.kind !== 'adjust') set[x.m] = 1; }); set[key] = 1; set[nowKey] = 1;
  var keys = Object.keys(set).sort(), M = T.filter(function (x) { return x.m === key; }), bal = balances(T), items = itemsDetail(db, T, key);
  var io = {};
  function mv(id, k, v) { if (!id) return; io[id] = io[id] || { inn: 0, out: 0 }; io[id][k] = r2(io[id][k] + v); }
  M.forEach(function (x) {
    if (x.kind === 'income' || x.kind === 'repay') mv(x.account_id, 'inn', x.amount);
    else if (x.kind === 'expense' || x.kind === 'payment' || x.kind === 'claim') mv(x.account_id, 'out', x.amount);
    else if (x.kind === 'transfer') { mv(x.account_id, 'out', x.amount); mv(x.to_account_id, 'inn', x.amount); }
  });
  function list(kinds) { return M.filter(function (x) { return kinds.indexOf(x.kind) >= 0; }).reverse(); }
  var accs = accountsView(db, bal).filter(shown);
  return {
    month: { key: key, label: monthLabel(key), isCurrent: key === nowKey },
    months: keys.map(function (k) { return { key: k, label: monthLabel(k) }; }),
    sum: monthSum(T, key),
    all: keys.map(function (k) { return monthSum(T, k); }),
    balance: r2(accs.reduce(function (t, a) { return t + a.balance; }, 0)),
    accounts: accs.map(function (a) { var m = io[a.id] || { inn: 0, out: 0 }; return { id: a.id, name: a.name, balance: a.balance, inn: m.inn, out: m.out }; }),
    items: items,
    itemsTotal: { budget: r2(items.reduce(function (t, i) { return t + (i.budget || 0); }, 0)), paid: r2(items.reduce(function (t, i) { return t + i.paid; }, 0)) },
    dues: dues(db, T),
    payments: list(['payment']), expenses: list(['expense']), claims: list(['claim', 'repay']), incomes: list(['income']), transfers: list(['transfer']), adjusts: list(['adjust']),
    accName: names(db.accounts), itemName: names(db.items), partyName: names(db.parties)
  };
}

HS.compute = { state: state, report: report, balances: balances, ledger: ledger, monthKey: monthKey, monthLabel: monthLabel, r2: r2, NOPART: NOPART };
if (typeof module !== 'undefined' && module.exports) module.exports = HS.compute;
})(typeof window !== 'undefined' ? window : globalThis);
