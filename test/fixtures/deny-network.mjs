import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url) => {
  if (process.env.LAB_TEST_ALLOW_ACCOUNT === 'yes' && url === 'https://api.clutta.io/v1/api-keys/validate') {
    appendFileSync(process.env.LAB_TEST_CALLS, 'fixture-account-validation\n');
    return new Response(JSON.stringify({ data: { isValid: true,
      workspaceId: '11111111-1111-4111-8111-111111111111', scopes: ['*'] } }));
  }
  appendFileSync(process.env.LAB_TEST_CALLS, 'network-denied\n');
  throw new Error('Offline test fixture');
};
