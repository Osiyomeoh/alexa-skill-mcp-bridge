import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startHotelsWeatherServer,
  type HotelsWeatherServerHandle,
} from '@alexa-mcp-bridge/hotels-weather-mcp-server';
import { createLogger } from '@alexa-mcp-bridge/core';
import { BridgeMcpClient } from './client.js';

/**
 * The window this closes: a server that elicits without setting `relatedRequestId` sends its
 * question on the standalone SSE stream, which the client opens moments after connect. A tool
 * called inside that window has its question dropped by the SDK without an error, and the call
 * hangs until the elicitation times out. Listing tools during connect closes the window, so the
 * order of messages on the wire is the thing worth pinning.
 */

const logger = createLogger({}, { write: () => undefined });
let server: HotelsWeatherServerHandle;
let methods: string[];

beforeEach(async () => {
  methods = [];
  server = await startHotelsWeatherServer({
    port: 0,
    log: (event) => {
      if (event.msg === 'mcp' && event.dir === 'in' && event.kind === 'request') {
        methods.push(String(event.method));
      }
    },
  });
});
afterEach(async () => {
  await server.close();
});

const client = () =>
  new BridgeMcpClient({
    url: server.url,
    auth: { headers: {} },
    callTimeoutMs: 10_000,
    onElicitation: async () => ({ action: 'decline' }),
    logger,
  });

describe('BridgeMcpClient', () => {
  it('lists tools while connecting, before any tool call can run', async () => {
    const mcp = client();
    await mcp.connect();
    expect(methods).toEqual(['initialize', 'tools/list']);
    await mcp.close();
  });

  it('serves the cached tool list without a second round trip', async () => {
    const mcp = client();
    await mcp.connect();
    const first = await mcp.listTools();
    const second = await mcp.listTools();
    expect(second).toBe(first);
    expect(methods.filter((m) => m === 'tools/list')).toHaveLength(1);
    await mcp.close();
  });

  it('elicits successfully on a tool called immediately after connecting', async () => {
    const mcp = client();
    await mcp.connect();
    const result = await mcp.callTool('search_hotels', {
      destination: 'Berlin',
      checkIn: '2026-10-05',
      checkOut: '2026-10-07',
    });
    // The question was declined, so the tool says so rather than hanging.
    expect(JSON.stringify(result)).toMatch(/cancelled|guests/i);
    await mcp.close();
  });

  it('starts a new session when the server has forgotten the old one', async () => {
    // What a redeployed server answers for a session it no longer has (the spec's 404).
    let forget = false;
    const mcp = new BridgeMcpClient({
      url: server.url,
      auth: { headers: {} },
      callTimeoutMs: 10_000,
      onElicitation: async () => ({ action: 'decline' }),
      logger,
      fetch: async (url, init) => {
        if (forget && typeof init?.body === 'string' && init.body.includes('"tools/call"')) {
          forget = false;
          const body = {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unknown session.' },
            id: null,
          };
          return new Response(JSON.stringify(body), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return fetch(url, init);
      },
    });
    await mcp.connect();
    forget = true;
    methods = [];
    const result = await mcp.callTool('get_weather', { city: 'Berlin' });
    expect(result.isError).not.toBe(true);
    expect(methods).toEqual(['initialize', 'tools/list', 'tools/call']);
    await mcp.close();
  });
});
