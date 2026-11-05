import assert from 'node:assert/strict';
import test from 'node:test';

import { toJson, toYaml, tomlKey, tomlString, tomlTable, tomlValue, yamlTag } from '../src/emit.js';

test('toJson indents with two spaces and ends with a newline', () => {
  assert.equal(toJson({ a: 1 }), '{\n  "a": 1\n}\n');
});

test('toYaml nests maps and arrays at the documented indentation', () => {
  assert.equal(toYaml({ a: { b: [1, 'x'] } }), 'a:\n  b:\n    - 1\n    - "x"\n');
});

test('toYaml aligns the first key of a block list item with the dash', () => {
  assert.equal(toYaml([{ a: 1, b: { c: 2 } }]), '- a: 1\n  b:\n    c: 2\n');
});

test('toYaml quotes scalars that a parser would otherwise retype', () => {
  const yaml = toYaml({ a: 'yes', b: 'null', c: '1.0', d: 1.0, e: true });
  assert.equal(yaml, 'a: "yes"\nb: "null"\nc: "1.0"\nd: 1\ne: true\n');
});

test('toYaml escapes strings rather than breaking the document', () => {
  const yaml = toYaml({ 'a: b': 'line\nbreak "quoted"' });
  assert.equal(yaml, '"a: b": "line\\nbreak \\"quoted\\""\n');
});

test('toYaml emits an explicit tag for a Cordis expression', () => {
  const yaml = toYaml({ Authorization: yamlTag('!!js', '`Bearer ${process.env.K}`') });
  assert.equal(yaml, 'Authorization: !!js "`Bearer ${process.env.K}`"\n');
});

test('toYaml handles empty collections', () => {
  assert.equal(toYaml({ a: [], b: {} }), 'a: []\nb: {}\n');
});

test('tomlString escapes the characters TOML would misread', () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(tomlString('a\nb\tc'), '"a\\nb\\tc"');
  assert.equal(tomlString('\u0001'), '"\\u0001"');
});

test('tomlKey quotes only when it has to', () => {
  assert.equal(tomlKey('mcp_servers'), 'mcp_servers');
  assert.equal(tomlKey('my.server'), '"my.server"');
});

test('tomlValue supports arrays of strings and inline tables', () => {
  assert.equal(tomlValue(['a', 'b']), '["a", "b"]');
  assert.equal(tomlValue({ a: 'b' }), '{ a = "b" }');
  assert.equal(tomlValue({}), '{}');
  assert.throws(() => tomlValue(undefined), /cannot emit undefined to TOML/);
});

test('tomlTable skips undefined and ends with a newline', () => {
  const table = tomlTable(['mcp_servers', 'x'], { url: 'https://e.com', args: undefined });
  assert.equal(table, '[mcp_servers.x]\nurl = "https://e.com"\n');
});

test('tomlTable quotes a dotted server name', () => {
  assert.equal(tomlTable(['mcp_servers', 'a.b'], { url: 'u' }), '[mcp_servers."a.b"]\nurl = "u"\n');
});
