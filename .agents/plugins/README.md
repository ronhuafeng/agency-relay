# Project plugins

`marketplace.json` owns plugin sources. Each Git source's `ref` selects the
tracking branch; `sha` selects the committed installation revision.
The project `.codex/config.toml` owns enablement. Plugin code stays in Codex's
host-local cache, not this repository.

From a trusted checkout, install or refresh the declared plugins:

```sh
plugin_repo_root=$(git rev-parse --show-toplevel)
for project_plugin in cloudflare stitch-design stitch-build stitch-utilities; do
  codex \
    -c 'marketplaces.agency-relay.source_type="local"' \
    -c "marketplaces.agency-relay.source=\"$plugin_repo_root\"" \
    plugin add "$project_plugin@agency-relay"
done
```

The marketplace overrides apply only to those commands. They do not register
this checkout globally. Keep these plugin IDs disabled in user configuration
and enabled in project configuration. The CLI installer can enable a plugin
in user configuration; check that setting after each install or refresh.

The [Plugin updates workflow](../../.github/workflows/plugin-updates.yml) checks
every declared Git plugin daily at 09:17 Asia/Shanghai and can be run manually.
GitHub may delay scheduled runs. It resolves each tracking branch once, updates
the `sha` selectors, runs `codex plugin marketplace upgrade`, and verifies each
plugin with the native installer. For this local marketplace, `marketplace
upgrade` alone does not advance plugin selectors; the revision updater owns that
Git change. Unsupported source kinds or failed resolution/installation stop the
run before publication.

Only changed selectors produce a `chore(plugins): update upstream plugin
revisions` commit directly on `main`. No upstream code or runner cache is
committed. The workflow uses the repository's `GITHUB_TOKEN`; its push does not
start another push workflow. Plugin validation runs before publication, not the
full product CI. A concurrent `main` change rejects the push rather than forcing
or retrying it.

Following `main` is not live host synchronization. Pull the project, refresh the
installed plugins, verify the loaded content, and start a new session. A new
host needs its own installation and authentication. Hosts that have not refreshed
can still have an older installed revision.

Stitch uses the existing project MCP connection. Set `STITCH_API_KEY` in the
environment of the Codex process before starting a session. The shared config
maps it to `X-Goog-Api-Key` with native `env_http_headers`; it contains no key
value. A host that does not supply the variable has no Stitch API-key
authentication from this configuration.

The Cloudflare plugin bundles its upstream MCP connection; account access needs
separate host-local authentication. Keep credentials outside committed plugin
configuration.
