/**
 * Notification links are produced server-side as dashboard paths (`/inbox/{id}`, `/offline-messages/{id}`);
 * older rows may still carry `/chats/{id}` or `/offline/{id}`, which map to the same pages. Only same-origin
 * relative paths are honoured.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHAT = new RegExp(`^/(?:chats|inbox)/(${UUID})$`, 'i');
const OFFLINE = new RegExp(`^/(?:offline|offline-messages|offline-submissions)/(${UUID})$`, 'i');

export function dashboardLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\')) return null;
  const chat = CHAT.exec(link);
  if (chat) return `/inbox/${chat[1]}`;
  const offline = OFFLINE.exec(link);
  if (offline) return `/offline-messages/${offline[1]}`;
  return link;
}
