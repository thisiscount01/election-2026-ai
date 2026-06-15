/**
 * 2026 지방선거 AI 서비스 — 디자인 토큰
 * 싱글 소스 오브 트루스. 하드코딩 금지.
 */

export const PARTY = {
  DEMOCRATIC:  { name: '더불어민주당', color: '#004EA2', bg: '#E8F0FB', emoji: '🔵' },
  PPP:         { name: '국민의힘',     color: '#E61E2B', bg: '#FDEAEB', emoji: '🔴' },
  REBUILDING:  { name: '조국혁신당',   color: '#00A651', bg: '#E6F5ED', emoji: '🟢' },
  REFORM:      { name: '개혁신당',     color: '#FF7600', bg: '#FFF0E3', emoji: '🟠' },
  PROGRESSIVE: { name: '진보당',       color: '#F4A300', bg: '#FDF5E3', emoji: '🟡' },
  INDEPENDENT: { name: '무소속',       color: '#6B7280', bg: '#F3F4F6', emoji: '⚪' },
  OTHER:       { name: '기타',         color: '#9CA3AF', bg: '#F9FAFB', emoji: '⚫' },
};

export const CATEGORY = {
  경제: { color: '#0EA5E9', icon: '💼' },
  복지: { color: '#10B981', icon: '🏥' },
  교통: { color: '#8B5CF6', icon: '🚆' },
  환경: { color: '#22C55E', icon: '🌿' },
  주거: { color: '#F59E0B', icon: '🏠' },
  교육: { color: '#3B82F6', icon: '📚' },
  산업: { color: '#6366F1', icon: '🏭' },
  에너지: { color: '#EF4444', icon: '⚡' },
  관광: { color: '#EC4899', icon: '🗺️' },
  농업: { color: '#84CC16', icon: '🌾' },
  안전: { color: '#F97316', icon: '🛡️' },
  행정: { color: '#64748B', icon: '🏛️' },
  바이오: { color: '#14B8A6', icon: '🧬' },
  문화: { color: '#A855F7', icon: '🎨' },
};

export const RESULT = {
  당선: { label: '당선', color: '#16A34A', bg: '#DCFCE7', icon: '✅' },
  낙선: { label: '낙선', color: '#DC2626', bg: '#FEE2E2', icon: '❌' },
};

export const COLOR = {
  // Brand
  BRAND_PRIMARY:  '#1B4FD8',
  BRAND_ACCENT:   '#EF4444',

  // UI
  BG:             '#F8FAFC',
  BG_CARD:        '#FFFFFF',
  BORDER:         '#E2E8F0',
  TEXT_PRIMARY:   '#1E293B',
  TEXT_SECONDARY: '#64748B',
  TEXT_MUTED:     '#94A3B8',

  // Status
  SUCCESS:  '#16A34A',
  WARNING:  '#D97706',
  ERROR:    '#DC2626',
  INFO:     '#2563EB',
};

export const EVENTS = {
  SESSION_START:    'session_start',
  AI_QUERY:         'ai_query',
  PREDICT_SUBMIT:   'predict_submit',
  INSIGHT_RENDER:   'insight_render',
  CANDIDATE_COMPARE:'candidate_compare',
  PAGE_VIEW:        'page_view',
  REGION_SELECT:    'region_select',
};
