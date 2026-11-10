// 데모 페이지에 쌓아 둔 자료(표준 Q&A · 집행원리 · 지침·FAQ · 설정)를 실제 서버 DB로 옮긴다.
// 대화 기록·사용자 계정·감사 로그 같은 시험 운영 기록은 옮기지 않는다.
import type { DB } from '../db.js';
import { isSettingKey, settingProblem, setSetting, getSetting } from '../settings.js';
import { activateQaVersion, addGuidelineDoc, createQaDraft, savePrincipleSet } from './store.js';
import type { ParsedQaItem } from './excel.js';
import type { ParsedPrinciple } from './principles.js';
import { audit } from '../audit.js';

type Row = Record<string, unknown>;

export interface DemoExport {
  format: 'anchor-chatbot-demo-export';
  version: 1;
  exported_at: string;
  qa: { filename: string; items: Row[] } | null;
  principles: { filename: string; items: Row[] } | null;
  guidelines: { name: string; kind: string; filename: string; chunks: Row[] }[];
  settings: Record<string, string>;
}

export interface ImportSummary {
  qa_items: number;
  principles: number;
  guideline_docs: number;
  guideline_chunks: number;
  settings_changed: string[];
  settings_skipped: string[];
  temporary_docs_hidden: number;
}

const str = (v: unknown) => (v == null ? '' : String(v));

/** 데모 상태(JSON) 전체에서 서버로 옮길 부분만 골라 낸다 */
export function exportFromDemoState(state: Row, now = new Date().toISOString()): DemoExport {
  const qaVersions = (state.qaVersions as Row[]) ?? [];
  const activeQa = qaVersions.find((v) => v.status === 'active');
  const qaItems = ((state.qaItems as Row[]) ?? []).filter((i) => activeQa && i.version_id === activeQa.id);

  const sets = (state.principleSets as Row[]) ?? [];
  const activeSet = sets.find((s) => s.status === 'active');
  const principles = ((state.principles as Row[]) ?? []).filter((p) => activeSet && p.set_id === activeSet.id);

  const chunks = (state.guidelineChunks as Row[]) ?? [];
  const guidelines = ((state.guidelineDocs as Row[]) ?? [])
    .filter((d) => Number(d.active) === 1)
    .map((d) => ({
      name: str(d.name),
      kind: str(d.kind),
      filename: str(d.filename),
      chunks: chunks
        .filter((c) => c.doc_id === d.id)
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((c) => ({ clause: str(c.clause), page: c.page ?? null, text: str(c.text) })),
    }));

  const settings: Record<string, string> = {};
  for (const [k, v] of Object.entries((state.settings as Row) ?? {})) if (isSettingKey(k)) settings[k] = str(v);

  return {
    format: 'anchor-chatbot-demo-export',
    version: 1,
    exported_at: now,
    qa: activeQa ? { filename: str(activeQa.filename), items: qaItems } : null,
    principles: activeSet ? { filename: str(activeSet.filename), items: principles } : null,
    guidelines,
    settings,
  };
}

/** 내보낸 파일을 서버 DB에 넣는다. 기존 자료는 지우지 않고 '보관'으로 돌린다(관리자 화면에서 되돌릴 수 있음) */
export function importDemoExport(db: DB, data: DemoExport): ImportSummary {
  if (data?.format !== 'anchor-chatbot-demo-export') throw new Error('데모에서 내보낸 파일이 아닙니다.');
  const summary: ImportSummary = {
    qa_items: 0, principles: 0, guideline_docs: 0, guideline_chunks: 0,
    settings_changed: [], settings_skipped: [], temporary_docs_hidden: 0,
  };

  db.transaction(() => {
    if (data.qa && data.qa.items.length) {
      const items: ParsedQaItem[] = data.qa.items.map((i, n) => ({
        row: n + 2,
        qa_id: str(i.qa_id), category1: str(i.category1), category2: str(i.category2), category3: str(i.category3),
        question: str(i.question), checklist: str(i.checklist), answer: str(i.answer),
        referral_answer: str(i.referral_answer), is_referral: Number(i.is_referral) ? 1 : 0,
        review_status: str(i.review_status), change_history: str(i.change_history),
      }));
      const id = createQaDraft(db, `[데모에서 옮김] ${data.qa.filename}`, null, items, []);
      activateQaVersion(db, id);
      summary.qa_items = items.length;
    }

    if (data.principles && data.principles.items.length) {
      const items: ParsedPrinciple[] = data.principles.items.map((p, n) => ({
        row: n + 2,
        code: str(p.code), category: str(p.category), subcategory: str(p.subcategory), keywords: str(p.keywords),
        text: str(p.text), detail: str(p.detail), caution: str(p.caution), referral: str(p.referral), basis: str(p.basis),
      }));
      savePrincipleSet(db, `[데모에서 옮김] ${data.principles.filename}`, null, items, []);
      summary.principles = items.length;
    }

    if (data.guidelines.length) {
      // 처음 실행 때 자동으로 넣은 [임시] 발췌본은 진짜 지침이 들어오면 숨긴다
      summary.temporary_docs_hidden = db
        .prepare(`UPDATE guideline_docs SET active = 0 WHERE active = 1 AND name LIKE '[임시]%'`)
        .run().changes;
      for (const g of data.guidelines) {
        addGuidelineDoc(
          db,
          { name: g.name, kind: g.kind, filename: g.filename, userId: null },
          g.chunks.map((c) => ({ clause: str(c.clause), page: c.page == null ? null : Number(c.page), text: str(c.text) })),
        );
        summary.guideline_docs += 1;
        summary.guideline_chunks += g.chunks.length;
      }
    }

    for (const [key, value] of Object.entries(data.settings ?? {})) {
      if (!isSettingKey(key) || settingProblem(key, value)) {
        summary.settings_skipped.push(key);
        continue;
      }
      if (getSetting(db, key) === value) continue;
      setSetting(db, key, value, null);
      summary.settings_changed.push(key);
    }

    audit(db, null, '데모 자료 옮겨 오기', data.exported_at,
      `표준 Q&A ${summary.qa_items}개, 집행원리 ${summary.principles}개, 지침·FAQ ${summary.guideline_docs}건, 설정 ${summary.settings_changed.length}개`);
  })();
  return summary;
}
