declare module 'proxy-addr' {
  import type { IncomingMessage } from 'node:http';
  type TrustFn = (addr: string, index: number) => boolean;
  interface ProxyAddr {
    (req: Pick<IncomingMessage, 'headers'> & { connection?: { remoteAddress?: string }; socket?: { remoteAddress?: string } }, trust: TrustFn | string | string[]): string;
    compile(trust: string | string[]): TrustFn;
  }
  const proxyaddr: ProxyAddr;
  export default proxyaddr;
}
