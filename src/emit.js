/**
 * Minimal, dependency-free serializers for the three config formats this tool
 * has to emit: JSON, TOML and YAML.
 *
 * They are deliberately narrow — they only understand the value shapes an MCP
 * client config needs (maps, arrays, strings, numbers, booleans). That is the
 * point: a general-purpose YAML/TOML writer is a liability here, because every
 * client parses its config with a different parser (JSONC, TOML 1.0, YAML 1.2,
 * the Cordis loader) and a subtly wrong quoting style breaks the file at load
 * time, not at generation time.
 */

const TAG = Symbol('yaml.tag');

/**
 * Wrap a value in an explicit YAML tag, e.g. Cordis' `!!js` expression tag.
 * @param {string} tag - Tag including the leading `!!`.
 * @param {string} value - Scalar payload, emitted double-quoted.
 * @returns {{ [TAG]: string, value: string }}
 */
export function yamlTag(tag, value) {
  return { [TAG]: tag, value };
}

const isTagged = (value) => typeof value === 'object' && value !== null && TAG in value;
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !isTagged(value);
const isEmptyCollection = (value) =>
  (Array.isArray(value) && value.length === 0) ||
  (isPlainObject(value) && Object.keys(value).length === 0);
/** Values that can sit on the same line as their key or list dash. */
const isInline = (value) =>
  isTagged(value) || isEmptyCollection(value) || (!Array.isArray(value) && !isPlainObject(value));

/**
 * Emit a JSON document.
 * @param {unknown} value
 * @returns {string} Two-space-indented JSON with a trailing newline.
 */
export function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {unknown} value
 * @returns {string} A YAML scalar. Strings are always double-quoted: JSON's
 * escaping rules are a strict subset of YAML's double-quoted style, so this is
 * valid YAML 1.2 and cannot accidentally produce a bool/number/null scalar or
 * a value that a parser reads as a different string.
 */
function yamlScalar(value) {
  if (isTagged(value)) return `${value[TAG]} ${JSON.stringify(String(value.value))}`;
  if (Array.isArray(value) && value.length === 0) return '[]';
  if (isPlainObject(value) && Object.keys(value).length === 0) return '{}';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot emit a non-finite number to YAML');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  throw new TypeError(`cannot emit ${typeof value} to YAML`);
}

/**
 * @param {string} key
 * @returns {string} The key, bare when unambiguous, quoted otherwise.
 */
function yamlKey(key) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Render a value as YAML lines, with no trailing newline.
 * @param {unknown} value
 * @param {number} [indent] - Indentation of the block's first line.
 * @returns {string[]}
 */
export function yamlLines(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (isTagged(value)) return [`${pad}${value[TAG]} ${JSON.stringify(value.value)}`];

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines = [];
    for (const item of value) {
      if (isInline(item)) {
        lines.push(`${pad}- ${yamlScalar(item)}`);
        continue;
      }
      // A block item keeps its own indentation, with the marker spliced over
      // the first line's leading spaces so `- ` and the child align.
      const inner = yamlLines(item, indent + 2);
      inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
      lines.push(...inner);
    }
    return lines;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}{}`];
    const lines = [];
    for (const [key, item] of entries) {
      if (isInline(item)) lines.push(`${pad}${yamlKey(key)}: ${yamlScalar(item)}`);
      else lines.push(`${pad}${yamlKey(key)}:`, ...yamlLines(item, indent + 2));
    }
    return lines;
  }

  return [`${pad}${yamlScalar(value)}`];
}

/**
 * Emit a YAML document.
 * @param {unknown} value
 * @returns {string} Document text with a trailing newline.
 */
export function toYaml(value) {
  return `${yamlLines(value, 0).join('\n')}\n`;
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} key
 * @returns {string} A TOML key segment.
 */
export function tomlKey(key) {
  if (!TOML_BARE_KEY.test(key)) return JSON.stringify(key);
  return key;
}

/**
 * @param {string} value
 * @returns {string} A TOML basic string.
 */
export function tomlString(value) {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/**
 * @param {unknown} value
 * @returns {string} A TOML value.
 */
export function tomlValue(value) {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('cannot emit a non-finite number to TOML');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    // A TOML inline table covers the nested maps a config needs (env,
    // http_headers) without opening a new table header mid-document.
    return `{ ${entries.map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`).join(', ')} }`;
  }
  throw new TypeError(`cannot emit ${typeof value} to TOML`);
}

/**
 * Emit a single TOML table.
 * @param {string[]} path - Table path segments, quoted as needed.
 * @param {Record<string, unknown>} entries - Keys with `undefined` are skipped.
 * @returns {string} Table text with a trailing newline.
 */
export function tomlTable(path, entries) {
  const header = `[${path.map(tomlKey).join('.')}]`;
  const body = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    body.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  }
  return `${[header, ...body].join('\n')}\n`;
}
