import { notificationText } from '@craftingtable/domain';
export interface NotificationMessage {
  applicationToken: string;
  userKey: string;
  device: string;
  title: string;
  message: string;
  url: string;
}
export type DeliveryResult =
  | { status: 'accepted' }
  | { status: 'retry'; reason: string; retryAt?: string }
  | { status: 'blocked'; reason: string };
export interface NotificationTransport {
  send(message: NotificationMessage, signal: AbortSignal): Promise<DeliveryResult>;
}
/** Fixed destination, bounded response, normal priority (respects phone quiet hours). */
export class PushoverTransport implements NotificationTransport {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async send(message: NotificationMessage, signal: AbortSignal): Promise<DeliveryResult> {
    try {
      const response = await this.fetcher('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: message.applicationToken,
          user: message.userKey,
          ...(message.device ? { device: message.device } : {}),
          priority: '0',
          title: notificationText(message.title, 250),
          message: notificationText(message.message, 1024),
          ...(Array.from(message.url).length <= 512
            ? { url: message.url, url_title: 'Open CraftingTable' }
            : {}),
        }),
      });
      if (response.status === 429) {
        await response.body?.cancel();
        const reset = Number(response.headers.get('x-limit-app-reset')) * 1000;
        const retry = response.headers.get('retry-after');
        const retryTime =
          retry === null
            ? 0
            : /^\d+$/.test(retry)
              ? this.now().getTime() + Number(retry) * 1000
              : Date.parse(retry);
        const deadline = Math.max(
          this.now().getTime() + 3_600_000,
          Number.isFinite(reset) ? reset : 0,
          Number.isFinite(retryTime) ? retryTime : 0,
        );
        return {
          status: 'retry',
          reason: 'Pushover rate limit reached; delivery will retry.',
          retryAt: new Date(deadline).toISOString(),
        };
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        return { status: 'retry', reason: 'Pushover is temporarily unavailable.' };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return {
          status: 'blocked',
          reason:
            'Pushover rejected the request. Check the application token, user key, and device, then send a test.',
        };
      }
      const reader = response.body?.getReader();
      if (reader === undefined)
        return { status: 'retry', reason: 'Pushover returned an empty response.' };
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16_384) {
          await reader.cancel();
          return { status: 'retry', reason: 'Pushover response exceeded the size limit.' };
        }
        chunks.push(part.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        typeof result === 'object' &&
        result !== null &&
        'status' in result &&
        result.status === 1
      )
        return { status: 'accepted' };
      return {
        status: 'blocked',
        reason: 'Pushover did not accept the request. Check credentials and send a test.',
      };
    } catch {
      return {
        status: 'retry',
        reason: 'Pushover delivery could not be confirmed; it will retry.',
      };
    }
  }
}
