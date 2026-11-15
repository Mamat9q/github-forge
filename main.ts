// Entry lifecycle for the github-core-clone-01 forge.
//
// This process is only the glue between the sealed env and the forge
// server defined in app.ts: it picks a free local port, tells the env
// where to find it, then waits until the env reports the suite is
// finished. It serves no API itself and makes no model calls.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff starting at 250 ms, doubling each attempt and
// capped at 2,000 ms. The attempt counter itself is capped at 8 so the
// exponent never grows past the cap anyway.
function backoffDelayMs(attempt: number): number {
  const capped = Math.min(attempt, 8);
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** capped);
}

function fail(message: string): never {
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}

async function register(envUrl: string, port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 200 || response.status === 409) {
        // 200: this entry won the registration. 409: another entry
        // registered first; the env still expects this process to
        // keep waiting for /done, so both are a success here.
        return;
      }

      if (response.status === 400 || response.status === 405) {
        const text = await response.text();
        throw new Error(`register failed with HTTP ${response.status}: ${text}`);
      }

      // Any other status is treated like a transient failure below.
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register failed with HTTP')) {
        throw err;
      }
      // Network error, timeout, or an unexpected status: the env may
      // still be starting, so keep retrying forever.
    }

    await sleep(backoffDelayMs(attempt));
    attempt += 1;
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) {
        return;
      }
      // done === false means the suite is still running; poll again.
    } catch {
      // A failed or slow poll is retried the same way as a "not done"
      // answer: the process never exits before the env says done.
    }

    await sleep(backoffDelayMs(attempt));
    attempt += 1;
  }
}

async function main(): Promise<void> {
  const rawEnvUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const envUrl = rawEnvUrl.replace(/\/+$/, '');
  if (envUrl === '') {
    process.stderr.write(
      '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n',
    );
    process.exit(1);
  }

  const server = createApp();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the bound port'));
        return;
      }
      resolve(address.port);
    });
  });

  console.log(`[entry] listening on port ${port}`);

  await register(envUrl, port);

  console.log('[entry] registered; waiting for the env to say done');

  await waitForDone(envUrl);

  console.log('[entry] done');

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
