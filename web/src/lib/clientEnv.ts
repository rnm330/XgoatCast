import type { ClientEnvironment, ClientDeviceType } from '../types/analytics';

const UNKNOWN = 'Unknown';

function firstMajor(userAgent: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function detectDevice(userAgent: string): ClientDeviceType {
  const isIPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;
  if (isIPadDesktopMode || /iPad|Tablet|PlayBook|Silk/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.+Mobile/i.test(userAgent)) return 'mobile';
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(userAgent)) return 'desktop';
  return 'unknown';
}

function detectOs(userAgent: string): string {
  if (/iPad|iPhone|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)) {
    return 'iOS';
  }
  if (/Android/i.test(userAgent)) return 'Android';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/CrOS/i.test(userAgent)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macOS';
  if (/Linux|X11/i.test(userAgent)) return 'Linux';
  return UNKNOWN;
}

function detectBrowser(userAgent: string): Pick<ClientEnvironment, 'browserName' | 'browserMajor'> {
  const candidates: Array<{ name: string; patterns: RegExp[] }> = [
    { name: 'Edge', patterns: [/EdgA?\/(\d+)/i, /EdgiOS\/(\d+)/i] },
    { name: 'Opera', patterns: [/OPR\/(\d+)/i, /Opera Mini\/(\d+)/i] },
    { name: 'Samsung Internet', patterns: [/SamsungBrowser\/(\d+)/i] },
    { name: 'Firefox', patterns: [/Firefox\/(\d+)/i, /FxiOS\/(\d+)/i] },
    { name: 'Chrome', patterns: [/Chrome\/(\d+)/i, /CriOS\/(\d+)/i] },
    { name: 'Safari', patterns: [/Version\/(\d+).*Safari/i] },
  ];

  for (const candidate of candidates) {
    const major = firstMajor(userAgent, candidate.patterns);
    if (major) return { browserName: candidate.name, browserMajor: major };
  }
  return { browserName: UNKNOWN, browserMajor: '' };
}

/**
 * Returns only coarse browser capabilities. Raw UA, exact device model, IP and
 * stable device identifiers are never returned or persisted.
 */
export function getClientEnvironment(): ClientEnvironment {
  if (typeof navigator === 'undefined') {
    return {
      deviceType: 'unknown',
      osName: UNKNOWN,
      browserName: UNKNOWN,
      browserMajor: '',
    };
  }

  const userAgent = navigator.userAgent || '';
  return {
    deviceType: detectDevice(userAgent),
    osName: detectOs(userAgent),
    ...detectBrowser(userAgent),
  };
}

export function markPageOpenOnce(token: string, pageType: 'share' | 'view'): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  const key = `xgoatcast_page_open:${pageType}:${token}`;
  if (sessionStorage.getItem(key)) return false;
  sessionStorage.setItem(key, '1');
  return true;
}

const ADMIN_PRESENCE_KEY = 'xgoatcast_admin_presence_v1';
const ADMIN_PRESENCE_TTL_MS = 2 * 60 * 1000;

/** Temporary cross-tab id used only to deduplicate the two-minute online window. */
export function getTemporaryAdminBrowserSessionId(): string {
  const now = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem(ADMIN_PRESENCE_KEY) || 'null');
    if (stored?.id && typeof stored.id === 'string' && Number(stored.expiresAt) > now) {
      localStorage.setItem(ADMIN_PRESENCE_KEY, JSON.stringify({
        id: stored.id,
        expiresAt: now + ADMIN_PRESENCE_TTL_MS,
      }));
      return stored.id;
    }
  } catch {
    // Replace malformed or unavailable storage values below.
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(ADMIN_PRESENCE_KEY, JSON.stringify({
      id,
      expiresAt: now + ADMIN_PRESENCE_TTL_MS,
    }));
  } catch {
    // The in-memory id still works when storage is unavailable.
  }
  return id;
}

export function sanitizeShareFailureReason(error: unknown): string {
  const value = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '';
  const message = value.toLowerCase();

  if (message.includes('permission') || message.includes('notallowed') || message.includes('拒绝')) {
    return 'capture_permission_denied';
  }
  if (message.includes('https') || message.includes('secure context')) return 'insecure_context';
  if (message.includes('audio') || message.includes('声音')) return 'screen_audio_unavailable';
  if (message.includes('sdk') || message.includes('agorartc')) return 'rtc_sdk_unavailable';
  if (message.includes('ended') || message.includes('失效')) return 'session_ended';
  if (message.includes('network') || message.includes('timeout') || message.includes('网络')) return 'network_error';
  return 'publish_failed';
}
