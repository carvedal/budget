'use strict';
/* 가계부 — single-file app. Data lives in the user's Google Sheet (via Apps Script);
   this file holds no personal data. Without a connection it runs on generic sample data. */

// ---------- sheet schema (tab name + column headers) ----------
const TABS = {
  records:  { tab: '내역',     cols: [['id','id'],['date','날짜'],['type','구분'],['cat','항목'],['sub','세부'],['amount','금액'],['pay','결제'],['what','사용내역'],['memo','메모'],['fixedId','고정ID']] },
  cats:     { tab: '항목',     cols: [['kind','구분'],['name','항목'],['account','계좌'],['fullFixed','전액고정'],['reserve','적립'],['hidden','숨김']] },
  budgets:  { tab: '예산',     cols: [['from','적용시작'],['cat','항목'],['amount','금액']] },
  accounts: { tab: '결제수단', cols: [['name','이름'],['kind','종류'],['payAccount','결제계좌'],['payDay','결제일'],['cycleStart','사용시작일'],['hidden','숨김']] },
  fixed:    { tab: '고정',     cols: [['id','id'],['type','구분'],['name','이름'],['period','주기'],['month','월'],['day','일'],['cat','항목'],['sub','세부'],['group','묶음'],['pay','결제'],['amount','금액'],['mode','방식'],['variable','변동'],['hidden','숨김']] },
  settings: { tab: '설정',     cols: [['key','키'],['value','값']] },
};
const NUM = new Set(['amount','payDay','cycleStart','month','day']);
const BOOL = new Set(['fullFixed','reserve','hidden','variable']);
const VERSION = '10.30-6';
const LIFE = '생활비', LUNCH = '평일 점심', SHOP = '식비·생활용품';
const LS = { data: 'budget.data', conn: 'budget.conn', queue: 'budget.queue', draft: 'budget.draft', last: 'budget.lastPay' };

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const won = n => Math.round(n || 0).toLocaleString('ko-KR');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate(); // m: 0-based
const mkDate = (y, m, d) => { const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12; return new Date(yy, mm, Math.min(d, daysIn(yy, mm))); };
const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

// ---------- state ----------
let S = null;              // data
let UI = {                 // view state (not persisted)
  view: 'input', mode: '지출', cat: null, sub: SHOP, pay: null, inCat: null, inPay: null, svPay: null, date: today(),
  slide: 0, group: '전체', sumView: 'cat', hl: LIFE, setTab: 'budget', histKey: null, filter: {}, draft: null,
};

function cfg(k, d) { const r = S.settings.find(x => x.key === k); return r ? r.value : d; }
function cfgNum(k, d) { const v = Number(cfg(k, d)); return isNaN(v) ? d : v; }
function setCfg(k, v) { const r = S.settings.find(x => x.key === k); if (r) r.value = String(v); else S.settings.push({ key: k, value: String(v) }); }

// ---------- periods (a "month" runs from startDay to the day before next startDay) ----------
const startDay = () => cfgNum('한달시작일', 5);
function periodOf(dateStr) { const d = parse(dateStr); let y = d.getFullYear(), m = d.getMonth(); if (d.getDate() < startDay()) { m -= 1; if (m < 0) { m = 11; y -= 1; } } return `${y}-${pad(m + 1)}`; }
function keyParts(k) { const [y, m] = k.split('-').map(Number); return [y, m - 1]; }
function addKey(k, n) { const [y, m] = keyParts(k); const d = new Date(y, m + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function range(k) { const [y, m] = keyParts(k); const s = mkDate(y, m, startDay()); const e = new Date(mkDate(y, m + 1, startDay()).getTime() - 864e5); return { start: ymd(s), end: ymd(e) }; }
const curKey = () => periodOf(today());
const keyLabel = k => `${keyParts(k)[1] + 1}월`;
function rangeLabel(k) { const r = range(k); const f = s => `${+s.slice(5, 7)}.${+s.slice(8)}`; return `${f(r.start)} ~ ${f(r.end)}`; }
function daysLeft(k) { const r = range(k); return Math.max(0, Math.round((parse(r.end) - parse(today())) / 864e5) + 1); }
function weekdaysLeft(k) { const r = range(k); let n = 0; for (let d = parse(today()); ymd(d) <= r.end; d = new Date(d.getTime() + 864e5)) { const w = d.getDay(); if (w > 0 && w < 6) n++; } return n; }

// ---------- budgets ----------
const expCats = (all) => S.cats.filter(c => c.kind === '지출' && (all || !c.hidden));
const incCats = (all) => S.cats.filter(c => c.kind === '수입' && (all || !c.hidden));
function budgetsFor(k) {
  const out = {};
  for (const b of S.budgets) { if (b.from <= k && (!out[b.cat] || out[b.cat].from <= b.from)) out[b.cat] = b; }
  const m = {}; for (const c in out) m[c] = out[c].amount; return m;
}
function fixedMonthlySum(type) { return S.fixed.filter(f => !f.hidden && f.type === type && f.period === '매월').reduce((s, f) => s + f.amount, 0); }
function totalBudget() { return fixedMonthlySum('수입') - fixedMonthlySum('저축'); }
function lunchBudget() { return cfgNum('평일점심예산', 60000); }
function lifeFrom(map) { return totalBudget() - expCats(true).filter(c => c.name !== LIFE).reduce((s, c) => s + (map[c.name] || 0), 0); }

// ---------- fixed items ----------
function occurrence(f, k) {
  const r = range(k), [y, m] = keyParts(k);
  if (f.period === '매년') {
    for (const yy of [y, y + 1]) { const d = ymd(mkDate(yy, (f.month || 1) - 1, f.day || 1)); if (d >= r.start && d <= r.end) return d; }
    return null;
  }
  const d = f.day || 1; return ymd(d >= startDay() ? mkDate(y, m, d) : mkDate(y, m + 1, d));
}
const fxId = (f, k) => `${f.id}@${k}`;
const fxRecord = (f, k) => S.records.find(r => r.fixedId === fxId(f, k));
// a bill typed in by hand (same item, name matches) also counts as recorded
function fxManual(f, k) {
  const nm = f.name.replace(/\s/g, '');
  return S.records.find(r => !r.fixedId && r.type === f.type && recPeriod(r) === k && (f.type !== '지출' || r.cat === f.cat) && r.what && (r.what.replace(/\s/g, '').includes(nm) || nm.includes(r.what.replace(/\s/g, ''))));
}
function fixedStatus(f, k) {
  const d = occurrence(f, k); if (!d) return null;
  const rec = fxRecord(f, k) || fxManual(f, k);
  if (rec) return { d, st: '기록됨', rec };
  if (d < cfg('시작일', '0000')) return { d, st: '이전' };
  if (d <= today() && f.mode !== '자동') return { d, st: '확인 필요' };
  return { d, st: '예정' };
}
function autoRecordFixed() {
  const k = curKey(), started = cfg('시작일', today());
  for (const f of S.fixed) {
    if (f.hidden || f.mode !== '자동') continue;
    const d = occurrence(f, k);
    if (!d || d > today() || d < started || fxRecord(f, k) || fxManual(f, k)) continue;
    saveRecord({ id: 'fx-' + fxId(f, k), date: d, type: f.type, cat: f.type === '저축' ? '저축' : f.cat, sub: f.sub || '', amount: f.amount, pay: f.pay, what: f.name, memo: '고정 자동 기록', fixedId: fxId(f, k) }, true);
  }
}

// ---------- calculations ----------
// which month a record belongs to. A fixed-income item (급여) paid up to 4 days early
// (payday on a holiday → previous business day) still counts for the month it's meant for.
const EARLY_PAY_DAYS = 4;
function recPeriod(r) {
  if (r.fixedId && r.fixedId.includes('@')) return r.fixedId.split('@')[1];
  const k = periodOf(r.date);
  if (r.type === '수입' && S.fixed.some(f => f.type === '수입' && !f.hidden && f.cat === r.cat)) {
    const d = parse(r.date), [y, m] = keyParts(addKey(k, 1)), start = mkDate(y, m, startDay());
    if ((start - d) / 864e5 <= EARLY_PAY_DAYS) return addKey(k, 1);
  }
  return k;
}
function recsIn(k) { return S.records.filter(x => recPeriod(x) === k); }
function calc(k) {
  const recs = recsIn(k), B = budgetsFor(k), isCur = k === curKey();
  const spent = {}; let lunchS = 0, shopS = 0, income = 0, saving = 0;
  for (const r of recs) {
    if (r.type === '수입') { income += r.amount; continue; }
    if (r.type === '저축') { saving += r.amount; continue; }
    spent[r.cat] = (spent[r.cat] || 0) + r.amount;
    if (r.cat === LIFE) { if (r.sub === LUNCH) lunchS += r.amount; else shopS += r.amount; }
  }
  const pending = {};
  if (isCur) for (const f of S.fixed) { if (f.hidden || f.type !== '지출') continue; const st = fixedStatus(f, k); if (st && (st.st === '예정' || st.st === '확인 필요')) pending[f.cat] = (pending[f.cat] || 0) + f.amount; }
  const lifeB = lifeFrom(B), lunchB = lunchBudget(), shopB = lifeB - lunchB;
  const rows = []; let overflow = 0, surplus = 0, total = 0;
  for (const c of expCats(true)) {
    const name = c.name; let s = spent[name] || 0;
    if (name === LIFE) { rows.push({ c, b: lifeB, s, p: 0 }); total += s; continue; }
    if (c.hidden && !s) continue;
    const b = B[name] || 0, p = pending[name] || 0;
    if (c.fullFixed) s = Math.max(s, b);
    total += c.reserve ? b : s;
    let over = 0, plus = 0;
    if (!c.reserve) { over = Math.max(0, s - b); overflow += over; if (!c.fullFixed) { plus = Math.max(0, b - s - p); surplus += plus; } }
    rows.push({ c, b, s, p, over, plus });
  }
  for (const name in spent) if (!S.cats.find(c => c.name === name)) { const s = spent[name]; overflow += s; total += s; rows.push({ c: { name, kind: '지출' }, b: 0, s, p: 0, over: s, plus: 0 }); }
  const tb = totalBudget();
  return { k, B, rows, lifeB, lunchB, shopB, lunchS, shopS, lunchLeft: lunchB - lunchS, shopLeft: shopB - shopS - overflow, overflow, surplus, total, tb, left: tb - total, income, saving, spent };
}
function warnText(label, left) { return left >= 0 ? `${label} 예산이 ${won(left)}원 남았어요.` : `${label} 예산보다 ${won(-left)}원 더 썼어요.`; }

// card bills
function cardInfo(card) {
  const t = parse(today()), P = card.payDay || 1, C = card.cycleStart || 1;
  let bill = mkDate(t.getFullYear(), t.getMonth(), P); if (ymd(bill) < today()) bill = mkDate(t.getFullYear(), t.getMonth() + 1, P);
  const by = bill.getFullYear(), bm = bill.getMonth();
  const s = ymd(mkDate(by, bm - 2, C)), e = ymd(new Date(mkDate(by, bm - 1, C).getTime() - 864e5));
  const s2 = ymd(mkDate(by, bm - 1, C));
  const sum = (a, b) => S.records.filter(r => r.type === '지출' && r.pay === card.name && r.date >= a && r.date <= b).reduce((x, r) => x + r.amount, 0);
  return { bill: ymd(bill), from: s, to: e, amount: sum(s, e), accFrom: s2, acc: sum(s2, today()) };
}
const md = s => `${+s.slice(5, 7)}.${+s.slice(8)}`;
const mdK = s => `${+s.slice(5, 7)}월 ${+s.slice(8)}일`;

function transferPlan() {
  const t = parse(today()); let pd = mkDate(t.getFullYear(), t.getMonth(), startDay()); if (ymd(pd) < today()) pd = mkDate(t.getFullYear(), t.getMonth() + 1, startDay());
  const payday = ymd(pd), k = periodOf(payday), B = budgetsFor(k);
  const sums = {}, from = {};
  const add = (acc, amt, label) => { if (!acc || !amt) return; sums[acc] = (sums[acc] || 0) + amt; (from[acc] = from[acc] || []).push(label); };
  for (const c of expCats(true)) { if (c.name === LIFE) continue; add(c.account, B[c.name] || 0, c.name); }
  const lifeB = lifeFrom(B), lunchB = lunchBudget();
  add(cfg('점심계좌', ''), lunchB, LUNCH); add(cfg('생활비계좌', ''), lifeB - lunchB, SHOP);
  const savingAccts = new Set();
  for (const f of S.fixed) if (!f.hidden && f.type === '저축' && f.period === '매월') { add(f.pay, f.amount, f.name); savingAccts.add(f.pay); }
  // account-list order, but savings always go last
  const order = S.accounts.map(a => a.name), rank = a => (savingAccts.has(a) ? 1000 : 0) + (order.indexOf(a) + 1 || 99);
  const keys = Object.keys(sums).sort((a, b) => rank(a) - rank(b));
  return { payday, k, items: keys.map(a => ({ key: 'pay:' + a, name: a, what: from[a].join('·'), amount: sums[a] })), total: keys.reduce((s, a) => s + sums[a], 0) };
}

// ---------- persistence & sync ----------
const conn = () => store.get(LS.conn, null);
function persist() { store.set(LS.data, S); }
function rowOf(type, obj) { return TABS[type].cols.map(([f]) => BOOL.has(f) ? (obj[f] ? 'Y' : '') : (obj[f] == null ? '' : obj[f])); }
function queue(op) { if (!conn()) return; const q = store.get(LS.queue, []); q.push(op); store.set(LS.queue, q); flushSoon(); }
function header(type) { return TABS[type].cols.map(c => c[1]); }
function saveRecord(r, silent) {
  const i = S.records.findIndex(x => x.id === r.id); if (i >= 0) S.records[i] = r; else S.records.push(r);
  persist(); queue({ op: 'upsert', tab: TABS.records.tab, header: header('records'), row: rowOf('records', r) });
  if (!silent) render();
}
function deleteRecord(id) { S.records = S.records.filter(x => x.id !== id); persist(); queue({ op: 'delete', tab: TABS.records.tab, id }); render(); }
function saveTable(type) { persist(); queue({ op: 'replace', tab: TABS[type].tab, header: header(type), rows: S[type].map(o => rowOf(type, o)) }); }
let flushTimer = null, syncing = false;
function flushSoon() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 600); }
async function flush() {
  const c = conn(); if (!c || syncing) return; const q = store.get(LS.queue, []); if (!q.length) return;
  syncing = true;
  try {
    const res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: c.key, ops: q }) });
    const j = await res.json(); if (!j.ok) throw new Error(j.error || '저장 실패');
    const rest = store.get(LS.queue, []).slice(q.length); store.set(LS.queue, rest);
  } catch (e) { toast('시트 저장을 못 했어요. 연결되면 다시 보낼게요.'); }
  syncing = false; updateSyncLabel();
}
function normalize(raw) {
  const out = {};
  for (const t in TABS) {
    out[t] = (raw[TABS[t].tab] || []).map(row => { const o = {}; TABS[t].cols.forEach(([f, h]) => { let v = row[h]; if (NUM.has(f)) v = Number(String(v).replace(/,/g, '')) || 0; else if (BOOL.has(f)) v = v === true || v === 'Y' || v === 'y' || v === 'TRUE'; else v = v == null ? '' : String(v); o[f] = v; }); return o; })
      .filter(o => Object.values(o).some(v => v !== '' && v !== 0 && v !== false));
  }
  out.records.forEach(r => { if (!r.id) r.id = uid(); });
  return out;
}
async function pull() {
  const c = conn(); if (!c) return false;
  await flush();
  try {
    const res = await fetch(`${c.url}?action=load&key=${encodeURIComponent(c.key)}`);
    const j = await res.json(); if (!j.ok) throw new Error(j.error || '불러오기 실패');
    S = normalize(j.data); S.demo = false;
    if (!cfg('시작일', '')) { setCfg('시작일', today()); saveTable('settings'); }
    persist(); return true;
  } catch (e) { toast('시트에서 못 불러왔어요: ' + e.message); return false; }
}
function updateSyncLabel() { const el = $('#syncLabel'); if (el) el.textContent = syncText(); }
function syncText() { const c = conn(); if (!c) return '연결 안 됨 (체험 모드)'; const n = store.get(LS.queue, []).length; return n ? `보내는 중 ${n}건` : '연결됨'; }

// ---------- sample data (generic — not anyone's real finances) ----------
function sample() {
  const k0 = (() => { const t = new Date(); let y = t.getFullYear(), m = t.getMonth(); if (t.getDate() < 5) m -= 1; const d = new Date(y, m - 5, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })();
  const cats = [
    ['지출', LIFE, '', false, false], ['지출', '공과금', '은행A', false, false], ['지출', '통신', '은행B', false, false], ['지출', '구독료', '은행B', false, false],
    ['지출', '교통', '페이', false, false], ['지출', '보험·세금', '은행C', false, true], ['지출', '용돈', '은행D', true, false], ['지출', '여행경비', '', false, false], ['지출', '기타', '', false, false],
    ['수입', '급여', '', false, false], ['수입', '기타 수입', '', false, false],
  ].map(([kind, name, account, fullFixed, reserve]) => ({ kind, name, account, fullFixed, reserve, hidden: false }));
  const budgets = [['공과금', 250000], ['통신', 80000], ['구독료', 50000], ['교통', 60000], ['보험·세금', 100000], ['용돈', 200000]].map(([cat, amount]) => ({ from: k0, cat, amount }));
  const accounts = [['은행A', '계좌'], ['은행B', '계좌'], ['은행C', '계좌'], ['은행D', '계좌'], ['생활비통장', '계좌'], ['페이', '페이'], ['저축통장', '계좌'], ['현금', '현금']].map(([name, kind]) => ({ name, kind, payAccount: '', payDay: 0, cycleStart: 0, hidden: false }));
  accounts.push({ name: 'A카드', kind: '카드', payAccount: '생활비통장', payDay: 10, cycleStart: 1, hidden: false });
  const fixed = [
    ['s1', '수입', '급여', '매월', 0, 5, '급여', '', '', '생활비통장', 2000000, '확인 후'], ['s2', '저축', '적금', '매월', 0, 5, '', '', '', '저축통장', 600000, '자동'],
    ['s3', '지출', '용돈', '매월', 0, 5, '용돈', '', '', '은행D', 200000, '자동'], ['s4', '지출', '관리비', '매월', 0, 25, '공과금', '', '공과금', '은행A', 120000, '자동'],
    ['s5', '지출', '전기세', '매월', 0, 10, '공과금', '', '공과금', '은행A', 40000, '확인 후', true], ['s6', '지출', '휴대폰', '매월', 0, 15, '통신', '', '', '은행B', 55000, '자동'],
    ['s7', '지출', '음악 구독', '매월', 0, 8, '구독료', '', '구독료', '은행B', 11000, '자동'], ['s8', '지출', '영상 구독', '매월', 0, 20, '구독료', '', '구독료', 'A카드', 14000, '자동'],
    ['s9', '지출', '자동차보험', '매년', 9, 1, '보험·세금', '', '자동차 유지비', '은행C', 700000, '확인 후'],
  ].map(([id, type, name, period, month, day, cat, sub, group, pay, amount, mode, variable]) => ({ id, type, name, period, month, day, cat, sub, group, pay, amount, mode, variable: !!variable, hidden: false }));
  const settings = [['한달시작일', 5], ['평일점심예산', 60000], ['점심계좌', '페이'], ['생활비계좌', '생활비통장'], ['생활비경고', 90000], ['점심경고', 30000], ['시작일', '2000-01-01']].map(([key, value]) => ({ key, value: String(value) }));
  S = { cats, budgets, accounts, fixed, settings, records: [], demo: true };
  // deterministic pseudo-random spending for the last 6 periods
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const items = [['동네 마트', 'A카드'], ['채소 가게', '생활비통장'], ['온라인 장보기', 'A카드'], ['빵집', '생활비통장'], ['생필품', 'A카드']];
  for (let i = 0; i < 6; i++) {
    const k = addKey(k0, i), r = range(k);
    for (let d = parse(r.start); ymd(d) <= r.end && ymd(d) <= today(); d = new Date(d.getTime() + 864e5)) {
      const w = d.getDay();
      if (w > 0 && w < 6 && rnd() < 0.5) S.records.push({ id: uid(), date: ymd(d), type: '지출', cat: LIFE, sub: LUNCH, amount: Math.round((7000 + rnd() * 5000) / 100) * 100, pay: '페이', what: '점심', memo: '', fixedId: '' });
      if (rnd() < 0.45) { const it = items[Math.floor(rnd() * items.length)]; S.records.push({ id: uid(), date: ymd(d), type: '지출', cat: LIFE, sub: SHOP, amount: Math.round((3000 + rnd() * 28000) / 100) * 100, pay: it[1], what: it[0], memo: '', fixedId: '' }); }
      if (rnd() < 0.05) S.records.push({ id: uid(), date: ymd(d), type: '지출', cat: '기타', sub: '', amount: Math.round((5000 + rnd() * 30000) / 1000) * 1000, pay: '생활비통장', what: '선물', memo: '', fixedId: '' });
    }
    for (const f of S.fixed) { const d = occurrence(f, k); if (d && d <= today()) S.records.push({ id: 'fx-' + fxId(f, k), date: d, type: f.type, cat: f.type === '저축' ? '저축' : f.cat, sub: '', amount: f.variable ? Math.round(f.amount * (0.8 + rnd() * 0.4) / 10) * 10 : f.amount, pay: f.pay, what: f.name, memo: '', fixedId: fxId(f, k) }); }
  }
}

// ---------- rendering ----------
const ICON = {
  transfer: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>', fixed: '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4"/>',
  input: '<path d="M12 5v14M5 12h14"/>', history: '<path d="M5 7h14M5 12h14M5 17h9"/>', summary: '<path d="M6 19V11M12 19V5M18 19v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
};
const VIEWS = [['transfer', '이체'], ['fixed', '고정'], ['input', '입력'], ['history', '내역'], ['summary', '집계'], ['settings', '설정']];
const svg = (p, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" aria-hidden="true">${p}</svg>`;
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>';
const TAGC = ['sage', 'blue', 'amber', 'red'];
function tagFor(g) { if (!g) return ''; const groups = [...new Set(S.fixed.map(f => f.group).filter(Boolean))]; const c = TAGC[groups.indexOf(g) % TAGC.length]; return `<span class="tag" style="color:var(--${c});background:var(--${c}-bg)">${esc(g)}</span>`; }
function bar(pct, over, thin) { return `<div class="bar${thin ? ' thin' : ''}"><i class="${over ? 'over' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`; }
function seg(items, cur, act) { return `<div class="seg" role="tablist" style="grid-template-columns:repeat(${items.length},1fr)">${items.map(([v, l]) => `<button type="button" role="tab" aria-selected="${v === cur}" class="${v === cur ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`; }

function render() {
  if (!S) return;
  $('#nav').innerHTML = VIEWS.map(([v, l]) => `<a href="#${v}" class="${UI.view === v ? 'on' : ''}" ${UI.view === v ? 'aria-current="page"' : ''}>${svg(ICON[v], UI.view === v ? 1.8 : 1.6)}${l}</a>`).join('');
  $('#sticky').innerHTML = '';
  const fn = { transfer: vTransfer, fixed: vFixed, input: vInput, history: vHistory, summary: vSummary, settings: vSettings }[UI.view];
  $('#view').innerHTML = (S.demo && UI.view !== 'settings' ? `<div class="banner">체험 모드예요. 예시 데이터로 보여주고 있어요. <b>설정 → 데이터</b>에서 구글 시트를 연결하면 실제 가계부로 바뀌어요.</div>` : '') + fn();
  if (UI.view === 'input') { const c = $('.carousel'); if (c) c.scrollLeft = UI.slide * c.clientWidth; }
}

// ----- 이체 -----
function vTransfer() {
  const plan = transferPlan(), checks = JSON.parse(cfg('이체체크', '{}') || '{}');
  const ck = key => !!checks[key];
  const cards = S.accounts.filter(a => a.kind === '카드' && !a.hidden).map(c => ({ c, i: cardInfo(c) })).sort((a, b) => a.i.bill < b.i.bill ? -1 : 1);
  const pkey = it => `${plan.payday}|${it.key}`, ckey = x => `${x.i.bill}|card:${x.c.name}`;
  const all = plan.items.map(pkey).concat(cards.map(ckey)); const n = all.filter(ck).length;
  const row = (key, title, sub, amt, inline) => `<button type="button" class="li ${ck(key) ? 'done' : ''}" data-act="check" data-v="${esc(key)}" aria-pressed="${ck(key)}">
      <span class="check ${ck(key) ? 'on' : ''}">${CHECK}</span>
      <span class="grow ${inline ? 'row' : 'col'}" style="${inline ? 'align-items:baseline;gap:6px' : 'gap:2px'}"><span class="t s15 b">${esc(title)}</span><span class="s12 muted">${esc(sub)}</span></span>
      <span class="t s15 b">${won(amt)}</span></button>`;
  return `<div class="between"><h1>이체</h1><span class="s13 muted">${all.length}개 중 ${n}개 완료</span></div>
  <section class="list"><div class="between" style="padding:12px 0 6px"><h2 class="s15">월급날 이체 · ${mdK(plan.payday)}</h2><span class="s14 b">${won(plan.total)}</span></div>
    ${plan.items.map(it => row(pkey(it), it.name, it.what, it.amount, true)).join('')}</section>
  <section class="list"><div class="between" style="padding:12px 0 6px"><h2 class="s15">카드값 이체</h2><span class="s12 muted">결제일 전까지</span></div>
    ${cards.length ? cards.map(x => row(ckey(x), `${md(x.i.bill)} ${x.c.name} → ${x.c.payAccount || '?'}`, `사용 ${md(x.i.from)} ~ ${md(x.i.to)} · 다음 청구 ${won(x.i.acc)} 쌓이는 중`, x.i.amount)).join('') : '<p class="note" style="padding:8px 0">설정 → 결제수단에서 카드를 추가하면 여기에 나와요.</p>'}</section>
  <p class="note">체크는 다음 월급날·결제일이 되면 자동으로 풀려요. 이체 금액은 설정의 예산에서 자동 계산돼요.</p>`;
}

// ----- 고정 -----
function vFixed() {
  const k = curKey(), g = UI.group;
  const groups = ['전체', ...new Set(S.fixed.filter(f => !f.hidden && f.type === '지출').map(f => f.group).filter(Boolean))];
  const mon = S.fixed.filter(f => !f.hidden && f.type === '지출' && f.period === '매월').map(f => ({ f, s: fixedStatus(f, k) })).filter(x => x.s).sort((a, b) => a.s.d < b.s.d ? -1 : 1);
  const shown = mon.filter(x => g === '전체' || x.f.group === g);
  const amt = x => x.s.rec ? x.s.rec.amount : x.f.amount;
  const total = shown.reduce((s, x) => s + amt(x), 0), done = shown.filter(x => x.s.st === '기록됨'), doneSum = done.reduce((s, x) => s + amt(x), 0);
  const chipSum = gr => mon.filter(x => x.f.group === gr).reduce((s, x) => s + amt(x), 0);
  const stTag = s => s.st === '기록됨' ? '<span class="s12 sage">기록됨</span>' : s.st === '확인 필요' ? '<span class="tag" style="background:var(--red);color:#fff;padding:2px 8px">확인 필요</span>' : s.st === '이전' ? '<span class="s12 faint">앱 쓰기 전</span>' : '<span class="s12 muted">예정</span>';
  const item = (x, left) => `<button type="button" class="li" data-act="fixedTap" data-v="${esc(x.f.id)}">
      <span class="s13 muted" style="width:44px;text-align:center;flex-shrink:0">${left}</span>
      <span class="grow col" style="gap:3px"><span class="row s15" style="gap:6px">${esc(x.f.name)}${tagFor(x.f.group)}</span><span class="s12 muted">${esc(x.f.pay)} · ${esc(x.f.mode)}${x.f.variable ? ' · 금액 변동' : ''}</span></span>
      <span class="col" style="align-items:flex-end;gap:4px"><span class="s15 b">${x.f.variable && !x.s.rec ? '약 ' : ''}${won(amt(x))}</span>${stTag(x.s)}</span></button>`;
  const yr = S.fixed.filter(f => !f.hidden && f.type === '지출' && f.period === '매년' && (g === '전체' || f.group === g)).sort((a, b) => (a.month * 40 + a.day) - (b.month * 40 + b.day));
  const inc = S.fixed.filter(f => !f.hidden && f.type !== '지출');
  return `<div class="between"><div class="col" style="gap:2px"><h1>${keyLabel(k)} 고정</h1><span class="s12 muted">${rangeLabel(k)}</span></div><a href="#settings" class="s13 sage" style="text-decoration:none">설정에서 편집</a></div>
  <section class="card"><div class="between"><span class="s13 muted">이번 달 ${g === '전체' ? '고정지출' : esc(g)}</span><span class="s13 muted">${shown.length}개 중 ${done.length}개 기록</span></div>
    <div class="row" style="align-items:baseline;gap:6px"><span class="big">${won(total)}</span><span class="s14">원</span></div>
    ${bar(total ? doneSum / total * 100 : 0)}
    <div class="between s12 muted" style="padding-top:6px;border-top:1px solid var(--soft)"><span>기록됨 <b class="s15" style="color:var(--ink)">${won(doneSum)}</b></span><span>남음 <b class="s15" style="color:var(--ink)">${won(total - doneSum)}</b></span></div></section>
  <div class="chips">${groups.map(gr => `<button type="button" class="chip ${gr === g ? 'on' : ''}" data-act="group" data-v="${esc(gr)}">${esc(gr)}${gr === '전체' ? '' : ` <span class="s12" style="opacity:.75">${chipSum(gr) ? '월 ' + won(chipSum(gr)) : '매년'}</span>`}</button>`).join('')}</div>
  <section class="col"><h2 style="margin-bottom:4px">매달</h2><div class="list">${shown.map(x => item(x, (() => { const d = x.f.day; return d >= 28 ? '말일' : d + '일'; })())).join('') || '<p class="note" style="padding:12px 0">없어요.</p>'}</div></section>
  ${yr.length ? `<section class="col"><h2 style="margin-bottom:4px">매년</h2><div class="list">${yr.map(f => `<button type="button" class="li" data-act="editFixed" data-v="${esc(f.id)}"><span class="s12 muted" style="width:44px;text-align:center;flex-shrink:0">${f.month}월${f.day ? '<br>' + f.day + '일' : ''}</span><span class="grow col" style="gap:3px"><span class="row s15" style="gap:6px">${esc(f.name)}${tagFor(f.group)}</span><span class="s12 muted">${esc(f.pay)} · ${esc(f.mode)}</span></span><span class="s15 b">${won(f.amount)}</span></button>`).join('')}</div></section>` : ''}
  ${inc.length && g === '전체' ? `<section class="col"><h2 style="margin-bottom:4px">고정수입 · 저축</h2><div class="list">${inc.map(f => { const s = fixedStatus(f, k); return `<button type="button" class="li" data-act="fixedTap" data-v="${esc(f.id)}"><span class="s13 muted" style="width:44px;text-align:center;flex-shrink:0">${f.day}일</span><span class="grow col" style="gap:2px"><span class="s15">${esc(f.name)}</span><span class="s12 muted">${f.type} · ${esc(f.pay)} · ${esc(f.mode)}</span></span><span class="col" style="align-items:flex-end;gap:4px"><span class="s15 b ${f.type === '수입' ? 'sage' : 'blue'}">${f.type === '수입' ? '+' : ''}${won(s && s.rec ? s.rec.amount : f.amount)}</span>${s ? stTag(s) : ''}</span></button>`; }).join('')}</div></section>` : ''}`;
}

// ----- 입력 -----
// ---------- default payment: set per item in 설정 (A), otherwise the last one used (B) ----------
const payKey = (cat, sub) => cat === LIFE ? `${LIFE}|${sub || SHOP}` : cat;
function defaults() { try { return JSON.parse(cfg('기본결제', '{}') || '{}'); } catch (e) { return {}; } }
function defaultPay(type, cat, sub) {
  const D = defaults(), L = store.get(LS.last, {}), k = payKey(cat, sub);
  if (type === '저축') { const f = S.fixed.find(x => x.type === '저축' && !x.hidden); return D['저축'] || L['저축:저축'] || (f ? f.pay : ''); }
  return D[k] || (type === '수입' ? D['수입'] : '') || L[type + ':' + k] || '';
}
// the input screen keeps a separate item/payment choice per mode (지출 / 수입 / 저축)
const curCat = () => UI.mode === '지출' ? UI.cat : UI.mode === '수입' ? UI.inCat : '저축';
const curPay = () => UI.mode === '지출' ? UI.pay : UI.mode === '수입' ? UI.inPay : UI.svPay;
function setPay(p) { if (UI.mode === '지출') UI.pay = p; else if (UI.mode === '수입') UI.inPay = p; else UI.svPay = p; }
const payList = () => S.accounts.filter(a => !a.hidden && (UI.mode === '지출' || a.kind !== '카드')).map(a => a.name);
function applyDefaultPay() {
  const p = defaultPay(UI.mode, curCat(), UI.sub);
  if (p && payList().includes(p)) setPay(p);
}
function setDefaultPay(k, pay) { const D = defaults(); if (pay) D[k] = pay; else delete D[k]; setCfg('기본결제', JSON.stringify(D)); }
function vInput() {
  const k = curKey(), C = calc(k), out = UI.mode === '지출', sav = UI.mode === '저축';
  const cats = out ? expCats().map(c => c.name) : sav ? [] : incCats().map(c => c.name);
  const pays = payList();
  if (out && !cats.includes(UI.cat)) { UI.cat = cats.includes(LIFE) ? LIFE : cats[0]; applyDefaultPay(); }
  if (UI.mode === '수입' && !cats.includes(UI.inCat)) { UI.inCat = cats[0]; applyDefaultPay(); }
  if (!pays.includes(curPay())) { applyDefaultPay(); if (!pays.includes(curPay())) setPay(pays[0]); }
  const cat = curCat(), pay = curPay(), onCls = out ? '' : sav ? ' sv' : ' in';
  const row = C.rows.find(r => r.c.name === cat);
  let hint = '', hintBad = false;
  if (out && cat === LIFE) { const l = UI.sub === LUNCH ? C.lunchLeft : C.shopLeft; hint = l >= 0 ? `${won(l)}원 남음` : `${won(-l)}원 초과`; hintBad = l < cfgNum(UI.sub === LUNCH ? '점심경고' : '생활비경고', 0); }
  else if (out && row) { if (row.c.fullFixed) hint = '월급날 전액 사용 (고정)'; else if (row.c.reserve) hint = '적립 항목'; else if (!row.b) { hint = '예산 없음 · 생활비에서 빠져요'; hintBad = true; } else { const l = row.b - row.s; hint = l >= 0 ? `${won(l)}원 남음` : `${won(-l)}원 초과`; hintBad = l < 0; } }
  const lunchW = C.lunchLeft < cfgNum('점심경고', 30000), shopW = C.shopLeft < cfgNum('생활비경고', 90000);
  const lifeLine = (label, left, b, s, w, extra) => `<div class="col" style="gap:4px"><div class="between"><span class="s14">${label}${extra ? ` <span class="s12 muted">· ${extra}</span>` : ''}</span><span class="${left < 0 ? 'red' : ''}" style="font-size:20px;font-weight:700">${left < 0 ? '−' : ''}${won(Math.abs(left))}</span></div>${bar(b ? Math.max(s, b - left) / b * 100 : 100, left < 0, true)}${w ? `<span class="s12 red">${warnText(label === SHOP ? LIFE : label, left)}</span>` : ''}</div>`;
  const cardsTxt = S.accounts.filter(a => a.kind === '카드' && !a.hidden).map(c => { const i = cardInfo(c); return `<div class="between"><span class="s14">${esc(c.name)} <span class="s12 muted">${md(i.bill)} · ${esc(c.payAccount)}</span></span><span class="s15 b">${won(i.amount)}</span></div>`; }).join('') || '<span class="s13 muted">등록된 카드가 없어요.</span>';
  const slides = [
    `<section class="card" aria-label="생활비"><div class="between"><span class="s13 muted">생활비 남은 돈</span><span class="s12 muted">예산 ${won(C.lifeB)}</span></div>
      ${lifeLine(SHOP, C.shopLeft, C.shopB, C.shopS, shopW, C.overflow ? `다른 항목 초과 ${won(C.overflow)} 포함` : '')}
      ${lifeLine(LUNCH, C.lunchLeft, C.lunchB, C.lunchS, lunchW, `남은 평일 ${weekdaysLeft(k)}일`)}</section>`,
    `<section class="card" aria-label="이번 달 전체"><div class="between"><span class="s13 muted">이번 달 전체 지출</span><span class="s12 muted">예산 ${won(C.tb)}</span></div>
      <div class="row" style="align-items:baseline;gap:6px"><span class="big">${won(C.total)}</span><span class="s14">원</span></div>${bar(C.tb ? C.total / C.tb * 100 : 0, C.left < 0)}
      <div class="between s12"><span class="${C.left < 0 ? 'red' : 'sage'}">${C.left < 0 ? '예산보다 ' + won(-C.left) + '원 더 썼어요' : '남은 예산 ' + won(C.left) + '원'}</span><span class="muted">${C.tb ? Math.round(C.total / C.tb * 100) : 0}%</span></div></section>`,
    `<section class="card" aria-label="카드값"><span class="s13 muted">다음 카드값</span>${cardsTxt}<span class="s12 muted">결제일 전에 결제 계좌에 넣어두세요</span></section>`,
  ];
  $('#sticky').innerHTML = `<button type="button" class="btn" data-act="save">${UI.mode} 기록하기</button>`;
  return `<div class="between"><h1>${keyLabel(k)}</h1><span class="s13 muted">${rangeLabel(k)} · ${daysLeft(k)}일 남음</span></div>
  <div class="col" style="gap:8px"><div class="carousel" id="carousel">${slides.join('')}</div><div class="dots" aria-hidden="true">${slides.map((_, i) => `<i class="${i === UI.slide ? 'on' : ''}"></i>`).join('')}</div></div>
  ${seg([['지출', '지출'], ['수입', '수입'], ['저축', '저축']], UI.mode, 'mode')}
  <div class="card" style="padding:6px 16px;gap:0">
    <div class="between" style="align-items:center;min-height:44px;border-bottom:1px solid var(--line2)"><label for="amt" class="s13 muted">금액</label>
      <label class="s13" style="position:relative;background:var(--bg);border-radius:10px;padding:8px 10px">${(() => { const d = parse(UI.date); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]}) ▾`; })()}<input type="date" id="date" value="${UI.date}" aria-label="날짜" style="position:absolute;inset:0;opacity:0"></label></div>
    <div class="row" style="align-items:baseline;gap:6px;padding:6px 0 10px;border-bottom:1px solid var(--line2)"><input id="amt" class="plain grow" inputmode="numeric" placeholder="0" autocomplete="off" style="font-size:36px;font-weight:700;letter-spacing:-.02em" value="${UI.amt || ''}"><span class="s15 b" style="font-size:18px">원</span></div>
    <label for="what" class="s13 muted" style="padding-top:10px">${out ? '사용 내역' : sav ? '저축 내역' : '수입 내역'}</label>
    <input id="what" class="plain" style="height:44px;font-size:16px" placeholder="${out ? '예: 왕란 30구' : sav ? '예: 비상금, 여행 적금' : '예: 중고거래 판매'}" value="${esc(UI.what || '')}">
  </div>
  ${sav ? '<p class="note">추가로 모은 돈을 기록해요. 생활비 예산은 그대로이고, 내역의 저축·총계에 반영돼요. 매달 정기 저축은 고정 탭에서 자동으로 기록돼요.</p>' : ''}
  <div class="col" style="gap:10px;${sav ? 'display:none' : ''}"><div class="between"><span class="s13 muted">${out ? '항목' : '수입 항목'}</span><span class="s12 ${hintBad ? 'red b' : 'sage'}">${hint ? esc(cat + ' · ' + hint) : ''}</span></div>
    <div class="chips">${cats.map(c => `<button type="button" class="chip ${c === cat ? 'on' + onCls : ''}" data-act="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    ${out && cat === LIFE ? `<div class="col" style="gap:6px;background:var(--soft);border-radius:14px;padding:8px">${seg([[SHOP, SHOP], [LUNCH, LUNCH]], UI.sub, 'sub').replace('class="seg"', 'class="seg" style="padding:0;background:none"')}<span class="s12 muted" style="padding:0 4px">${UI.autoLunch && UI.sub === LUNCH ? '지역화폐·평일이라 평일 점심으로 골랐어요' : ''}</span></div>` : ''}
  </div>
  <div class="col" style="gap:10px"><span class="s13 muted">${out ? '결제' : sav ? '보낸 통장' : '받은 통장'}</span>
    <div class="chips">${pays.map(p => `<button type="button" class="chip ${p === pay ? 'on' + onCls : ''}" data-act="pay" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
  <div class="col" style="gap:6px"><label for="memo" class="s13 muted">메모 <span class="faint">(선택)</span></label><input id="memo" class="box" placeholder="예: 1+1 행사" value="${esc(UI.memo || '')}"></div>`;
}
function keepInputs() { const a = $('#amt'), w = $('#what'), m = $('#memo'); if (a) UI.amt = a.value; if (w) UI.what = w.value; if (m) UI.memo = m.value; }
function doSave() {
  keepInputs();
  const amount = Number(String(UI.amt || '').replace(/[^\d]/g, ''));
  if (!amount) { toast('금액을 입력해 주세요'); $('#amt') && $('#amt').focus(); return; }
  const out = UI.mode === '지출';
  const r = { id: uid(), date: UI.date, type: UI.mode, cat: curCat(), sub: out && UI.cat === LIFE ? UI.sub : '', amount, pay: curPay(), what: (UI.what || '').trim(), memo: (UI.memo || '').trim(), fixedId: '' };
  UI.amt = ''; UI.what = ''; UI.memo = '';
  const L = store.get(LS.last, {}); L[r.type + ':' + payKey(r.cat, r.sub)] = r.pay; if (r.type === '수입') L['수입:' + r.cat] = r.pay; store.set(LS.last, L);
  saveRecord(r);
  toast(`${r.cat}${r.sub ? '·' + r.sub : ''} ${won(amount)}원 기록했어요`);
}

// ----- 내역 -----
function vHistory() {
  const k = UI.histKey || curKey(), F = UI.filter, H = hParts();
  const filtered = H.filtered, fl = H.fl;
  return `<div class="between" style="align-items:center">
      <button type="button" class="stepper" style="border:0;background:none" data-act="hist" data-v="-1" aria-label="이전 달">‹</button>
      <div class="col" style="align-items:center;gap:2px"><h1 style="font-size:22px">${filtered && (F.from || F.to) ? '기간 검색' : keyLabel(k)}</h1><span class="s12 muted">${filtered && (F.from || F.to) ? fl : rangeLabel(k)}</span></div>
      <button type="button" class="stepper" style="border:0;background:none;${k >= curKey() ? 'opacity:.3' : ''}" data-act="hist" data-v="1" aria-label="다음 달" ${k >= curKey() ? 'disabled' : ''}>›</button></div>
  <div id="hBoxes" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${H.boxes}</div>
  <div class="row"><label class="row grow card" style="flex-direction:row;padding:0 14px;height:44px;border-radius:22px;gap:8px;align-items:center"><span class="muted">${svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', 1.8).replace('<svg', '<svg width="16" height="16"')}</span><input id="q" class="plain grow" placeholder="내역·메모 검색" value="${esc(F.q || '')}" aria-label="검색"></label>
    <button type="button" class="chip sm ${filtered && !F.q ? 'on' : ''}" data-act="filter">필터</button></div>
  ${fl ? `<div class="between s12"><span class="muted">필터: ${esc(fl)}</span><button type="button" class="s12 sage" style="background:none;border:0;min-height:32px" data-act="clearFilter">지우기</button></div>` : ''}
  <div id="hList" class="col" style="gap:18px">${H.list}</div>`;
}
// the parts of 내역 that change while typing a search (the search box itself is never redrawn)
function hParts() {
  const k = UI.histKey || curKey(), F = UI.filter, C = calc(k);
  let recs = recsIn(k);
  if (F.from || F.to) recs = S.records.filter(r => (!F.from || r.date >= F.from) && (!F.to || r.date <= F.to));
  if (F.type) recs = recs.filter(r => r.type === F.type);
  if (F.cat) recs = recs.filter(r => r.cat === F.cat);
  if (F.pay) recs = recs.filter(r => r.pay === F.pay);
  if (F.q) { const q = F.q.toLowerCase(); recs = recs.filter(r => (r.what + ' ' + r.memo + ' ' + r.cat).toLowerCase().includes(q)); }
  recs.sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const filtered = !!(F.from || F.to || F.type || F.cat || F.pay || F.q);
  const sum = t => recs.filter(r => r.type === t).reduce((s, r) => s + r.amount, 0);
  const inc = filtered ? sum('수입') : C.income, sp = filtered ? sum('지출') : C.total, sv = filtered ? sum('저축') : C.saving;
  const days = {}; recs.forEach(r => (days[r.date] = days[r.date] || []).push(r));
  const box = (l, v, cls, dark) => `<div class="card" style="padding:12px 14px;gap:2px;${dark ? 'background:var(--ink);border-color:var(--ink)' : ''}"><span class="s12" style="color:${dark ? '#D9D4C8' : 'var(--muted)'}">${l}</span><span class="b ${cls}" style="font-size:18px;${dark ? 'color:var(--bg)' : ''}">${v}</span></div>`;
  const fl = [F.from || F.to ? `${F.from ? md(F.from) : '처음'} ~ ${F.to ? md(F.to) : '오늘'}` : '', F.type, F.cat, F.pay].filter(Boolean).join(' · ');
  const boxes = `${box('수입', '+' + won(inc), 'sage')}${box('지출', '−' + won(sp), '')}${box('저축', '−' + won(sv), 'blue')}${box('총계 · 남은 돈', won(inc - sp - sv), '', true)}`;
  const list = Object.keys(days).map(d => { const list = days[d], tot = list.filter(r => r.type === '지출').reduce((s, r) => s + r.amount, 0), dd = parse(d);
    return `<section class="col"><div class="between" style="padding:0 2px 6px;border-bottom:1px solid var(--chip)"><h2 class="s14" style="font-weight:400">${dd.getMonth() + 1}월 ${dd.getDate()}일 ${DOW[dd.getDay()]}요일${d === today() ? ' · 오늘' : ''}</h2><span class="s13 muted">${tot ? '−' + won(tot) : ''}</span></div>
      ${list.map(r => `<button type="button" class="li" style="border-bottom:1px solid var(--soft)" data-act="editRec" data-v="${esc(r.id)}"><span class="grow col" style="gap:2px"><span class="s15">${esc(r.what || r.cat)}</span><span class="s12 muted">${esc(r.type === '지출' ? r.cat + (r.sub ? '·' + r.sub : '') : r.type)} · ${esc(r.pay)}${r.memo ? ' · ' + esc(r.memo) : ''}</span></span><span class="b ${r.type === '수입' ? 'sage' : r.type === '저축' ? 'blue' : ''}" style="font-size:16px">${r.type === '수입' ? '+' : ''}${won(r.amount)}</span></button>`).join('')}</section>`; }).join('') || '<p class="note">기록이 없어요.</p>';
  return { filtered, fl, boxes, list };
}

// ----- 집계 -----
function vSummary() {
  const k = UI.histKey || curKey(), C = calc(k), isPay = UI.sumView === 'pay';
  const life = C.rows.find(r => r.c.name === LIFE);
  const line = (name, s, b, note, tone) => { const p = b ? Math.round(s / b * 100) : 0, over = b && s > b; return `<div class="col" style="gap:6px;padding:10px 2px;border-bottom:1px solid var(--line)"><div class="between"><span class="s14">${esc(name)}</span><span class="s12 muted" style="white-space:nowrap"><b class="s15" style="color:var(--ink)">${won(s)}</b> / ${b ? won(b) : '예산 없음'}</span></div><div class="row" style="gap:10px"><div class="grow">${bar(p, over, true)}</div><span class="s12 ${over ? 'red b' : 'muted'}" style="width:44px;text-align:right">${b ? p + '%' : '—'}</span></div>${note ? `<span class="s12 ${tone}">${note}</span>` : ''}</div>`; };
  let body = '';
  if (!isPay) {
    body = C.rows.map(r => {
      if (r.c.name === LIFE) { const lifeLeft = C.shopLeft + C.lunchLeft; return line(LIFE, r.s, r.b, `${SHOP} ${won(C.shopS)} · ${LUNCH} ${won(C.lunchS)}${C.overflow ? ` · 다른 항목 초과 ${won(C.overflow)} 포함하면 ${lifeLeft < 0 ? won(-lifeLeft) + ' 초과' : won(lifeLeft) + ' 남음'}` : ''}`, lifeLeft < 0 ? 'red' : 'muted'); }
      let note = '', tone = 'muted';
      if (r.c.reserve) note = '적립 중 · 매년 지출용이라 여유로 안 셈';
      else if (r.c.fullFixed) note = '월급날 전액 고정';
      else if (!r.b) { note = r.s ? `예산 없음 → ${won(r.s)} 생활비에서 차감` : '예산 없음'; tone = r.s ? 'red' : 'muted'; }
      else if (r.over) { note = `${won(r.over)} 초과 → 생활비에서 차감`; tone = 'red'; }
      else if (r.p && r.s + r.p > r.b) { note = `남은 고정지출 ${won(r.p)} 포함하면 ${won(r.s + r.p - r.b)} 초과 예상`; tone = 'amber'; }
      else { note = r.p ? `남은 고정지출 ${won(r.p)} 빼고 여유 ${won(r.plus)}` : `여유 ${won(r.plus)}`; tone = 'sage'; }
      return line(r.c.name, r.s, r.b, note, tone);
    }).join('');
  } else {
    const plan = (() => { const B = C.B, sums = {}; const add = (a, v) => { if (a && v) sums[a] = (sums[a] || 0) + v; };
      for (const c of expCats(true)) if (c.name !== LIFE) add(c.account, B[c.name] || 0);
      add(cfg('점심계좌', ''), C.lunchB); add(cfg('생활비계좌', ''), C.shopB); return sums; })();
    const used = {}; recsIn(k).filter(r => r.type === '지출').forEach(r => used[r.pay] = (used[r.pay] || 0) + r.amount);
    for (const c of expCats(true)) if (c.fullFixed && c.account) used[c.account] = Math.max(used[c.account] || 0, C.B[c.name] || 0);
    const accts = S.accounts.filter(a => a.kind !== '카드' && (plan[a.name] || used[a.name]));
    const cards = S.accounts.filter(a => a.kind === '카드' && !a.hidden);
    body = accts.map(a => line(a.name, used[a.name] || 0, plan[a.name] || 0, '', '')).join('') +
      (cards.length ? `<span class="s13 muted" style="padding:14px 2px 4px">카드 (예산 대신 결제 계좌로 관리)</span>` + cards.map(c => `<div class="between" style="min-height:52px;align-items:center;border-bottom:1px solid var(--line);padding:0 2px"><span class="col" style="gap:2px"><span class="s14">${esc(c.name)}</span><span class="s12 muted">${esc(c.payAccount)}에서 매월 ${c.payDay}일 결제</span></span><span class="s15 b">${won(used[c.name] || 0)}</span></div>`).join('') : '');
  }
  // chart
  const keys = [...Array(6)].map((_, i) => addKey(curKey(), i - 5));
  const hlOpts = expCats(true).filter(c => !c.hidden).map(c => c.name).slice(0, 8);
  if (!hlOpts.includes(UI.hl)) UI.hl = hlOpts[0];
  const cs = keys.map(kk => { const cc = calc(kk); return { kk, t: cc.total, h: cc.rows.filter(r => r.c.name === UI.hl).reduce((s, r) => s + r.s, 0), b: UI.hl === LIFE ? cc.lifeB : (cc.B[UI.hl] || 0) }; });
  const mx = Math.max(1, ...cs.map(c => c.t)); const past = cs.slice(0, 5).filter(c => c.t > 0);
  const avg = past.length ? past.reduce((s, c) => s + c.h, 0) / past.length : 0;
  return `<div class="between" style="align-items:center">
      <button type="button" class="stepper" style="border:0;background:none" data-act="hist" data-v="-1" aria-label="이전 달">‹</button>
      <div class="col" style="align-items:center;gap:2px"><h1 style="font-size:22px">${keyLabel(k)} 집계</h1><span class="s12 muted">${rangeLabel(k)}</span></div>
      <button type="button" class="stepper" style="border:0;background:none;${k >= curKey() ? 'opacity:.3' : ''}" data-act="hist" data-v="1" aria-label="다음 달" ${k >= curKey() ? 'disabled' : ''}>›</button></div>
  <section class="card"><span class="s13 muted">이번 달 지출</span><div class="row" style="align-items:baseline;gap:6px"><span class="big">${won(C.total)}</span><span class="s14">원</span><span class="s13 muted" style="margin-left:auto">/ ${won(C.tb)}원</span></div>
    ${bar(C.tb ? C.total / C.tb * 100 : 0, C.left < 0)}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:8px;border-top:1px solid var(--soft)">
      <div class="col" style="gap:2px"><span class="s12 muted">수입</span><span class="s15 b sage">${won(C.income)}</span></div>
      <div class="col" style="gap:2px"><span class="s12 muted">남은 예산</span><span class="s15 b ${C.left < 0 ? 'red' : ''}">${won(C.left)}</span></div>
      <div class="col" style="gap:2px"><span class="s12 muted">저축</span><span class="s15 b blue">${won(C.saving)}</span></div></div>
    <div class="col" style="gap:6px;padding-top:10px;border-top:1px solid var(--soft)">
      <div class="between"><span class="s13">다른 항목 여유 (잉여 자금)</span><span class="s15 b sage">${won(C.surplus)}</span></div>
      <div class="between"><span class="s13">다른 항목 초과 → 생활비에서 차감</span><span class="s15 b ${C.overflow ? 'red' : 'muted'}">${C.overflow ? '−' : ''}${won(C.overflow)}</span></div>
      <span class="s12 muted" style="line-height:1.5">여유는 생활비에 더하지 않고 따로 보여줘요. 남은 고정지출까지 빼고 계산했어요.</span></div></section>
  ${seg([['cat', '항목별'], ['pay', '결제수단별']], UI.sumView, 'sumView')}
  <section class="col">${body}</section>
  <section class="col" style="gap:12px"><div class="between"><h2>월별 지출</h2><span class="row s12 muted" style="gap:10px"><span class="row" style="gap:4px"><i style="width:10px;height:10px;border-radius:2px;background:var(--sage)"></i>${esc(UI.hl)}</span><span class="row" style="gap:4px"><i style="width:10px;height:10px;border-radius:2px;background:#D3CCBD"></i>그 외</span></span></div>
    <div class="hscroll">${hlOpts.map(n => `<button type="button" class="chip sm ${n === UI.hl ? 'on in' : ''}" data-act="hl" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <div class="chart" role="img" aria-label="최근 6개월 지출">${cs.map(c => `<div><span style="font-size:10px" class="muted">${Math.round(c.t / 10000)}만</span><div class="rest" style="height:${Math.round((c.t - c.h) / mx * 120)}px;margin-bottom:-4px"></div><div class="hl" style="height:${Math.round(c.h / mx * 120)}px"></div><span class="s12">${keyLabel(c.kk)}</span></div>`).join('')}</div>
    <div class="card" style="flex-direction:row;justify-content:space-between;align-items:baseline;padding:12px 14px"><span class="s13 muted">${esc(UI.hl)} 월평균 (지난 5달)</span><span class="s13"><b class="s15">${won(avg)}</b> <span class="muted">/ 예산 ${won(cs[5].b)}</span></span></div>
    <p class="note">한 달 = ${startDay()}일 ~ 다음 달 ${startDay() - 1 || '말'}일. 이번 달은 진행 중이에요.</p></section>`;
}

// ----- 설정 -----
function getDraft() {
  if (!UI.draft) { const B = budgetsFor(curKey()); UI.draft = {}; expCats(true).filter(c => c.name !== LIFE).forEach(c => UI.draft[c.name] = B[c.name] || 0); }
  return UI.draft;
}
function vSettings() {
  const t = UI.setTab;
  let body = '';
  if (t === 'budget') {
    const D = getDraft(), B = budgetsFor(curKey());
    const others = Object.values(D).reduce((s, v) => s + v, 0), tb = totalBudget(), life = tb - others, lunch = lunchBudget(), shop = life - lunch;
    const warn = shop < cfgNum('생활비경고', 90000);
    const changed = Object.keys(D).some(c => D[c] !== (B[c] || 0));
    const fixedRows = S.fixed.filter(f => f.type === '지출').sort((a, b) => (a.period === b.period ? 0 : a.period === '매월' ? -1 : 1) || a.day - b.day);
    body = `<div class="card" style="background:var(--ink);border-color:var(--ink);color:var(--bg)"><span class="s13" style="color:#D9D4C8">한 달 총 예산</span><span class="big">${won(tb)}원</span><span class="s12" style="color:#D9D4C8">고정수입 ${won(fixedMonthlySum('수입'))} − 저축 ${won(fixedMonthlySum('저축'))} · 이 안에서 나눠 써요</span></div>
    <div class="card"><div class="between"><button type="button" class="row s15 b" style="gap:6px;background:none;border:0;padding:0;cursor:pointer" data-act="editCat" data-v="${LIFE}">${LIFE}<span class="tag" style="color:var(--sage);border:1px solid #C9D3C6;font-weight:400">자동 계산</span><span class="s12 muted" style="font-weight:400">· 기본 결제수단</span></button><span class="b ${warn ? 'red' : ''}" style="font-size:18px">${won(life)}원</span></div>
      <button type="button" class="between s13 muted" style="background:none;border:0;padding:4px 0;cursor:pointer" data-act="editLunch"><span>${LUNCH} · ${esc(cfg('점심계좌', ''))} (고정)</span><span style="border-bottom:1px dashed var(--chip)">${won(lunch)}</span></button>
      <div class="between s13 muted"><span>${SHOP} · ${esc(cfg('생활비계좌', ''))} (자동)</span><span>${won(shop)}</span></div>
      <span class="s12 muted">= 총 예산 − 아래 항목 합계 ${won(others)}</span>
      ${warn ? `<div class="warn" role="status">${WARN}<span>${warnText(LIFE, shop)}</span></div>` : ''}</div>
    <div class="list" style="padding:4px 12px">${expCats(true).filter(c => c.name !== LIFE).map(c => `<div class="li" style="gap:8px">
        <button type="button" class="grow col" style="gap:2px;background:none;border:0;text-align:left;padding:0;cursor:pointer" data-act="editCat" data-v="${esc(c.name)}"><span class="row s14" style="gap:6px">${esc(c.name)}${c.fullFixed ? '<span class="tag" style="background:var(--sage);color:#fff">전액 고정</span>' : ''}${c.reserve ? '<span class="tag" style="background:var(--amber-bg);color:var(--amber)">적립</span>' : ''}${c.hidden ? '<span class="tag" style="background:var(--soft);color:var(--muted)">숨김</span>' : ''}</span><span class="s12 muted">${esc(c.account || '계좌 없음')}</span></button>
        <button type="button" class="stepper" data-act="step" data-v="${esc(c.name)}" data-d="-10000" aria-label="${esc(c.name)} 10,000원 줄이기">−</button>
        <button type="button" class="amtbtn ${D[c.name] !== (B[c.name] || 0) ? 'changed' : ''}" data-act="typeAmt" data-v="${esc(c.name)}" aria-label="${esc(c.name)} 금액 직접 입력">${D[c.name] ? won(D[c.name]) : '없음'}</button>
        <button type="button" class="stepper" data-act="step" data-v="${esc(c.name)}" data-d="10000" aria-label="${esc(c.name)} 10,000원 늘리기">+</button></div>`).join('')}
      <button type="button" class="linkbtn" data-act="addCat" data-v="지출">${PLUS}지출 항목 추가</button></div>
    <div class="row"><button type="button" class="btn ghost" style="flex:1" data-act="resetDraft">되돌리기</button><button type="button" class="btn sm" style="flex:2;${changed ? '' : 'opacity:.4'}" data-act="applyDraft" ${changed ? '' : 'disabled'}>이번 달부터 적용</button></div>
    <p class="note">+/−는 10,000원씩, 금액을 누르면 직접 입력해요. 되돌리기는 마지막으로 적용한 값으로 돌아가요. 적용하면 이체 금액과 PC 예산표도 같이 바뀌어요. 항목 이름을 누르면 계좌·전액 고정·숨김을 바꿀 수 있어요.</p>
    <section class="col" style="gap:10px"><div class="between"><h2>고정지출</h2><span class="s12 muted">매월 ${won(fixedRows.filter(f => f.period === '매월' && !f.hidden).reduce((s, f) => s + f.amount, 0))}</span></div>
      <div class="list">${fixedRows.map(f => `<button type="button" class="li" data-act="editFixed" data-v="${esc(f.id)}"><span class="grow col" style="gap:3px"><span class="row s14" style="gap:6px">${esc(f.name)}<span class="tag" style="${f.period === '매년' ? 'color:var(--amber);border:1px solid #E3CFAE' : 'color:var(--sage);border:1px solid #C9D3C6'}">${f.period}</span>${f.hidden ? '<span class="tag" style="background:var(--soft);color:var(--muted)">숨김</span>' : ''}</span><span class="s12 muted">${esc(f.cat)} · ${esc(f.pay)} · ${f.period === '매년' ? f.month + '월 ' : ''}${f.day >= 28 && f.period === '매월' ? '말일' : f.day + '일'} · ${esc(f.mode)}${f.variable ? ' · 변동' : ''}${f.group ? ' · ' + esc(f.group) : ''}</span></span><span class="s15 b">${won(f.amount)}</span></button>`).join('')}
        <button type="button" class="linkbtn" data-act="addFixed" data-v="지출">${PLUS}고정지출 추가</button></div></section>`;
  } else if (t === 'pay') {
    const plan = transferPlan();
    body = `<section class="col" style="gap:10px"><div class="between"><h2>월급날 이체 금액</h2><span class="s12 muted">합계 ${won(plan.total)}</span></div>
      <div class="list">${plan.items.map(i => `<div class="li"><span class="grow col" style="gap:2px"><span class="s14">${esc(i.name)}</span><span class="s12 muted">${esc(i.what)}</span></span><span class="s15 b">${won(i.amount)}</span></div>`).join('')}</div>
      <p class="note">예산 탭의 항목 금액을 더해서 자동으로 계산돼요. 여기서는 고칠 필요가 없어요.</p></section>
    <section class="col" style="gap:10px"><h2>결제수단</h2><div class="list">${S.accounts.map((a, i) => `<button type="button" class="li" data-act="editAcct" data-v="${i}"><span class="grow col" style="gap:2px"><span class="row s14" style="gap:6px">${esc(a.name)}<span class="tag" style="background:var(--soft);color:var(--muted)">${esc(a.kind)}</span>${a.hidden ? '<span class="tag" style="background:var(--soft);color:var(--muted)">숨김</span>' : ''}</span>${a.kind === '카드' ? `<span class="s12 muted">결제 ${esc(a.payAccount)} · 매월 ${a.payDay}일 · 사용 전전월 ${a.cycleStart}일 ~ 전월 ${a.cycleStart > 1 ? a.cycleStart - 1 + '일' : '말일'}</span>` : ''}</span></button>`).join('')}
      <button type="button" class="linkbtn" data-act="addAcct">${PLUS}결제수단 추가</button></div>
      <p class="note">순서는 입력 화면 버튼 순서와 같아요. 결제수단을 누르면 이름·종류·숨김·순서를 바꿀 수 있어요.</p></section>`;
  } else {
    const inc = S.fixed.filter(f => f.type !== '지출');
    body = `<section class="col" style="gap:10px"><h2>고정수입 · 고정 저축</h2><div class="list">${inc.map(f => `<button type="button" class="li" data-act="editFixed" data-v="${esc(f.id)}"><span class="grow col" style="gap:3px"><span class="row s14" style="gap:6px">${esc(f.name)}<span class="tag" style="color:var(--sage);border:1px solid #C9D3C6">${f.type}</span></span><span class="s12 muted">${f.day}일 · ${esc(f.pay)} · ${esc(f.mode)}</span></span><span class="s15 b ${f.type === '수입' ? 'sage' : 'blue'}">${won(f.amount)}</span></button>`).join('')}
      <button type="button" class="linkbtn" data-act="addFixed" data-v="수입">${PLUS}고정수입 추가</button><button type="button" class="linkbtn" data-act="addFixed" data-v="저축">${PLUS}고정 저축 추가</button></div>
      <p class="note">고정수입이나 저축을 바꾸면 한 달 총 예산이 같이 바뀌고, 그 차이는 생활비로 들어가요.</p></section>
    <section class="col" style="gap:10px"><h2>수입 항목</h2><div class="list">${incCats(true).map(c => `<button type="button" class="li" data-act="editCat" data-v="${esc(c.name)}"><span class="grow s14">${esc(c.name)}</span>${c.hidden ? '<span class="tag" style="background:var(--soft);color:var(--muted)">숨김</span>' : ''}</button>`).join('')}
      <button type="button" class="linkbtn" data-act="addCat" data-v="수입">${PLUS}수입 항목 추가</button></div>
      <p class="note">기타 수입처럼 그때그때 다른 건 입력 화면의 [수입]에서 기록해요.</p></section>`;
  }
  return `<h1>설정</h1>${seg([['budget', '예산'], ['pay', '결제수단'], ['inc', '수입·저축']], t, 'setTab')}${body}
  <section class="col" style="gap:10px"><h2>알림 · 기간</h2><div class="list">
    ${[['생활비경고', '식비·생활용품 경고 기준', '남은 돈이 이보다 적으면 알려줘요'], ['점심경고', '평일 점심 경고 기준', '남은 돈이 이보다 적으면 알려줘요'], ['한달시작일', '한 달 시작일 (월급날)', `매월 ${startDay()}일 ~ 다음 달 ${startDay() - 1 || '말'}일`]].map(([key, l, d]) => `<button type="button" class="li" data-act="editCfg" data-v="${key}"><span class="grow col" style="gap:3px"><span class="s14">${l}</span><span class="s12 muted">${d}</span></span><span class="s15 b">${key === '한달시작일' ? startDay() + '일' : won(cfgNum(key, 0)) + '원'}</span></button>`).join('')}</div></section>
  <section class="col" style="gap:10px"><h2>데이터</h2><div class="list">
    <button type="button" class="li" data-act="connect"><span class="grow col" style="gap:2px"><span class="s14">구글 시트 연동</span><span class="s12 muted" id="syncLabel">${syncText()}</span></span><span class="s13 sage">${conn() ? '바꾸기' : '연결하기'}</span></button>
    ${conn() ? '<button type="button" class="li" data-act="pull"><span class="grow s14">지금 시트에서 다시 불러오기</span></button>' : ''}
    <button type="button" class="li" data-act="export"><span class="grow col" style="gap:2px"><span class="s14">엑셀(CSV) 파일로 내보내기</span><span class="s12 muted">전체 내역 · PC 예산표는 구글 시트의 '예산표' 탭에 있어요</span></span></button></div></section>
  <p class="note" style="text-align:center">앱 버전 ${VERSION}</p>`;
}

// ---------- bottom sheet (forms) ----------
let sheetSave = null;
function openSheet(title, fields, onSave, extra) {
  const f = fields.map(x => {
    const id = 'f_' + x.k;
    if (x.type === 'select') return `<div class="col" style="gap:6px"><label class="fl" for="${id}">${x.label}</label><select id="${id}" class="box">${x.options.map(o => `<option ${String(o) === String(x.v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    if (x.type === 'toggle') return `<label class="between" style="align-items:center;min-height:44px"><span class="s14">${x.label}${x.help ? `<br><span class="s12 muted">${x.help}</span>` : ''}</span><input type="checkbox" id="${id}" ${x.v ? 'checked' : ''} style="width:22px;height:22px"></label>`;
    return `<div class="col" style="gap:6px"><label class="fl" for="${id}">${x.label}</label><input id="${id}" class="box" ${x.type === 'number' ? 'inputmode="numeric"' : ''} type="${x.type === 'date' ? 'date' : 'text'}" value="${esc(x.type === 'number' && x.v ? won(x.v) : x.v)}" placeholder="${esc(x.ph || '')}"></div>`;
  }).join('');
  $('#sheet').innerHTML = `<div class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="between"><h2>${esc(title)}</h2><button type="button" class="stepper" style="border:0;background:none" data-act="closeSheet" aria-label="닫기">✕</button></div>${f}${extra || ''}<button type="button" class="btn" data-act="sheetSave">저장</button></div>`;
  $('#sheet').hidden = false;
  sheetSave = () => { const v = {}; fields.forEach(x => { const el = $('#f_' + x.k); v[x.k] = x.type === 'toggle' ? el.checked : x.type === 'number' ? Number(String(el.value).replace(/[^\d]/g, '')) : el.value.trim(); }); if (onSave(v) !== false) closeSheet(); };
  const first = $('#sheet input, #sheet select'); if (first) setTimeout(() => first.focus(), 50);
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; sheetSave = null; }

// ---------- actions ----------
function editRecord(id) {
  const r = S.records.find(x => x.id === id); if (!r) return;
  const catOpts = r.type === '지출' ? expCats(true).map(c => c.name) : r.type === '수입' ? incCats(true).map(c => c.name) : ['저축'];
  openSheet('기록 고치기', [
    { k: 'date', label: '날짜', type: 'date', v: r.date }, { k: 'amount', label: '금액', type: 'number', v: r.amount },
    { k: 'what', label: '사용 내역', v: r.what }, { k: 'cat', label: '항목', type: 'select', options: catOpts, v: r.cat },
    ...(r.type === '지출' ? [{ k: 'sub', label: '생활비 세부 (생활비일 때만)', type: 'select', options: [SHOP, LUNCH], v: r.sub || SHOP }] : []),
    { k: 'pay', label: '결제수단', type: 'select', options: S.accounts.map(a => a.name), v: r.pay }, { k: 'memo', label: '메모', v: r.memo },
  ], v => { if (!v.amount) { toast('금액을 입력해 주세요'); return false; } saveRecord(Object.assign({}, r, v, { sub: v.cat === LIFE ? (v.sub || SHOP) : '' })); toast('고쳤어요'); },
  `<button type="button" class="btn ghost" style="color:var(--red)" data-act="delRec" data-v="${esc(id)}">이 기록 지우기</button>`);
}
function editFixed(id, type) {
  const f = id ? S.fixed.find(x => x.id === id) : { id: 'f' + Date.now().toString(36), type: type || '지출', name: '', period: '매월', month: 1, day: 1, cat: '', sub: '', group: '', pay: '', amount: 0, mode: '자동', variable: false, hidden: false };
  const isOut = f.type === '지출';
  openSheet(id ? f.name + ' 고치기' : `${f.type === '지출' ? '고정지출' : f.type === '수입' ? '고정수입' : '고정 저축'} 추가`, [
    { k: 'name', label: '이름', v: f.name, ph: '예: 관리비' }, { k: 'amount', label: '금액 (변동이면 대략)', type: 'number', v: f.amount },
    ...(isOut ? [{ k: 'period', label: '주기', type: 'select', options: ['매월', '매년'], v: f.period }, { k: 'month', label: '월 (매년일 때만)', type: 'number', v: f.month }] : []),
    { k: 'day', label: '날짜 (일, 말일은 31)', type: 'number', v: f.day },
    ...(isOut ? [{ k: 'cat', label: '항목', type: 'select', options: expCats(true).map(c => c.name), v: f.cat }, { k: 'group', label: '묶음 (예: 구독료, 공과금)', v: f.group }] : f.type === '수입' ? [{ k: 'cat', label: '수입 항목', type: 'select', options: incCats(true).map(c => c.name), v: f.cat }] : []),
    { k: 'pay', label: isOut ? '결제수단' : '통장', type: 'select', options: S.accounts.map(a => a.name), v: f.pay },
    { k: 'mode', label: '기록 방식', type: 'select', options: ['자동', '확인 후'], v: f.mode },
    ...(isOut ? [{ k: 'variable', label: '금액이 달마다 달라요', type: 'toggle', v: f.variable }] : []),
    { k: 'hidden', label: '숨기기 (기록은 남아요)', type: 'toggle', v: f.hidden },
  ], v => {
    if (!v.name || !v.amount) { toast('이름과 금액을 입력해 주세요'); return false; }
    Object.assign(f, v, { day: Math.min(31, Math.max(1, v.day || 1)), month: Math.min(12, Math.max(1, v.month || f.month || 1)) });
    if (!id) S.fixed.push(f);
    saveTable('fixed'); render(); toast('저장했어요');
  });
}
function editCat(name, kind) {
  const c = name ? S.cats.find(x => x.name === name) : { kind, name: '', account: '', fullFixed: false, reserve: false, hidden: false };
  const out = c.kind === '지출';
  openSheet(name ? name + ' 고치기' : (out ? '지출 항목 추가' : '수입 항목 추가'), [
    { k: 'name', label: '이름', v: c.name },
    ...(out ? [{ k: 'account', label: '이체 계좌 (월급날 이 계좌로 예산을 보내요)', type: 'select', options: ['', ...S.accounts.filter(a => a.kind !== '카드').map(a => a.name)], v: c.account },
      { k: 'fullFixed', label: '월급날 전액 사용으로 고정', help: '기록이 없어도 예산 100% 사용으로 집계', type: 'toggle', v: c.fullFixed },
      { k: 'reserve', label: '적립 항목', help: '매년 나가는 돈을 모으는 항목 · 초과해도 생활비에서 안 빠져요', type: 'toggle', v: c.reserve }] : []),
    ...(c.name === LIFE
      ? [{ k: 'defShop', label: `기본 결제수단 · ${SHOP}`, type: 'select', options: ['', ...S.accounts.map(a => a.name)], v: defaults()[payKey(LIFE, SHOP)] || '' },
         { k: 'defLunch', label: `기본 결제수단 · ${LUNCH}`, type: 'select', options: ['', ...S.accounts.map(a => a.name)], v: defaults()[payKey(LIFE, LUNCH)] || '' }]
      : [{ k: 'defPay', label: '기본 결제수단 (비우면 마지막에 쓴 걸 기억해요)', type: 'select', options: ['', ...S.accounts.filter(a => out || a.kind !== '카드').map(a => a.name)], v: defaults()[c.name] || '' }]),
    { k: 'hidden', label: '숨기기 (기록은 남아요)', type: 'toggle', v: c.hidden },
  ], v => {
    if (!v.name) { toast('이름을 입력해 주세요'); return false; }
    if (c.name === LIFE) { setDefaultPay(payKey(LIFE, SHOP), v.defShop); setDefaultPay(payKey(LIFE, LUNCH), v.defLunch); }
    else { if (name && v.name !== name) setDefaultPay(name, ''); setDefaultPay(v.name, v.defPay); }
    delete v.defShop; delete v.defLunch; delete v.defPay; saveTable('settings');
    if (name === LIFE && v.name !== LIFE) { toast('생활비는 이름을 바꿀 수 없어요'); return false; }
    if (name && v.name !== name) { S.records.forEach(r => { if (r.cat === name) { r.cat = v.name; queue({ op: 'upsert', tab: TABS.records.tab, header: header('records'), row: rowOf('records', r) }); } }); S.budgets.forEach(b => { if (b.cat === name) b.cat = v.name; }); S.fixed.forEach(f => { if (f.cat === name) f.cat = v.name; }); saveTable('budgets'); saveTable('fixed'); }
    else if (!name && S.cats.find(x => x.name === v.name)) { toast('같은 이름이 있어요'); return false; }
    Object.assign(c, v); if (!name) S.cats.push(c);
    UI.draft = null; saveTable('cats'); render();
  });
}
function editAcct(i) {
  const a = i == null ? { name: '', kind: '계좌', payAccount: '', payDay: 0, cycleStart: 0, hidden: false } : S.accounts[i];
  const old = a.name;
  openSheet(i == null ? '결제수단 추가' : old + ' 고치기', [
    { k: 'name', label: '이름', v: a.name, ph: '예: 생활비 통장' }, { k: 'kind', label: '종류', type: 'select', options: ['계좌', '카드', '페이', '현금'], v: a.kind },
    { k: 'payAccount', label: '결제 계좌 (카드만)', type: 'select', options: ['', ...S.accounts.filter(x => x.kind !== '카드').map(x => x.name)], v: a.payAccount },
    { k: 'payDay', label: '결제일 (카드만)', type: 'number', v: a.payDay }, { k: 'cycleStart', label: '사용 기간 시작일 (카드만, 예: 23 → 전전월 23일 ~ 전월 22일)', type: 'number', v: a.cycleStart },
    { k: 'hidden', label: '숨기기 (기록은 남아요)', type: 'toggle', v: a.hidden },
  ], v => {
    if (!v.name) { toast('이름을 입력해 주세요'); return false; }
    if (i != null && old !== v.name) { S.records.forEach(r => { if (r.pay === old) { r.pay = v.name; queue({ op: 'upsert', tab: TABS.records.tab, header: header('records'), row: rowOf('records', r) }); } }); S.fixed.forEach(f => { if (f.pay === old) f.pay = v.name; }); S.cats.forEach(c => { if (c.account === old) c.account = v.name; }); S.accounts.forEach(x => { if (x.payAccount === old) x.payAccount = v.name; }); ['점심계좌', '생활비계좌'].forEach(k => { if (cfg(k) === old) setCfg(k, v.name); }); saveTable('fixed'); saveTable('cats'); saveTable('settings'); }
    Object.assign(a, v); if (i == null) S.accounts.push(a);
    saveTable('accounts'); render();
  }, i != null ? `<div class="row"><button type="button" class="btn ghost" data-act="moveAcct" data-v="${i}" data-d="-1">위로</button><button type="button" class="btn ghost" data-act="moveAcct" data-v="${i}" data-d="1">아래로</button></div>` : '');
}
function exportCsv() {
  const head = TABS.records.cols.map(c => c[1]).slice(1);
  const lines = [head.join(',')].concat(S.records.slice().sort((a, b) => a.date < b.date ? -1 : 1).map(r => TABS.records.cols.slice(1).map(([f]) => `"${String(r[f] == null ? '' : r[f]).replace(/"/g, '""')}"`).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `가계부_${today()}.csv`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function connectSheet() {
  const c = conn() || { url: '', key: '' };
  openSheet('구글 시트 연결', [
    { k: 'url', label: '웹 앱 주소 (https://script.google.com/macros/s/…/exec)', v: c.url }, { k: 'key', label: '연결 키 (시트 메뉴 가계부 앱 → 연결 키 보기)', v: c.key },
  ], v => {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(v.url)) { toast('웹 앱 주소가 맞는지 확인해 주세요'); return false; }
    if (!v.key) { toast('연결 키를 입력해 주세요'); return false; }
    store.set(LS.conn, v); store.del(LS.queue);
    toast('연결하는 중…');
    pull().then(ok => { if (ok) { autoRecordFixed(); UI.draft = null; toast('연결됐어요!'); } else { store.del(LS.conn); toast('연결에 실패했어요. 주소와 키를 확인해 주세요.'); } render(); });
  }, conn() ? `<button type="button" class="btn ghost" style="color:var(--red)" data-act="disconnect">연결 끊기 (체험 모드로)</button>` : '');
}

let toastT = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) { if (e.target.id === 'sheet') closeSheet(); return; }
  const a = el.dataset.act, v = el.dataset.v;
  if (UI.view === 'input') keepInputs();
  switch (a) {
    case 'mode': UI.mode = v; break;
    case 'cat': if (UI.mode === '지출') UI.cat = v; else UI.inCat = v; applyDefaultPay(); break;
    case 'sub': UI.sub = v; UI.autoLunch = false; applyDefaultPay(); break;
    case 'pay': setPay(v); if (UI.mode === '지출') autoLunch(); break;
    case 'save': doSave(); return;
    case 'check': { const c = JSON.parse(cfg('이체체크', '{}') || '{}'); const t = transferPlan(); Object.keys(c).forEach(k => { if (k.split('|')[0] < ymd(new Date(parse(today()).getTime() - 40 * 864e5))) delete c[k]; }); c[v] = !c[v]; setCfg('이체체크', JSON.stringify(c)); saveTable('settings'); break; }
    case 'group': UI.group = v; break;
    case 'fixedTap': { const f = S.fixed.find(x => x.id === v), k = curKey(), s = f && fixedStatus(f, k);
      if (s && s.st === '확인 필요') { openSheet(`${f.name} 기록`, [{ k: 'amount', label: `이번 달 금액 (${mdK(s.d)})`, type: 'number', v: f.amount }], x => { if (!x.amount) return false; saveRecord({ id: 'fx-' + fxId(f, k), date: s.d, type: f.type, cat: f.type === '저축' ? '저축' : f.cat, sub: f.sub || '', amount: x.amount, pay: f.pay, what: f.name, memo: '', fixedId: fxId(f, k) }); toast('기록했어요'); }); return; }
      if (s && s.rec) { editRecord(s.rec.id); return; } editFixed(v); return; }
    case 'editFixed': editFixed(v); return;
    case 'addFixed': editFixed(null, v); return;
    case 'hist': UI.histKey = addKey(UI.histKey || curKey(), Number(v)); if (UI.histKey > curKey()) UI.histKey = curKey(); break;
    case 'filter': openSheet('필터', [
      { k: 'from', label: '시작일 (비우면 이번 달)', type: 'date', v: UI.filter.from || '' }, { k: 'to', label: '종료일', type: 'date', v: UI.filter.to || '' },
      { k: 'type', label: '구분', type: 'select', options: ['', '지출', '수입', '저축'], v: UI.filter.type || '' },
      { k: 'cat', label: '항목', type: 'select', options: ['', ...S.cats.map(c => c.name)], v: UI.filter.cat || '' },
      { k: 'pay', label: '결제수단', type: 'select', options: ['', ...S.accounts.map(x => x.name)], v: UI.filter.pay || '' },
    ], x => { UI.filter = Object.assign({}, UI.filter, x); render(); }); return;
    case 'clearFilter': UI.filter = {}; break;
    case 'editRec': editRecord(v); return;
    case 'delRec': closeSheet(); deleteRecord(v); toast('지웠어요'); return;
    case 'sumView': UI.sumView = v; break;
    case 'hl': UI.hl = v; break;
    case 'setTab': UI.setTab = v; break;
    case 'step': { const D = getDraft(); D[v] = Math.max(0, (D[v] || 0) + Number(el.dataset.d)); break; }
    case 'typeAmt': openSheet(`${v} 예산`, [{ k: 'amount', label: '금액', type: 'number', v: getDraft()[v] }], x => { getDraft()[v] = x.amount || 0; render(); }); return;
    case 'resetDraft': UI.draft = null; break;
    case 'applyDraft': { const k = curKey(), D = getDraft(), B = budgetsFor(k);
      for (const c in D) { if (D[c] === (B[c] || 0)) continue; S.budgets = S.budgets.filter(b => !(b.from === k && b.cat === c)); S.budgets.push({ from: k, cat: c, amount: D[c] });
        const cat = S.cats.find(x => x.name === c); if (cat && cat.fullFixed) S.fixed.forEach(f => { if (f.cat === c && f.type === '지출' && f.period === '매월') f.amount = D[c]; }); }
      saveTable('budgets'); saveTable('fixed'); UI.draft = null; toast(`${keyLabel(k)}부터 적용했어요`); break; }
    case 'editLunch': openSheet('평일 점심 예산', [{ k: 'amount', label: '금액 (생활비 안에서 고정)', type: 'number', v: lunchBudget() }, { k: 'acc', label: '점심 계좌', type: 'select', options: S.accounts.filter(x => x.kind !== '카드').map(x => x.name), v: cfg('점심계좌', '') }, { k: 'shop', label: '식비·생활용품 계좌', type: 'select', options: S.accounts.filter(x => x.kind !== '카드').map(x => x.name), v: cfg('생활비계좌', '') }],
      x => { setCfg('평일점심예산', x.amount || 0); setCfg('점심계좌', x.acc); setCfg('생활비계좌', x.shop); saveTable('settings'); render(); }); return;
    case 'editCat': editCat(v); return;
    case 'addCat': editCat(null, v); return;
    case 'editAcct': editAcct(Number(v)); return;
    case 'addAcct': editAcct(null); return;
    case 'moveAcct': { const i = Number(v), j = i + Number(el.dataset.d); if (j < 0 || j >= S.accounts.length) return; const t = S.accounts[i]; S.accounts[i] = S.accounts[j]; S.accounts[j] = t; saveTable('accounts'); closeSheet(); render(); return; }
    case 'editCfg': openSheet(v === '한달시작일' ? '한 달 시작일' : '경고 기준', [{ k: 'n', label: v === '한달시작일' ? '날짜 (1~28)' : '금액', type: 'number', v: cfgNum(v, 0) }], x => { let n = x.n || 0; if (v === '한달시작일') n = Math.min(28, Math.max(1, n || 1)); setCfg(v, n); saveTable('settings'); UI.draft = null; render(); }); return;
    case 'connect': connectSheet(); return;
    case 'disconnect': store.del(LS.conn); store.del(LS.queue); store.del(LS.data); closeSheet(); sample(); render(); toast('연결을 끊었어요'); return;
    case 'pull': pull().then(ok => { if (ok) { autoRecordFixed(); UI.draft = null; render(); toast('불러왔어요'); } }); return;
    case 'export': exportCsv(); return;
    case 'closeSheet': closeSheet(); return;
    case 'sheetSave': if (sheetSave) sheetSave(); return;
    default: return;
  }
  render();
});
function autoLunch() { const d = parse(UI.date).getDay(); if (UI.cat === LIFE && UI.pay === cfg('점심계좌', '') && d > 0 && d < 6) { UI.sub = LUNCH; UI.autoLunch = true; } }
document.addEventListener('input', e => {
  if (e.target.id === 'q') { UI.filter.q = e.target.value; clearTimeout(UI.qT); UI.qT = setTimeout(updateSearch, 250); }
  if (e.target.id === 'amt') { const n = e.target.value.replace(/[^\d]/g, ''); e.target.value = n ? Number(n).toLocaleString('ko-KR') : ''; }
  if (e.target.id === 'f_amount' || e.target.id === 'f_n') { const n = e.target.value.replace(/[^\d]/g, ''); e.target.value = n ? Number(n).toLocaleString('ko-KR') : ''; }
});
function updateSearch() { const H = hParts(), b = $('#hBoxes'), l = $('#hList'); if (b) b.innerHTML = H.boxes; if (l) l.innerHTML = H.list; }
document.addEventListener('compositionend', e => { if (e.target.id === 'q') { UI.filter.q = e.target.value; updateSearch(); } });
document.addEventListener('change', e => { if (e.target.id === 'date') { keepInputs(); UI.date = e.target.value || today(); autoLunch(); render(); } });
document.addEventListener('scroll', e => { if (e.target.id === 'carousel') { const c = e.target, i = Math.round(c.scrollLeft / c.clientWidth); if (i !== UI.slide) { UI.slide = i; document.querySelectorAll('.dots i').forEach((d, j) => d.classList.toggle('on', j === i)); } } }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); if (e.key === 'Enter' && UI.view === 'input' && ['amt', 'what', 'memo'].includes(e.target.id)) doSave(); });
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS.some(x => x[0] === v)) { if (UI.view === 'input') keepInputs(); UI.view = v; UI.histKey = null; window.scrollTo(0, 0); render(); } });
window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && conn()) pull().then(ok => { if (ok) { autoRecordFixed(); render(); } }); });

// ---------- boot ----------
(function boot() {
  const cached = store.get(LS.data, null);
  if (cached && cached.cats) S = cached; else sample();
  if (!conn() && !S.demo) sample();
  if (location.hash.startsWith('#defaults=')) {
    try {
      const b = location.hash.slice(10).replace(/-/g, '+').replace(/_/g, '/');
      const obj = JSON.parse(decodeURIComponent(escape(atob(b))));
      const D = defaults(); Object.assign(D, obj); setCfg('기본결제', JSON.stringify(D)); saveTable('settings');
      setTimeout(() => toast('기본 결제수단을 저장했어요'), 300);
    } catch (e) { setTimeout(() => toast('링크를 읽지 못했어요'), 300); }
  }
  UI.view = 'input'; if (location.hash !== '#input') history.replaceState(null, '', '#input');
  render();
  if (conn()) pull().then(ok => { if (ok) { autoRecordFixed(); render(); } }); else autoRecordFixed();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
