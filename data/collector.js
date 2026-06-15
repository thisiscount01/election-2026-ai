/**
 * 2026 지방선거 공공데이터 수집 스크립트
 * 선관위 Open API (data.go.kr) 연동 + CSV 백업 채널
 *
 * 사용법:
 *   node data/collector.js
 *   SERVICE_KEY=<발급받은키> node data/collector.js
 *
 * API 출처:
 *   - 중앙선거관리위원회 선거통계시스템: https://www.nec.go.kr
 *   - 공공데이터포털: https://www.data.go.kr/data/15013116/openapi.do
 *   - 선거정보공개시스템 API: http://apis.data.go.kr/9760000/
 */

'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR     = path.join(__dirname);
const SERVICE_KEY  = process.env.SERVICE_KEY || '';
const API_BASE     = 'http://apis.data.go.kr/9760000';
const ELECTION_ID  = '20260603'; // 2026 전국동시지방선거

// ── 결측 허용 임계값 (20% 초과 시 필드 제외) ───────────────────────────────
const MISSING_THRESHOLD = 0.2;

/** HTTP GET → Promise<string> */
function get(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/** 선관위 API — 후보자 목록 수집 */
async function fetchCandidates(sdName = '') {
  if (!SERVICE_KEY) {
    console.warn('[collector] SERVICE_KEY 없음 → 샘플 데이터 사용 (실 API 연동 시 SERVICE_KEY 환경변수 설정)');
    return null;
  }
  const url = `${API_BASE}/CommonCandService/getCandidateInfoInqireService`
    + `?serviceKey=${encodeURIComponent(SERVICE_KEY)}`
    + `&electionId=${ELECTION_ID}`
    + `&sdName=${encodeURIComponent(sdName)}`
    + `&numOfRows=100&pageNo=1&_type=json`;
  try {
    const raw = await get(url);
    const json = JSON.parse(raw);
    if (json?.response?.header?.resultCode !== '00') {
      throw new Error(`API 오류: ${json?.response?.header?.resultMsg}`);
    }
    return json.response.body.items.item;
  } catch (e) {
    console.error('[collector] API 호출 실패:', e.message);
    return null;
  }
}

/** API 응답 → 표준 스키마 정규화 */
function normalizeCandidate(raw, regionCode) {
  const candidate = {
    id:         `API-${raw.candidateNo || raw.sggName || 'unknown'}`,
    number:     parseInt(raw.candidateNo, 10) || 0,
    name:       raw.candidateName || '',
    district:   raw.sggName || '',
    district_type: raw.electionType || '광역단체장',
    region:     raw.sdName || '',
    region_code: regionCode || '',
    party:      raw.partyName || '무소속',
    party_code: partyToCode(raw.partyName),
    age:        parseInt(raw.age, 10) || null,
    gender:     raw.gender || '',
    education:  raw.education || '',
    career:     raw.career ? raw.career.split(',').map(s => s.trim()) : [],
    policies:   [],
    is_incumbent: raw.incumbentYn === 'Y',
    result:     null,
    source:     '중앙선거관리위원회',
    source_url: 'https://www.nec.go.kr',
    registered_at: raw.registDate || '',
    updated_at: new Date().toISOString().split('T')[0],
    tags:       [raw.sdName, raw.partyName].filter(Boolean),
  };

  // 결측률 체크
  const requiredFields = ['name', 'district', 'region', 'party'];
  const missingCount = requiredFields.filter(f => !candidate[f]).length;
  if (missingCount / requiredFields.length > MISSING_THRESHOLD) {
    console.warn(`[collector] 결측률 초과 후보 제외: ${raw.candidateName}`);
    return null;
  }
  return candidate;
}

/** 정당명 → 내부 코드 */
function partyToCode(partyName = '') {
  const map = {
    '더불어민주당': 'DEMOCRATIC',
    '국민의힘':     'PPP',
    '조국혁신당':   'REBUILDING',
    '개혁신당':     'REFORM',
    '진보당':       'PROGRESSIVE',
    '무소속':       'INDEPENDENT',
  };
  return map[partyName] || 'OTHER';
}

/** 스키마 검증 — Gate Condition: 필수 필드 누락률 0% */
function validateSchema(candidates) {
  const REQUIRED = ['id', 'name', 'district', 'region', 'region_code', 'party'];
  const errors = [];
  candidates.forEach((c, i) => {
    REQUIRED.forEach(field => {
      if (!c[field]) errors.push(`[${i}] ${c.name || '?'}: 필드 누락 — ${field}`);
    });
    if (!Array.isArray(c.policies)) {
      errors.push(`[${i}] ${c.name}: policies 배열 형식 오류`);
    }
  });
  if (errors.length > 0) {
    console.error('[validator] 스키마 오류:');
    errors.forEach(e => console.error(' ', e));
    return false;
  }
  console.log(`[validator] ✓ ${candidates.length}명 전원 스키마 통과`);
  return true;
}

/** 메인 수집 파이프라인 */
async function collect() {
  console.log('[collector] 2026 지방선거 데이터 수집 시작');
  console.log(`[collector] 출처: 중앙선거관리위원회 Open API + 공공데이터포털`);
  console.log(`[collector] API 키: ${SERVICE_KEY ? '설정됨' : '미설정 (샘플 모드)'}`);

  let candidates;

  if (SERVICE_KEY) {
    // 실 API 수집
    const regions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'regions.json'), 'utf8'));
    const results = [];
    for (const region of regions) {
      console.log(`[collector] ${region.name} 후보자 수집 중...`);
      const raw = await fetchCandidates(region.name);
      if (raw) {
        const normalized = raw.map(r => normalizeCandidate(r, region.code)).filter(Boolean);
        results.push(...normalized);
      }
      await new Promise(r => setTimeout(r, 100)); // API Rate limit
    }
    candidates = results;
  } else {
    // 샘플 데이터 사용
    console.log('[collector] 샘플 데이터 로드 (data/candidates.json)');
    candidates = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'candidates.json'), 'utf8'));
  }

  // 스키마 검증
  const isValid = validateSchema(candidates);
  if (!isValid) {
    console.error('[collector] 검증 실패 — 배포 불가');
    process.exit(1);
  }

  // 결과 저장
  const outPath = path.join(DATA_DIR, 'candidates.json');
  fs.writeFileSync(outPath, JSON.stringify(candidates, null, 2), 'utf8');
  console.log(`[collector] ✓ ${candidates.length}명 저장 → ${outPath}`);
  console.log(`[collector] 데이터 갱신 시각: ${new Date().toISOString()}`);
  console.log('[collector] 수집 완료');
}

// 직접 실행 시
if (require.main === module) {
  collect().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { collect, validateSchema, normalizeCandidate };
