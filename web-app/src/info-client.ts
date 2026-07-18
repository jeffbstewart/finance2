// Typed client for the finance2 InfoService, generated end to end from
// proto/info.proto. A hallucinated field or RPC on either side is a
// compile error — this file is the TS half of that guarantee.
import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { InfoService } from './proto-gen/info_pb';

export function infoClient(baseUrl: string): Client<typeof InfoService> {
  return createClient(
    InfoService,
    createGrpcWebTransport({
      baseUrl,
      // HttpOnly session cookie rides along automatically.
      fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
    }),
  );
}

export async function fetchServerVersion(baseUrl: string): Promise<string> {
  const response = await infoClient(baseUrl).getInfo({});
  return response.version;
}
