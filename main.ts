// Entrypoint and trial lifecycle. The harness starts this file as
// `node /bot/main.ts`, expects the forge to bind an ephemeral port, POST
// that port to $MAKEFUN_ENV_URL/register, and then long-poll
// $MAKEFUN_ENV_URL/done until the trial says it is finished, at which
// point the process exits 0. Without MAKEFUN_ENV_URL (a local run) the
// forge simply serves until interrupted.

import type { AddressInfo } from 'node:net';

import { createApp } from './app.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const { server } = createApp({ token });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  console.log(`lucky-forge listening on port ${port}`);

  if (envUrl === '') {
    console.log('MAKEFUN_ENV_URL is not set: serving without the trial lifecycle.');
    return;
  }

  // Register the port with the trial environment, retrying until it
  // accepts us (the environment may still be coming up).
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) break;
    } catch {
      // Not up yet; keep trying.
    }
    await sleep(250);
  }
  console.log('registered with the trial environment');

  // Long-poll for the end of the trial.
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) break;
      }
    } catch {
      // A dropped poll is not fatal; the trial is still running.
    }
    await sleep(250);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
