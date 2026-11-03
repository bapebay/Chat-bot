import type { DB } from './db.js';
import { DEFAULT_DISCLAIMER, DEFAULT_SYSTEM_PROMPT } from './defaults.js';

// 이력을 남기며 관리자 화면에서 고치는 설정
export const EDITABLE_SETTINGS = {
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  disclaimer: DEFAULT_DISCLAIMER,
  // 답변 원칙: 한 줄에 한 항목. 매 질문 시스템 프롬프트에 함께 들어간다
  principles: '',
  // 'true'면 검수상태가 '확정'이 아닌 표준답안도 검색에 쓴다 (1단계 내부 시범용)
  include_unreviewed: 'false',
  // 근거로 인정할 최소 관련도. 키워드: 질문 핵심어가 답안에 들어 있는 비율(0~1), 의미: 문장 유사도(0~1)
  threshold_keyword: '0.5',
  threshold_semantic: '0.83',
  // 모델에 넘기는 검색 결과 수
  top_k_qa: '6',
  top_k_guideline: '3',
  // 하루 질문 상한 (0 = 제한 없음). 사용자 1명당 / 전체
  daily_limit_user: '50',
  daily_limit_total: '3000',
  // 평가 통과 기준: 기대 표준답안 인용 비율(0~1). 잘못된 결론(관리자 표시)은 0건이어야 통과
  eval_pass_hit_rate: '0.8',
  // 비용 추정용 모델 단가 (USD, 100만 토큰당)와 환율. 쓰는 모델에 맞게 관리자가 고친다
  price_input_per_mtok: '0.10',
  price_output_per_mtok: '0.50',
  usd_krw: '1400',
  // 대화 보관 기간(일). 지난 대화는 자동 삭제. 0 = 삭제하지 않음
  retention_days: '0',
} as const;

export type SettingKey = keyof typeof EDITABLE_SETTINGS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(EDITABLE_SETTINGS, key);
}

/** 저장 전 값 검사. 문제가 없으면 null */
export function settingProblem(key: SettingKey, value: string): string | null {
  switch (key) {
    case 'include_unreviewed':
      return value === 'true' || value === 'false' ? null : 'true 또는 false 여야 합니다.';
    case 'threshold_keyword':
    case 'threshold_semantic':
    case 'eval_pass_hit_rate': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? null : '0과 1 사이의 숫자를 입력하세요.';
    }
    case 'top_k_qa':
    case 'top_k_guideline': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 10 ? null : '1~10 사이의 정수를 입력하세요.';
    }
    case 'daily_limit_user':
    case 'daily_limit_total': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 1000000 ? null : '0 이상의 정수를 입력하세요 (0 = 제한 없음).';
    }
    case 'price_input_per_mtok':
    case 'price_output_per_mtok':
    case 'usd_krw': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? null : '0 이상의 숫자를 입력하세요.';
    }
    case 'retention_days': {
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 3650 ? null : '0~3650 사이의 정수를 입력하세요 (0 = 삭제하지 않음).';
    }
    case 'principles':
      return value.length > 30000 ? '내용이 너무 깁니다(30,000자 이내).' : null;
    default:
      if (!value.trim()) return '내용이 비어 있습니다.';
      return value.length > 30000 ? '내용이 너무 깁니다(30,000자 이내).' : null;
  }
}

export function getSetting(db: DB, key: SettingKey): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : EDITABLE_SETTINGS[key];
}

export function getNumberSetting(db: DB, key: SettingKey): number {
  const n = Number(getSetting(db, key));
  return Number.isFinite(n) ? n : Number(EDITABLE_SETTINGS[key]);
}

export function setSetting(db: DB, key: SettingKey, value: string, changedBy: number | null): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value);
    db.prepare('INSERT INTO setting_revisions (key, value, changed_by) VALUES (?, ?, ?)').run(key, value, changedBy);
  })();
}

export function listRevisions(db: DB, key: SettingKey, limit = 30) {
  return db
    .prepare(
      `SELECT r.id, r.value, r.created_at, u.username AS changed_by
       FROM setting_revisions r LEFT JOIN users u ON u.id = r.changed_by
       WHERE r.key = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(key, limit) as { id: number; value: string; created_at: string; changed_by: string | null }[];
}

export function getRevision(db: DB, key: SettingKey, id: number) {
  return db.prepare('SELECT value FROM setting_revisions WHERE key = ? AND id = ?').get(key, id) as
    | { value: string }
    | undefined;
}
