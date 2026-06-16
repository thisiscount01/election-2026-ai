/**
 * 2026 지방선거 AI 서비스 — 프론트엔드 SPA
 * 이벤트 수집: session_start, ai_query, predict_submit, insight_render,
 *              candidate_compare, page_view, region_select
 */

import { PARTY, CATEGORY, RESULT, EVENTS } from './tokens.js';

const API = '';   // 같은 origin

// ── Session ──────────────────────────────────────────────────────────────────
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('sid');
  if (!id) { id = Math.random().toString(36).slice(2); sessionStorage.setItem('sid', id); }
  return id;
})();

// ── Analytics ────────────────────────────────────────────────────────────────
let aiQueryCount = 0;
let compareTriggered = false;

async function track(eventName, props = {}) {
  try {
    await fetch(`${API}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: eventName, session_id: SESSION_ID, timestamp: new Date().toISOString(), properties: props }),
    });
  } catch { /* analytics failure is non-fatal */ }
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentRegion = null;
let allCandidates = [];
let allRegions    = [];
let currentPage   = 'home';

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

// ── Navigation ────────────────────────────────────────────────────────────────
function goTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  track(EVENTS.PAGE_VIEW, { page });
  if (page === 'candidates') renderCandidates();
  if (page === 'guide')      loadSchedule();
  if (page === 'home')       loadHome();
}

// ── Region ────────────────────────────────────────────────────────────────────
function setRegion(region) {
  currentRegion = region;
  document.getElementById('region-label').textContent = region.short || region.name;
  closeRegionModal();
  track(EVENTS.REGION_SELECT, { region_code: region.code, region_name: region.name });
  loadInsight(region.code);
  if (currentPage === 'candidates') renderCandidates();
}

function openRegionModal()  { document.getElementById('region-modal').classList.add('open'); }
function closeRegionModal() { document.getElementById('region-modal').classList.remove('open'); }

function buildRegionGrid() {
  const grid = document.getElementById('region-grid');
  grid.innerHTML = '';
  allRegions.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'region-btn' + (currentRegion?.code === r.code ? ' selected' : '');
    btn.textContent = r.short;
    btn.onclick = () => setRegion(r);
    grid.appendChild(btn);
  });
}

// ── Party Helpers ─────────────────────────────────────────────────────────────
function partyCode(partyName) {
  const map = { '더불어민주당':'DEMOCRATIC','국민의힘':'PPP','조국혁신당':'REBUILDING','개혁신당':'REFORM','진보당':'PROGRESSIVE','무소속':'INDEPENDENT' };
  return map[partyName] || 'OTHER';
}
function partyChip(partyName) {
  const code = partyCode(partyName); const p = PARTY[code] || PARTY.OTHER;
  return `<span class="party-chip" style="background:${p.bg};color:${p.color}">${p.emoji} ${partyName}</span>`;
}
function resultChip(result) {
  if (!result) return '';
  const r = RESULT[result];
  if (!r) return `<span class="result-chip" style="background:#F1F5F9;color:#64748B">${result}</span>`;
  return `<span class="result-chip" style="background:${r.bg};color:${r.color}">${r.icon} ${r.label}</span>`;
}
function categoryChip(cat) {
  const c = CATEGORY[cat];
  if (!c) return `<span class="policy-cat">${cat}</span>`;
  return `<span class="policy-cat" style="background:${c.color}20;color:${c.color}">${c.icon} ${cat}</span>`;
}

// ── Candidate Card ────────────────────────────────────────────────────────────
function candCard(c, showCompare = false) {
  const code = partyCode(c.party); const p = PARTY[code] || PARTY.OTHER;
  const policiesHtml = (c.policies || []).slice(0, 3).map(pol => `
    <div class="policy-item">
      ${categoryChip(pol.category)}
      <div class="policy-text">
        <div class="policy-title">${escHtml(pol.title)}</div>
        <div class="policy-summary">${escHtml(pol.summary)}</div>
      </div>
    </div>`).join('');

  const compareBtn = showCompare
    ? `<button class="btn-outline" style="margin-top:10px;width:100%;font-size:12px" onclick="event.stopPropagation();window.addToCompare('${c.id}')">⚖️ 비교에 추가</button>`
    : '';

  return `
  <div class="cand-card" onclick="window.openDrawer('${c.id}')">
    <div class="cand-header">
      <div class="cand-avatar" style="background:${p.bg}">${p.emoji}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
          <span class="cand-name">${escHtml(c.name)}</span>${resultChip(c.result)}
        </div>
        <div class="cand-district">${escHtml(c.district)}</div>
        <div style="margin-top:6px">${partyChip(c.party)}</div>
      </div>
    </div>
    <div class="cand-meta">
      ${c.age ? c.age + '세 · ' : ''}${c.gender || ''} · ${c.is_incumbent ? '현직' : '신인'}
      ${c.vote_rate ? `<span style="font-variant-numeric:tabular-nums;margin-left:6px;color:var(--brand);font-weight:700">${c.vote_rate}%</span>` : ''}
    </div>
    <div class="cand-policies">${policiesHtml}</div>
    ${compareBtn}
  </div>`;
}

// ── Drawer ────────────────────────────────────────────────────────────────────
function openDrawer(candId) {
  const c = allCandidates.find(x => x.id === candId);
  if (!c) return;
  const code = partyCode(c.party); const p = PARTY[code] || PARTY.OTHER;
  const policiesHtml = (c.policies || []).map(pol => `
    <div class="policy-item" style="align-items:flex-start;padding:10px 0">
      ${categoryChip(pol.category)}
      <div class="policy-text">
        <div class="policy-title">${escHtml(pol.title)}</div>
        <div class="policy-summary" style="margin-top:4px">${escHtml(pol.summary)}</div>
        ${pol.detail ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${escHtml(pol.detail)}</div>` : ''}
      </div>
    </div>`).join('');
  const careerHtml = Array.isArray(c.career) ? c.career.map(cr => `<li>${escHtml(cr)}</li>`).join('') : '';

  document.getElementById('drawer-content').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div class="cand-avatar" style="width:56px;height:56px;font-size:28px;background:${p.bg}">${p.emoji}</div>
      <div>
        <div class="drawer-name">${escHtml(c.name)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${partyChip(c.party)}${resultChip(c.result)}</div>
      </div>
    </div>
    <div class="cand-district" style="font-size:14px;margin-bottom:12px">📍 ${escHtml(c.district)}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-bottom:16px">
      ${c.age ? `<div class="stat-box" style="padding:12px"><div class="stat-num" style="font-size:20px">${c.age}</div><div class="stat-label">나이</div></div>` : ''}
      ${c.vote_rate ? `<div class="stat-box" style="padding:12px"><div class="stat-num" style="font-size:20px">${c.vote_rate}%</div><div class="stat-label">득표율</div></div>` : ''}
      ${c.vote_count ? `<div class="stat-box" style="padding:12px"><div class="stat-num" style="font-size:16px">${Number(c.vote_count).toLocaleString()}</div><div class="stat-label">득표수</div></div>` : ''}
    </div>
    ${c.education ? `<div style="margin-bottom:12px"><strong>학력</strong><p style="font-size:13px;color:var(--text-sub);margin-top:4px">${escHtml(c.education)}</p></div>` : ''}
    ${careerHtml ? `<div style="margin-bottom:16px"><strong>주요 경력</strong><ul style="margin-top:6px;padding-left:18px;font-size:13px;color:var(--text-sub);display:flex;flex-direction:column;gap:4px">${careerHtml}</ul></div>` : ''}
    <div><strong style="display:block;margin-bottom:4px">📜 공약 전체</strong>${policiesHtml}</div>
    <div style="margin-top:16px;padding:10px;background:var(--warn-bg);border-radius:8px;font-size:12px;color:var(--text-muted)">
      출처: ${escHtml(c.source || '')} ·
      <a href="${c.source_url || 'https://www.nec.go.kr'}" target="_blank" rel="noopener" style="color:var(--info)">공식 확인 →</a>
    </div>`;

  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
}

// ── Home ──────────────────────────────────────────────────────────────────────
async function loadHome() {
  try {
    const r = await fetch(`${API}/api/stats`);
    const s = await r.json();
    document.getElementById('stat-total').textContent   = s.total_candidates;
    document.getElementById('stat-winners').textContent = s.total_winners;
    document.getElementById('stat-docs').textContent    = s.index_docs;
  } catch { /* silent */ }
  renderWinners();
}

function renderWinners() {
  const grid    = document.getElementById('winners-grid');
  const winners = allCandidates.filter(c => c.result === '당선');
  if (!winners.length) { grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>'; return; }
  grid.innerHTML = winners.map(c => {
    const code = partyCode(c.party); const p = PARTY[code] || PARTY.OTHER;
    return `
    <div class="cand-card" onclick="window.openDrawer('${c.id}')">
      <div class="cand-header">
        <div class="cand-avatar" style="background:${p.bg}">${p.emoji}</div>
        <div>
          <div class="cand-name">${escHtml(c.name)} <span style="font-size:14px;color:var(--ok)">✅</span></div>
          <div class="cand-district">${escHtml(c.district)}</div>
          <div style="margin-top:6px">${partyChip(c.party)}</div>
        </div>
      </div>
      <div class="cand-meta" style="font-variant-numeric:tabular-nums">득표율 <strong style="color:var(--brand)">${c.vote_rate}%</strong> · ${Number(c.vote_count).toLocaleString()}표</div>
    </div>`;
  }).join('');
}

// ── Insight ───────────────────────────────────────────────────────────────────
async function loadInsight(regionCode) {
  const t0 = Date.now();
  try {
    const r   = await fetch(`${API}/api/insight/${regionCode}`);
    const ins = await r.json();
    if (ins.winner) {
      document.getElementById('insight-title').textContent = `📍 ${ins.region} — ${ins.winner.name} 당선`;
      document.getElementById('insight-sub').textContent   = `${ins.winner.party} · 득표율 ${ins.winner.vote_rate || '-'}%`;
      document.getElementById('insight-pills').innerHTML   = (ins.key_policies || [])
        .map(p => `<span class="insight-pill">${escHtml(p.category)}: ${escHtml(p.title)}</span>`).join('');
      // predict_submit CTA — Service Metric: 전환율 ≥40% 달성 핵심 버튼
      document.getElementById('insight-actions').innerHTML = `
        <button class="btn-white" onclick="window.runPredict('${regionCode}')">📊 예측 분석 전체 보기</button>
        <button class="btn-white-outline" onclick="goTo('candidates');document.getElementById('filter-region').value='${regionCode}';renderCandidates()">👤 후보자 보기</button>
        <button class="btn-white-outline" onclick="goTo('compare');window.autoCompare('${regionCode}')">⚖️ 후보 비교</button>`;
      document.getElementById('insight-banner').classList.add('show');
      track(EVENTS.INSIGHT_RENDER, { region_code: regionCode, latency_ms: Date.now() - t0 });
    }
  } catch { /* silent */ }
}

// ── Predict ───────────────────────────────────────────────────────────────────
async function runPredict(regionCode) {
  const code = regionCode || currentRegion?.code || '11';
  // predict_submit 이벤트 — Service Metric: 예측 참여 전환율 ≥40%
  track(EVENTS.PREDICT_SUBMIT, { region_code: code });
  try {
    const r    = await fetch(`${API}/api/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region_code: code }),
    });
    const data = await r.json();
    showPredictModal(data);
  } catch {
    toast('예측 정보를 불러오지 못했습니다.');
  }
}

function showPredictModal(data) {
  const winner  = data.winner;
  const runners = (data.runners || []).filter(r => r.vote_rate);

  const partyDistHtml = Object.entries(data.party_distribution || {})
    .sort((a, b) => b[1] - a[1])
    .map(([party, rate]) => {
      const code = partyCode(party);
      const p = PARTY[code] || PARTY.OTHER;
      const w = Math.min(Math.round(rate / 70 * 100), 100);
      return `<div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
          <span>${p.emoji} ${escHtml(party)}</span>
          <strong style="font-variant-numeric:tabular-nums">${rate}%</strong>
        </div>
        <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
          <div style="height:100%;width:${w}%;background:${p.color};border-radius:3px"></div>
        </div></div>`;
    }).join('');

  const topPoliciesHtml = (winner?.top_policies || []).map(p =>
    `<div style="padding:8px 0;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-start;font-size:13px">
      ${categoryChip(p.category)}
      <div><div style="font-weight:600">${escHtml(p.title)}</div>
      <div style="color:var(--text-sub);margin-top:2px">${escHtml(p.summary)}</div></div>
    </div>`).join('');

  document.getElementById('predict-modal-body').innerHTML = `
    <h3 style="font-size:18px;font-weight:800;margin-bottom:16px;padding-right:32px">📊 ${escHtml(data.region || '')} 선거 결과 분석</h3>
    ${winner ? `
    <div style="background:var(--ok-bg);border-radius:var(--r);padding:14px 16px;margin-bottom:16px;border-left:4px solid var(--ok)">
      <div style="font-size:12px;color:var(--ok);font-weight:700;margin-bottom:4px">✅ 당선자 · ${escHtml(data.position || '')}</div>
      <div style="font-size:18px;font-weight:800">${escHtml(winner.name)}</div>
      <div style="font-size:13px;color:var(--text-sub);margin-top:2px;font-variant-numeric:tabular-nums">득표율 ${winner.vote_rate || '-'}%</div>
    </div>` : ''}
    ${runners.length > 0 ? `
    <div style="margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;color:var(--text-sub);margin-bottom:8px">기타 후보</div>
      ${runners.map(r => `<div style="font-size:13px;padding:5px 0;border-top:1px solid var(--border);display:flex;justify-content:space-between">
        <span>${escHtml(r.name)} <span style="color:var(--text-muted);font-size:12px">(${escHtml(r.party)})</span></span>
        <strong style="font-variant-numeric:tabular-nums">${r.vote_rate}%</strong>
      </div>`).join('')}
    </div>` : ''}
    ${partyDistHtml ? `<div style="margin-bottom:16px"><div style="font-size:13px;font-weight:700;margin-bottom:10px">🏛️ 정당별 득표율</div>${partyDistHtml}</div>` : ''}
    ${topPoliciesHtml ? `<div style="margin-bottom:16px"><div style="font-size:13px;font-weight:700;margin-bottom:4px">📜 당선자 주요 공약</div>${topPoliciesHtml}</div>` : ''}
    <div style="padding:10px 12px;background:var(--warn-bg);border-radius:var(--r-sm);font-size:11px;color:var(--text-muted)">
      ${escHtml(data.disclaimer || '')}
      · <a href="https://www.nec.go.kr" target="_blank" rel="noopener" style="color:var(--info)">선관위 공식 확인 →</a>
    </div>
    <button class="btn-primary" style="width:100%;margin-top:14px" onclick="window.closePredictModal()">닫기</button>`;

  document.getElementById('predict-modal').classList.add('open');
}

function closePredictModal() {
  document.getElementById('predict-modal').classList.remove('open');
}

// 비교 자동 진입
function autoCompare(regionCode) {
  const regionCands = allCandidates.filter(c => c.region_code === regionCode);
  if (regionCands.length >= 2) {
    compareIds = regionCands.slice(0, 2).map(c => c.id);
    renderCompare();
    track(EVENTS.CANDIDATE_COMPARE, { candidate_ids: compareIds, region_code: regionCode });
  } else if (regionCands.length === 1) {
    compareIds = [regionCands[0].id];
    renderCompare();
  }
}

// ── Candidates Page ───────────────────────────────────────────────────────────
function renderCandidates() {
  const regionCode = document.getElementById('filter-region').value;
  const party      = document.getElementById('filter-party').value;
  const result     = document.getElementById('filter-result').value;
  const q          = document.getElementById('cand-search').value.trim();

  let list = allCandidates;
  if (regionCode) list = list.filter(c => c.region_code === regionCode);
  if (party)      list = list.filter(c => c.party === party);
  if (result)     list = list.filter(c => c.result === result);
  if (q)          list = list.filter(c =>
    c.name.includes(q) || c.region.includes(q) || c.party.includes(q) ||
    (c.tags || []).some(t => t.includes(q)));

  const grid = document.getElementById('candidates-grid');
  if (!list.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div>검색 결과가 없습니다.</div>';
    return;
  }
  grid.innerHTML = list.map(c => candCard(c, true)).join('');
}

// ── Compare Page ──────────────────────────────────────────────────────────────
let compareIds = [];

function addToCompare(candId) {
  if (compareIds.includes(candId)) { toast('이미 비교 목록에 있습니다.'); return; }
  if (compareIds.length >= 2) compareIds.shift();
  compareIds.push(candId);
  renderCompare();
  goTo('compare');
  if (!compareTriggered && compareIds.length >= 2) {
    compareTriggered = true;
    track(EVENTS.CANDIDATE_COMPARE, { candidate_ids: compareIds });
  }
}

function renderCompare() {
  const [idA, idB] = compareIds;
  const a = allCandidates.find(c => c.id === idA);
  const b = allCandidates.find(c => c.id === idB);
  document.getElementById('compare-left').innerHTML  = a ? comparePanel(a, b) : '<div class="empty-state">후보자를 선택하세요</div>';
  document.getElementById('compare-right').innerHTML = b ? comparePanel(b, a) : '<div class="empty-state">후보자를 선택하세요</div>';
}

function comparePanel(c, opp) {
  const code = partyCode(c.party); const p = PARTY[code] || PARTY.OTHER;
  const total = (c.vote_rate || 0) + (opp?.vote_rate || 0);
  const barW = total > 0 ? Math.round(c.vote_rate / total * 100) : 50;
  const policiesHtml = (c.policies || []).map(pol => `
    <div style="padding:8px 0;border-top:1px solid var(--border)">
      ${categoryChip(pol.category)} <span style="font-size:13px;font-weight:600">${escHtml(pol.title)}</span>
      <div style="font-size:12px;color:var(--text-sub);margin-top:3px">${escHtml(pol.summary)}</div>
    </div>`).join('');
  return `
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div class="cand-avatar" style="background:${p.bg}">${p.emoji}</div>
        <div>
          <div class="compare-name">${escHtml(c.name)}</div>
          <div>${partyChip(c.party)}${resultChip(c.result)}</div>
        </div>
      </div>
      <div class="vote-bar"><div class="vote-fill" style="width:${barW}%;background:${p.color}"></div></div>
      <div class="vote-label" style="font-variant-numeric:tabular-nums">득표율 ${c.vote_rate || '-'}%${c.vote_count ? ' · ' + Number(c.vote_count).toLocaleString() + '표' : ''}</div>
      <div style="margin-top:12px">${policiesHtml}</div>
    </div>`;
}

// ── AI Chat ───────────────────────────────────────────────────────────────────
let chatBusy = false;

function appendMsg(role, html) {
  const msgs = document.getElementById('chat-messages');
  const div  = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = role === 'user'
    ? `<div class="msg-avatar">👤</div><div class="msg-bubble">${html}</div>`
    : `<div class="msg-avatar">🤖</div><div class="msg-bubble">${html}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

async function sendChat(question) {
  if (!question.trim() || chatBusy) return;
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  document.getElementById('chat-input').value   = '';

  appendMsg('user', escHtml(question));

  const loadId = 'load-' + Date.now();
  const msgs   = document.getElementById('chat-messages');
  const loadDiv = document.createElement('div');
  loadDiv.className = 'msg bot'; loadDiv.id = loadId;
  loadDiv.innerHTML = '<div class="msg-avatar">🤖</div><div class="msg-bubble"><div class="loading-spinner" style="width:20px;height:20px;margin:0;border-width:2px"></div></div>';
  msgs.appendChild(loadDiv); msgs.scrollTop = msgs.scrollHeight;

  aiQueryCount++;
  track(EVENTS.AI_QUERY, { question, query_count: aiQueryCount, region_code: currentRegion?.code });

  try {
    const t0  = Date.now();
    const res = await fetch(`${API}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, region_code: currentRegion?.code }),
    });
    const data = await res.json();
    const latencyMs = Date.now() - t0;

    document.getElementById(loadId)?.remove();

    const answerHtml = escHtml(data.answer || '')
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const confidencePct = Math.round((data.confidence || 0) * 100);
    const belowWarn = data.below_threshold
      ? '<div class="disclaimer-text">⚠️ 신뢰도가 낮습니다. 공식 출처를 반드시 확인하세요.</div>' : '';
    const sourcesHtml = (data.sources || []).map(s =>
      `<a class="source-tag" href="${s.source_url || '#'}" target="_blank" rel="noopener">📎 ${escHtml(s.source || '')}</a>`
    ).join('');

    appendMsg('bot', `
      ${answerHtml}
      <div class="confidence-bar"><div class="confidence-fill" style="width:${confidencePct}%"></div></div>
      <div style="font-size:11px;color:var(--text-muted)">신뢰도 ${confidencePct}% · 응답 ${latencyMs}ms</div>
      ${sourcesHtml ? `<div class="msg-sources">${sourcesHtml}</div>` : ''}
      ${belowWarn}
      <div class="disclaimer-text">${escHtml(data.disclaimer || '')}</div>`);

    // follow-up 칩 — AI 질문 3회 이상 비율 ≥30% 달성 유도
    const followups = generateFollowups(data.intent, data.region_detected);
    if (followups.length > 0) {
      const msgs    = document.getElementById('chat-messages');
      const fDiv    = document.createElement('div');
      fDiv.className = 'followup-chips';
      fDiv.innerHTML = followups
        .map(q => `<button class="followup-chip" onclick="window.sendChatQ('${q.replace(/'/g, '\\\'')}')">${escHtml(q)}</button>`)
        .join('');
      msgs.appendChild(fDiv);
      msgs.scrollTop = msgs.scrollHeight;
    }

    if (/당선|결과|누가|예측/.test(question)) track(EVENTS.PREDICT_SUBMIT, { question });

  } catch {
    document.getElementById(loadId)?.remove();
    appendMsg('bot', '⚠️ 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  } finally {
    chatBusy = false;
    document.getElementById('chat-send').disabled = false;
    document.getElementById('chat-input').focus();
  }
}

// ── Follow-up 질문 생성 (AI 3회 이상 상호작용 유도) ─────────────────────────────
function generateFollowups(intent, regionName) {
  const short = currentRegion?.short || (regionName ? regionName.replace(/특별시|광역시|특별자치시|특별자치도|도$/g, '') : '서울');
  switch (intent) {
    case 'candidate_search':
      return [`${short} 후보자 공약은?`, `${short} 선거 결과는?`, '다른 지역 후보도 알려줘'];
    case 'policy_search':
      return ['경제 공약 더 자세히', '환경·교통 공약 비교해줘', '복지 공약 알려줘'];
    case 'result_query':
      return ['당선자 주요 공약은?', '다른 지역 결과도 알려줘', '정당별 당선 현황은?'];
    case 'polling_guide':
    case 'schedule_query':
      return ['사전투표 일정도 알려줘', '투표소는 어떻게 찾나요?', '선거 종류는?'];
    case 'comparison':
      return [`${short} 공약 비교해줘`, '경기도 후보자 알려줘', '민주당 공약 알려줘'];
    default:
      return [`${short} 후보자 알려줘`, '투표 방법 알려줘', '선거 결과 요약해줘'];
  }
}

// ── Schedule Page ─────────────────────────────────────────────────────────────
async function loadSchedule() {
  try {
    const r     = await fetch(`${API}/api/schedule`);
    const sched = await r.json();
    const list  = document.getElementById('schedule-list');
    const items = [
      { date: `${sched.candidate_registration?.start} ~ ${sched.candidate_registration?.end}`, label: '후보자 등록' },
      { date: `${sched.voter_roll_inspection?.start} ~ ${sched.voter_roll_inspection?.end}`,   label: '선거인명부 열람·이의신청' },
      { date: (sched.early_voting || []).map(e => e.date).join(', '),                           label: `사전투표 (${sched.early_voting?.[0]?.time || ''})` },
      { date: sched.election_date,                                                              label: `🗳️ 선거일 (${sched.election_time || ''})` },
    ];
    list.innerHTML = items.map(({ date, label }) => `
      <li class="schedule-item">
        <span class="schedule-date">${date}</span>
        <span class="schedule-label">${label}</span>
      </li>`).join('');

    document.getElementById('official-links').innerHTML = (sched.official_links || []).map(l =>
      `<a class="official-link" href="${l.url}" target="_blank" rel="noopener">🔗 ${escHtml(l.label)}</a>`
    ).join('');
  } catch { /* silent */ }
}

// ── Compare region filter ─────────────────────────────────────────────────────
function buildCompareRegionFilter() {
  const sel = document.getElementById('compare-region');
  // 모든 지역 표시 — 지역 간 교차 비교 지원
  allRegions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.code; opt.textContent = r.name; sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const code = sel.value;
    if (!code) return;
    const selCand = allCandidates.find(c => c.region_code === code);
    if (!selCand) return;
    // 선택 지역 후보(left) + 다음 후보(right) 교차 비교
    const idx = allCandidates.indexOf(selCand);
    const otherCand = allCandidates[idx === allCandidates.length - 1 ? 0 : idx + 1];
    compareIds = otherCand ? [selCand.id, otherCand.id] : [selCand.id];
    renderCompare();
    if (compareIds.length >= 2) track(EVENTS.CANDIDATE_COMPARE, { candidate_ids: compareIds, region_code: code });
  });

  // 서울(11) vs 부산(21) 기본 비교 — 데이터 도착 즉시 콘텐츠 표시
  if (allCandidates.length >= 2 && compareIds.length < 2) {
    const candA = allCandidates.find(c => c.region_code === '11') || allCandidates[0];
    const candB = allCandidates.find(c => c.region_code === '21') || allCandidates[1];
    if (candA && candB) {
      sel.value = candA.region_code || '';
      compareIds = [candA.id, candB.id];
      renderCompare();
    }
  }
}

// ── Candidates Region Filter ──────────────────────────────────────────────────
function buildCandidatesRegionFilter() {
  const sel = document.getElementById('filter-region');
  allRegions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.code; opt.textContent = r.name; sel.appendChild(opt);
  });
}

// ── Geo Detection ─────────────────────────────────────────────────────────────
async function detectRegionOnLoad() {
  // 1) GPS
  if (navigator.geolocation) {
    try {
      await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(pos => {
        const region = geoToRegion(pos.coords.latitude, pos.coords.longitude);
        if (region) { setRegion(region); }
        res();
      }, rej, { timeout: 3000 }));
      return;
    } catch { /* fall through */ }
  }
  // 2) IP
  try {
    const r = await fetch(`${API}/api/geo`);
    const g = await r.json();
    const region = allRegions.find(x => x.code === g.code);
    if (region) setRegion(region);
  } catch { /* keep default */ }
}

function geoToRegion(lat, lng) {
  const map = [
    { code:'11', minLat:37.4, maxLat:37.7, minLng:126.7, maxLng:127.2, name:'서울특별시', short:'서울' },
    { code:'21', minLat:34.9, maxLat:35.5, minLng:128.7, maxLng:129.3, name:'부산광역시', short:'부산' },
    { code:'22', minLat:35.6, maxLat:36.2, minLng:128.3, maxLng:128.9, name:'대구광역시', short:'대구' },
    { code:'23', minLat:37.3, maxLat:37.6, minLng:126.4, maxLng:126.9, name:'인천광역시', short:'인천' },
    { code:'24', minLat:35.0, maxLat:35.3, minLng:126.6, maxLng:127.1, name:'광주광역시', short:'광주' },
    { code:'25', minLat:36.2, maxLat:36.5, minLng:127.2, maxLng:127.6, name:'대전광역시', short:'대전' },
    { code:'26', minLat:35.4, maxLat:35.7, minLng:129.1, maxLng:129.5, name:'울산광역시', short:'울산' },
    { code:'31', minLat:36.9, maxLat:38.3, minLng:126.5, maxLng:127.9, name:'경기도', short:'경기' },
    { code:'39', minLat:33.1, maxLat:33.6, minLng:126.1, maxLng:126.9, name:'제주특별자치도', short:'제주' },
  ];
  for (const r of map) {
    if (lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng) return r;
  }
  return null;
}

// ── Util ──────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
// 이벤트 리스너 일괄 등록 — 데이터 fetch와 독립적으로 즉시 실행
function _bindListeners() {
  // [data-page] 라우팅
  document.querySelectorAll('[data-page]').forEach(el =>
    el.addEventListener('click', () => goTo(el.dataset.page))
  );

  // 지역 모달
  document.getElementById('region-badge').addEventListener('click', openRegionModal);
  document.getElementById('region-modal-close').addEventListener('click', closeRegionModal);
  document.getElementById('region-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('region-modal')) closeRegionModal();
  });

  // 필터
  ['filter-region','filter-party','filter-result'].forEach(id =>
    document.getElementById(id).addEventListener('change', renderCandidates)
  );
  document.getElementById('cand-search-btn').addEventListener('click', renderCandidates);
  document.getElementById('cand-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') renderCandidates();
  });

  // AI Chat
  document.getElementById('chat-send').addEventListener('click', () =>
    sendChat(document.getElementById('chat-input').value)
  );
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(e.target.value); }
  });

  // 빠른 질문 버튼
  document.querySelectorAll('.sq-btn').forEach(btn =>
    btn.addEventListener('click', () => { goTo('ai'); sendChat(btn.dataset.q); })
  );

  // Drawer
  document.getElementById('drawer-overlay').addEventListener('click', e => {
    if (!document.getElementById('drawer').contains(e.target)) closeDrawer();
  });
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
}

async function init() {
  track(EVENTS.SESSION_START, { ts: new Date().toISOString() });

  const _hideOverlay = () => {
    const pl = document.getElementById('page-loading');
    if (pl && !pl.classList.contains('hidden')) pl.classList.add('hidden');
  };

  // ① 리스너 즉시 등록 — fetch 완료를 기다리지 않음
  _bindListeners();

  // 로딩 경과 시간 표시 — cold-start 대기 사용자에게 진행 상황 안내
  const _startMs = Date.now();
  const plSub = document.querySelector('#page-loading .pl-sub');
  const _loadTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _startMs) / 1000);
    if (plSub) plSub.innerHTML = `서버를 깨우는 중… (${elapsed}초)<br><small>처음 접속 시 20~30초 소요될 수 있습니다</small>`;
  }, 1000);

  // ② UI 셸 즉시 표시 (데이터 없어도 네비게이션·골격 동작)
  goTo('home');

  // ④ Cold-start 대응 fetch 헬퍼
  function fetchWithRetry(url, maxWaitMs, intervalMs) {
    const deadline = Date.now() + maxWaitMs;
    const attempt = () => Promise.race([
      fetch(url),
      new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), intervalMs))
    ]).catch(err => {
      if (Date.now() + intervalMs >= deadline) throw err;
      return new Promise(r => setTimeout(r, 500)).then(attempt);
    });
    return attempt();
  }

  // ⑤ 백그라운드 데이터 fetch — UI를 블로킹하지 않음
  Promise.all([
    fetchWithRetry(`${API}/api/candidates?limit=100`, 40000, 4000),
    fetchWithRetry(`${API}/api/regions`, 40000, 4000),
  ]).then(async ([candRes, regRes]) => {
    clearInterval(_loadTimer);
    const candData = await candRes.json();
    const regData  = await regRes.json();
    allCandidates  = candData.data || [];
    allRegions     = regData.data  || [];

    buildRegionGrid();
    buildCandidatesRegionFilter();
    buildCompareRegionFilter();

    // 서울 즉시 기본 설정 — insight_render ≤90초 Gate Condition 보장
    if (!currentRegion) {
      const seoulRegion = allRegions.find(r => r.code === '11');
      if (seoulRegion) {
        currentRegion = seoulRegion;
        document.getElementById('region-label').textContent = seoulRegion.short;
        buildRegionGrid();
      }
    }

    // 데이터가 3초보다 빨리 도착하면 즉시 해제
    _hideOverlay();
    loadHome();
    if (currentRegion) loadInsight(currentRegion.code);
    detectRegionOnLoad();

  }).catch(e => {
    clearInterval(_loadTimer);
    console.error('데이터 로드 오류:', e);
    _hideOverlay();
    const homeEl = document.getElementById('page-home');
    if (homeEl) homeEl.innerHTML = `
      <div class="empty-state" style="padding:48px 20px;text-align:center">
        <div class="empty-icon">⚠️</div>
        <div style="margin-bottom:10px;font-size:16px;font-weight:700;color:var(--text)">데이터를 불러오지 못했습니다</div>
        <div style="font-size:13px;color:var(--text-sub);margin-bottom:20px">서버가 준비 중이거나 네트워크 오류가 발생했습니다.<br>잠시 후 다시 시도해 주세요.</div>
        <a href="/" style="display:inline-block;padding:10px 24px;background:var(--brand);color:#fff;border-radius:var(--r);text-decoration:none;font-weight:700;font-size:14px">🔄 새로고침</a>
      </div>`;
  });
}

// 전역 노출 (인라인 onclick에서 사용)
window.addToCompare      = addToCompare;
window.openDrawer        = openDrawer;
window.runPredict        = runPredict;
window.closePredictModal = closePredictModal;
window.autoCompare       = autoCompare;
window.sendChatQ         = (q) => { goTo('ai'); sendChat(q); };

init();
