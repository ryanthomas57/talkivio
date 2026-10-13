/**
 * @talkivio/client — typed access to the Talkivio HTTP API and realtime contracts.
 *
 * - `createClient()` — tiny typed fetch wrapper over the generated OpenAPI `paths`.
 * - `paths` / `components` / `operations` — generated from `contracts/openapi.yaml`.
 * - Resource schemas: `@talkivio/client/schemas`; realtime envelopes, event payloads and
 *   socket commands: `@talkivio/client/events` (zod, camelCase; the wire is snake_case).
 */
export * from './client.ts';
export * from './wire.ts';
export type { components, operations, paths } from './generated/openapi.ts';
export type {
  AgentCommandPayload,
  AgentCommandType,
  AuthOk,
  Command,
  CommandAck,
  CommandError,
  ControlFrame,
  DurableEventType,
  DurableFrame,
  DurablePayload,
  EphemeralEventType,
  EphemeralFrame,
  PublicDurablePayload,
  Scope,
  VisitorCommandPayload,
  VisitorCommandType,
} from './events/index.ts';
