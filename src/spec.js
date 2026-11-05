/**
 * The canonical server description every client renderer consumes.
 *
 * One shape, validated once, so that a client's quirks stay in that client's
 * renderer instead of leaking into the CLI or into the other nine clients.
 */

/** Anything the user can fix by editing their input. */
export class SpecError extends Error {
  /** @param {string} message @param {{ field?: string }} [details] */
  constructor(message, { field } = {}) {
    super(message);
    this.name = 'SpecError';
    this.field = field;
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELDS = new Set([
  'name',
  'transport',
  'url',
  'headers',
  'auth',
  'command',
  'args',
  'env',
]);
const AUTH_FIELDS = new Set(['env', 'header', 'scheme']);

/** @param {unknown} value @param {string} field @param {string} source */
function requireString(value, field, source) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SpecError(`${source}: "${field}" must be a non-empty string`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} source */
function requireStringMap(value, field, source) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SpecError(`${source}: "${field}" must be an object of string values`, { field });
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new SpecError(`${source}: "${field}.${key}" must be a string`, { field });
    }
    out[key] = item;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} source
 * @returns {{ env: string, header: string, scheme: string }}
 */
function parseAuth(value, source) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SpecError(`${source}: "auth" must be an object`, { field: 'auth' });
  }
  for (const key of Object.keys(value)) {
    if (!AUTH_FIELDS.has(key)) {
      throw new SpecError(
        `${source}: "auth" has unknown field "${key}" (known: ${[...AUTH_FIELDS].join(', ')})`,
        { field: 'auth' },
      );
    }
  }
  const env = requireString(/** @type {any} */ (value).env, 'auth.env', source);
  if (!ENV_NAME_PATTERN.test(env)) {
    throw new SpecError(
      `${source}: "auth.env" must be an environment variable name, got ${JSON.stringify(env)}`,
      { field: 'auth.env' },
    );
  }
  const header = /** @type {any} */ (value).header ?? 'Authorization';
  const scheme = /** @type {any} */ (value).scheme ?? 'Bearer';
  return {
    env,
    header: requireString(header, 'auth.header', source),
    scheme: typeof scheme === 'string' ? scheme : '',
  };
}

/**
 * Validate one server description.
 * @param {unknown} input - Parsed JSON body of one server.
 * @param {{ source?: string }} [options]
 * @returns {{
 *   name: string,
 *   transport: 'http' | 'stdio',
 *   url?: string,
 *   headers: Record<string, string>,
 *   auth?: { env: string, header: string, scheme: string },
 *   command?: string,
 *   args: string[],
 *   env: Record<string, string>,
 * }}
 */
export function parseSpec(input, { source = 'spec' } = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SpecError(`${source}: expected an object describing one server`);
  }
  const raw = /** @type {Record<string, unknown>} */ (input);
  for (const key of Object.keys(raw)) {
    if (!FIELDS.has(key)) {
      throw new SpecError(
        `${source}: unknown field "${key}" (known: ${[...FIELDS].sort().join(', ')})`,
        { field: key },
      );
    }
  }

  const name = requireString(raw.name, 'name', source);
  if (!NAME_PATTERN.test(name)) {
    throw new SpecError(
      `${source}: "name" must match ${NAME_PATTERN} (letters, digits, "_", "." and "-", max 64) — got ${JSON.stringify(name)}`,
      { field: 'name' },
    );
  }

  const transport =
    raw.transport ?? (raw.url !== undefined ? 'http' : raw.command !== undefined ? 'stdio' : undefined);
  if (transport === undefined) {
    throw new SpecError(
      `${source}: cannot tell the transport — set "transport", or give "url" (http) / "command" (stdio)`,
      { field: 'transport' },
    );
  }
  if (transport !== 'http' && transport !== 'stdio') {
    throw new SpecError(
      `${source}: "transport" must be "http" or "stdio", got ${JSON.stringify(transport)}`,
      { field: 'transport' },
    );
  }

  /** @type {any} */
  const spec = { name, transport, headers: {}, args: [], env: {} };

  if (transport === 'http') {
    for (const field of ['command', 'args', 'env']) {
      if (raw[field] !== undefined) {
        throw new SpecError(
          `${source}: "${field}" belongs to the stdio transport, but this server is http`,
          { field },
        );
      }
    }
    const url = requireString(raw.url, 'url', source);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new SpecError(`${source}: "url" is not an absolute URL: ${JSON.stringify(url)}`, {
        field: 'url',
      });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new SpecError(
        `${source}: "url" must be http(s), got ${JSON.stringify(parsed.protocol)}`,
        { field: 'url' },
      );
    }
    spec.url = parsed.toString();
    if (raw.headers !== undefined) spec.headers = requireStringMap(raw.headers, 'headers', source);
    if (raw.auth !== undefined) spec.auth = parseAuth(raw.auth, source);
    return spec;
  }

  for (const field of ['url', 'headers', 'auth']) {
    if (raw[field] !== undefined) {
      throw new SpecError(
        `${source}: "${field}" belongs to the http transport, but this server is stdio`,
        { field },
      );
    }
  }
  spec.command = requireString(raw.command, 'command', source);
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== 'string')) {
      throw new SpecError(`${source}: "args" must be an array of strings`, { field: 'args' });
    }
    spec.args = [...raw.args];
  }
  if (raw.env !== undefined) spec.env = requireStringMap(raw.env, 'env', source);
  return spec;
}

/**
 * Validate one or many servers.
 *
 * Accepts a bare array, `{ servers: [...] }`, or a single object.
 * @param {unknown} input
 * @param {{ source?: string }} [options]
 * @returns {ReturnType<typeof parseSpec>[]}
 */
export function parseSpecs(input, { source = 'spec' } = {}) {
  if (Array.isArray(input)) return input.map((item, i) => parseSpec(item, { source: `${source}[${i}]` }));
  if (typeof input === 'object' && input !== null && 'servers' in input) {
    const servers = /** @type {any} */ (input).servers;
    if (!Array.isArray(servers)) throw new SpecError(`${source}: "servers" must be an array`);
    return servers.map((item, i) => parseSpec(item, { source: `${source}.servers[${i}]` }));
  }
  return [parseSpec(input, { source })];
}
