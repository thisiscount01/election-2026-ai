/**
 * TF-IDF 기반 벡터 스토어
 * 외부 API·GPU 없이 순수 JS로 구현한 한국어 의미 검색 엔진
 *
 * 한국어 처리 전략:
 *   - 음절 bi-gram, tri-gram (형태소 분석기 없이도 유의미한 유사도)
 *   - 어절(공백 기준 단어) 토큰
 *   - 숫자·영문 단어 토큰
 */

'use strict';

// ─── 한국어 + 영어 토크나이저 ────────────────────────────────────────────────
function tokenize(text) {
  if (!text || typeof text !== 'string') return new Map();
  const norm = text.toLowerCase()
    .replace(/[^가-힣ᄀ-ᇿ㄰-㆏a-z0-9\s]/g, ' ');

  const freq = new Map();
  const add = (t) => { if (t) freq.set(t, (freq.get(t) || 0) + 1); };

  // ① 어절 토큰 (길이 2 이상)
  norm.split(/\s+/).forEach(w => { if (w.length >= 2) add(w); });

  // ② 한국어 음절만 추출
  const syllables = [...norm].filter(c => /[가-힣]/.test(c));

  // ③ 음절 bi-gram
  for (let i = 0; i < syllables.length - 1; i++) {
    add(syllables[i] + syllables[i + 1]);
  }

  // ④ 음절 tri-gram (보다 긴 패턴 매칭)
  for (let i = 0; i < syllables.length - 2; i++) {
    add(syllables[i] + syllables[i + 1] + syllables[i + 2]);
  }

  return freq;
}

// ─── BM25-스타일 TF-IDF 벡터 스토어 ─────────────────────────────────────────
class VectorStore {
  constructor() {
    this.docs     = [];    // 인덱싱된 문서 배열
    this.df       = new Map(); // 토큰 → document frequency
    this.N        = 0;     // 총 문서 수
    this.built    = false;
  }

  /**
   * 문서 추가 — build() 호출 전에 모두 추가
   * @param {string} id   - 고유 ID
   * @param {string} text - 전체 텍스트 (검색 대상)
   * @param {object} meta - 원본 데이터 (id·name·region·party·source 등)
   */
  add(id, text, meta = {}) {
    const freq = tokenize(text);
    this.docs.push({ id, text: text.slice(0, 500), meta, freq, tfidf: null, magnitude: 0 });
    // DF 카운트
    freq.forEach((_, t) => this.df.set(t, (this.df.get(t) || 0) + 1));
  }

  /** TF-IDF 인덱스 빌드 — 최초 search() 전 자동 호출 또는 명시적 호출 */
  build() {
    this.N = this.docs.length;
    this.docs.forEach(doc => {
      const total = [...doc.freq.values()].reduce((a, b) => a + b, 0) || 1;
      const tfidf = new Map();
      let mag = 0;
      doc.freq.forEach((cnt, t) => {
        const tf  = cnt / total;
        const idf = Math.log((this.N + 1) / ((this.df.get(t) || 0) + 1)) + 1;
        const v   = tf * idf;
        tfidf.set(t, v);
        mag += v * v;
      });
      doc.tfidf    = tfidf;
      doc.magnitude = Math.sqrt(mag) || 1;
      delete doc.freq; // 메모리 절약
    });
    this.built = true;
    return this;
  }

  /**
   * 코사인 유사도 검색
   * @param {string}   query  - 검색 쿼리
   * @param {number}   topK   - 반환 최대 결과 수
   * @param {Function} filter - doc.meta 기반 필터 함수 (optional)
   * @returns {Array<{id, text, meta, score}>}
   */
  search(query, topK = 5, filter = null) {
    if (!this.built) this.build();

    const qFreq  = tokenize(query);
    const qTotal = [...qFreq.values()].reduce((a, b) => a + b, 0) || 1;

    // 쿼리 TF-IDF 벡터
    const qVec = new Map();
    let qMag = 0;
    qFreq.forEach((cnt, t) => {
      const tf  = cnt / qTotal;
      const idf = Math.log((this.N + 1) / ((this.df.get(t) || 0) + 1)) + 1;
      const v   = tf * idf;
      qVec.set(t, v);
      qMag += v * v;
    });
    qMag = Math.sqrt(qMag) || 1;

    const results = this.docs
      .filter(doc => !filter || filter(doc.meta))
      .map(doc => {
        let dot = 0;
        qVec.forEach((qv, t) => {
          const dv = doc.tfidf.get(t) || 0;
          dot += qv * dv;
        });
        return { id: doc.id, text: doc.text, meta: doc.meta, score: dot / (doc.magnitude * qMag) };
      })
      .filter(r => r.score > 0.005)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return results;
  }

  size() { return this.N; }
}

module.exports = { VectorStore, tokenize };
