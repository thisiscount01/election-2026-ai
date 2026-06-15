/**
 * RAG 파이프라인 — AI 추론 엔드포인트 핵심 모듈
 *
 * 아키텍처: TF-IDF 검색 + 템플릿 기반 응답 생성
 * 외부 LLM API 없이 동작 (오픈소스 임베딩 방식)
 *
 * 응답 스키마 (팀 합의):
 *   { answer, sources[], confidence, disclaimer, indexed_at, below_threshold }
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { VectorStore } = require('./vectorstore');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.08');
const DISCLAIMER    = 'AI 생성 정보입니다. 공식 선거 정보는 중앙선거관리위원회(www.nec.go.kr)에서 반드시 직접 확인하세요.';

// ─── 전역 인덱스 (싱글턴) ──────────────────────────────────────────────────
let store        = null;
let candidates   = [];
let regions      = [];
let indexedAt    = null;
let lastModified = null;

// ─── 자동 갱신 (30분 주기 — Gate Condition: 데이터 신선도) ─────────────────
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function scheduleAutoRefresh() {
  setInterval(async () => {
    try {
      await reindex();
      console.log('[pipeline] 자동 갱신 완료:', new Date().toISOString());
    } catch (e) {
      console.error('[pipeline] 자동 갱신 실패:', e.message);
    }
  }, REFRESH_INTERVAL_MS);
}

// ─── 인덱스 구축 ───────────────────────────────────────────────────────────
async function reindex() {
  const candidatePath = path.join(DATA_DIR, 'candidates.json');
  const regionPath    = path.join(DATA_DIR, 'regions.json');

  const currentMtime = fs.statSync(candidatePath).mtimeMs;
  if (store && currentMtime === lastModified) {
    return; // 변경 없음 — 재색인 스킵
  }

  candidates = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  regions    = JSON.parse(fs.readFileSync(regionPath, 'utf8'));

  const newStore = new VectorStore();

  // ① 후보자 기본 정보 인덱싱
  candidates.forEach(c => {
    const careerText = Array.isArray(c.career) ? c.career.join('. ') : '';
    const text = [
      `후보자 이름: ${c.name}`,
      `선거구: ${c.district}`,
      `지역: ${c.region}`,
      `정당: ${c.party}`,
      `나이: ${c.age}세`,
      `성별: ${c.gender}`,
      `학력: ${c.education}`,
      `경력: ${careerText}`,
      `현직여부: ${c.is_incumbent ? '현직' : '신인'}`,
      `선거결과: ${c.result || '미정'}`,
      c.tags ? `태그: ${c.tags.join(', ')}` : '',
    ].join(' ');

    newStore.add(`cand:${c.id}`, text, {
      type: 'candidate', id: c.id, name: c.name,
      region: c.region, region_code: c.region_code,
      district: c.district, party: c.party,
      result: c.result, source: c.source, source_url: c.source_url,
    });
  });

  // ② 공약 문서 인덱싱 (후보자별 공약 분리 색인)
  candidates.forEach(c => {
    if (!Array.isArray(c.policies)) return;
    c.policies.forEach((policy, idx) => {
      const text = [
        `후보: ${c.name} (${c.party}, ${c.region})`,
        `공약 분야: ${policy.category}`,
        `공약 제목: ${policy.title}`,
        `공약 요약: ${policy.summary}`,
        `공약 상세: ${policy.detail}`,
      ].join(' ');

      newStore.add(`policy:${c.id}:${idx}`, text, {
        type: 'policy',
        candidate_id: c.id, candidate_name: c.name,
        party: c.party, region: c.region,
        district: c.district,
        category: policy.category,
        policy_title: policy.title,
        policy_summary: policy.summary,
        source: c.source, source_url: c.source_url,
      });
    });
  });

  // ③ 지역 정보 인덱싱
  regions.forEach(r => {
    const text = [
      `지역: ${r.name} (${r.short})`,
      `지역 유형: ${r.type}`,
      `선출직: ${r.position_name}`,
      `인구: ${r.population.toLocaleString()}명`,
    ].join(' ');
    newStore.add(`region:${r.code}`, text, {
      type: 'region', code: r.code, name: r.name,
      position_name: r.position_name,
    });
  });

  // ④ 선거 일정·안내 문서
  const scheduleTexts = [
    {
      id: 'schedule:election-day',
      text: '2026 전국동시지방선거 투표일 선거일 날짜는 2026년 6월 3일 수요일입니다. 투표 시간은 오전 6시부터 오후 6시까지입니다. 사전투표는 5월 29일~30일 오전 6시 ~ 오후 6시 실시됩니다.',
      meta: { type: 'schedule', source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' },
    },
    {
      id: 'schedule:register',
      text: '선거인명부 열람 및 이의신청 기간은 2026년 5월 19일~23일입니다. 유권자 등록 선거권자 투표권 확인은 선관위 홈페이지나 선거정보 앱에서 확인하세요.',
      meta: { type: 'schedule', source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' },
    },
    {
      id: 'schedule:polling',
      text: '투표소 위치 찾기는 중앙선거관리위원회 투표소 찾기 서비스에서 확인할 수 있습니다. 주소: https://www.nec.go.kr/site/nec/sub.do?mncd=020203 또는 선거정보 앱을 이용하세요. 신분증 지참 필수입니다.',
      meta: { type: 'schedule', source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr/site/nec/sub.do?mncd=020203' },
    },
    {
      id: 'guide:voting',
      text: '투표 방법 절차 안내: 투표소에 신분증 지참 후 방문. 투표용지 수령 후 기표소 내에서 기표. 투표함에 투표용지 투입. 투표 인증샷은 투표소 내 금지입니다. 투표 후 손가락 도장 찍음.',
      meta: { type: 'guide', source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' },
    },
    {
      id: 'guide:election-type',
      text: '2026 전국동시지방선거 선거 종류: 광역단체장(17명: 시도지사), 기초단체장(226명: 시장군수구청장), 광역의회의원, 기초의회의원, 교육감 선거가 동시에 치러집니다.',
      meta: { type: 'guide', source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' },
    },
  ];
  scheduleTexts.forEach(({ id, text, meta }) => newStore.add(id, text, meta));

  newStore.build();
  store        = newStore;
  lastModified = currentMtime;
  indexedAt    = new Date().toISOString();

  console.log(`[pipeline] 인덱스 구축: ${store.size()}개 문서, 시각=${indexedAt}`);
}

// ─── 쿼리 분류 ─────────────────────────────────────────────────────────────
const INTENT_PATTERNS = {
  candidate_search: [/누구|후보|출마|입후보|경쟁|대결/],
  policy_search:    [/공약|정책|약속|계획|추진|경제|복지|환경|교통|교육|주거|산업|농업|에너지/],
  result_query:     [/결과|당선|낙선|득표|승패|이겼|졌|누가 됐/],
  polling_guide:    [/투표소|투표 방법|어떻게 투표|투표 절차|기표|신분증|투표 시간|투표일|사전투표/],
  schedule_query:   [/일정|언제|날짜|기간|등록|신청|마감|선거일/],
  region_query:     [/지역구|시도|광역|기초|어느 지역|내 지역|우리 지역/],
  comparison:       [/비교|차이|다른|vs|versus|어느 쪽|누가 더/],
};

function detectIntent(query) {
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    if (patterns.some(p => p.test(query))) return intent;
  }
  return 'general';
}

// ─── 지역명 추출 ───────────────────────────────────────────────────────────
function extractRegion(query) {
  const regionNames = regions.map(r => ({ short: r.short, name: r.name, code: r.code }));
  for (const r of regionNames) {
    if (query.includes(r.name) || query.includes(r.short)) return r;
  }
  return null;
}

// ─── 응답 생성 ─────────────────────────────────────────────────────────────
function generateAnswer(intent, query, results, regionInfo) {
  if (results.length === 0) {
    return {
      answer: `죄송합니다. "${query}"에 대한 정보를 찾지 못했습니다. 더 구체적인 지역명이나 정당명을 포함해 질문해 보세요.`,
      answer_parts: [],
    };
  }

  const candResults  = results.filter(r => r.meta.type === 'candidate');
  const policyResults = results.filter(r => r.meta.type === 'policy');
  const guideResults  = results.filter(r => ['schedule', 'guide'].includes(r.meta.type));

  switch (intent) {
    case 'candidate_search': {
      if (candResults.length === 0 && policyResults.length > 0) {
        // 정책 결과에서 후보 추출
        const names = [...new Set(policyResults.map(r => `${r.meta.candidate_name}(${r.meta.party})`))]
          .slice(0, 3);
        return {
          answer: `검색 결과에서 관련 후보자로 ${names.join(', ')}를 찾았습니다.`,
          answer_parts: policyResults.slice(0, 3).map(r => ({
            label: `${r.meta.candidate_name} — ${r.meta.district}`,
            content: `${r.meta.party} | ${r.meta.policy_title}: ${r.meta.policy_summary}`,
          })),
        };
      }
      const candidateList = candResults.slice(0, 4).map(r => {
        const c = candidates.find(x => x.id === r.meta.id);
        const resultStr = c?.result ? ` [${c.result}]` : '';
        return `• **${r.meta.name}** (${r.meta.party})${resultStr} — ${r.meta.district}`;
      });
      const regionStr = regionInfo ? ` ${regionInfo.name}` : '';
      return {
        answer: `${regionStr} 후보자 정보입니다:\n\n${candidateList.join('\n')}`,
        answer_parts: candResults.slice(0, 4).map(r => {
          const c = candidates.find(x => x.id === r.meta.id);
          return {
            label: `${r.meta.name} (${r.meta.party})`,
            content: `선거구: ${r.meta.district} | 결과: ${c?.result || '집계중'} | 득표율: ${c?.vote_rate || '-'}%`,
            candidate_id: r.meta.id,
          };
        }),
      };
    }

    case 'policy_search': {
      const policyList = policyResults.slice(0, 5).map(r =>
        `• **${r.meta.candidate_name}** (${r.meta.party}, ${r.meta.region}) [${r.meta.category}]\n  ${r.meta.policy_title}: ${r.meta.policy_summary}`
      );
      return {
        answer: `관련 공약 정보입니다:\n\n${policyList.join('\n\n')}`,
        answer_parts: policyResults.slice(0, 5).map(r => ({
          label: `${r.meta.candidate_name} (${r.meta.party}) — ${r.meta.category}`,
          content: `${r.meta.policy_title}: ${r.meta.policy_summary}`,
          candidate_id: r.meta.candidate_id,
        })),
      };
    }

    case 'result_query': {
      const won  = candidates.filter(c => c.result === '당선');
      const regionFilter = regionInfo ? won.filter(c => c.region_code === regionInfo.code) : won.slice(0, 6);
      if (regionFilter.length === 0) {
        return { answer: `선거 결과 정보를 찾지 못했습니다. 구체적인 지역명을 포함해 질문해 주세요.`, answer_parts: [] };
      }
      const resultList = regionFilter.map(c =>
        `• **${c.district}**: ${c.name} (${c.party}) 당선 — 득표율 ${c.vote_rate}%`
      );
      return {
        answer: `2026 지방선거 당선자 현황:\n\n${resultList.join('\n')}`,
        answer_parts: regionFilter.map(c => ({
          label: c.district,
          content: `당선: ${c.name} (${c.party}) | 득표율: ${c.vote_rate}%`,
          candidate_id: c.id,
        })),
      };
    }

    case 'polling_guide':
    case 'schedule_query': {
      const guide = guideResults[0];
      return {
        answer: guide ? guide.text : '투표소 및 선거 일정은 중앙선거관리위원회 홈페이지(www.nec.go.kr)에서 확인하세요.',
        answer_parts: guideResults.slice(0, 2).map(r => ({
          label: r.meta.type === 'schedule' ? '선거 일정' : '투표 안내',
          content: r.text,
          source_url: r.meta.source_url,
        })),
      };
    }

    case 'comparison': {
      const compared = candResults.slice(0, 2);
      if (compared.length < 2) {
        return { answer: `비교할 후보자 2명을 특정해 주세요. 예: "${regionInfo?.name || '서울'} 후보자 비교"`, answer_parts: [] };
      }
      const [a, b] = compared.map(r => candidates.find(c => c.id === r.meta.id)).filter(Boolean);
      if (!a || !b) return { answer: '비교 정보를 불러오지 못했습니다.', answer_parts: [] };
      return {
        answer: `**${a.name}** (${a.party}) vs **${b.name}** (${b.party}) 비교:\n\n• ${a.name}: ${a.district} / 결과: ${a.result || '미정'} / 득표율: ${a.vote_rate || '-'}%\n• ${b.name}: ${b.district} / 결과: ${b.result || '미정'} / 득표율: ${b.vote_rate || '-'}%`,
        answer_parts: [a, b].map(c => ({
          label: `${c.name} (${c.party})`,
          content: `${c.district} | ${c.result || '집계중'} | 득표율 ${c.vote_rate || '-'}%`,
          candidate_id: c.id,
        })),
      };
    }

    default: {
      const top = results[0];
      return {
        answer: top.text.length > 200 ? top.text.slice(0, 200) + '…' : top.text,
        answer_parts: results.slice(0, 3).map(r => ({
          label: r.meta.name || r.meta.policy_title || r.meta.type || '',
          content: r.text.slice(0, 150),
        })),
      };
    }
  }
}

// ─── 신뢰도 계산 ───────────────────────────────────────────────────────────
function computeConfidence(results) {
  if (!results.length) return 0;
  const topScore = results[0].score;
  // 0~1 스케일로 정규화 (TF-IDF 코사인 유사도는 보통 0.05~0.5 범위)
  return Math.min(topScore / 0.4, 1.0);
}

// ─── 출처 포맷팅 ───────────────────────────────────────────────────────────
function formatSources(results) {
  const seen = new Set();
  return results
    .filter(r => r.meta.source)
    .map(r => ({
      label:      r.meta.name || r.meta.candidate_name || r.meta.type || '출처',
      source:     r.meta.source || '중앙선거관리위원회',
      source_url: r.meta.source_url || 'https://www.nec.go.kr',
      type:       r.meta.type,
      relevance:  Math.round(r.score * 100) / 100,
    }))
    .filter(s => {
      const key = s.source + s.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

// ─── 공개 API ──────────────────────────────────────────────────────────────

/**
 * AI Q&A 쿼리
 * @param {string} question
 * @param {object} opts - { region_code, party, top_k }
 */
async function query(question, opts = {}) {
  if (!store) await reindex();

  const startMs = Date.now();
  const intent  = detectIntent(question);
  const regionInfo = extractRegion(question) || (opts.region_code
    ? regions.find(r => r.code === opts.region_code)
    : null);

  // 지역 필터
  const filter = regionInfo
    ? (meta) => {
        if (meta.type === 'region') return meta.code === regionInfo.code;
        if (meta.region_code) return meta.region_code === regionInfo.code;
        if (meta.region) return meta.region.includes(regionInfo.short) || meta.region === regionInfo.name;
        return true; // guide/schedule는 항상 포함
      }
    : null;

  const topK   = opts.top_k || 8;
  const results = store.search(question, topK, filter);

  const { answer, answer_parts } = generateAnswer(intent, question, results, regionInfo);
  const confidence   = computeConfidence(results);
  const sources      = formatSources(results);
  const belowThresh  = confidence < CONFIDENCE_THRESHOLD;
  const latencyMs    = Date.now() - startMs;

  return {
    answer,
    answer_parts,
    sources,
    confidence:       Math.round(confidence * 1000) / 1000,
    below_threshold:  belowThresh,
    intent,
    region_detected:  regionInfo?.name || null,
    disclaimer:       DISCLAIMER,
    indexed_at:       indexedAt,
    latency_ms:       latencyMs,
  };
}

/**
 * 예측 분석 — 지역 후보 정보 + 정당 분포 요약
 * @param {string} regionCode
 */
async function predict(regionCode) {
  if (!store) await reindex();

  const startMs = Date.now();
  const region  = regions.find(r => r.code === regionCode);
  if (!region) {
    return { error: '알 수 없는 지역 코드', region_code: regionCode };
  }

  const regionCandidates = candidates.filter(c => c.region_code === regionCode);
  const winner    = regionCandidates.find(c => c.result === '당선');
  const runners   = regionCandidates.filter(c => c.result !== '당선');

  const partyDist = {};
  regionCandidates.forEach(c => {
    partyDist[c.party] = (partyDist[c.party] || 0) + c.vote_rate;
  });

  // 주요 공약 요약 (상위 3개)
  const topPolicies = winner
    ? (winner.policies || []).slice(0, 3).map(p => ({ category: p.category, title: p.title, summary: p.summary }))
    : [];

  return {
    region:         region.name,
    position:       region.position_name,
    winner:         winner ? {
      name:       winner.name,
      party:      winner.party,
      vote_rate:  winner.vote_rate,
      top_policies: topPolicies,
    } : null,
    runners:        runners.map(c => ({
      name: c.name, party: c.party, vote_rate: c.vote_rate || null,
    })),
    party_distribution: partyDist,
    candidate_count: regionCandidates.length,
    sources:        [{ source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' }],
    disclaimer:     DISCLAIMER,
    indexed_at:     indexedAt,
    latency_ms:     Date.now() - startMs,
  };
}

/** 개인화 인사이트 (랜딩~90초 내 표시 — Gate Condition) */
async function insight(regionCode) {
  if (!store) await reindex();
  const pred = await predict(regionCode);
  const region = regions.find(r => r.code === regionCode);

  const regionCands = candidates.filter(c => c.region_code === regionCode);
  const topPolicy = regionCands.flatMap(c =>
    (c.policies || []).map(p => ({ ...p, candidate: c.name, party: c.party }))
  ).slice(0, 3);

  return {
    region:        region?.name,
    winner:        pred.winner,
    key_policies:  topPolicy,
    sources:       [{ source: '중앙선거관리위원회', source_url: 'https://www.nec.go.kr' }],
    disclaimer:    DISCLAIMER,
    indexed_at:    indexedAt,
  };
}

/** 전체 통계 */
async function stats() {
  if (!store) await reindex();
  const total      = candidates.length;
  const won        = candidates.filter(c => c.result === '당선').length;
  const byParty    = {};
  candidates.forEach(c => { byParty[c.party] = (byParty[c.party] || 0) + 1; });
  const wonByParty = {};
  candidates.filter(c => c.result === '당선').forEach(c => {
    wonByParty[c.party] = (wonByParty[c.party] || 0) + 1;
  });
  return {
    total_candidates: total,
    total_winners:    won,
    by_party:         byParty,
    won_by_party:     wonByParty,
    regions_count:    regions.length,
    index_docs:       store.size(),
    indexed_at:       indexedAt,
  };
}

module.exports = { reindex, query, predict, insight, stats, scheduleAutoRefresh };
