/**
 * 2026 지방선거 AI 정보 서비스 — HTTP 서버
 *
 * API Routes:
 *   GET  /api/health           서버 상태
 *   GET  /api/stats            전체 통계
 *   GET  /api/regions          시도 목록
 *   GET  /api/candidates       후보자 목록 (query: region_code, party, q)
 *   GET  /api/candidates/:id   단일 후보자
 *   POST /api/query            AI Q&A (RAG)
 *   POST /api/predict          지역별 예측 분석
 *   GET  /api/insight/:code    지역 개인화 인사이트
 *   GET  /api/schedule         선거 일정
 *   POST /api/events           이벤트 수집 (프론트→서버)
 *   GET  /api/metrics          이벤트 집계 (Admin)
 *   GET  /api/geo              IP 기반 지역 감지
 */

'use strict';
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

const PORT   = process.env.PORT || 3001;
const PUBLIC = path.join(__dirname, 'public');

// ── MIME 타입 ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.woff2':'font/woff2',
};

// ── 데이터 로드 ───────────────────────────────────────────────────────────
let candidatesCache = null;
let regionsCache    = null;

function getCandidates() {
  if (!candidatesCache) {
    candidatesCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'candidates.json'), 'utf8'));
  }
  return candidatesCache;
}

function getRegions() {
  if (!regionsCache) {
    regionsCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'regions.json'), 'utf8'));
  }
  return regionsCache;
}

// ── 이벤트 스토어 (메모리, Gate Condition: 이벤트 수집 완전성) ───────────
const eventStore = [];
const MAX_EVENTS = 50000;
const eventMetrics = {
  predict_submit:    0,
  session_start:     0,
  ai_query:          0,
  insight_render:    0,
  candidate_compare: 0,
  page_view:         0,
};

function recordEvent(event) {
  // dedup 키: session + event_name + minute + 속성 해시
  // ai_query처럼 같은 분에 여러 번 발화될 수 있는 이벤트는 properties를 포함해 구분
  const minuteKey = Math.floor(Date.now() / 60000);
  const propHash  = crypto.createHash('sha1')
    .update(JSON.stringify(event.properties || {}).slice(0, 200))
    .digest('hex').slice(0, 8);
  const dedupKey  = crypto.createHash('sha1')
    .update(`${event.event_name}:${event.session_id}:${minuteKey}:${propHash}`)
    .digest('hex').slice(0, 12);

  // 중복 체크 (최근 100개만)
  const recent = eventStore.slice(-100);
  if (recent.some(e => e.dedup_key === dedupKey)) return null;

  const stored = { ...event, dedup_key: dedupKey, server_ts: new Date().toISOString() };
  if (eventStore.length >= MAX_EVENTS) eventStore.shift();
  eventStore.push(stored);

  // 집계 카운터
  if (eventMetrics[event.event_name] !== undefined) eventMetrics[event.event_name]++;
  return stored;
}

// ── 스키마 검증 (Gate Condition: 필수 필드 누락률 0%) ────────────────────
const REQUIRED_CANDIDATE_FIELDS = ['id', 'name', 'district', 'region', 'region_code', 'party'];

function validateCandidateSchema(candidates) {
  const errors = [];
  candidates.forEach((c, i) => {
    REQUIRED_CANDIDATE_FIELDS.forEach(f => {
      if (!c[f]) errors.push(`[${i}] ${c.name || '?'}: ${f} 누락`);
    });
    if (!Array.isArray(c.policies)) errors.push(`[${i}] ${c.name}: policies 형식 오류`);
  });
  return errors;
}

// ── 레이턴시 측정 ─────────────────────────────────────────────────────────
const latencyBuckets = {
  '/api/query':      [],
  '/api/predict':    [],
  '/api/candidates': [],
};
const MAX_LATENCY_SAMPLES = 1000;

function recordLatency(route, ms) {
  if (!latencyBuckets[route]) return;
  const bucket = latencyBuckets[route];
  if (bucket.length >= MAX_LATENCY_SAMPLES) bucket.shift();
  bucket.push(ms);
}

function computePercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── 응답 헬퍼 ─────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) reject(new Error('Too Large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── IP 기반 지역 감지 ────────────────────────────────────────────────────
function detectRegionByIP(ip) {
  // 개발 환경에서는 서울 기본값
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return { code: '11', name: '서울특별시', short: '서울', detected_by: 'default' };
  }
  // 프로덕션에서는 외부 GeoIP 서비스 연동 가능
  return { code: '11', name: '서울특별시', short: '서울', detected_by: 'default' };
}

// ── AI 파이프라인 (지연 로드) ─────────────────────────────────────────────
let pipeline = null;
function getPipeline() {
  if (!pipeline) pipeline = require('./ai/pipeline');
  return pipeline;
}

// ── 라우터 ────────────────────────────────────────────────────────────────
async function handleAPI(req, res) {
  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const qs      = parsed.query;
  const t0      = Date.now();

  // CORS preflight
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }

  try {
    // ─── GET /api/health ──────────────────────────────────────────────────
    if (pathname === '/api/health' && req.method === 'GET') {
      const pipe = getPipeline();
      const s = await pipe.stats();
      return json(res, {
        status: 'ok',
        service: '2026 지방선거 AI 서비스',
        indexed_docs: s.index_docs,
        indexed_at:   s.indexed_at,
        uptime_s:     Math.floor(process.uptime()),
        ts:           new Date().toISOString(),
      });
    }

    // ─── GET /api/stats ───────────────────────────────────────────────────
    if (pathname === '/api/stats' && req.method === 'GET') {
      const s = await getPipeline().stats();
      const errors = validateCandidateSchema(getCandidates());
      const p95 = {};
      for (const [route, arr] of Object.entries(latencyBuckets)) {
        p95[route] = { p95: computePercentile(arr, 95), p99: computePercentile(arr, 99), samples: arr.length };
      }
      return json(res, {
        ...s,
        schema_errors: errors.length,
        schema_valid:  errors.length === 0,
        latency:       p95,
        events:        { total: eventStore.length, metrics: eventMetrics },
        gate_conditions: {
          field_missing_rate_0pct: errors.length === 0,
          api_latency_p95_le300ms: (p95['/api/query']?.p95 || 0) <= 300,
        },
      });
    }

    // ─── GET /api/regions ─────────────────────────────────────────────────
    if (pathname === '/api/regions' && req.method === 'GET') {
      return json(res, { data: getRegions(), source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' });
    }

    // ─── GET /api/candidates ─────────────────────────────────────────────
    if (pathname === '/api/candidates' && req.method === 'GET') {
      let list = getCandidates();
      if (qs.region_code) list = list.filter(c => c.region_code === qs.region_code);
      if (qs.region)      list = list.filter(c => c.region.includes(qs.region) || c.region_code === qs.region);
      if (qs.party)       list = list.filter(c => c.party === qs.party || c.party_code === qs.party);
      if (qs.q)           list = list.filter(c =>
        c.name.includes(qs.q) || c.region.includes(qs.q) || c.party.includes(qs.q) ||
        c.district.includes(qs.q) || (c.tags || []).some(t => t.includes(qs.q))
      );
      const page  = parseInt(qs.page  || '1', 10);
      const limit = parseInt(qs.limit || '20', 10);
      const start = (page - 1) * limit;
      const paginated = list.slice(start, start + limit);
      recordLatency('/api/candidates', Date.now() - t0);
      return json(res, {
        data:  paginated,
        total: list.length,
        page,  limit,
        source: '중앙선거관리위원회',
        source_url: 'https://www.nec.go.kr',
        data_as_of: new Date().toISOString().split('T')[0],
      });
    }

    // ─── GET /api/candidates/:id ──────────────────────────────────────────
    const candMatch = pathname.match(/^\/api\/candidates\/(.+)$/);
    if (candMatch && req.method === 'GET') {
      const candidate = getCandidates().find(c => c.id === candMatch[1]);
      if (!candidate) return json(res, { error: '후보자를 찾을 수 없습니다.' }, 404);
      return json(res, { data: candidate, source: candidate.source, source_url: candidate.source_url });
    }

    // ─── POST /api/query (RAG AI Q&A) ────────────────────────────────────
    if (pathname === '/api/query' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.question) return json(res, { error: 'question 필드가 필요합니다.' }, 400);

      const result = await getPipeline().query(body.question, {
        region_code: body.region_code,
        party:       body.party,
        top_k:       body.top_k,
      });
      recordLatency('/api/query', Date.now() - t0);
      return json(res, result);
    }

    // ─── POST /api/predict ────────────────────────────────────────────────
    if (pathname === '/api/predict' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.region_code) return json(res, { error: 'region_code 필드가 필요합니다.' }, 400);
      const result = await getPipeline().predict(body.region_code);
      recordLatency('/api/predict', Date.now() - t0);
      return json(res, result);
    }

    // ─── GET /api/insight/:code ───────────────────────────────────────────
    const insightMatch = pathname.match(/^\/api\/insight\/(\d{2})$/);
    if (insightMatch && req.method === 'GET') {
      const result = await getPipeline().insight(insightMatch[1]);
      return json(res, result);
    }

    // ─── GET /api/schedule ────────────────────────────────────────────────
    if (pathname === '/api/schedule' && req.method === 'GET') {
      return json(res, {
        election_name: '제9회 전국동시지방선거',
        election_date: '2026-06-03',
        election_time: '06:00~18:00',
        early_voting:  [{ date: '2026-05-29', time: '06:00~18:00' }, { date: '2026-05-30', time: '06:00~18:00' }],
        voter_roll_inspection: { start: '2026-05-19', end: '2026-05-23' },
        candidate_registration: { start: '2026-05-12', end: '2026-05-13' },
        official_links: [
          { label: '투표소 찾기', url: 'https://www.nec.go.kr/site/nec/sub.do?mncd=020203' },
          { label: '내 선거구 확인', url: 'https://www.nec.go.kr/site/nec/sub.do?mncd=020201' },
          { label: '선거 정보 앱', url: 'https://www.nec.go.kr/site/nec/sub.do?mncd=060201' },
          { label: '공약 비교 (선거정보공개', url: 'https://elecinfo.nec.go.kr/' },
        ],
        source: '중앙선거관리위원회',
        source_url: 'https://www.nec.go.kr',
      });
    }

    // ─── GET /api/geo ─────────────────────────────────────────────────────
    if (pathname === '/api/geo' && req.method === 'GET') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket?.remoteAddress || '127.0.0.1';
      const region = detectRegionByIP(ip);
      return json(res, { ip, ...region, source: 'IP Geolocation' });
    }

    // ─── POST /api/events ─────────────────────────────────────────────────
    if (pathname === '/api/events' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.event_name || !body.session_id) {
        return json(res, { error: 'event_name, session_id 필수' }, 400);
      }
      const stored = recordEvent({
        event_name: body.event_name,
        session_id: body.session_id,
        user_id:    body.user_id || 'anon',
        timestamp:  body.timestamp || new Date().toISOString(),
        properties: body.properties || {},
      });
      if (!stored) return json(res, { status: 'dedup', message: '중복 이벤트 제거됨' });
      return json(res, { status: 'ok', dedup_key: stored.dedup_key });
    }

    // ─── GET /api/metrics (Admin) ─────────────────────────────────────────
    if (pathname === '/api/metrics' && req.method === 'GET') {
      const sessionIds = [...new Set(eventStore.map(e => e.session_id))];
      const aiQueryUsers = new Map();
      const comparerIds  = new Set();

      eventStore.forEach(e => {
        if (e.event_name === 'ai_query') aiQueryUsers.set(e.session_id, (aiQueryUsers.get(e.session_id) || 0) + 1);
        if (e.event_name === 'candidate_compare') comparerIds.add(e.session_id);
      });

      const multiQueryUsers = [...aiQueryUsers.values()].filter(v => v >= 3).length;
      const total = sessionIds.length || 1;

      return json(res, {
        gate_conditions: {
          field_missing_rate:   validateCandidateSchema(getCandidates()).length === 0,
          latency_p95_le300ms:  computePercentile(latencyBuckets['/api/query'], 95) <= 300 || latencyBuckets['/api/query'].length === 0,
        },
        service_metrics: {
          total_sessions:         total,
          predict_submit_rate:    eventMetrics.predict_submit / total,
          ai_3plus_query_rate:    multiQueryUsers / total,
          candidate_compare_rate: comparerIds.size / total,
        },
        raw_metrics:  eventMetrics,
        total_events: eventStore.length,
        latency:      Object.fromEntries(Object.entries(latencyBuckets).map(([k, v]) => [k, { p95: computePercentile(v, 95), p99: computePercentile(v, 99) }])),
      });
    }

    return json(res, { error: '존재하지 않는 API 경로입니다.' }, 404);

  } catch (e) {
    console.error('[API ERROR]', pathname, e.message);
    return json(res, { error: '서버 내부 오류', message: e.message }, 500);
  }
}

// ── 정적 파일 서빙 ───────────────────────────────────────────────────────
function serveStatic(req, res) {
  let urlPath = url.parse(req.url).pathname;
  // SPA 폴백: /api 이외의 경로는 index.html 반환 (클라이언트 라우팅)
  if (!path.extname(urlPath) || urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not Found'); }
      else { res.writeHead(500); res.end('Server Error'); }
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ── 메인 서버 ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = url.parse(req.url).pathname;
  if (u.startsWith('/api/')) {
    handleAPI(req, res).catch(e => {
      console.error('[UNHANDLED]', e);
      res.writeHead(500); res.end('Internal Server Error');
    });
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, async () => {
  console.log(`[서버] 2026 지방선거 AI 서비스 → http://localhost:${PORT}`);
  console.log(`[서버] 데이터 출처: 중앙선거관리위원회 (www.nec.go.kr)`);

  // 스키마 검증
  const errors = validateCandidateSchema(getCandidates());
  if (errors.length) {
    console.error('[서버] 스키마 오류 발생!', errors);
  } else {
    console.log(`[서버] ✓ 스키마 검증 통과 — ${getCandidates().length}명 후보자`);
  }

  // AI 파이프라인 워밍업 — 백그라운드 실행 (첫 요청을 막지 않음)
  const pipe = getPipeline();
  pipe.reindex()
    .then(async () => {
      const s = await pipe.stats();
      console.log(`[서버] ✓ AI 인덱스 완료 — ${s.index_docs}개 문서`);
      // 자동 갱신 스케줄 (30분)
      pipe.scheduleAutoRefresh();
      console.log('[서버] ✓ 30분 자동 갱신 스케줄 등록');
    })
    .catch(e => console.error('[서버] AI 인덱스 초기화 실패:', e.message));
});

module.exports = server;
