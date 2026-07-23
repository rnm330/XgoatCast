import { config } from 'dotenv';
import { resolve } from 'path';
// Load .env from project root (two levels up from server/src)
config({ path: resolve(__dirname, '..', '..', '.env') });

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const db = app.get(DatabaseService);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false, // reshare 端点内联样式/脚本需要
  }));

  // 解析 application/x-www-form-urlencoded（用于重新发起共享确认表单）
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
      /\/(login|bind)$/.test(path);

    if (isLoginOrBind && req.method === 'POST') {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!checkRateLimit(`auth:${ip}`, res)) {
        return res.status(429).json({ message: '请求过于频繁，请稍后再试' });
      }
    }
    next();
  });

  // ===== CSRF middleware (POST endpoints) =====
  const publicDomain = (process.env.PUBLIC_DOMAIN || '').replace(/\/+$/, '');
  app.use((req: any, res: any, next: any) => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
      return next();
    }
    const path = req.path;

    // Skip CSRF for public share endpoints (already have token guard)
    if (path.startsWith('/api/share/')) {
      return next();
    }

    // Admin endpoints: verify Origin/Referer or require SameSite cookie
    if (path.startsWith('/api/super') || path.startsWith('/api/server')) {
      const origin = req.headers.origin || req.headers.referer || '';
      // Only check if publicDomain is configured (skip in dev with localhost)
      if (publicDomain && !origin.startsWith(publicDomain) && !origin.includes('localhost')) {
        return res.status(403).json({ message: '跨站请求被拒绝' });
      }
    }

    next();
  });

  // ===== Auth middleware =====
  // Protects /api/super/* and /api/server/* endpoints.
  // Public exceptions: /api/super/login, /api/server/:id/login|status|bind
  app.use((req: any, res: any, next: any) => {
    const path = req.path;

    let needsAuth = false;
    if (path.startsWith('/api/super')) {
      needsAuth = path !== '/api/super/login';
    }
    if (path.startsWith('/api/server')) {
      needsAuth = !/\/(login|status|bind)$/.test(path);
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
      const match = path.match(/^\/api\/server\/([^/]+)/);
      if (!match || payload.serverId !== match[1]) {
        return res.status(403).json({ message: '无权访问此服务器' });
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
  await app.listen(port);
  console.log(`xgoatcast server running on http://localhost:${port}`);
}

bootstrap();
