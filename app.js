'use strict';
/* ================= 달의 기록 · 생리주기 트래커 =================
   - 데이터: localStorage (백업/복원은 JSON 파일)
   - 알림: 로컬(앱 사용 중) + 구글 캘린더 이벤트(백그라운드)
================================================================ */

// ---------- 날짜 유틸 (로컬 기준, 타임존 안전) ----------
const pad = (n) => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0); }
function addDays(s, n) { const d = parseYMD(s); d.setDate(d.getDate() + n); return ymd(d); }
function diffDays(a, b) { return Math.round((parseYMD(b) - parseYMD(a)) / 86400000); }
function todayStr() { return ymd(new Date()); }
function fmtKo(s) { const d = parseYMD(s); const w = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()]; return `${d.getMonth() + 1}월 ${d.getDate()}일 (${w})`; }
function fmtShort(s) { const d = parseYMD(s); return `${d.getMonth() + 1}.${d.getDate()}`; }

// ---------- 상태 ----------
const DEFAULTS = { defaultCycle: 28, window: 6, remindHour: 9, clientId: '' };
let state = { periods: [], settings: { ...DEFAULTS } };
let viewYear, viewMonth; // 달력에 보이는 달

const K_DATA = 'cycle.data.v1';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(K_DATA) || '{}');
    state.periods = Array.isArray(raw.periods) ? raw.periods : [];
    state.settings = { ...DEFAULTS, ...(raw.settings || {}) };
  } catch { /* ignore */ }
  normalize();
}
function save() {
  localStorage.setItem(K_DATA, JSON.stringify(state));
}

// 정렬 + 겹침 병합, end>=start 보장
function normalize() {
  const ps = state.periods
    .filter((p) => p && p.start)
    .map((p) => ({ start: p.start, end: p.end && p.end >= p.start ? p.end : (p.end && p.end < p.start ? p.start : p.end || null) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const out = [];
  for (const p of ps) {
    const last = out[out.length - 1];
    const lastEnd = last ? (last.end || last.start) : null;
    if (last && p.start <= addDays(lastEnd, 1)) {
      // 이어지거나 겹침 → 병합
      const pEnd = p.end || p.start;
      if (!last.end || pEnd > last.end) last.end = pEnd;
    } else {
      out.push({ start: p.start, end: p.end || null });
    }
  }
  state.periods = out;
}

// ---------- 통계 ----------
function computeStats() {
  const ps = state.periods;
  const starts = ps.map((p) => p.start);
  const cycles = [];
  for (let i = 1; i < starts.length; i++) cycles.push(diffDays(starts[i - 1], starts[i]));
  const durations = ps.filter((p) => p.end).map((p) => diffDays(p.start, p.end) + 1);

  const win = state.settings.window;
  const recentCycles = cycles.slice(-win);
  const recentDur = durations.slice(-win);
  const mean = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;

  const avgCycle = recentCycles.length ? mean(recentCycles) : null;
  const avgDuration = recentDur.length ? mean(recentDur) : null;
  const lastStart = starts.length ? starts[starts.length - 1] : null;
  const cycleForPredict = avgCycle || state.settings.defaultCycle;
  const nextPredicted = lastStart ? addDays(lastStart, cycleForPredict) : null;

  // 배란/가임기 추정 (다음 예정일 기준 -14일 배란, 가임기 -5~+1)
  let fertileStart = null, fertileEnd = null, ovulation = null;
  if (nextPredicted) {
    ovulation = addDays(nextPredicted, -14);
    fertileStart = addDays(ovulation, -5);
    fertileEnd = addDays(ovulation, 1);
  }

  return {
    cycles, durations, recentCycles, avgCycle, avgDuration,
    lastStart, nextPredicted, cycleForPredict,
    minCycle: cycles.length ? Math.min(...recentCycles) : null,
    maxCycle: cycles.length ? Math.max(...recentCycles) : null,
    predictedDuration: avgDuration || 5,
    fertileStart, fertileEnd, ovulation,
  };
}

// 특정 날짜가 어떤 기록에 속하는지
function periodOf(dateStr) {
  return state.periods.find((p) => {
    const end = p.end || p.start;
    return dateStr >= p.start && dateStr <= end;
  });
}

// ---------- 기록 조작 ----------
function setStart(dateStr) {
  if (state.periods.some((p) => p.start === dateStr)) return toast('이미 시작일로 기록돼 있어요');
  if (periodOf(dateStr)) return toast('이미 생리 기간에 포함된 날이에요');
  state.periods.push({ start: dateStr, end: null });
  normalize(); save(); toast(`${fmtShort(dateStr)} 시작일로 기록`);
}
function setEnd(dateStr) {
  // 시작일이 이 날짜보다 앞선 기록 중 가장 최근 것을 종료
  const cand = state.periods.filter((p) => p.start <= dateStr).sort((a, b) => a.start.localeCompare(b.start));
  const p = cand[cand.length - 1];
  if (!p) return toast('먼저 시작일을 기록해 주세요');
  p.end = dateStr;
  normalize(); save(); toast(`${fmtShort(dateStr)} 종료일로 기록`);
}
function deleteAt(dateStr) {
  const p = periodOf(dateStr);
  if (!p) return toast('삭제할 기록이 없어요');
  state.periods = state.periods.filter((x) => x !== p);
  save(); toast('기록을 삭제했어요');
}

// ---------- 렌더링: 달력 ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function renderCalendar() {
  const st = computeStats();
  $('#cal-title').textContent = `${viewYear}년 ${viewMonth + 1}월`;
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const first = new Date(viewYear, viewMonth, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = todayStr();

  // 예정 생리 기간 집합
  const predictedDays = new Set();
  if (st.nextPredicted) for (let i = 0; i < st.predictedDuration; i++) predictedDays.add(addDays(st.nextPredicted, i));
  const fertileDays = new Set();
  if (st.fertileStart) { let d = st.fertileStart; while (d <= st.fertileEnd) { fertileDays.add(d); d = addDays(d, 1); } }

  for (let i = 0; i < startPad; i++) {
    const c = document.createElement('div'); c.className = 'cell empty'; grid.appendChild(c);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${viewYear}-${pad(viewMonth + 1)}-${pad(day)}`;
    const cell = document.createElement('div');
    cell.className = 'cell';
    const p = periodOf(ds);
    if (p) { cell.classList.add(p.start === ds ? 'period-start' : 'period'); }
    else if (predictedDays.has(ds)) cell.classList.add('predicted');
    if (fertileDays.has(ds) && !p) cell.classList.add('fertile');
    if (ds === today) cell.classList.add('today');
    cell.innerHTML = `<span class="num">${day}</span>` +
      (p && p.start === ds ? '<span class="marker">🩸</span>' : '');
    cell.addEventListener('click', () => openSheet(ds));
    grid.appendChild(cell);
  }
}

// ---------- 렌더링: 대시보드 ----------
function renderDashboard() {
  const st = computeStats();
  const today = todayStr();

  if (st.nextPredicted) {
    $('#d-next').textContent = fmtKo(st.nextPredicted);
    const dd = diffDays(today, st.nextPredicted);
    let sub;
    if (dd > 0) sub = `${dd}일 남음` + (st.avgCycle ? '' : ' (기본 주기 기준)');
    else if (dd === 0) sub = '오늘이 예정일이에요';
    else sub = `${-dd}일 지남 · 시작을 기록해 주세요`;
    $('#d-next-sub').textContent = sub;
  } else { $('#d-next').textContent = '기록 필요'; $('#d-next-sub').textContent = '시작일을 먼저 입력하세요'; }

  if (st.lastStart) {
    $('#d-last').textContent = fmtKo(st.lastStart);
    $('#d-last-sub').textContent = `${diffDays(st.lastStart, today)}일째`;
  } else { $('#d-last').textContent = '-'; $('#d-last-sub').textContent = ''; }

  $('#d-cycle').textContent = st.avgCycle ? `${st.avgCycle}일` : '-';
  $('#d-duration').textContent = st.avgDuration ? `${st.avgDuration}일` : '-';

  // 주기 막대
  const bars = $('#cycle-bars'); bars.innerHTML = '';
  const cs = st.cycles.slice(-8);
  if (cs.length) {
    const max = Math.max(...cs, st.avgCycle || 0);
    cs.forEach((c) => {
      const bar = document.createElement('div');
      bar.className = 'bar' + (st.avgCycle && c === st.avgCycle ? ' avg' : '');
      bar.style.height = `${Math.max(12, (c / max) * 100)}%`;
      bar.innerHTML = `<i>${c}</i>`;
      bars.appendChild(bar);
    });
    $('#cycle-range').textContent = st.minCycle === st.maxCycle
      ? `최근 주기 ${st.minCycle}일` : `최근 주기 ${st.minCycle}~${st.maxCycle}일`;
  } else {
    bars.innerHTML = '<span class="sub">주기 2회 이상 기록하면 그래프가 표시돼요</span>';
    $('#cycle-range').textContent = '';
  }

  // 최근 기록
  const ul = $('#history'); ul.innerHTML = '';
  const recent = [...state.periods].reverse().slice(0, 8);
  if (!recent.length) ul.innerHTML = '<li><span class="meta">아직 기록이 없어요</span></li>';
  recent.forEach((p) => {
    const li = document.createElement('li');
    const dur = p.end ? `${diffDays(p.start, p.end) + 1}일` : '진행 중';
    li.innerHTML = `<span>${fmtKo(p.start)}</span><span class="meta">${p.end ? fmtShort(p.start) + '~' + fmtShort(p.end) : '시작'} · ${dur}</span>`;
    ul.appendChild(li);
  });
}

function renderAll() { renderCalendar(); renderDashboard(); updateSyncBadge(); }

// ---------- 액션 시트 ----------
let sheetDate = null;
function openSheet(ds) {
  sheetDate = ds;
  $('#sheet-date').textContent = fmtKo(ds);
  $('#sheet').classList.remove('hidden');
}
function closeSheet() { $('#sheet').classList.add('hidden'); sheetDate = null; }

// ---------- 토스트 ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- 탭 ----------
function switchTab(name) {
  ['calendar', 'dashboard', 'settings'].forEach((t) => {
    $('#tab-' + t).classList.toggle('hidden', t !== name);
  });
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'dashboard') renderDashboard();
  if (name === 'calendar') renderCalendar();
}

// ---------- 로컬 알림 (앱 사용 중 / 열었을 때 따라잡기) ----------
async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const r = await Notification.requestPermission();
  return r === 'granted';
}
async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  if (reg) reg.active?.postMessage({ type: 'notify', title, body, tag });
  else new Notification(title, { body, icon: 'icons/icon-192.png', tag });
}
// 앱을 열 때, 예정일 관련 알림을 한 번씩 띄움
function localCatchUp() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const st = computeStats();
  if (!st.nextPredicted) return;
  const today = todayStr();
  const dd = diffDays(today, st.nextPredicted);
  const flagKey = 'cycle.notified.' + today;
  const done = JSON.parse(localStorage.getItem(flagKey) || '[]');
  const already = periodOf(today) || (st.lastStart && diffDays(st.lastStart, today) < st.cycleForPredict - 3);

  if (dd === 2 && !done.includes('pre')) {
    notify('🩸 생리 예정 2일 전', `${fmtKo(st.nextPredicted)} 예정이에요. 미리 준비하세요.`, 'pre');
    done.push('pre');
  }
  if (dd <= 0 && !already && !done.includes('day')) {
    notify('🩸 생리 예정일 확인', '오늘 예정일이에요. 시작했다면 기록해 주세요.', 'day');
    done.push('day');
  }
  localStorage.setItem(flagKey, JSON.stringify(done));
}

// ---------- 구글 캘린더 연동 ----------
let tokenClient = null;
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';

function gcalStatus(msg) { $('#gcal-status').textContent = msg; }
function updateSyncBadge() {
  $('#sync-badge').classList.toggle('hidden', !state.settings.clientId);
}

function getToken(clientId) {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts?.oauth2) return reject(new Error('구글 라이브러리 로딩 안 됨'));
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GCAL_SCOPE,
      callback: (resp) => { resp.error ? reject(new Error(resp.error)) : resolve(resp.access_token); },
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function gapi(token, method, path, body) {
  const res = await fetch('https://www.googleapis.com/calendar/v3' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function timedEvent(dateStr, summary, description) {
  const h = pad(state.settings.remindHour);
  return {
    summary,
    description,
    start: { dateTime: `${dateStr}T${h}:00:00`, timeZone: TZ },
    end: { dateTime: `${dateStr}T${h}:30:00`, timeZone: TZ },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    extendedProperties: { private: { app: 'cycle-tracker' } },
    colorId: '4',
  };
}

async function syncCalendar() {
  const clientId = $('#s-client-id').value.trim() || state.settings.clientId;
  if (!clientId) { gcalStatus('클라이언트 ID를 먼저 입력하세요.'); return; }
  state.settings.clientId = clientId; save(); updateSyncBadge();

  const st = computeStats();
  if (!st.nextPredicted) { gcalStatus('예측할 기록이 없어요. 시작일을 먼저 기록하세요.'); return; }

  gcalStatus('구글 인증 중…');
  let token;
  try { token = await getToken(clientId); }
  catch (e) { gcalStatus('인증 실패: ' + e.message); return; }

  try {
    gcalStatus('기존 알림 정리 중…');
    const nowIso = new Date().toISOString();
    const list = await gapi(token, 'GET',
      `/calendars/primary/events?privateExtendedProperty=${encodeURIComponent('app=cycle-tracker')}&timeMin=${encodeURIComponent(nowIso)}&maxResults=50&singleEvents=true`);
    for (const ev of (list.items || [])) {
      await gapi(token, 'DELETE', `/calendars/primary/events/${ev.id}`);
    }

    const today = todayStr();
    const created = [];
    const pre = addDays(st.nextPredicted, -2);
    if (pre > today) {
      await gapi(token, 'POST', '/calendars/primary/events',
        timedEvent(pre, '🩸 생리 예정 2일 전', `예상 시작일: ${fmtKo(st.nextPredicted)}`));
      created.push('2일 전');
    }
    if (st.nextPredicted >= today) {
      await gapi(token, 'POST', '/calendars/primary/events',
        timedEvent(st.nextPredicted, '🩸 생리 예정일 — 시작했나요?', '시작했다면 앱에 기록해 주세요.'));
      created.push('예정일 당일');
    } else {
      // 예정일이 이미 지났고 아직 기록 안 됨 → 오늘 확인 알림
      if (!periodOf(today)) {
        await gapi(token, 'POST', '/calendars/primary/events',
          timedEvent(today, '🩸 생리 시작 확인', `예정일(${fmtShort(st.nextPredicted)})이 지났어요. 시작했다면 기록해 주세요.`));
        created.push('오늘 확인');
      }
    }
    gcalStatus(created.length ? `동기화 완료 · 알림 등록: ${created.join(', ')}` : '등록할 미래 알림이 없어요.');
    toast('구글 캘린더 동기화 완료');
  } catch (e) {
    gcalStatus('동기화 오류: ' + e.message);
  }
}

// 기록이 바뀌면 자동 재동기화(연동돼 있을 때만, 조용히)
async function autoSync() {
  if (!state.settings.clientId || !window.google) return;
  try { await syncCalendar(); } catch { /* silent */ }
}

// ---------- 백업 ----------
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `달의기록_백업_${todayStr()}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('백업 파일을 내보냈어요');
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!Array.isArray(obj.periods)) throw new Error('형식 오류');
      state.periods = obj.periods;
      state.settings = { ...DEFAULTS, ...(obj.settings || {}) };
      normalize(); save(); loadSettingsToForm(); renderAll();
      toast('백업을 불러왔어요');
    } catch (e) { toast('불러오기 실패: 올바른 백업 파일이 아니에요'); }
  };
  reader.readAsText(file);
}

// ---------- 설정 폼 ----------
function loadSettingsToForm() {
  $('#s-client-id').value = state.settings.clientId || '';
  $('#s-remind-hour').value = state.settings.remindHour;
  $('#s-default-cycle').value = state.settings.defaultCycle;
  $('#s-window').value = state.settings.window;
  $('#s-origin').textContent = location.origin;
}
function saveSettings() {
  state.settings.remindHour = clampInt($('#s-remind-hour').value, 0, 23, 9);
  state.settings.defaultCycle = clampInt($('#s-default-cycle').value, 15, 60, 28);
  state.settings.window = clampInt($('#s-window').value, 2, 24, 6);
  state.settings.clientId = $('#s-client-id').value.trim();
  save(); renderAll(); toast('설정을 저장했어요');
}
function clampInt(v, min, max, def) { const n = parseInt(v, 10); return isNaN(n) ? def : Math.min(max, Math.max(min, n)); }

// ---------- 초기화 & 이벤트 바인딩 ----------
function init() {
  load();
  const now = new Date();
  viewYear = now.getFullYear(); viewMonth = now.getMonth();
  loadSettingsToForm();
  renderAll();

  // 달력 이동
  $('#cal-prev').onclick = () => { if (--viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar(); };
  $('#cal-next').onclick = () => { if (++viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar(); };

  // 빠른 기록
  $('#btn-log-today').onclick = async () => { setStart(todayStr()); renderAll(); await ensureNotifyPermission(); autoSync(); };
  $('#btn-end-today').onclick = () => { setEnd(todayStr()); renderAll(); autoSync(); };

  // 시트
  $('#sheet-start').onclick = () => { if (sheetDate) { setStart(sheetDate); renderAll(); autoSync(); } closeSheet(); };
  $('#sheet-end').onclick = () => { if (sheetDate) { setEnd(sheetDate); renderAll(); autoSync(); } closeSheet(); };
  $('#sheet-delete').onclick = () => { if (sheetDate) { deleteAt(sheetDate); renderAll(); autoSync(); } closeSheet(); };
  $('#sheet-cancel').onclick = closeSheet;
  $('.sheet-bg').onclick = closeSheet;

  // 탭
  $$('.tabbar button').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));

  // 설정 / 백업
  $('#btn-save-settings').onclick = saveSettings;
  $('#btn-export').onclick = exportData;
  $('#btn-import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('#btn-reset').onclick = () => {
    if (confirm('모든 기록을 삭제할까요? 되돌릴 수 없어요. (백업을 먼저 권장)')) {
      state = { periods: [], settings: { ...DEFAULTS } };
      save(); loadSettingsToForm(); renderAll(); toast('모든 데이터를 삭제했어요');
    }
  };

  // 구글 캘린더
  $('#btn-gcal-connect').onclick = () => syncCalendar();
  $('#btn-gcal-off').onclick = () => {
    state.settings.clientId = ''; $('#s-client-id').value = ''; save(); updateSyncBadge();
    gcalStatus('연동을 해제했어요. (이미 등록된 캘린더 일정은 남아 있어요)');
  };

  // 알림 권한 + 따라잡기
  ensureNotifyPermission().then((ok) => { if (ok) localCatchUp(); });

  // 서비스워커
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
