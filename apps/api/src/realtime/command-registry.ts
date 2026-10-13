import { Injectable } from '@nestjs/common';
import type { AuthContext, VisitorContext } from '../common/http';

export interface AgentCommandContext {
  auth: AuthContext;
  connectionId: string;
}

export interface VisitorCommandContext {
  visitor: VisitorContext;
  connectionId: string;
}

export interface SocketCommand {
  commandId: string;
  type: string;
  scope?: { kind: string; id: string };
  expectedVersion?: number;
  payload: Record<string, unknown>;
}

export type AgentHandler = (ctx: AgentCommandContext, cmd: SocketCommand) => Promise<unknown>;
export type VisitorHandler = (ctx: VisitorCommandContext, cmd: SocketCommand) => Promise<unknown>;

/**
 * Allowlisted socket commands (ch. 77). Feature modules register handlers that
 * delegate to the same services used by REST controllers — the gateway holds no
 * business logic of its own.
 */
@Injectable()
export class CommandRegistry {
  private readonly agent = new Map<string, AgentHandler>();
  private readonly visitor = new Map<string, VisitorHandler>();

  registerAgent(type: string, handler: AgentHandler): void {
    this.agent.set(type, handler);
  }

  registerVisitor(type: string, handler: VisitorHandler): void {
    this.visitor.set(type, handler);
  }

  agentHandler(type: string): AgentHandler | undefined {
    return this.agent.get(type);
  }

  visitorHandler(type: string): VisitorHandler | undefined {
    return this.visitor.get(type);
  }
}
