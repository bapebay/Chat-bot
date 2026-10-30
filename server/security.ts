import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import net from 'node:net';

// ================= 보안 헤더 =================

/** 모든 응답에 붙이는 기본 보안 헤더. 화면은 같은 주소의 파일만 불러오므로 CSP를 좁게 잡는다 */
export function securityHeaders(app: FastifyInstance, opts: { hsts: boolean }): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    if (opts.hsts) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
}

// ================= 요청 횟수 제한 =================

export interface RateRule {
  /** 이 규칙에 걸리는 요청인지 */
  match: (req: FastifyRequest) => boolean;
  /** 이름 (같은 IP라도 규칙마다 따로 센다) */
  name: string;
  max: number;
  windowMs: number;
  message: string;
}

/**
 * IP별 요청 횟수 제한 (서버 한 대 기준, 메모리에 센다).
 * 서버를 다시 켜면 숫자가 초기화되지만, 도배·무차별 대입·AI 비용 폭주를 막는 용도로는 충분하다.
 */
export function rateLimit(app: FastifyInstance, rules: RateRule[]): void {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000);
  cleanup.unref();
  app.addHook('onClose', async () => clearInterval(cleanup));

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    for (const rule of rules) {
      if (!rule.match(req)) continue;
      const key = `${rule.name}|${req.ip}`;
      let h = hits.get(key);
      if (!h || h.resetAt <= now) {
        h = { count: 0, resetAt: now + rule.windowMs };
        hits.set(key, h);
      }
      h.count++;
      if (h.count > rule.max) {
        reply.header('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
        return reply.code(429).send({ error: rule.message });
      }
    }
  });
}

const route = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? ''}`;

export const DEFAULT_RATE_RULES: RateRule[] = [
  {
    name: 'login',
    match: (r) => route(r) === 'POST /api/auth/login',
    max: 10,
    windowMs: 60_000,
    message: '로그인 시도가 너무 많습니다. 1분 뒤 다시 시도하세요.',
  },
  {
    name: 'signup',
    match: (r) => route(r) === 'POST /api/auth/signup',
    max: 5,
    windowMs: 3600_000,
    message: '가입 신청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  },
  {
    name: 'question',
    match: (r) => route(r) === 'POST /api/conversations/:id/messages',
    max: 15,
    windowMs: 60_000,
    message: '질문이 너무 빠르게 들어오고 있습니다. 1분 뒤 다시 질문하세요.',
  },
  {
    name: 'inquiry',
    match: (r) => route(r) === 'POST /api/inquiries',
    max: 10,
    windowMs: 3600_000,
    message: '문의 접수가 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  },
  {
    name: 'api',
    match: (r) => r.url.startsWith('/api/'),
    max: 300,
    windowMs: 60_000,
    message: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  },
];

// ================= 관리 메뉴 접근 IP 제한 =================

function ipv4ToInt(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

/** ip가 목록(정확한 IP 또는 IPv4 대역 a.b.c.d/n)에 들어 있는지 */
export function ipAllowed(ip: string, allowed: string[]): boolean {
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const n = ipv4ToInt(plain);
  for (const entry of allowed) {
    const [base, bitsRaw] = entry.split('/');
    if (bitsRaw === undefined) {
      if (base === plain || base === ip) return true;
      continue;
    }
    const b = ipv4ToInt(base);
    const bits = Number(bitsRaw);
    if (n === null || b === null || !(bits >= 0 && bits <= 32)) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (b & mask)) return true;
  }
  return false;
}

const STAFF_PREFIXES = ['/api/admin/', '/api/review/', '/api/manage/'];

/** 관리자·검수자 메뉴(API)는 허용한 IP에서만 열리게 한다. 목록이 비어 있으면 제한하지 않는다 */
export function staffIpGuard(app: FastifyInstance, allowed: string[]): void {
  if (!allowed.length) return;
  app.addHook('onRequest', async (req, reply) => {
    if (!STAFF_PREFIXES.some((p) => req.url.startsWith(p))) return;
    if (ipAllowed(req.ip, allowed)) return;
    return reply.code(403).send({ error: '관리 메뉴는 허용된 곳(기관 네트워크)에서만 쓸 수 있습니다.' });
  });
}
