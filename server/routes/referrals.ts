import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth.js';
import { REGIONS } from '../constants.js';
import type { DB } from '../db.js';
import { idParam, str } from './util.js';

export const REFERRAL_TARGETS = ['지역앵커센터', 'e나라도움', '교육부', '대학규정', '담당자'] as const;

export interface ReferralContact {
  id: number;
  target: (typeof REFERRAL_TARGETS)[number];
  region: string | null;
  name: string;
  contact: string;
  note: string;
  sort_order: number;
}

/** 처음 실행할 때 17개 지역앵커센터와 기타 연결 대상 자리를 만들어 둔다 (연락처는 관리자가 입력) */
export function seedReferralContacts(db: DB): void {
  if (db.prepare('SELECT 1 FROM referral_contacts LIMIT 1').get()) return;
  const ins = db.prepare('INSERT INTO referral_contacts (target, region, name, contact, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    REGIONS.filter((r) => r !== '해당없음').forEach((r, i) => ins.run('지역앵커센터', r, `${r} 지역앵커센터`, '', '', i));
    ins.run('e나라도움', null, 'e나라도움 콜센터', '', '', 100);
    ins.run('교육부', null, '교육부 담당 부서', '', '', 101);
    ins.run('대학규정', null, '소속 대학 산학협력단', '', '소속 대학의 사업비 관리 규정을 확인하세요.', 102);
    ins.run('담당자', null, '중앙앵커센터(한국연구재단)', '', '챗봇의 ‘담당자에게 문의’로 남겨 주시면 확인 후 답변드립니다.', 103);
  })();
}

export function referralRoutes(app: FastifyInstance, db: DB) {
  const loggedIn = requireRole(db, 'user');
  const admin = requireRole(db, 'admin');

  // 사용자용: 내 지역 앵커센터 + 공통 연결 대상 (연락처가 입력된 것만)
  app.get('/api/referral-contacts', { preHandler: loggedIn }, async (req) => {
    const region = req.user.region;
    const rows = db.prepare('SELECT * FROM referral_contacts ORDER BY sort_order, id').all() as ReferralContact[];
    return rows.filter(
      (r) =>
        (r.contact.trim() || r.note.trim()) &&
        (r.target !== '지역앵커센터' || region === '해당없음' || r.region === region),
    );
  });

  app.get('/api/admin/referral-contacts', { preHandler: admin }, async () =>
    db.prepare('SELECT * FROM referral_contacts ORDER BY sort_order, id').all(),
  );

  function validate(b: Record<string, unknown>) {
    const target = str(b.target);
    const region = str(b.region) || null;
    const name = str(b.name);
    if (!(REFERRAL_TARGETS as readonly string[]).includes(target)) return { error: '연결 대상을 선택해 주세요.' };
    if (target === '지역앵커센터' && !(region && (REGIONS as readonly string[]).includes(region))) return { error: '지역을 선택해 주세요.' };
    if (!name) return { error: '이름을 입력해 주세요.' };
    return {
      value: {
        target,
        region: target === '지역앵커센터' ? region : null,
        name: name.slice(0, 100),
        contact: str(b.contact).slice(0, 500),
        note: str(b.note).slice(0, 500),
        sort_order: Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 0,
      },
    };
  }

  app.post('/api/admin/referral-contacts', { preHandler: admin }, async (req, reply) => {
    const v = validate((req.body ?? {}) as Record<string, unknown>);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const c = v.value;
    const info = db
      .prepare('INSERT INTO referral_contacts (target, region, name, contact, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.target, c.region, c.name, c.contact, c.note, c.sort_order);
    return db.prepare('SELECT * FROM referral_contacts WHERE id = ?').get(info.lastInsertRowid);
  });

  app.put('/api/admin/referral-contacts/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const v = validate((req.body ?? {}) as Record<string, unknown>);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const c = v.value;
    const info = db
      .prepare('UPDATE referral_contacts SET target = ?, region = ?, name = ?, contact = ?, note = ?, sort_order = ? WHERE id = ?')
      .run(c.target, c.region, c.name, c.contact, c.note, c.sort_order, id);
    if (!info.changes) return reply.code(404).send({ error: '연락처를 찾을 수 없습니다.' });
    return db.prepare('SELECT * FROM referral_contacts WHERE id = ?').get(id);
  });

  app.delete('/api/admin/referral-contacts/:id', { preHandler: admin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id) ?? 0;
    const info = db.prepare('DELETE FROM referral_contacts WHERE id = ?').run(id);
    if (!info.changes) return reply.code(404).send({ error: '연락처를 찾을 수 없습니다.' });
    return { ok: true };
  });
}
