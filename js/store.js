/* حساباتي — التخزين والمزامنة.
   النسخة المحلية (IndexedDB) هي اللي يشتغل عليها التطبيق، فكل شيء يعمل بدون نت.
   المزامنة مع Supabase: نرفع الصفوف المعدّلة (upsert بالمعرّف، فالتكرار ما يضر) ثم نسحب ما تغيّر على الخادم. */
(function (G) {
'use strict';
var HS = G.HS = G.HS || {};
var TABLES = ['accounts', 'items', 'parties', 'transactions'];          // بهذا الترتيب عند الرفع (المراجع قبل الحركات)
var COLS = {
  accounts: { id: null, name: null, sort: 0, archived: false, deleted_at: null },
  items: { id: null, name: null, budget: null, sort: 0, archived: false, deleted_at: null },
  parties: { id: null, name: null, deleted_at: null },
  transactions: { id: null, kind: null, amount: null, account_id: null, to_account_id: null, item_id: null, party_id: null, category: null, note: null, occurred_at: null, deleted_at: null }
};
var conf = G.HESABATI || {}, BASE = String(conf.supabaseUrl || '').replace(/\/+$/, ''), KEY = String(conf.supabaseKey || '');
var PAGE = 1000;

function empty() { return { accounts: [], items: [], parties: [], transactions: [] }; }
var db = empty(), cursor = {}, session = null, listeners = [], running = null, refreshing = null;
var status = { online: null, last: 0, error: '' };

/* ---------- تخزين محلي: IndexedDB (مع احتياط localStorage) ---------- */
var idb = null;
function openIdb() {
  return new Promise(function (res) {
    try {
      var rq = indexedDB.open('hesabati', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { idb = rq.result; res(); };
      rq.onerror = function () { res(); };
    } catch (e) { res(); }
  });
}
function kvGet(k) {
  return new Promise(function (res) {
    if (!idb) { try { res(JSON.parse(localStorage.getItem('hs:' + k))); } catch (e) { res(null); } return; }
    var rq = idb.transaction('kv').objectStore('kv').get(k);
    rq.onsuccess = function () { res(rq.result || null); }; rq.onerror = function () { res(null); };
  });
}
function kvSet(k, v) {
  if (!idb) { try { localStorage.setItem('hs:' + k, JSON.stringify(v)); } catch (e) { } return; }
  try { idb.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) { }
}
function save() { kvSet('data', { db: db, cursor: cursor }); }
function saveSession() { try { if (session) localStorage.setItem('hs:session', JSON.stringify(session)); else localStorage.removeItem('hs:session'); } catch (e) { } }
function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }

function init() {
  try { session = JSON.parse(localStorage.getItem('hs:session')); } catch (e) { session = null; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  return openIdb().then(function () { return kvGet('data'); }).then(function (d) {
    if (d && d.db) { db = Object.assign(empty(), d.db); cursor = d.cursor || {}; }
  });
}

/* ---------- تعديل محلي ---------- */
function uid() {
  if (G.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}
function find(table, id) { for (var i = 0; i < db[table].length; i++) if (db[table][i].id === id) return db[table][i]; return null; }
/** إضافة أو تعديل صف. يُعلَّم «معدّل» إلى أن يُرفع. */
function put(table, patch) {
  var row = patch.id ? find(table, patch.id) : null;
  if (!row) {
    row = Object.assign({}, COLS[table], patch, { id: patch.id || uid(), _new: true });
    if (table === 'transactions' && !row.occurred_at) row.occurred_at = new Date().toISOString();
    db[table].push(row);
  } else Object.assign(row, patch);
  row._dirty = true; row._rev = (row._rev || 0) + 1; delete row._err;
  save();
  return row;
}
/** حذف: صف ما انرفع أبدًا يُشال محليًا، غيره حذف ناعم يتزامن. */
function remove(table, id) {
  var row = find(table, id); if (!row) return;
  if (row._new) { db[table] = db[table].filter(function (r) { return r.id !== id; }); save(); }
  else put(table, { id: id, deleted_at: new Date().toISOString() });
}
function dirty() {
  var out = [];
  TABLES.forEach(function (t) { db[t].forEach(function (r) { if (r._dirty) out.push({ table: t, row: r }); }); });
  return out;
}

/* ---------- الدخول ---------- */
function setSession(j) {
  session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: (j.user && j.user.email) || (session && session.email) || '' };
  saveSession();
}
function authCall(path, body, token) {
  var h = { apikey: KEY, 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;            // المفتاح العام يكفي في apikey؛ Bearer لتوكن المستخدم فقط
  return fetch(BASE + '/auth/v1/' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.text().then(function (t) { var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { } return { ok: r.ok, status: r.status, j: j }; }); },
      function () { var e = new Error('ما فيه اتصال'); e.net = true; throw e; });
}
function signIn(email, password) {
  return authCall('token?grant_type=password', { email: email, password: password }).then(function (r) {
    if (!r.ok) {
      var m = r.j.error_description || r.j.msg || r.j.message || '';
      throw new Error(/invalid/i.test(m) ? 'الإيميل أو كلمة السر غير صحيحة' : (m || 'تعذّر تسجيل الدخول'));
    }
    setSession(r.j); emit();
  });
}
function refresh() {
  if (refreshing) return refreshing;
  refreshing = authCall('token?grant_type=refresh_token', { refresh_token: session && session.refresh_token }).then(function (r) {
    if (!r.ok) { session = null; saveSession(); var e = new Error('انتهت الجلسة، سجّل الدخول من جديد'); e.auth = true; throw e; }
    setSession(r.j);
  }).finally(function () { refreshing = null; });
  return refreshing;
}
/** خروج: يمسح النسخة المحلية من هذا الجهاز (البيانات باقية في القاعدة). */
function signOut() {
  var tok = session && session.access_token;
  session = null; saveSession(); db = empty(); cursor = {}; save(); status = { online: null, last: 0, error: '' };
  emit();
  return tok ? authCall('logout', {}, tok).catch(function () { }) : Promise.resolve();
}

/* ---------- REST ---------- */
function rest(method, path, body, headers, retried) {
  if (!session) { var e0 = new Error('غير مسجّل الدخول'); e0.auth = true; return Promise.reject(e0); }
  var pre = (session.expires_at - Date.now() < 60000) ? refresh() : Promise.resolve();
  return pre.then(function () {
    var h = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + session.access_token }, headers || {});
    if (body) h['Content-Type'] = 'application/json';
    return fetch(BASE + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { var e = new Error('ما فيه اتصال'); e.net = true; throw e; });
  }).then(function (r) {
    if (r.status === 401 && !retried) return refresh().then(function () { return rest(method, path, body, headers, true); });
    return r.text().then(function (t) {
      var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
      if (!r.ok) { var er = new Error((j && (j.message || j.msg || j.error)) || ('خطأ ' + r.status)); er.status = r.status; if (r.status === 401) er.auth = true; throw er; }
      return j;
    });
  });
}

/* ---------- المزامنة ---------- */
function upsert(table, rows) {
  var revs = rows.map(function (r) { return r._rev; });
  var body = rows.map(function (r) { var o = {}; Object.keys(COLS[table]).forEach(function (c) { o[c] = (r[c] === undefined || r[c] === '') ? COLS[table][c] : r[c]; }); return o; });
  return rest('POST', '/rest/v1/' + table + '?on_conflict=id', body, { Prefer: 'resolution=merge-duplicates,return=minimal' }).then(function () {
    rows.forEach(function (r, i) { if (r._rev === revs[i]) delete r._dirty; delete r._new; });   // تعدّل أثناء الرفع؟ يبقى معلّمًا للجولة الجاية
  });
}
function pushTable(table) {
  var rows = db[table].filter(function (r) { return r._dirty && !r._err; });
  if (!rows.length) return Promise.resolve();
  return upsert(table, rows).catch(function (e) {
    if (e.net || e.auth || rows.length === 1) { if (!e.net && !e.auth) rows[0]._err = e.message; else throw e; return; }
    return rows.reduce(function (p, r) {              // صف واحد مرفوض ما يوقّف الباقي: نعزله ونعلّمه
      return p.then(function () { return upsert(table, [r]).catch(function (e2) { if (e2.net || e2.auth) throw e2; r._err = e2.message; }); });
    }, Promise.resolve());
  });
}
function pullTable(table) {
  var since = cursor[table] || '1970-01-01T00:00:00Z', max = since, off = 0;
  function page() {
    return rest('GET', '/rest/v1/' + table + '?select=*&updated_at=gte.' + encodeURIComponent(since) + '&order=updated_at.asc,id.asc&limit=' + PAGE + '&offset=' + off).then(function (rows) {
      rows = rows || [];
      rows.forEach(function (s) {
        var cur = find(table, s.id);
        if (!cur) db[table].push(s);
        else if (!cur._dirty) db[table][db[table].indexOf(cur)] = s;      // المعدّل محليًا ولم يُرفع له الأولوية
        if (s.updated_at > max) max = s.updated_at;
      });
      off += rows.length;
      if (rows.length === PAGE) return page();
      cursor[table] = max;
    });
  }
  return page();
}
function each(fn) { return TABLES.reduce(function (p, t) { return p.then(function () { return fn(t); }); }, Promise.resolve()); }
function sync() {
  if (running) return running;
  if (!session || !BASE || !KEY) return Promise.resolve();
  running = each(pushTable).then(function () { return each(pullTable); }).then(function () {
    status = { online: true, last: Date.now(), error: '' };
  }, function (e) {
    status = { online: e.net ? false : status.online, last: status.last, error: e.net ? '' : e.message };
  }).then(function () { running = null; save(); emit(); });
  return running;
}

HS.store = {
  init: init, put: put, remove: remove, find: find, dirty: dirty, uid: uid, sync: sync, save: save,
  signIn: signIn, signOut: signOut,
  on: function (f) { listeners.push(f); },
  configured: function () { return !!(BASE && KEY); },
  get db() { return db; },
  get session() { return session; },
  get status() { return status; }
};
})(window);
