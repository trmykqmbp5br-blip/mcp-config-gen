import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLIENTS } from '../src/clients.js';
import { run } from '../src/cli.js';

const EXAMPLES = fileURLToPath(new URL('../examples/servers.json', import.meta.url));

/** Run the CLI in-process and capture both streams. */
function invoke(argv, io = {}) {
  let out = '';
  let err = '';
  const code = run(argv, {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ...io,
  });
  return { code, out, err };
}

/** A scratch directory that also stands in for $HOME. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-config-gen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('--list prints every client', () => {
  const { code, out } = invoke(['--list']);
  assert.equal(code, 0);
  for (const client of CLIENTS) assert.ok(out.includes(client.id), client.id);
});

test('--help prints usage and exits 0', () => {
  const { code, out } = invoke(['--help']);
  assert.equal(code, 0);
  assert.match(out, /^mcp-config-gen —/);
});

test('no client is a usage error', () => {
  const { code, err } = invoke(['--name', 'a', '--url', 'https://e.com/mcp']);
  assert.equal(code, 2);
  assert.match(err, /at least one client/);
});

test('an unknown client is an input error', () => {
  const { code, err } = invoke(['nope', '--name', 'a', '--url', 'https://e.com/mcp']);
  assert.equal(code, 1);
  assert.match(err, /unknown client "nope"/);
});

test('an unknown option is a usage error', () => {
  assert.equal(invoke(['cursor', '--nope']).code, 2);
  assert.equal(invoke(['cursor', '--header', 'novalue']).code, 2);
});

test('a spec file renders one result per server, and --json is parseable', () => {
  const { code, out } = invoke(['cursor', '--spec', EXAMPLES, '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(out);
  assert.equal(payload.results.length, 2);
  assert.equal(payload.results[0].client, 'cursor');
  assert.equal(payload.results[0].format, 'json');
  assert.match(payload.results[0].content, /\$\{env:ANYSEARCH_API_KEY\}/);
  assert.match(payload.results[1].content, /"command": "npx"/);
});

test('"all" renders every client that can express the server, and reports the rest', () => {
  const { code, out, err } = invoke(['all', '--spec', EXAMPLES, '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(out);
  // Every server/client pair is either rendered or explicitly skipped: nothing
  // is silently dropped, and nothing is emitted with a literal credential.
  assert.equal(payload.results.length + payload.skipped.length, CLIENTS.length * 2);
  const skippedIds = new Set(payload.skipped.map((entry) => entry.client));
  assert.ok(skippedIds.has('antigravity'));
  for (const id of skippedIds) {
    assert.ok(['antigravity', 'omp', 'hermes'].includes(id), `unexpected skip: ${id}`);
  }
  // --json keeps stdout/stderr clean: the skips are already in the payload.
  assert.equal(err, '');
});

test('plain "all" reports each skipped client on stderr', () => {
  const { code, err } = invoke(['all', '--spec', EXAMPLES]);
  assert.equal(code, 0);
  assert.match(err, /# skipped antigravity: .*no environment interpolation/);
});

test('plain output is only the snippet, so it can be redirected', () => {
  const { code, out, err } = invoke(['claude-code', '--name', 'a', '--url', 'https://e.com/mcp']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.ok(out.startsWith('{'));
  assert.ok(out.endsWith('}\n'));
});

test('flag mode infers stdio and keeps repeated --arg order', () => {
  const { out } = invoke(['claude-code', '--name', 'gh', '--command', 'npx', '--arg', '-y', '--arg', 'server']);
  assert.match(out, /"type": "stdio"/);
  assert.match(out, /"args": \[\n\s+"-y",\n\s+"server"\n\s+\]/);
});

test('an empty --auth-scheme drops the scheme prefix', () => {
  const { out } = invoke([
    'claude-code',
    '--name',
    'a',
    '--url',
    'https://e.com/mcp',
    '--auth-env',
    'KEY',
    '--auth-scheme=',
  ]);
  assert.match(out, /"Authorization": "\$\{KEY\}"/);
});

test('--write creates and then merges without duplicating the server', (t) => {
  const dir = scratch(t);
  const target = join(dir, '.cursor', 'mcp.json');
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`);

  const first = invoke(['cursor', '--name', 'a', '--url', 'https://e.com/mcp', '--write'], {
    cwd: dir,
    home: dir,
  });
  assert.equal(first.code, 0);
  assert.match(first.err, /merged/);

  const second = invoke(['cursor', '--name', 'a', '--url', 'https://e.com/other', '--write'], {
    cwd: dir,
    home: dir,
  });
  assert.equal(second.code, 0);

  const parsed = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['a', 'other']);
  assert.equal(parsed.mcpServers.a.url, 'https://e.com/other');
});

test('--write creates a missing file', (t) => {
  const dir = scratch(t);
  const { code, err } = invoke(['vscode', '--name', 'a', '--url', 'https://e.com/mcp', '--write'], {
    cwd: dir,
    home: dir,
  });
  assert.equal(code, 0);
  assert.match(err, /created/);
  const parsed = JSON.parse(readFileSync(join(dir, '.vscode', 'mcp.json'), 'utf8'));
  assert.equal(parsed.servers.a.type, 'http');
});

test('--write keeps a .bak when it overwrites by force', (t) => {
  const dir = scratch(t);
  const target = join(dir, '.cursor', 'mcp.json');
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  writeFileSync(target, '{"mcpServers":{}}\n');
  const { code } = invoke(
    ['cursor', '--name', 'a', '--url', 'https://e.com/mcp', '--write', '--force'],
    { cwd: dir, home: dir },
  );
  assert.equal(code, 0);
  assert.ok(existsSync(`${target}.bak`));
});

test('--write refuses a non-JSON client', () => {
  const { code, err } = invoke(['codex', '--name', 'a', '--url', 'https://e.com/mcp', '--write']);
  assert.equal(code, 1);
  assert.match(err, /JSON client configs only/);
});

test('--write refuses to combine with "all"', () => {
  const { code, err } = invoke(['all', '--spec', EXAMPLES, '--write']);
  assert.equal(code, 2);
  assert.match(err, /one client and one server/);
});

test('--write refuses to rewrite a JSONC file it cannot preserve', (t) => {
  const dir = scratch(t);
  const target = join(dir, '.cursor', 'mcp.json');
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  writeFileSync(target, '{\n  // a comment\n  "mcpServers": {}\n}\n');
  const { code, err } = invoke(['cursor', '--name', 'a', '--url', 'https://e.com/mcp', '--write'], {
    cwd: dir,
    home: dir,
  });
  assert.equal(code, 1);
  assert.match(err, /not plain JSON/);
  assert.match(readFileSync(target, 'utf8'), /a comment/);
});

test('--out writes the snippet verbatim', (t) => {
  const dir = scratch(t);
  const { code } = invoke(
    ['vscode', '--name', 'a', '--url', 'https://e.com/mcp', '--out', 'nested/mcp.json'],
    { cwd: dir, home: dir },
  );
  assert.equal(code, 0);
  assert.match(readFileSync(join(dir, 'nested', 'mcp.json'), 'utf8'), /"servers"/);
});

test('antigravity needs --inline, and then embeds the value', () => {
  const base = ['antigravity', '--name', 'a', '--url', 'https://e.com/mcp', '--auth-env', 'ANYSEARCH_API_KEY'];
  const refused = invoke(base);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /no environment interpolation/);

  const inlined = invoke([...base, '--inline'], { env: { ANYSEARCH_API_KEY: 'sekret' } });
  assert.equal(inlined.code, 0);
  assert.match(inlined.out, /"Authorization": "Bearer sekret"/);
});

test('missing input is reported rather than guessed', () => {
  assert.equal(invoke(['cursor']).code, 2);
  const { code, err } = invoke(['cursor', '--name', 'a']);
  assert.equal(code, 1);
  assert.match(err, /cannot tell the transport/);
});
