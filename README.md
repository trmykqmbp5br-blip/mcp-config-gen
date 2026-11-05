# mcp-config-gen

One MCP server definition in, every client's config file out.

A single remote MCP server looks like this to four different clients — same
server, same token, four formats, four file locations, three different
environment-variable syntaxes:

```jsonc
// Claude Code — .mcp.json
{ "mcpServers": { "anysearch": {
  "type": "http", "url": "https://api.anysearch.com/mcp",
  "headers": { "Authorization": "Bearer ${ANYSEARCH_API_KEY}" } } } }
```

```jsonc
// Cursor — .cursor/mcp.json  (no "type", different interpolation)
{ "mcpServers": { "anysearch": {
  "url": "https://api.anysearch.com/mcp",
  "headers": { "Authorization": "Bearer ${env:ANYSEARCH_API_KEY}" } } } }
```

```toml
# Codex — ~/.codex/config.toml  (TOML, and no header at all)
[mcp_servers.anysearch]
url = "https://api.anysearch.com/mcp"
bearer_token_env_var = "ANYSEARCH_API_KEY"
```

```yaml
# DeepSeek Harness — ~/.dsh/profiles/desktop/cordis.patch.yml (YAML, JS expression)
- insert:
    - id: "mcp-anysearch"
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "anysearch"
        transport: "streamable-http"
        url: "https://api.anysearch.com/mcp"
        headers:
          Authorization: !!js "`Bearer ${process.env.ANYSEARCH_API_KEY}`"
```

Writing that by hand once is fine. Keeping ten of them in sync is not, and
copy-pasting is how a key ends up committed to a repository. This tool takes
one JSON description and emits each client's correct shape — with a **load-time
reference to your environment instead of the secret itself**.

## Quick start

```bash
# Describe the server once (or pass the same fields as flags).
cat > anysearch.json <<'JSON'
{
  "name": "anysearch",
  "url": "https://api.anysearch.com/mcp",
  "headers": { "X-Anysearch-Client": "mcp/1.0.0" },
  "auth": { "env": "ANYSEARCH_API_KEY" }
}
JSON

node bin/mcp-config-gen.js claude-code --spec anysearch.json     # print the snippet
node bin/mcp-config-gen.js codex      --spec anysearch.json
node bin/mcp-config-gen.js dsh        --spec anysearch.json --profile desktop
node bin/mcp-config-gen.js all        --spec anysearch.json --json
```

Same thing without a spec file:

```bash
node bin/mcp-config-gen.js cursor --name anysearch \
  --url https://api.anysearch.com/mcp \
  --auth-env ANYSEARCH_API_KEY \
  --write
```

## Install

Requires Node.js 20 or newer. No dependencies, no build step.

```bash
git clone https://github.com/trmykqmbp5br-blip/mcp-config-gen.git
cd mcp-config-gen
node --test          # optional: 63 tests, no network
node bin/mcp-config-gen.js --list
```

`node bin/mcp-config-gen.js` is the whole CLI; there is nothing to install for
local use. Symlink it onto your `PATH` if you want `mcp-config-gen` directly.

## The server spec

A spec is one JSON object. `transport` is inferred from which fields you give.

| field | applies to | notes |
| --- | --- | --- |
| `name` | both | Config key. `[A-Za-z0-9][A-Za-z0-9_.-]*`, max 64. |
| `transport` | both | `http` or `stdio`. Inferred from `url` / `command`. |
| `url` | http | Absolute `http(s)` URL. |
| `headers` | http | Static headers, string → string. |
| `auth.env` | http | Environment variable holding the credential. |
| `auth.header` | http | Header to put it in. Default `Authorization`. |
| `auth.scheme` | http | Prefix. Default `Bearer`; `""` for a bare token. |
| `command` | stdio | Executable to launch. |
| `args` | stdio | Array of strings. |
| `env` | stdio | Literal environment for the child process. |

Unknown fields are rejected rather than ignored, so a typo like `headres` fails
loudly instead of silently producing a config without your header.

One file may hold several servers — either a bare array or `{ "servers": [ ... ] }`
(see [`examples/servers.json`](examples/servers.json)).

## Clients

`--list` prints this table from the same registry the renderers come from, so
it cannot drift from the code.

| id | format | transports | auth reference | config path |
| --- | --- | --- | --- | --- |
| `claude-code` | json | http, stdio | `${VAR}` | `.mcp.json` |
| `cursor` | json | http, stdio | `${env:VAR}` | `.cursor/mcp.json` |
| `vscode` | json | http, stdio | `${env:VAR}` | `.vscode/mcp.json` |
| `cline` | json | http, stdio | `${env:VAR}` | `~/.cline/data/settings/cline_mcp_settings.json` |
| `opencode` | json | http, stdio | `{env:VAR}` | `~/.config/opencode/opencode.json` |
| `antigravity` | json | http | literal only (`--inline`) | `~/.gemini/config/mcp_config.json` |
| `omp` | json | http | `${VAR}` | `.omp/mcp.json` |
| `codex` | toml | http, stdio | `bearer_token_env_var` | `~/.codex/config.toml` |
| `hermes` | yaml | http | `${VAR}` | `~/.hermes/config.yaml` |
| `dsh` | yaml | http, stdio | `` !!js `` `process.env` | `~/.dsh/profiles/{profile}/cordis.patch.yml` |

Paths without `~` are relative to the current directory (project scope); paths
with `~` are relative to your home directory (user scope). Each client records
the documentation page its shape was checked against in
[`src/clients.js`](src/clients.js).

Client configs change. If a shape is stale, the fix is one object in
`src/clients.js` plus one test — see [Adding a client](#adding-a-client).

## Secrets

By default nothing secret is ever written to disk or to stdout. `auth.env` is
rendered as the client's own load-time reference, so the config says "read
`ANYSEARCH_API_KEY`" and the value stays in your shell, your OS keychain, or
your service manager.

`--inline` is the escape hatch: it reads the variable from the environment at
generation time and embeds the literal value. It exists for clients with no
interpolation syntax at all — Antigravity, today — and for one-off setups where
a reference is not an option. It prints the secret into the snippet, so it is
never the default and never inferred.

`antigravity` therefore *fails* on a server with `auth` unless you pass
`--inline`, rather than writing `Bearer ${ANYSEARCH_API_KEY}` into a file whose
loader would treat it as a literal token.

## Writing files

Printing is the default and stdout carries only the snippet, so redirecting
works:

```bash
node bin/mcp-config-gen.js cursor --spec anysearch.json > /tmp/mcp.json
```

`--write` puts the snippet where that client expects it:

- JSON clients are **merged**: your other servers, and every other key in the
  file, are preserved. Installing the same server twice replaces that one entry
  instead of duplicating it.
- The file is written through a temp sibling and renamed, so an interrupted run
  cannot truncate a working config.
- A file with comments (JSONC, which VS Code allows) is **refused**, not
  round-tripped: a parser would silently delete your comments. Copy the printed
  snippet in instead.
- `--force` keeps a `.bak` and overwrites rather than merging.
- TOML and YAML clients are not merged yet — `--write` refuses them and tells
  you so. Use `--out <file>` or paste the snippet. Merging those formats
  without destroying comments and ordering is a bigger promise than this
  version makes.

## Several servers, several clients

`all` renders every client that can express a given server. When one client
cannot — no interpolation syntax, or no documented shape for that transport —
it is reported per client and skipped, never emitted half-right:

```bash
$ node bin/mcp-config-gen.js all --spec examples/servers.json --json
# stdout: { "results": [ ... ], "skipped": [ { "client": "antigravity", "reason": "..." } ] }
```

Exit codes: `0` success, `1` invalid input (bad spec, unreadable file,
unsupported request), `2` usage error.

## Library

```js
import { parseSpec, renderClientConfig } from 'mcp-config-gen';

const spec = parseSpec({
  name: 'anysearch',
  url: 'https://api.anysearch.com/mcp',
  auth: { env: 'ANYSEARCH_API_KEY' },
});

const { content, format } = renderClientConfig('codex', spec);
```

`renderClientConfig` accepts a client id or a client object from `CLIENTS`;
`context` can be `{ inline: true, env: {...} }` for the embedding case.

## Adding a client

1. Add one object to `JSON_CLIENTS` (or `FORMAT_CLIENTS` for TOML/YAML) in
   `src/clients.js`: `id`, `label`, `docs`, `path`, `scope`, `transports`,
   `format`, `interp`, and an `entry(spec, client, ctx)` — or a whole `render`.
2. Add a test in `test/clients.test.js` asserting the field names that client
   actually uses, and that it does not leak a secret when not inlined.
3. Run `node --test`. The README matrix and `--list` pick the client up
   automatically.

## What this does not do

- It does not install or run MCP servers, and it does not talk to them. It
  produces configuration.
- It does not verify that the URL serves MCP, or that a token is valid.
- It does not merge YAML or TOML configs (see above).
- `env` on a stdio server is passed through literally; it is not a secret
  channel. Keep real credentials in the child's own environment.

## Development

```bash
node --test                  # all tests, no network, no dependencies
node bin/mcp-config-gen.js --list
```

Layout: `src/spec.js` (validate one description), `src/clients.js` (one
renderer per client), `src/emit.js` (narrow JSON/TOML/YAML writers),
`src/cli.js` (argument parsing, merging, writing). The CLI is a thin shell over
the library, and `run()` takes its streams as arguments so it is tested
in-process.

If you have a real client installed, you can check a renderer against the real
loader instead of trusting the test. For DeepSeek Harness, for example, a
generated patch can be composed by the actual loader without booting anything:

```bash
node bin/mcp-config-gen.js dsh --name anysearch --url https://example.com/mcp \
  --auth-env ANYSEARCH_API_KEY --out /tmp/gen.yml
dsh --profile web --patch /tmp/gen.yml --dump-config   # entries, no warnings
```

## License

MIT.
