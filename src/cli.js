/**
 * The command line.
 *
 * Deliberately stream-split: the config snippet goes to stdout so it can be
 * redirected straight into a file (`mcp-config-gen cursor --spec s.json > .cursor/mcp.json`),
 * while provenance, warnings and write confirmations go to stderr.
 *
 * `run()` takes its streams and environment as arguments, so the whole CLI is
 * testable in-process without spawning a child.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CLIENTS, describeClients, getClient, renderClientConfig, resolveClientPath } from './clients.js';
import { toJson } from './emit.js';
import { SpecError, parseSpec, parseSpecs } from './spec.js';

const USAGE = `mcp-config-gen — write one MCP server definition once, get each client's config

Usage
  mcp-config-gen <client...> --spec <file>          [options]
  mcp-config-gen <client...> --name <n> --url <u>   [options]
  mcp-config-gen all --spec <file> --json
  mcp-config-gen --list

Clients
  ${CLIENTS.map((client) => client.id).join(', ')}, all

Server definition (use --spec, or these flags)
  --spec <file>          JSON file: one server, an array, or { "servers": [...] }
  --name <name>          Server name used as the config key
  --transport <t>        http | stdio (inferred from --url / --command)
  --url <url>            http endpoint
  --header <k:v>         Static header (repeatable)
  --auth-env <VAR>       Header value comes from this env var (reference by default)
  --auth-header <name>   Header carrying auth (default: Authorization)
  --auth-scheme <s>      Scheme prefix (default: Bearer; "" for none)
  --command <cmd>        stdio executable
  --arg <value>          stdio argument (repeatable)
  --env <k=v>            stdio environment entry (repeatable)

Output
  --json                 Machine-readable result: client, format, path, content
  --out <file>           Write the rendered snippet to an explicit path
  --write                Write to the client's own config path (JSON clients:
                         merged into the existing file; other formats refuse)
  --force                Keep a .bak and overwrite instead of merging
  --profile <name>       DSH profile directory (default: desktop)
  --inline               Embed the secret from the environment instead of a
                         load-time reference. Prefer the default.
  --list                 Print the client matrix
  -h, --help             This text

Secrets
  By default an auth header is emitted as the client's own reference syntax
  (\${VAR}, \${env:VAR}, {env:VAR}, !!js, or bearer_token_env_var), so no
  credential is ever written into a config file or a shell history.

Exit codes
  0 success, 1 invalid input, 2 usage error
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const BOOLEAN_FLAGS = new Set(['inline', 'json', 'write', 'force', 'list', 'help']);
const REPEATED_FLAGS = new Set(['header', 'env', 'arg', 'client']);
const VALUE_FLAGS = new Set([
  'spec',
  'name',
  'transport',
  'url',
  'command',
  'auth-env',
  'auth-header',
  'auth-scheme',
  'out',
  'profile',
  ...REPEATED_FLAGS,
]);

/**
 * @param {string[]} argv
 * @returns {{ positionals: string[], flags: Record<string, any> }}
 */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const flags = { header: [], env: [], arg: [], client: [] };
  /** @type {string[]} */
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h' || token === '--help') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      if (BOOLEAN_FLAGS.has(name)) {
        if (equals !== -1) throw new UsageError(`--${name} takes no value`);
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option --${name}`);
      let value;
      if (equals !== -1) value = token.slice(equals + 1);
      else {
        value = argv[index + 1];
        index += 1;
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
      }
      if (REPEATED_FLAGS.has(name)) flags[name].push(value);
      else flags[name] = value;
      continue;
    }
    if (token.startsWith('-') && token !== '-') throw new UsageError(`unknown option ${token}`);
    positionals.push(token);
  }
  return { positionals, flags };
}

/**
 * @param {string[]} values
 * @param {string} separator
 * @param {string} flagName
 * @returns {Record<string, string>}
 */
function toPairs(values, separator, flagName) {
  /** @type {Record<string, string>} */
  const pairs = {};
  for (const value of values) {
    const index = value.indexOf(separator);
    if (index <= 0) {
      throw new UsageError(`${flagName} expects KEY${separator}VALUE, got ${JSON.stringify(value)}`);
    }
    pairs[value.slice(0, index)] = value.slice(index + separator.length);
  }
  return pairs;
}

/** @param {Record<string, unknown>} object */
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/**
 * @param {Record<string, any>} flags
 * @param {{ cwd: string, home: string }} location
 */
function loadSpecs(flags, { cwd, home }) {
  if (flags.spec !== undefined) {
    const file = flags.spec === '~' ? home : flags.spec.startsWith('~/')
      ? join(home, flags.spec.slice(2))
      : resolve(cwd, flags.spec);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new SpecError(`cannot read spec file ${file}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SpecError(`spec file ${file} is not valid JSON: ${error.message}`);
    }
    return parseSpecs(parsed, { source: file });
  }

  if (flags.name === undefined) {
    throw new UsageError('give a server with --spec <file>, or --name plus --url / --command');
  }
  /** @type {Record<string, any>} */
  const raw = {
    name: flags.name,
    transport: flags.transport,
    url: flags.url,
    command: flags.command,
  };
  if (flags.header.length > 0) raw.headers = toPairs(flags.header, ':', '--header');
  if (flags.env.length > 0) raw.env = toPairs(flags.env, '=', '--env');
  if (flags.arg.length > 0) raw.args = flags.arg;
  if (flags['auth-env'] !== undefined) raw.auth = { env: flags['auth-env'] };
  if (flags['auth-scheme'] !== undefined) raw.auth = { ...(raw.auth ?? {}), scheme: flags['auth-scheme'] };
  if (flags['auth-header'] !== undefined) raw.auth = { ...(raw.auth ?? {}), header: flags['auth-header'] };
  return [parseSpec(compact(raw), { source: 'flags' })];
}

/**
 * @param {string[]} positionals
 * @param {Record<string, any>} flags
 * @returns {string[]}
 */
function selectClients(positionals, flags) {
  const ids = [...flags.client, ...positionals];
  if (ids.length === 0) throw new UsageError('name at least one client, or "all"');
  if (ids.includes('all')) {
    if (ids.length > 1) throw new UsageError('"all" cannot be combined with other clients');
    return CLIENTS.map((client) => client.id);
  }
  for (const id of ids) getClient(id);
  return [...new Set(ids)];
}

function renderList() {
  const rows = describeClients();
  const widths = {
    id: Math.max(4, ...rows.map((row) => row.id.length)),
    format: Math.max(6, ...rows.map((row) => row.format.length)),
    transports: Math.max(10, ...rows.map((row) => row.transports.length)),
    auth: Math.max(14, ...rows.map((row) => row.auth.length)),
  };
  const header = [
    'id'.padEnd(widths.id),
    'format'.padEnd(widths.format),
    'transport'.padEnd(widths.transports),
    'auth reference'.padEnd(widths.auth),
    'path',
  ].join('  ');
  const lines = [header, '-'.repeat(header.length)];
  for (const row of rows) {
    lines.push(
      [
        row.id.padEnd(widths.id),
        row.format.padEnd(widths.format),
        row.transports.padEnd(widths.transports),
        row.auth.padEnd(widths.auth),
        row.path,
      ].join('  '),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Merge one server into an existing JSON config, preserving every other key.
 * @param {string} existingText
 * @param {{ rootKey: string }} client
 * @param {Record<string, any>} document
 * @param {string} path
 * @returns {string}
 */
export function mergeJson(existingText, client, document, path) {
  if (existingText.trim() === '') return toJson(document);
  let parsed;
  try {
    parsed = JSON.parse(existingText);
  } catch (error) {
    throw new SpecError(
      `${path} is not plain JSON (${error.message}); refusing to rewrite it. Copy the printed snippet in, or re-run with --out`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SpecError(`${path} does not contain a JSON object`);
  }
  const bucket = parsed[client.rootKey];
  if (bucket !== undefined && (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket))) {
    throw new SpecError(`${path}: "${client.rootKey}" is not an object`);
  }
  return toJson({ ...parsed, [client.rootKey]: { ...(bucket ?? {}), ...document[client.rootKey] } });
}

/** Write through a temp sibling so a crash cannot truncate a live config. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/**
 * Run the CLI.
 * @param {string[]} argv - Arguments without the node/script prefix.
 * @param {{ stdout?: (text: string) => void, stderr?: (text: string) => void, env?: Record<string, string | undefined>, cwd?: string, home?: string }} [io]
 * @returns {number} Exit code.
 */
export function run(argv, io = {}) {
  const write = io.stdout ?? ((text) => process.stdout.write(text));
  const warn = io.stderr ?? ((text) => process.stderr.write(text));
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const home = io.home ?? homedir();

  try {
    const { positionals, flags } = parseArgs(argv);
    if (flags.help) {
      write(USAGE);
      return 0;
    }
    if (flags.list) {
      write(renderList());
      return 0;
    }

    const specs = loadSpecs(flags, { cwd, home });
    const clientIds = selectClients(positionals, flags);

    if (
      (flags.write === true || flags.out !== undefined) &&
      (clientIds.length !== 1 || specs.length !== 1)
    ) {
      throw new UsageError('--write and --out target one client and one server at a time');
    }

    /** @type {{ client: any, path: string, format: string, content: string, document?: unknown }[]} */
    const results = [];
    /** @type {{ client: string, reason: string }[]} */
    const skipped = [];
    for (const id of clientIds) {
      const client = getClient(id);
      for (const spec of specs) {
        try {
          const rendered = renderClientConfig(client, spec, {
            inline: flags.inline === true,
            env,
          });
          results.push({ client, path: client.path, spec, ...rendered });
        } catch (error) {
          // One server can be inexpressible for one client — no interpolation
          // syntax, or no documented stdio shape. In a multi-client run that is
          // a skip, not a reason to throw away the other nine renditions.
          if (clientIds.length === 1 || !(error instanceof SpecError)) throw error;
          skipped.push({ client: client.id, reason: error.message });
        }
      }
    }
    if (results.length === 0) {
      throw new SpecError(skipped[0]?.reason ?? 'no client could express this server');
    }

    if (flags.write === true) {
      const [result] = results;
      if (result.format !== 'json' || result.document === undefined) {
        throw new SpecError(
          `--write supports JSON client configs only; ${result.client.label} uses ${result.format}. Use --out, or paste the printed snippet`,
        );
      }
      const target = resolveClientPath(result.client, { cwd, home, profile: flags.profile });
      const existed = existsSync(target);
      const content = existed
        ? mergeJson(readFileSync(target, 'utf8'), result.client, result.document, target)
        : toJson(result.document);
      if (existed && flags.force === true) copyFileSync(target, `${target}.bak`);
      atomicWrite(target, content);
      warn(`mcp-config-gen: ${existed ? 'merged' : 'created'} ${target}\n`);
      return 0;
    }

    if (flags.out !== undefined) {
      const [result] = results;
      const target = flags.out === '~' ? home : flags.out.startsWith('~/')
        ? join(home, flags.out.slice(2))
        : resolve(cwd, flags.out);
      atomicWrite(target, result.content);
      warn(`mcp-config-gen: wrote ${target}\n`);
      return 0;
    }

    if (flags.json === true) {
      write(
        `${JSON.stringify(
          {
            results: results.map((result) => ({
              client: result.client.id,
              label: result.client.label,
              format: result.format,
              path: result.path,
              content: result.content,
            })),
            skipped,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    for (const entry of skipped) warn(`# skipped ${entry.client}: ${entry.reason}\n`);
    let previousClient = null;
    results.forEach((result, index) => {
      if (results.length > 1) {
        if (index > 0) write('\n');
        // One header per client, not one per server, so a multi-server run
        // reads as a list of targets rather than repeated noise.
        if (result.client.id !== previousClient) {
          warn(`# ${result.client.id} — ${result.client.label} → ${result.path}\n`);
          previousClient = result.client.id;
        } else {
          warn(`# ${result.client.id} — server "${result.spec.name}"\n`);
        }
      }
      write(result.content);
    });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      warn(`mcp-config-gen: ${error.message}\n`);
      warn('mcp-config-gen: try --help\n');
      return 2;
    }
    if (error instanceof SpecError) {
      warn(`mcp-config-gen: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export { USAGE };
