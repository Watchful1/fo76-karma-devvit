import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RateLimitedError,
  rateLimitWaitMs,
  withRateLimitRetry,
} from './rate-limit';

const NOW = 1_800_000_000_000;
const now = () => NOW;
const limited = (time: string) =>
  new Error(`8 RESOURCE_EXHAUSTED: RatelimitError(TimeString="${time}")`);

test('rateLimitWaitMs reads seconds and minutes from Reddit', () => {
  assert.equal(rateLimitWaitMs(limited('5 seconds')), 5500);
  assert.equal(rateLimitWaitMs(limited('1 second')), 1500);
  assert.equal(rateLimitWaitMs(limited('9 minutes')), 540_500);
  assert.equal(rateLimitWaitMs(limited('2 hours')), 7_200_500);
  assert.equal(
    rateLimitWaitMs(new Error('RESOURCE_EXHAUSTED')),
    5000,
    'no wait given: retry soon'
  );
  assert.equal(rateLimitWaitMs(new Error('5 NOT_FOUND')), undefined);
});

test('a short rate limit is waited out and retried once', async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await withRateLimitRetry(
    async () => {
      if (++calls === 1) throw limited('5 seconds');
      return 'ok';
    },
    now,
    async (ms) => {
      waits.push(ms);
    }
  );
  assert.equal(result, 'ok');
  assert.deepEqual(waits, [5500]);
});

test('a long rate limit is not retried, and says when it ends', async () => {
  let calls = 0;
  const failure = withRateLimitRetry(async () => {
    calls++;
    throw limited('9 minutes');
  }, now);
  await assert.rejects(
    failure,
    (error) =>
      error instanceof RateLimitedError && error.untilMs === NOW + 540_500
  );
  assert.equal(calls, 1);
});

test('a second refusal after the retry ends with a RateLimitedError', async () => {
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        throw limited('5 seconds');
      },
      now,
      async () => {}
    ),
    RateLimitedError
  );
});

test('other errors pass straight through', async () => {
  await assert.rejects(
    withRateLimitRetry(async () => {
      throw new Error('5 NOT_FOUND');
    }),
    /NOT_FOUND/
  );
});

test('a wait just under the ceiling is retried and just over it is not', async () => {
  // The ceiling is 10 s plus the 0.5 s margin: "10 seconds" asks for 10,500 ms
  // and is retried, "11 seconds" asks for 11,500 ms and is not.
  assert.equal(rateLimitWaitMs(limited('10 seconds')), 10_500);
  assert.equal(rateLimitWaitMs(limited('11 seconds')), 11_500);

  let retried = 0;
  await withRateLimitRetry(
    async () => {
      if (++retried === 1) throw limited('10 seconds');
    },
    now,
    async () => {}
  );
  assert.equal(retried, 2);

  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        calls++;
        throw limited('11 seconds');
      },
      now,
      async () => assert.fail('must not sleep')
    ),
    (error) =>
      error instanceof RateLimitedError && error.untilMs === NOW + 11_500
  );
  assert.equal(calls, 1);
});

test('an error with no time to wait is retried after 5 seconds', async () => {
  const waits: number[] = [];
  let calls = 0;
  await withRateLimitRetry(
    async () => {
      if (++calls === 1) throw new Error('8 RESOURCE_EXHAUSTED');
    },
    now,
    async (ms) => {
      waits.push(ms);
    }
  );
  assert.deepEqual(waits, [5000]);
});

test('a non-rate-limit failure on the retry passes through as it is', async () => {
  let calls = 0;
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        if (++calls === 1) throw limited('1 second');
        throw new Error('5 NOT_FOUND');
      },
      now,
      async () => {}
    ),
    /NOT_FOUND/
  );
});
