import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { CLIENTS, describeClients, getClient, renderClientConfig, resolveClientPath } from '../src/clients.js';
import { parseSpec } from '../src/spec.js';

const context = (over = {}) => ({ inline: false, env: {}, ...over });

const httpSpec = (over = {}) =>
  parseSpec({
    name: 'anysearch',
    url: 'https://api.anysearch.com/mcp',
    auth: { env: 'ANYSEARCH_API_KEY' },
    ...over,
  });

const stdioSpec = () => parseSpec({ name: 'gh', command: 'npx', args: ['-y', 'server'] });

const render = (id, spec, ctx = context()) => renderClientConfig(id, spec, ctx);

test('every client id is unique and described', () => {
  const ids = CLIENTS.map((client) => client.id);
  assert.equal(new Set(ids).size, ids.length);
  const rows = describeClients();
  assert.equal(rows.length, CLIENTS.length);
  for (const row of rows) {
    assert.ok(row.path.length > 0, row.id);
    assert.ok(['json', 'toml', 'yaml'].includes(row.format), row.id);
    assert.ok(row.auth.length > 0, row.id);
  }
});

test('no client writes a literal secret unless asked to inline it', () => {
  const spec = httpSpec();
  const env = { ANYSEARCH_API_KEY: 'sekret-value' };
  for (const client of CLIENTS) {
    if (client.id === 'antigravity') continue; // has no interpolation, covered below
    const { content } = renderClientConfig(client.id, spec, context({ env }));
    assert.ok(!content.includes('sekret-value'), `${client.id} leaked the secret`);
  }
});

test('claude-code wraps the reference in a Bearer header', () => {
  const { document } = render('claude-code', httpSpec({ headers: { 'X-Client': 'gen/0.1.0' } }));
  assert.deepEqual(document, {
    mcpServers: {
      anysearch: {
        type: 'http',
        url: 'https://api.anysearch.com/mcp',
        headers: { 'X-Client': 'gen/0.1.0', Authorization: 'Bearer ${ANYSEARCH_API_KEY}' },
      },
    },
  });
});

test('claude-code emits a stdio entry without http fields', () => {
  const { document } = render('claude-code', stdioSpec());
  assert.deepEqual(document.mcpServers.gh, { type: 'stdio', command: 'npx', args: ['-y', 'server'] });
});

test('cursor omits the transport field and uses ${env:...}', () => {
  const { document } = render('cursor', httpSpec());
  assert.deepEqual(document.mcpServers.anysearch, {
    url: 'https://api.anysearch.com/mcp',
    headers: { Authorization: 'Bearer ${env:ANYSEARCH_API_KEY}' },
  });
});

test('vscode puts servers under "servers"', () => {
  const { document } = render('vscode', httpSpec());
  assert.ok(document.servers.anysearch);
  assert.equal(document.servers.anysearch.type, 'http');
});

test('cline spells the remote transport streamableHttp and always sends headers', () => {
  const spec = parseSpec({ name: 'plain', url: 'https://e.com/mcp' });
  const entry = render('cline', spec).document.mcpServers.plain;
  assert.equal(entry.type, 'streamableHttp');
  assert.deepEqual(entry.headers, {});
  assert.deepEqual(entry.autoApprove, []);
  assert.equal(entry.disabled, false);
});

test('opencode uses a remote entry with oauth disabled', () => {
  const entry = render('opencode', httpSpec()).document.mcp.anysearch;
  assert.equal(entry.type, 'remote');
  assert.equal(entry.enabled, true);
  assert.equal(entry.oauth, false);
  assert.equal(entry.headers.Authorization, 'Bearer {env:ANYSEARCH_API_KEY}');
});

test('opencode folds a stdio command into an argv array', () => {
  const entry = render('opencode', stdioSpec()).document.mcp.gh;
  assert.deepEqual(entry.command, ['npx', '-y', 'server']);
  assert.equal(entry.type, 'local');
});

test('antigravity uses serverUrl and refuses to fake an interpolation', () => {
  const spec = httpSpec();
  assert.throws(() => render('antigravity', spec), /no environment interpolation/);
  const entry = render('antigravity', spec, context({ inline: true, env: { ANYSEARCH_API_KEY: 'sekret' } }))
    .document.mcpServers.anysearch;
  assert.equal(entry.serverUrl, 'https://api.anysearch.com/mcp');
  assert.equal(entry.url, undefined);
  assert.equal(entry.headers.Authorization, 'Bearer sekret');
});

test('antigravity rejects the undocumented stdio shape', () => {
  assert.throws(() => render('antigravity', stdioSpec()), /does not support the stdio transport/);
});

test('codex uses bearer_token_env_var instead of a header reference', () => {
  const { content } = render('codex', httpSpec({ headers: { 'X-Client': 'gen/0.1.0' } }));
  assert.match(content, /^\[mcp_servers\.anysearch\]/m);
  assert.match(content, /^url = "https:\/\/api\.anysearch\.com\/mcp"$/m);
  assert.match(content, /^bearer_token_env_var = "ANYSEARCH_API_KEY"$/m);
  assert.match(content, /^http_headers = \{ X-Client = "gen\/0\.1\.0" \}$/m);
  assert.ok(!content.includes('Authorization'));
});

test('codex refuses a scheme its token field cannot express', () => {
  const spec = httpSpec({ auth: { env: 'KEY', scheme: 'Token' } });
  assert.throws(() => render('codex', spec), /bearer_token_env_var/);
});

test('codex inlines when asked', () => {
  const { content } = render('codex', httpSpec(), context({ inline: true, env: { ANYSEARCH_API_KEY: 'sekret' } }));
  assert.match(content, /^http_headers = \{ Authorization = "Bearer sekret" \}$/m);
  assert.ok(!content.includes('bearer_token_env_var'));
});

test('codex emits stdio as command, args and env', () => {
  const spec = parseSpec({ name: 'gh', command: 'npx', args: ['-y'], env: { TOKEN: 'x' } });
  const { content } = render('codex', spec);
  assert.match(content, /^command = "npx"$/m);
  assert.match(content, /^args = \["-y"\]$/m);
  assert.match(content, /^env = \{ TOKEN = "x" \}$/m);
});

test('hermes nests under mcp_servers', () => {
  const { content } = render('hermes', httpSpec());
  assert.match(content, /^mcp_servers:$/m);
  assert.match(content, /Authorization: "Bearer \$\{ANYSEARCH_API_KEY\}"/);
});

test('dsh emits an insert patch with a !!js header expression', () => {
  const { content } = render('dsh', httpSpec());
  assert.match(content, /^- insert:$/m);
  assert.match(content, /id: "mcp-anysearch"/);
  assert.match(content, /name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.match(content, /transport: "streamable-http"/);
  assert.match(content, /Authorization: !!js "`Bearer \$\{process\.env\.ANYSEARCH_API_KEY\}`"/);
});

test('dsh emits stdio through the plugin stdio transport', () => {
  const { document } = render('dsh', stdioSpec());
  const config = document[0].insert[0].config;
  assert.equal(config.transport, 'stdio');
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, ['-y', 'server']);
});

test('resolveClientPath expands home and project paths', () => {
  const home = resolve('/home/u');
  const cwd = resolve('/work/p');
  assert.equal(resolveClientPath(getClient('cursor'), { cwd, home }), resolve(cwd, '.cursor/mcp.json'));
  assert.equal(resolveClientPath(getClient('codex'), { cwd, home }), join(home, '.codex/config.toml'));
  assert.equal(
    resolveClientPath(getClient('dsh'), { cwd, home, profile: 'web' }),
    join(home, '.dsh/profiles/web/cordis.patch.yml'),
  );
});
