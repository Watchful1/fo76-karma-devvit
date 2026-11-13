import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { alertPayload, discordAlerts, isDiscordWebhook } from './alerts';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abc-DEF_ghi';

test('a real-shaped Discord webhook is accepted', () => {
  assert.equal(isDiscordWebhook(HOOK), true);
  assert.equal(isDiscordWebhook(`${HOOK}?wait=true`), true);
});

test('anything else is refused', () => {
  for (const url of [
    HOOK.replace('https:', 'http:'),
    'https://discordapp.com/api/webhooks/1/abc',
    'https://canary.discord.com/api/webhooks/1/abc',
    'https://discord.com.evil.example/api/webhooks/1/abc',
    'https://evil.example/https://discord.com/api/webhooks/1/abc',
    'https://discord.com@evil.example/api/webhooks/1/abc',
    'https://discord.com/channels/1/2',
    'https://discord.com/api/webhook/1/abc',
    'https://discord.com/',
    'discord.com/api/webhooks/1/abc',
    'not a url',
    '',
  ]) {
    assert.equal(isDiscordWebhook(url), false, url);
  }
});

test('the payload switches every mention off and starts with the app name', () => {
  const body = JSON.parse(alertPayload('app', '@everyone hello')) as {
    content: string;
    allowed_mentions: { parse: unknown[] };
  };
  assert.deepEqual(body.allowed_mentions.parse, []);
  assert.ok(body.content.startsWith('[app] '));
  assert.equal(body.content, '[app] @everyone hello');
});

test('the payload content is cut to 1900 characters', () => {
  const body = JSON.parse(alertPayload('app', 'x'.repeat(5000))) as {
    content: string;
  };
  assert.equal(body.content.length, 1900);
  assert.ok(body.content.startsWith('[app] xxx'));
  const short = JSON.parse(alertPayload('app', 'x'.repeat(1893))) as {
    content: string;
  };
  assert.equal(short.content.length, 1899, 'shorter text is not padded');
});

// ------------------------------------------------------------ discordAlerts

const realFetch = globalThis.fetch;
const realError = console.error;
let requests: { url: string; init: RequestInit | undefined }[];
let logged: string[];

beforeEach(() => {
  requests = [];
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  mock.timers.reset();
});

function stubFetch(respond: () => Promise<Response>): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return respond();
  }) as typeof fetch;
}

test('an empty webhook URL sends nothing and logs nothing', async () => {
  stubFetch(async () => new Response(null, { status: 204 }));
  await discordAlerts('', 'app').send('hi');
  assert.equal(requests.length, 0);
  assert.equal(logged.length, 0);
});

test('a bad URL sends nothing and does not throw', async () => {
  stubFetch(async () => new Response(null, { status: 204 }));
  await discordAlerts('https://evil.example/api/webhooks/1/a', 'app').send(
    'hi'
  );
  await discordAlerts('junk', 'app').send('hi');
  assert.equal(requests.length, 0);
  assert.equal(logged.length, 2);
  assert.match(logged[0]!, /Alert not sent/);
});

test('a good URL is posted the payload', async () => {
  stubFetch(async () => new Response(null, { status: 204 }));
  await discordAlerts(HOOK, 'app').send('hello');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, HOOK);
  assert.equal(requests[0]!.init?.method, 'POST');
  assert.equal(requests[0]!.init?.body, alertPayload('app', 'hello'));
  assert.equal(logged.length, 0);
});

test('a non-OK response does not throw, and is logged', async () => {
  stubFetch(async () => new Response('nope', { status: 429 }));
  await discordAlerts(HOOK, 'app').send('hi');
  assert.equal(requests.length, 1);
  assert.match(logged.join('\n'), /429/);
});

test('a fetch that rejects does not throw', async () => {
  stubFetch(async () => {
    throw new Error('network down');
  });
  await discordAlerts(HOOK, 'app').send('hi');
  assert.match(logged.join('\n'), /network down/);
});

test('a fetch that never resolves gives up after five seconds, without throwing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  stubFetch(() => new Promise<Response>(() => {}));
  const sending = discordAlerts(HOOK, 'app').send('hi');
  mock.timers.tick(4999);
  let settled = false;
  void sending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting just before five seconds');
  mock.timers.tick(1);
  await sending;
  assert.match(logged.join('\n'), /did not answer in time/);
});
