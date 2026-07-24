export interface BrowserSecurityHeaders {
  readonly origin?: string;
  readonly secFetchSite?: string;
}

export function isAllowedBrowserRequest(
  headers: BrowserSecurityHeaders,
  publicOrigin: string,
): boolean {
  if (headers.secFetchSite?.toLowerCase() === 'cross-site') {
    return false;
  }
  return headers.origin === undefined || headers.origin === publicOrigin;
}
