/**
 * One renderer per client.
 *
 * The clients disagree on almost everything: which file holds the config,
 * whether the server map is called `mcpServers` / `servers` / `mcp` /
 * `mcp_servers`, whether the transport is spelled `http` / `streamableHttp` /
 * `remote` / `local`, and how an environment variable is interpolated at load
 * time. Keeping each answer in one small record means adding a client is one
 * object, not a change to the CLI.
 */

import { join, resolve } from 'node:path';

import { toJson, toYaml, tomlTable, yamlTag } from './emit.js';
import { SpecError } from './spec.js';

/**
 * How each client spells "read this value from the environment at load time".
 * @type {Record<string, (name: string) => string>}
 */
const INTERPOLATION = {
  dollar: (name) => `\${${name}}`,
  'env-colon': (name) => `\${env:${name}}`,
  opencode: (name) => `{env:${name}}`,
};

/** @param {Record<string, unknown>} object */
const hasKeys = (object) => Object.keys(object).length > 0;

/** Drop `undefined` entries so renderers can read as declarations. */
const prune = (/** @type {Record<string, unknown>} */ object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/**
 * Read a secret from the environment, for `--inline`.
 * @param {string} envName
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function inlineSecret(envName, env) {
  const value = env[envName];
  if (typeof value !== 'string' || value === '') {
    throw new SpecError(
      `--inline needs ${envName} in the environment, but it is unset or empty; drop --inline to emit a reference instead`,
      { field: 'auth.env' },
    );
  }
  return value;
}

/**
 * Resolve a server's auth into a header value: a load-time reference by
 * default, a literal only when the caller explicitly asked to inline it.
 * @param {any} client
 * @param {{ inline: boolean, env: Record<string, string | undefined> }} ctx
 * @param {string} envName
 * @returns {string}
 */
function secretReference(client, ctx, envName) {
  if (ctx.inline) return inlineSecret(envName, ctx.env);
  const interpolate = INTERPOLATION[client.interp];
  if (interpolate === undefined) {
    throw new SpecError(
      `${client.label} documents no environment interpolation for headers; re-run with --inline to embed ${envName} literally, or configure auth by hand`,
      { field: 'auth' },
    );
  }
  return interpolate(envName);
}

/**
 * @param {any} spec
 * @param {any} client
 * @param {{ inline: boolean, env: Record<string, string | undefined> }} ctx
 * @returns {Record<string, string> | undefined}
 */
function headersFor(spec, client, ctx) {
  /** @type {Record<string, string>} */
  const headers = { ...spec.headers };
  if (spec.auth !== undefined) {
    const reference = secretReference(client, ctx, spec.auth.env);
    headers[spec.auth.header] = spec.auth.scheme === ''
      ? reference
      : `${spec.auth.scheme} ${reference}`;
  }
  return hasKeys(headers) ? headers : undefined;
}

/** Refuse a transport a client has no documented shape for, instead of guessing one. */
function assertTransport(client, spec) {
  if (!client.transports.includes(spec.transport)) {
    throw new SpecError(
      `${client.label} config does not support the ${spec.transport} transport (supported: ${client.transports.join(', ')})`,
      { field: 'transport' },
    );
  }
}

/** @param {any} client @param {any} spec @param {any} ctx */
function renderJson(client, spec, ctx) {
  assertTransport(client, spec);
  const entry = client.entry(spec, client, ctx);
  const document = { [client.rootKey]: { [spec.name]: entry } };
  return { format: 'json', content: toJson(document), document, entry };
}

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {string} label
 * @property {string} docs - Where the shape was checked against.
 * @property {string} path - `~` expands to the home directory; `{profile}` is a placeholder.
 * @property {'project' | 'home'} scope
 * @property {'http' | 'stdio'}[] transports
 * @property {string} format
 * @property {(spec: any, ctx: any, client: any) => { format: string, content: string, entry?: unknown, document?: unknown }} render
 */

/** @type {Client[]} */
const JSON_CLIENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    docs: 'https://code.claude.com/docs/en/mcp',
    path: '.mcp.json',
    scope: 'project',
    transports: ['http', 'stdio'],
    format: 'json',
    rootKey: 'mcpServers',
    interp: 'dollar',
    entry(spec, client, ctx) {
      if (spec.transport === 'stdio') {
        return prune({
          type: 'stdio',
          command: spec.command,
          args: hasKeys(spec.args) ? spec.args : undefined,
          env: hasKeys(spec.env) ? spec.env : undefined,
        });
      }
      return prune({ type: 'http', url: spec.url, headers: headersFor(spec, client, ctx) });
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    docs: 'https://cursor.com/docs/mcp',
    path: '.cursor/mcp.json',
    scope: 'project',
    transports: ['http', 'stdio'],
    format: 'json',
    rootKey: 'mcpServers',
    interp: 'env-colon',
    entry(spec, client, ctx) {
      // Cursor infers the transport from which fields are present.
      if (spec.transport === 'stdio') {
        return prune({
          command: spec.command,
          args: spec.args.length > 0 ? spec.args : undefined,
          env: hasKeys(spec.env) ? spec.env : undefined,
        });
      }
      return prune({ url: spec.url, headers: headersFor(spec, client, ctx) });
    },
  },
  {
    id: 'vscode',
    label: 'VS Code',
    docs: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers',
    path: '.vscode/mcp.json',
    scope: 'project',
    transports: ['http', 'stdio'],
    format: 'json',
    rootKey: 'servers',
    interp: 'env-colon',
    entry(spec, client, ctx) {
      if (spec.transport === 'stdio') {
        return prune({
          type: 'stdio',
          command: spec.command,
          args: spec.args.length > 0 ? spec.args : undefined,
          env: hasKeys(spec.env) ? spec.env : undefined,
        });
      }
      return prune({ type: 'http', url: spec.url, headers: headersFor(spec, client, ctx) });
    },
  },
  {
    id: 'cline',
    label: 'Cline',
    docs: 'https://docs.cline.bot/mcp/mcp-overview',
    path: '~/.cline/data/settings/cline_mcp_settings.json',
    scope: 'home',
    transports: ['http', 'stdio'],
    format: 'json',
    rootKey: 'mcpServers',
    interp: 'env-colon',
    entry(spec, client, ctx) {
      // Cline must be told the streamable-HTTP transport explicitly; omitting
      // `type` falls back to legacy SSE.
      if (spec.transport === 'stdio') {
        return prune({
          type: 'stdio',
          command: spec.command,
          args: spec.args.length > 0 ? spec.args : undefined,
          env: hasKeys(spec.env) ? spec.env : undefined,
          disabled: false,
          autoApprove: [],
        });
      }
      return {
        type: 'streamableHttp',
        url: spec.url,
        headers: headersFor(spec, client, ctx) ?? {},
        disabled: false,
        autoApprove: [],
      };
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    docs: 'https://opencode.ai/docs/mcp-servers/',
    path: '~/.config/opencode/opencode.json',
    scope: 'home',
    transports: ['http', 'stdio'],
    format: 'json',
    rootKey: 'mcp',
    interp: 'opencode',
    entry(spec, client, ctx) {
      // `oauth: false` stops the client from probing for OAuth when the server
      // authenticates with a static API key.
      if (spec.transport === 'stdio') {
        return prune({
          type: 'local',
          command: [spec.command, ...spec.args],
          enabled: true,
          environment: hasKeys(spec.env) ? spec.env : undefined,
        });
      }
      return prune({
        type: 'remote',
        url: spec.url,
        enabled: true,
        oauth: false,
        headers: headersFor(spec, client, ctx),
      });
    },
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    docs: 'https://antigravity.google/docs/ide/mcp',
    path: '~/.gemini/config/mcp_config.json',
    scope: 'home',
    transports: ['http'],
    format: 'json',
    rootKey: 'mcpServers',
    interp: 'none',
    entry(spec, client, ctx) {
      // Antigravity uses `serverUrl`, not `url`, and documents no env
      // interpolation for remote headers.
      return prune({ serverUrl: spec.url, headers: headersFor(spec, client, ctx) });
    },
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    docs: 'https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md',
    path: '.omp/mcp.json',
    scope: 'project',
    transports: ['http'],
    format: 'json',
    rootKey: 'mcpServers',
    interp: 'dollar',
    entry(spec, client, ctx) {
      return prune({ type: 'http', url: spec.url, headers: headersFor(spec, client, ctx) });
    },
  },
].map((client) => ({
  ...client,
  render: (spec, ctx) => renderJson(client, spec, ctx),
}));

/** @type {Client[]} */
const FORMAT_CLIENTS = [
  {
    id: 'codex',
    label: 'OpenAI Codex',
    docs: 'https://developers.openai.com/codex/mcp/',
    path: '~/.codex/config.toml',
    scope: 'home',
    transports: ['http', 'stdio'],
    format: 'toml',
    interp: 'codex',
    render(spec, ctx, client) {
      assertTransport(client, spec);
      /** @type {Record<string, unknown>} */
      const entries = {};
      if (spec.transport === 'stdio') {
        entries.command = spec.command;
        if (spec.args.length > 0) entries.args = spec.args;
        if (hasKeys(spec.env)) entries.env = spec.env;
        return {
          format: 'toml',
          content: tomlTable(['mcp_servers', spec.name], entries),
        };
      }

      entries.url = spec.url;
      /** @type {Record<string, string>} */
      const headers = { ...spec.headers };
      if (spec.auth !== undefined) {
        const isBearer =
          spec.auth.header === 'Authorization' &&
          spec.auth.scheme.trim().toLowerCase() === 'bearer';
        if (ctx.inline) {
          headers[spec.auth.header] = `${spec.auth.scheme} ${inlineSecret(spec.auth.env, ctx.env)}`;
        } else if (isBearer) {
          // Codex reads the bearer token from the environment itself, so no
          // interpolation syntax is needed in the header.
          entries.bearer_token_env_var = spec.auth.env;
        } else {
          throw new SpecError(
            `Codex can only take an environment-sourced token through bearer_token_env_var (Authorization: Bearer). For ${spec.auth.header} with scheme ${JSON.stringify(spec.auth.scheme)}, re-run with --inline or set the header manually`,
            { field: 'auth' },
          );
        }
      }
      if (hasKeys(headers)) entries.http_headers = headers;
      return {
        format: 'toml',
        content: tomlTable(['mcp_servers', spec.name], entries),
        entry: entries,
      };
    },
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    docs: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md',
    path: '~/.hermes/config.yaml',
    scope: 'home',
    transports: ['http'],
    format: 'yaml',
    interp: 'dollar',
    render(spec, ctx, client) {
      assertTransport(client, spec);
      const document = {
        mcp_servers: {
          [spec.name]: prune({
            url: spec.url,
            headers: headersFor(spec, client, ctx),
          }),
        },
      };
      return { format: 'yaml', content: toYaml(document), document };
    },
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    docs: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md',
    path: '~/.dsh/profiles/{profile}/cordis.patch.yml',
    scope: 'home',
    transports: ['http', 'stdio'],
    format: 'yaml',
    interp: 'cordis',
    render(spec, ctx, client) {
      assertTransport(client, spec);
      /** @type {Record<string, unknown>} */
      const config = { serverName: spec.name };

      if (spec.transport === 'stdio') {
        config.transport = 'stdio';
        config.command = spec.command;
        if (spec.args.length > 0) config.args = spec.args;
        if (hasKeys(spec.env)) config.env = spec.env;
      } else {
        config.transport = 'streamable-http';
        config.url = spec.url;
        /** @type {Record<string, unknown>} */
        const headers = { ...spec.headers };
        if (spec.auth !== undefined) {
          // The Cordis loader evaluates `!!js` expressions, so the header can
          // stay a reference to the process environment instead of a literal.
          headers[spec.auth.header] = ctx.inline
            ? `${spec.auth.scheme} ${inlineSecret(spec.auth.env, ctx.env)}`
            : yamlTag(
              '!!js',
              '`' + spec.auth.scheme + ' ${process.env.' + spec.auth.env + '}`',
            );
        }
        if (hasKeys(headers)) config.headers = headers;
      }

      // A patch list entry: the plugin is inserted with an id the profile can
      // later target for overrides.
      const document = [
        {
          insert: [
            {
              id: `mcp-${spec.name}`,
              name: '@deepseek-ai/dsh-mcp-client',
              config,
            },
          ],
        },
      ];
      return { format: 'yaml', content: toYaml(document), document, entry: config };
    },
  },
];

/** Every client this version knows about. @type {Client[]} */
export const CLIENTS = [...JSON_CLIENTS, ...FORMAT_CLIENTS];

/**
 * @param {string} id
 * @returns {Client}
 */
export function getClient(id) {
  const client = CLIENTS.find((candidate) => candidate.id === id);
  if (client === undefined) {
    throw new SpecError(
      `unknown client ${JSON.stringify(id)}; known clients: ${CLIENTS.map((candidate) => candidate.id).join(', ')}`,
      { field: 'client' },
    );
  }
  return client;
}

/**
 * Render one server definition for one client. The public entry point: callers
 * should not have to hand a client object to its own `render`.
 * @param {Client | string} clientOrId
 * @param {any} spec - A spec from `parseSpec`.
 * @param {{ inline?: boolean, env?: Record<string, string | undefined> }} [context]
 * @returns {{ format: string, content: string, document?: unknown, entry?: unknown }}
 */
export function renderClientConfig(clientOrId, spec, context = {}) {
  const client = typeof clientOrId === 'string' ? getClient(clientOrId) : clientOrId;
  return client.render(
    spec,
    { inline: context.inline === true, env: context.env ?? process.env },
    client,
  );
}

/**
 * Expand a client's config path for this machine.
 * @param {Client} client
 * @param {{ cwd: string, home: string, profile?: string }} location
 * @returns {string}
 */
export function resolveClientPath(client, { cwd, home, profile = 'desktop' }) {
  const expanded = client.path.replaceAll('{profile}', profile);
  if (expanded === '~') return home;
  if (expanded.startsWith('~/')) return join(home, expanded.slice(2));
  return resolve(cwd, expanded);
}

/**
 * Rows for `--list`, and the source of truth for the table in the README.
 * @returns {{ id: string, label: string, format: string, path: string, transports: string, auth: string }[]}
 */
export function describeClients() {
  const auth = (interp) => {
    if (interp === 'none') return 'literal only (--inline)';
    if (interp === 'codex') return 'bearer_token_env_var';
    if (interp === 'cordis') return '`!!js` process.env';
    return INTERPOLATION[interp]('VAR');
  };
  return CLIENTS.map((client) => ({
    id: client.id,
    label: client.label,
    format: client.format,
    path: client.path,
    transports: client.transports.join(', '),
    auth: auth(client.interp),
  }));
}
