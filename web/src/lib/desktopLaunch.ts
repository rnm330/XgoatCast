export function buildDesktopLaunch(options: {
  server: string; token: string; clientId: string; launchId?: string;
}): string {
  const params = new URLSearchParams({
    server: options.server, t: options.token, cid: options.clientId,
  });
  if (options.launchId) params.set('launchId', options.launchId);
  return `xgoatcast://share?${params}`;
}

export const CLIENT_RELEASE_PAGE = '/downloads.html';
