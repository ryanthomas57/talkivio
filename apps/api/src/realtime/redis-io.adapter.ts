import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import { RedisService } from '../common/redis.service';

/** Socket.IO adapter that fans events out across API nodes through Redis pub/sub. */
/** The Socket.IO Server type as Nest's IoAdapter declares it (Nest pins its own socket.io copy). */
type NestIoServer = Parameters<IoAdapter['close']>[0];

export class RedisIoAdapter extends IoAdapter {
  private adapterFactory: ReturnType<typeof createAdapter> | null = null;
  private readonly servers: NestIoServer[] = [];
  private readonly closed = new WeakSet<object>();

  constructor(private readonly appRef: INestApplicationContext) {
    super(appRef);
  }

  connect(): void {
    const redis = this.appRef.get(RedisService);
    this.adapterFactory = createAdapter(redis.create('io-pub'), redis.create('io-sub'));
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, { ...options, path: options?.path ?? '/realtime/v1', serveClient: false, transports: ['websocket', 'polling'] });
    if (this.adapterFactory) server.adapter(this.adapterFactory);
    this.servers.push(server as unknown as NestIoServer);
    return server;
  }

  /**
   * Graceful drain: close Socket.IO while Redis is still up. Sockets see a transport close (not a
   * server disconnect), so clients reconnect — to another replica — and replay from their cursor.
   */
  async closeAll(): Promise<void> {
    await Promise.all(this.servers.map((s) => this.close(s)));
  }

  /** Idempotent: Nest's dispose calls this again after closeAll(). */
  override async close(server: NestIoServer): Promise<void> {
    if (this.closed.has(server)) return;
    this.closed.add(server);
    await new Promise<void>((resolve) => {
      try {
        void server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}
