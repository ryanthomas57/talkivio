/**
 * Compile-time checks for the typed client (run by `tsc --noEmit`; never executed).
 * They pin the camelCase mapping of generated wire types and request option typing.
 */
import { createClient, type ResponseData, type Operation } from '../src/index.ts';
import type { DurablePayload } from '../src/events/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_t?: T) => undefined;

const api = createClient({ baseUrl: 'http://localhost:4000', credentials: 'include', csrf: () => 'csrf' });

export async function samples(id: string) {
  const chat = await api.get('/api/v1/chats/{id}', { params: { id } });
  assert<Equal<typeof chat.data.ownerMembershipId, string | null>>();
  assert<Equal<typeof chat.data.visitor.avatarColor, string>>();

  const history = await api.get('/api/v1/chats/history', { query: { limit: 20, departmentId: id } });
  const first = history.data[0];
  assert<Equal<typeof first.snippetHighlights, [number, number][]>>();
  assert<Equal<typeof history.page.hasMore, boolean>>();

  const sent = await api.post('/api/v1/chats/{id}/messages', { params: { id }, body: { clientMessageId: 'c-1', body: 'Hi' } });
  assert<Equal<typeof sent.data.sender.type, 'visitor' | 'agent' | 'system'>>();

  const visitor = await api.get('/api/v1/visitors/{id}', { params: { id } });
  // Opaque map: keys untouched.
  assert<Equal<typeof visitor.data.customFields, { [key: string]: unknown }>>();

  await api.delete('/api/v1/sites/{id}/widget-config/draft', { params: { id }, query: { etag: 'abc' } });
  // @ts-expect-error path parameter is required
  await api.get('/api/v1/chats/{id}');
  // @ts-expect-error unknown path
  await api.get('/api/v1/nope');
  // @ts-expect-error body must be camelCase
  await api.post('/api/v1/chats/{id}/messages', { params: { id }, body: { client_message_id: 'x' } });
}

type Snapshot = ResponseData<Operation<'/api/v1/monitor', 'get'>>;
assert<Equal<Snapshot['counters']['oldestWaitLevel'], 'none' | 'ok' | 'warning' | 'critical'>>();
type Created = DurablePayload<'message.created'>;
assert<Equal<Created['message']['visibility'], 'public' | 'internal'>>();
