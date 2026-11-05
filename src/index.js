/**
 * Library entry point.
 *
 * The CLI is a thin shell over these functions; anything a script needs to do
 * is reachable here without reproducing the argument parsing.
 */

export { SpecError, parseSpec, parseSpecs } from './spec.js';
export { CLIENTS, describeClients, getClient, renderClientConfig, resolveClientPath } from './clients.js';
export { toJson, toYaml, toToml, tomlTable, tomlString, tomlKey, tomlValue, yamlLines, yamlTag } from './emit.js';
export { run, mergeJson, USAGE } from './cli.js';
