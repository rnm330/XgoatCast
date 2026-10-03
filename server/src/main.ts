import { config } from 'dotenv';
import { resolve } from 'path';
// Load .env from project root (two levels up from server/src)
config({ path: process.env.XGOAT_ENV_FILE || resolve(__dirname, '..', '..', '.env') });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { createHmac } from 'crypto';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { DatabaseService } from './modules/database/database.service';

const SUPER_SECRET = process.env.SUPER_ADMIN_PASSWORD;
if (!SUPER_SECRET) {
  console.error('FATAL: SUPER_ADMIN_PASSWORD environment variable is required');
  process.exit(1);
}

// ===== 简易内存速率限制器 =====
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 分钟窗口
const RATE_LIMIT_MAX = 10; // 每窗口最大请求数

function checkRateLimit(key: string, res: any): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count++;
  return true;
}

// 定期清理过期条目
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) {
    if (now > v.resetAt) rateLimitMap.delete(k);
  }
}, 60_000);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const db = app.get(DatabaseService);
  // Configure only trusted reverse-proxy addresses; never trust arbitrary forwarded IPs.
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(value => value.trim()));

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false, // reshare 端点内联样式/脚本需要
  }));

  // KOOK Webhook 必须保留原始请求体，且要先于全局 JSON parser 注册。
  // body-parser 会按 Content-Encoding 解压；Codec 另外兼容没有 Header 的 zlib 数据。
  app.use(
    '/api/integrations/kook/webhook',
    bodyParser.raw({ type: () => true, limit: '1mb', inflate: true }),
  );

  // 解析 application/x-www-form-urlencoded（用于重新发起共享确认表单）
  app.use('/api/integrations/qq/webhook', bodyParser.raw({ type: () => true, limit: '1mb', inflate: false }));
  app.use(bodyParser.urlencoded({ extended: false, limit: '1mb' }));
  // 显式限制 JSON 请求体大小
  app.use(bodyParser.json({ limit: '1mb' }));

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:5173', 'http://localhost:3520'];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  // ===== Rate limit middleware (login/bind endpoints) =====
  app.use((req: any, res: any, next: any) => {
    const path = req.path;
    const isLoginOrBind =
      path === '/api/super/login' ||
      /\/(login|bind)$/.test(path) ||
      /^\/api\/spaces\/heychat\/[^/]+\/binding\/[^/]+\/claim$/.test(path) ||
      /^\/api\/spaces\/qq\/[^/]+\/binding\/[^/]+\/claim$/.test(path);

    if (isLoginOrBind && req.method === 'POST') {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!checkRateLimit(`auth:${ip}`, res)) {
        return res.status(429).json({ message: '请求过于频繁，请稍后再试' });
      }
    }
    next();
  });

  // ===== Auth middleware =====
  // Protects /api/super/*, legacy /api/server/* and canonical /api/spaces/* endpoints.
  // Public exceptions: login/status/bind for a specific platform space.
  app.use((req: any, res: any, next: any) => {
    const path = req.path;
    if (path.startsWith('/api/panels/') || path.startsWith('/api/share/')) res.setHeader('Cache-Control', 'no-store');

    let needsAuth = false;
    if (path.startsWith('/api/super')) {
      needsAuth = path !== '/api/super/login';
    }
    if (path.startsWith('/api/server')) {
      needsAuth = !/\/(login|status|bind)$/.test(path);
    }
    if (path.startsWith('/api/spaces')) {
      const publicDeviceBinding =
        /^\/api\/spaces\/heychat\/[^/]+\/binding\/[^/]+\/(status|claim|poll|bind)$/.test(path) ||
        /^\/api\/spaces\/qq\/[^/]+\/binding\/[^/]+\/(status|claim|poll|bind)$/.test(path);
      needsAuth = !publicDeviceBinding && !/\/(login|status|bind)$/.test(path);
    }

    if (!needsAuth) return next();

    const authHeader: string = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    const parts = token.split('.');
    if (parts.length !== 2) {
      return res.status(401).json({ message: '未登录' });
    }

    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
    } catch {
      return res.status(401).json({ message: '登录已过期，请重新登录' });
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return res.status(401).json({ message: '登录已过期，请重新登录' });
    }

    // Per-role HMAC key isolation
    let hmacKey: string;
    if (payload.role === 'super_admin') {
      hmacKey = SUPER_SECRET;
    } else if (payload.role === 'server_admin') {
      // Use per-server secret from DB
      const server = db.getServer(payload.serverId);
      if (!server) {
        return res.status(401).json({ message: '服务器不存在' });
      }
      hmacKey = (server as any).serverSecret || SUPER_SECRET; // fallback to legacy shared secret
    } else if (payload.role === 'space_admin') {
      const server = db.getSpace(payload.platform, payload.externalId);
      if (!server || server.serverId !== payload.spaceId) {
        return res.status(401).json({ message: '平台空间不存在' });
      }
      if (server.status !== 'active' || !server.bound) {
        return res.status(401).json({ message: '平台空间当前不可管理' });
      }
      hmacKey = server.serverSecret || SUPER_SECRET;
    } else {
      return res.status(401).json({ message: '无效的登录凭证' });
    }

    const sig = createHmac('sha256', hmacKey).update(parts[0]).digest('base64url');
    if (sig !== parts[1]) {
      return res.status(401).json({ message: '登录已过期，请重新登录' });
    }

    // Cross-role check: super_admin token only for /api/super, server_admin token must match serverId
    if (payload.role === 'super_admin') {
      if (!path.startsWith('/api/super')) {
        return res.status(403).json({ message: '无权访问' });
      }
    } else if (payload.role === 'server_admin') {
      const legacyMatch = path.match(/^\/api\/server\/([^/]+)/);
      const spaceMatch = path.match(/^\/api\/spaces\/([^/]+)\/([^/]+)/);
      const legacyAllowed = legacyMatch && payload.serverId === legacyMatch[1];
      const space = spaceMatch ? db.getSpace(spaceMatch[1], spaceMatch[2]) : undefined;
      const canonicalAllowed = !!space && payload.serverId === space.serverId;
      if (!legacyAllowed && !canonicalAllowed) {
        return res.status(403).json({ message: '无权访问此服务器' });
      }
    } else if (payload.role === 'space_admin') {
      const legacyMatch = path.match(/^\/api\/server\/([^/]+)/);
      const spaceMatch = path.match(/^\/api\/spaces\/([^/]+)\/([^/]+)/);
      const legacyAllowed =
        payload.platform === 'kook' &&
        legacyMatch &&
        payload.externalId === legacyMatch[1];
      const canonicalAllowed =
        spaceMatch &&
        payload.platform === spaceMatch[1] &&
        payload.externalId === spaceMatch[2];
      if (!legacyAllowed && !canonicalAllowed) {
        return res.status(403).json({ message: '无权访问此平台空间' });
      }
    }

    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // 生产环境静态托管前端构建产物
  const webDist = join(__dirname, '..', '..', 'web', 'dist');
  app.use('/downloads/windows/latest.json', (_req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useStaticAssets(webDist, {
    index: false,
  });

  // SPA fallback：非 API、非静态文件的 GET/HEAD 请求返回 index.html
  app.use((req: any, res: any, next: any) => {
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.path.startsWith('/api') &&
      !/\.[a-zA-Z0-9]+$/.test(req.path)
    ) {
      return res.sendFile(join(webDist, 'index.html'));
    }
    next();
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3520;
  await app.listen(port, process.env.HOST || '0.0.0.0');
  console.log(`xgoatcast server running on http://localhost:${port}`);
}

bootstrap();
