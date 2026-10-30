/**
 * 가계부 앱 ↔ 구글 시트 연결 코드
 * 이 시트의 [확장 프로그램 → Apps Script]에 그대로 붙여넣고 [배포 → 새 배포 → 웹 앱]으로 배포하세요.
 * 연결 키는 시트 상단 메뉴 [가계부 앱 → 연결 키 보기]에서 확인할 수 있어요.
 */
const TZ = 'Asia/Seoul';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('가계부 앱')
    .addItem('연결 키 보기', 'showKey')
    .addItem('연결 키 새로 만들기', 'resetKey')
    .addItem('예산표 다시 만들기', 'rebuildPrintSheet')
    .addToUi();
}

function getKey_() {
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty('APP_KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, '').slice(0, 20); p.setProperty('APP_KEY', k); }
  return k;
}
function showKey() { SpreadsheetApp.getUi().alert('연결 키', getKey_() + '\n\n이 키를 앱의 [설정 → 데이터 → 구글 시트 연동]에 입력하세요. 다른 사람에게 알려주지 마세요.', SpreadsheetApp.getUi().ButtonSet.OK); }
function resetKey() { PropertiesService.getScriptProperties().deleteProperty('APP_KEY'); showKey(); }

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet(e) {
  try {
    if (!e || !e.parameter || e.parameter.key !== getKey_()) return json_({ ok: false, error: '연결 키가 맞지 않아요' });
    const ss = SpreadsheetApp.getActive(), data = {};
    ss.getSheets().forEach(sh => {
      const name = sh.getName(); if (name === '예산표') return;
      const v = sh.getDataRange().getValues(); if (v.length < 1) return;
      const h = v[0].map(String);
      data[name] = v.slice(1).filter(r => r.some(c => c !== '')).map(r => {
        const o = {}; h.forEach((k, i) => { let c = r[i]; if (c instanceof Date) c = Utilities.formatDate(c, TZ, k === '적용시작' ? 'yyyy-MM' : 'yyyy-MM-dd'); o[k] = c; }); return o;
      });
    });
    return json_({ ok: true, data: data });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doPost(e) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.key !== getKey_()) return json_({ ok: false, error: '연결 키가 맞지 않아요' });
    let configChanged = false;
    (body.ops || []).forEach(op => {
      const sh = sheet_(op.tab, op.header);
      if (op.op === 'upsert') {
        const id = String(op.row[0]); const n = sh.getLastRow();
        const ids = n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0])) : [];
        const i = ids.indexOf(id);
        if (i >= 0) sh.getRange(i + 2, 1, 1, op.row.length).setValues([op.row]); else sh.appendRow(op.row);
      } else if (op.op === 'delete') {
        const n = sh.getLastRow(); if (n < 2) return;
        const ids = sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0]));
        const i = ids.indexOf(String(op.id)); if (i >= 0) sh.deleteRow(i + 2);
      } else if (op.op === 'replace') {
        const n = sh.getLastRow(); if (n > 1) sh.getRange(2, 1, n - 1, Math.max(sh.getLastColumn(), op.header.length)).clearContent();
        if (op.rows.length) sh.getRange(2, 1, op.rows.length, op.header.length).setValues(op.rows);
        configChanged = true;
      }
    });
    if (configChanged) rebuildPrintSheet();
    return json_({ ok: true });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
  finally { lock.releaseLock(); }
}

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  if (header && sh.getLastRow() === 0) { sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); sh.setFrozenRows(1); }
  sh.getRange('A:Z').setNumberFormat('@'); // keep dates/ids as plain text
  const amt = header ? header.indexOf('금액') : -1; if (amt >= 0) sh.getRange(2, amt + 1, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('#,##0');
  return sh;
}

function table_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name); if (!sh) return [];
  const v = sh.getDataRange().getValues(); const h = v[0].map(String);
  return v.slice(1).filter(r => r.some(c => c !== '')).map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; });
}

/** '예산표' 탭: 인쇄용. 앱에서 예산을 바꿀 때마다 자동으로 다시 만들어져요. */
function rebuildPrintSheet() {
  const ss = SpreadsheetApp.getActive();
  const cfg = {}; table_('설정').forEach(r => cfg[r['키']] = r['값']);
  const cats = table_('항목'), budgets = table_('예산'), fixed = table_('고정');
  const now = new Date(), sd = Number(cfg['한달시작일'] || 5);
  const d = new Date(now.getFullYear(), now.getMonth() - (now.getDate() < sd ? 1 : 0), 1);
  const key = Utilities.formatDate(d, TZ, 'yyyy-MM');
  const B = {}; budgets.forEach(b => { const f = b['적용시작'] instanceof Date ? Utilities.formatDate(b['적용시작'], TZ, 'yyyy-MM') : String(b['적용시작']); if (f <= key && (!B[b['항목']] || B[b['항목']].f <= f)) B[b['항목']] = { f: f, a: Number(b['금액']) || 0 }; });
  const num = v => Number(String(v).replace(/,/g, '')) || 0;
  const inc = fixed.filter(f => f['구분'] === '수입' && f['주기'] === '매월' && f['숨김'] !== 'Y').reduce((s, f) => s + num(f['금액']), 0);
  const sav = fixed.filter(f => f['구분'] === '저축' && f['주기'] === '매월' && f['숨김'] !== 'Y');
  const savSum = sav.reduce((s, f) => s + num(f['금액']), 0);
  const total = inc - savSum, lunch = num(cfg['평일점심예산'] || 0);
  const rows = [], acct = {};
  const add = (a, v) => { if (a && v) acct[a] = (acct[a] || 0) + v; };
  let others = 0;
  cats.filter(c => c['구분'] === '지출' && c['항목'] !== '생활비' && c['숨김'] !== 'Y').forEach(c => { const a = B[c['항목']] ? B[c['항목']].a : 0; others += a; if (a) rows.push([c['항목'], a, c['계좌'] || '', c['전액고정'] === 'Y' ? '월급날 전액' : c['적립'] === 'Y' ? '적립' : '']); add(c['계좌'], a); });
  const life = total - others;
  rows.unshift(['생활비 · 식비·생활용품', life - lunch, cfg['생활비계좌'] || '', '자동 계산'], ['생활비 · 평일 점심', lunch, cfg['점심계좌'] || '', '고정']);
  add(cfg['생활비계좌'], life - lunch); add(cfg['점심계좌'], lunch);
  sav.forEach(f => add(f['결제'], num(f['금액'])));

  let sh = ss.getSheetByName('예산표'); if (!sh) sh = ss.insertSheet('예산표'); sh.clear();
  const out = [];
  out.push([`${Utilities.formatDate(now, TZ, 'yyyy')} 예산 (${sd}일 ~ 다음 달 ${sd - 1 || '말'}일)`, '', '', '']);
  out.push(['', '', '', '']);
  out.push(['항목', '금액', '이체 계좌', '비고']);
  rows.forEach(r => out.push(r));
  out.push(['합계', total, '', `고정수입 ${inc.toLocaleString()} − 저축 ${savSum.toLocaleString()}`]);
  out.push(['', '', '', '']);
  out.push(['월급날 이체', '금액', '', '']);
  Object.keys(acct).forEach(a => out.push([a, acct[a], '', '']));
  out.push(['', '', '', '']);
  out.push(['고정지출', '금액', '결제', '날짜']);
  fixed.filter(f => f['구분'] === '지출' && f['숨김'] !== 'Y').forEach(f => out.push([f['이름'] + (f['변동'] === 'Y' ? ' (변동)' : ''), num(f['금액']), f['결제'], f['주기'] === '매년' ? `${f['월']}월 ${f['일']}일` : `매월 ${num(f['일']) >= 28 ? '말' : f['일']}일`]));
  sh.getRange(1, 1, out.length, 4).setValues(out);
  sh.getRange('B:B').setNumberFormat('#,##0');
  sh.getRange('A1').setFontWeight('bold').setFontSize(14);
  [3, rows.length + 6, rows.length + 8 + Object.keys(acct).length].forEach(r => sh.getRange(r, 1, 1, 4).setFontWeight('bold').setBackground('#ECE8DE'));
  sh.setColumnWidths(1, 4, 160);
}
