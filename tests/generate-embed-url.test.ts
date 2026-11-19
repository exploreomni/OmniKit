import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { packSignedPayload, type SignedPayloadParams } from '@omni-co/embed';

import handler, { generateSignedEmbedUrl } from '../server/handlers/generate-embed-url';
import { generateEmbedUrl as requestSignedEmbedUrl } from '../src/services/omniApi';

const baseInput = {
  baseUrl: 'https://example.omniapp.co',
  embedSecret: 'embed-secret-do-not-leak',
  embedData: {
    contentPath: '/dashboards/operations',
    externalId: 'external-123',
    name: 'Example Person',
  },
};

const NONCE = 'nonce_1234567890abcdefghijklmnop';

function signedUrl(
  host = 'example.embed-omniapp.co',
  overrides: Partial<SignedPayloadParams> = {},
  secret = baseInput.embedSecret,
): string {
  const url = new URL(`https://${host}/embed/login`);
  const { payload, signature } = packSignedPayload({
    loginUrl: url.toString(),
    ...baseInput.embedData,
    nonce: NONCE,
    ...overrides,
  }, secret, { now: () => Date.UTC(2026, 10, 19) });
  url.searchParams.set('payload', payload);
  url.searchParams.set('signature', signature);
  return url.toString();
}

function generatedResponse(url: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ url, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('standard SSO generation sends the secret in the JSON body without an Authorization header', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const result = await generateSignedEmbedUrl(baseInput, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return generatedResponse(signedUrl());
    }) as typeof fetch,
  });

  assert.equal(capturedUrl, 'https://example.omniapp.co/embed/sso/generate-url');
  assert.equal(capturedInit?.method, 'POST');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.has('Authorization'), false);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    ...baseInput.embedData,
    secret: baseInput.embedSecret,
  });
  assert.deepEqual(result, { url: signedUrl() });
  assert.equal(JSON.stringify(result).includes(baseInput.embedSecret), false);
});

test('browser signing requests bypass retained in-flight request keying', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), '/api/generate-embed-url');
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(requestBody.embed_secret, baseInput.embedSecret);
    return new Response(JSON.stringify({ url: `https://signed.example/${calls}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const [first, second] = await Promise.all([
    requestSignedEmbedUrl(baseInput.baseUrl, baseInput.embedSecret, baseInput.embedData),
    requestSignedEmbedUrl(baseInput.baseUrl, baseInput.embedSecret, baseInput.embedData),
  ]);

  assert.equal(calls, 2, 'sensitive signing requests were incorrectly deduplicated through a retained key');
  assert.notEqual(first.url, second.url);
});

test('generation requires contentPath, externalId, name, and an embed secret before any request', async () => {
  let calls = 0;
  const dependencies = {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => {
      calls += 1;
      return new Response('{}');
    }) as typeof fetch,
  };

  await assert.rejects(
    generateSignedEmbedUrl({ ...baseInput, embedSecret: '' }, dependencies),
    /Embed secret is required/,
  );
  await assert.rejects(
    generateSignedEmbedUrl({ ...baseInput, embedData: { ...baseInput.embedData, externalId: '' } }, dependencies),
    /contentPath, externalId, and name are required/,
  );
  await assert.rejects(
    generateSignedEmbedUrl({ ...baseInput, embedData: { ...baseInput.embedData, unexpectedClaim: 'unsafe' } }, dependencies),
    /unsupported fields/,
  );
  assert.equal(calls, 0);
});

test('optional email and groups are normalized, forwarded, and bound to the signed output', async () => {
  const optional = {
    email: 'person@example.invalid',
    groups: ['Finance', 'Operations'],
  };
  const input = {
    ...baseInput,
    embedData: {
      ...baseInput.embedData,
      email: ` ${optional.email} `,
      groups: optional.groups.map((group) => ` ${group} `),
    },
  };
  let capturedBody: Record<string, unknown> | null = null;
  const result = await generateSignedEmbedUrl(input, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return generatedResponse(signedUrl('example.embed-omniapp.co', optional));
    }) as typeof fetch,
  });

  assert.deepEqual(capturedBody, {
    ...baseInput.embedData,
    email: optional.email,
    groups: JSON.stringify(optional.groups),
    secret: baseInput.embedSecret,
  });
  assert.deepEqual(result, { url: signedUrl('example.embed-omniapp.co', optional) });
});

test('v1 output accepts optional unsigned SDK telemetry and standard padded signatures', async () => {
  const url = new URL(signedUrl());
  url.searchParams.set('sdk', '@omni-co/embed@1.3.0');
  const signature = url.searchParams.get('signature')!;
  url.searchParams.set('signature', Buffer.from(signature, 'base64url').toString('base64'));
  const result = await generateSignedEmbedUrl(baseInput, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(url.toString())) as typeof fetch,
  });
  assert.deepEqual(result, { url: url.toString() });
});

test('signed output rejects changed, missing, extra, or malformed optional identity claims', async () => {
  const optional = { email: 'person@example.invalid', groups: ['Finance', 'Operations'] };
  const input = { ...baseInput, embedData: { ...baseInput.embedData, ...optional } };
  const candidates = [
    signedUrl('example.embed-omniapp.co', { groups: optional.groups }),
    signedUrl('example.embed-omniapp.co', { ...optional, email: 'different@example.invalid' }),
    signedUrl('example.embed-omniapp.co', { email: optional.email }),
    signedUrl('example.embed-omniapp.co', { ...optional, groups: [...optional.groups].reverse() }),
    signedUrl('example.embed-omniapp.co', { ...optional, groups: 'not-json' as unknown as string[] }),
  ];
  const unexpected = new URL(signedUrl('example.embed-omniapp.co', optional));
  unexpected.searchParams.set('mode', 'read');
  candidates.push(unexpected.toString());

  for (const candidate of candidates) {
    await assert.rejects(generateSignedEmbedUrl(input, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
    }));
  }

  for (const extra of [{ email: optional.email }, { groups: optional.groups }, { entity: 'Unexpected entity' }]) {
    await assert.rejects(generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl('example.embed-omniapp.co', extra))) as typeof fetch,
    }), /unexpected signed payload parameter/);
  }
});

test('upstream failures never expose response bodies or the embed secret', async () => {
  const upstreamMarker = 'raw-upstream-private-marker';
  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => new Response(`${upstreamMarker}:${baseInput.embedSecret}`, { status: 403 })) as typeof fetch,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /HTTP 403/);
      assert.equal(message.includes(upstreamMarker), false);
      assert.equal(message.includes(baseInput.embedSecret), false);
      return true;
    },
  );
});

test('redirects and Omni host lookalikes are rejected', async () => {
  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/embed' },
      })) as typeof fetch,
    }),
    /HTTP 302/,
  );

  for (const host of [
    'example.omniapp.co',
    'example-embed-omniapp.co',
    'example.embed-omniapp.co.attacker.example',
  ]) {
    await assert.rejects(
      generateSignedEmbedUrl(baseInput, {
        assertSafeUrl: async () => undefined,
        fetchImpl: (async () => generatedResponse(signedUrl(host))) as typeof fetch,
      }),
      /unexpected host/,
    );
  }

  const trailingDotBase = { ...baseInput, baseUrl: 'https://example.omniapp.co.' };
  await assert.rejects(
    generateSignedEmbedUrl(trailingDotBase, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl('example.omniapp.co.'))) as typeof fetch,
    }),
    /unexpected host/,
  );
  assert.deepEqual(await generateSignedEmbedUrl(trailingDotBase, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(signedUrl())) as typeof fetch,
  }), { url: signedUrl() });
});

test('custom vanity bases accept only the exact same host', async () => {
  const customInput = { ...baseInput, baseUrl: 'https://analytics.customer.example' };
  const valid = signedUrl('analytics.customer.example');
  const result = await generateSignedEmbedUrl(customInput, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(valid)) as typeof fetch,
  });
  assert.deepEqual(result, { url: valid });

  await assert.rejects(
    generateSignedEmbedUrl(customInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl('embed.customer.example'))) as typeof fetch,
    }),
    /unexpected host/,
  );
});

test('signed output rejects wrong schemes, userinfo, fragments, and ambiguous raw paths', async () => {
  const query = signedUrl().slice(signedUrl().indexOf('?'));
  const candidates = [
    signedUrl().replace('https:', 'http:'),
    signedUrl().replace('https://', 'https://user:password@'),
    signedUrl().replace('https://', 'https://@'),
    `${signedUrl()}#private-fragment`,
    `${signedUrl()}#`,
    `https://example.embed-omniapp.co/embed/login/${query}`,
    `https://example.embed-omniapp.co/%65mbed/login${query}`,
    `https://example.embed-omniapp.co/embed//login${query}`,
    `https://example.embed-omniapp.co/embed/other/../login${query}`,
    `https://example.embed-omniapp.co/embed\\login${query}`,
    signedUrl().replace('embed-omniapp', 'embed-\nomniapp'),
  ];

  for (const candidate of candidates) {
    await assert.rejects(
      generateSignedEmbedUrl(baseInput, {
        assertSafeUrl: async () => undefined,
        fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
      }),
      /invalid signed embed URL|documented standard SSO URL shape/,
    );
  }
});

test('signed output binds the verified login URL, identity, and content to the request', async () => {
  const overrides = [
    { externalId: 'different-external-id' },
    { name: 'Different Person' },
    { contentPath: '/dashboards/different' },
    { loginUrl: 'https://attacker.example/embed/login' },
    { loginUrl: 'https://example.embed-omniapp.co/embed/other' },
    { loginUrl: 'https://example.embed-omniapp.co/embed/login?extra=value' },
    { nonce: '../../unsafe' },
  ];
  for (const override of overrides) {
    await assert.rejects(generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl('example.embed-omniapp.co', override))) as typeof fetch,
    }), (error: unknown) => {
      assert.equal((error as { statusCode: number }).statusCode, 502);
      return true;
    });
  }
});

test('v1 output rejects tampering, wrong secrets, and malformed signed payloads', async () => {
  const valid = new URL(signedUrl());
  const tampered = new URL(signedUrl('example.embed-omniapp.co', { nonce: 'different_1234567890abcdefghijklmnop' }));
  valid.searchParams.set('payload', tampered.searchParams.get('payload')!);
  const candidates = [valid.toString(), signedUrl('example.embed-omniapp.co', {}, 'different-test-secret')];
  for (const key of ['payload', 'signature']) {
    const invalid = new URL(signedUrl());
    invalid.searchParams.set(key, 'invalid');
    candidates.push(invalid.toString());
  }
  for (const candidate of candidates) {
    await assert.rejects(generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
    }), /invalid v1 signed embed URL/);
  }
});

test('v1 output rejects authenticated payloads with missing or invalid required fields', async () => {
  const params: Record<string, unknown> = {
    loginUrl: 'https://example.embed-omniapp.co/embed/login',
    ...baseInput.embedData,
    nonce: NONCE,
    exp: Date.UTC(2026, 10, 20) / 1000,
  };
  const candidates: Record<string, unknown>[] = [];
  for (const key of Object.keys(params)) {
    const missing = { ...params };
    delete missing[key];
    candidates.push(missing);
  }
  candidates.push({ ...params, exp: 'not-an-epoch' }, { ...params, exp: null }, { ...params, name: 123 });
  for (const candidate of candidates) {
    // Construct invalid signed data directly because the SDK packer rejects it.
    const payload = deflateRawSync(Buffer.from(JSON.stringify(candidate))).toString('base64url');
    const signature = createHmac('sha256', baseInput.embedSecret).update(payload).digest('base64url');
    const url = new URL(String(params.loginUrl));
    url.searchParams.set('payload', payload);
    url.searchParams.set('signature', signature);
    await assert.rejects(generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(url.toString())) as typeof fetch,
    }), /invalid v1 signed embed URL/);
  }
});

test('v1 output rejects duplicate, missing, ambiguous, or unexpected query parameters', async () => {
  const candidates: string[] = [];
  for (const key of ['payload', 'signature', 'sdk']) {
    const duplicate = new URL(signedUrl());
    const value = duplicate.searchParams.get(key) ?? '@omni-co/embed@1.3.0';
    duplicate.searchParams.set(key, value);
    duplicate.searchParams.append(key, value);
    candidates.push(duplicate.toString());
    const lookalike = new URL(signedUrl());
    lookalike.searchParams.set(key.toUpperCase(), value);
    candidates.push(lookalike.toString());
  }
  for (const key of ['payload', 'signature']) {
    const missing = new URL(signedUrl());
    missing.searchParams.delete(key);
    candidates.push(missing.toString());
  }
  for (const [key, value] of [
    ['contentPath', baseInput.embedData.contentPath],
    ['externalId', baseInput.embedData.externalId],
    ['name', baseInput.embedData.name],
    ['nonce', NONCE],
    ['secret', baseInput.embedSecret],
    ['optionalField', `prefix-${baseInput.embedSecret}-suffix`],
    ['sdk', `prefix-${baseInput.embedSecret}-suffix`],
    ['sdk', 'x'.repeat(65)],
  ]) {
    const extra = new URL(signedUrl());
    extra.searchParams.set(key, value);
    candidates.push(extra.toString());
  }
  const legacy = new URL('https://example.embed-omniapp.co/embed/login');
  for (const [key, value] of Object.entries({ ...baseInput.embedData, nonce: NONCE, signature: 'legacy-test-signature' })) {
    legacy.searchParams.set(key, value);
  }
  candidates.push(legacy.toString());

  for (const candidate of candidates) {
    await assert.rejects(
      generateSignedEmbedUrl(baseInput, {
        assertSafeUrl: async () => undefined,
        fetchImpl: (async () => generatedResponse(candidate)) as typeof fetch,
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal((error as { statusCode: number }).statusCode, 502);
        assert.equal(message.includes(candidate), false);
        assert.equal(message.includes(baseInput.embedSecret), false);
        return true;
      },
    );
  }
});

test('v1 output never forwards secret material inside a verified payload', async () => {
  const name = `Example ${baseInput.embedSecret}`;
  await assert.rejects(generateSignedEmbedUrl({
    ...baseInput,
    embedData: { ...baseInput.embedData, name },
  }, {
    assertSafeUrl: async () => undefined,
    fetchImpl: (async () => generatedResponse(signedUrl('example.embed-omniapp.co', { name }))) as typeof fetch,
  }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /prohibited secret material/);
    assert.equal(message.includes(baseInput.embedSecret), false);
    return true;
  });
});

test('ambiguous response fields and rejected URL values are never echoed', async () => {
  const privateMarker = 'raw-url-private-marker';
  const rejected = signedUrl('example.embed-omniapp.co', { name: privateMarker });

  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(rejected)) as typeof fetch,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes(privateMarker), false);
      assert.equal(message.includes(baseInput.embedSecret), false);
      return true;
    },
  );

  await assert.rejects(
    generateSignedEmbedUrl(baseInput, {
      assertSafeUrl: async () => undefined,
      fetchImpl: (async () => generatedResponse(signedUrl(), { embed_url: signedUrl() })) as typeof fetch,
    }),
    /ambiguous signed embed URL response/,
  );
});

test('HTTP handler is POST-only and returns a generic failure envelope', async () => {
  const methodResponse = await handler(new Request('http://127.0.0.1/api/generate-embed-url'));
  assert.equal(methodResponse.status, 405);

  const invalidResponse = await handler(new Request('http://127.0.0.1/api/generate-embed-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://example.omniapp.co',
      embed_secret: baseInput.embedSecret,
      embed_data: { contentPath: '/dashboards/example' },
    }),
  }));
  const body = JSON.stringify(await invalidResponse.json());
  assert.equal(invalidResponse.status, 400);
  assert.equal(body.includes(baseInput.embedSecret), false);
  assert.match(body, /externalId/);
});
