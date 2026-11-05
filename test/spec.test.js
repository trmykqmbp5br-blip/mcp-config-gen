import assert from 'node:assert/strict';
import test from 'node:test';

import { SpecError, parseSpec, parseSpecs } from '../src/spec.js';

test('infers the http transport from url', () => {
  const spec = parseSpec({ name: 'a', url: 'https://example.com/mcp' });
  assert.equal(spec.transport, 'http');
  assert.equal(spec.url, 'https://example.com/mcp');
  assert.deepEqual(spec.headers, {});
});

test('infers the stdio transport from command', () => {
  const spec = parseSpec({ name: 'a', command: 'npx', args: ['-y', 'server'] });
  assert.equal(spec.transport, 'stdio');
  assert.deepEqual(spec.args, ['-y', 'server']);
});

test('rejects an explicit transport that contradicts the fields', () => {
  assert.throws(
    () => parseSpec({ name: 'a', transport: 'http', command: 'npx' }),
    { name: 'SpecError' },
  );
});

test('rejects an unknown field instead of dropping it', () => {
  assert.throws(
    () => parseSpec({ name: 'a', url: 'https://example.com/mcp', headres: {} }),
    /unknown field "headres"/,
  );
});

test('rejects a name that would break a config key', () => {
  for (const name of ['', ' has space', '-leading', 'x'.repeat(65)]) {
    assert.throws(() => parseSpec({ name, url: 'https://example.com/mcp' }), SpecError, name);
  }
  assert.equal(parseSpec({ name: 'ok.name-1_2', url: 'https://example.com/mcp' }).name, 'ok.name-1_2');
});

test('rejects http without url and stdio without command', () => {
  assert.throws(() => parseSpec({ name: 'a', transport: 'http' }), /"url" must be a non-empty string/);
  assert.throws(() => parseSpec({ name: 'a', transport: 'stdio' }), /"command" must be a non-empty string/);
});

test('rejects a non-http(s) url', () => {
  assert.throws(() => parseSpec({ name: 'a', url: 'file:///tmp/x' }), /must be http\(s\)/);
  assert.throws(() => parseSpec({ name: 'a', url: 'not a url' }), /not an absolute URL/);
});

test('defaults auth to Authorization: Bearer', () => {
  const spec = parseSpec({ name: 'a', url: 'https://example.com/mcp', auth: { env: 'KEY' } });
  assert.deepEqual(spec.auth, { env: 'KEY', header: 'Authorization', scheme: 'Bearer' });
});

test('accepts an empty auth scheme', () => {
  const spec = parseSpec({
    name: 'a',
    url: 'https://example.com/mcp',
    auth: { env: 'KEY', scheme: '', header: 'X-Api-Key' },
  });
  assert.equal(spec.auth.scheme, '');
  assert.equal(spec.auth.header, 'X-Api-Key');
});

test('rejects an auth env that is not an env name', () => {
  assert.throws(
    () => parseSpec({ name: 'a', url: 'https://example.com/mcp', auth: { env: 'not a name' } }),
    /environment variable name/,
  );
});

test('rejects auth fields it does not understand', () => {
  assert.throws(
    () => parseSpec({ name: 'a', url: 'https://example.com/mcp', auth: { env: 'K', token: 'x' } }),
    /unknown field "token"/,
  );
});

test('parseSpecs accepts an array, a servers wrapper, and a lone object', () => {
  const one = parseSpecs({ name: 'a', url: 'https://example.com/mcp' });
  assert.equal(one.length, 1);
  const two = parseSpecs({
    servers: [
      { name: 'a', url: 'https://example.com/mcp' },
      { name: 'b', command: 'npx' },
    ],
  });
  assert.deepEqual(two.map((spec) => spec.name), ['a', 'b']);
  assert.throws(() => parseSpecs({ servers: {} }), /"servers" must be an array/);
});
