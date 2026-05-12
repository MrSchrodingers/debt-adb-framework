# T4 — Plugin Architecture Deep-dive

> **Tipo**: Comparação + design decision | **Subagent**: general-purpose + WebSearch + Read | **STATUS**: ANSWERED
> **Tokens**: ~65k | **Duração**: 97s

## Current Dispatch Plugin SDK (summary)

- **Single context object** `PluginContext` exposed by `loader.ts:126-234` — bundles enqueue, sender resolution, ADB intent (`registerContact`), device mutex, event subscription, route registration, logger, idempotency cache, blacklist. (`packages/core/src/plugins/types.ts:22-55`)
- **Plugin contract** `DispatchPlugin { name, version, events, webhookUrl, init(ctx), destroy() }` — no manifest file; loaded by direct instantiation. (`types.ts:10-18`)
- **Lifecycle** is `init`-then-stay-resident; `destroyAll` exists but no hot-reload (`loader.ts:101-120`).
- **Event delivery** uses Node `EventEmitter` with 5s timeout per handler, dispatched via `Promise.allSettled`, no priorities, no replay (`plugin-event-bus.ts:47-80`).
- **Outbound callbacks**: HMAC-signed, at-least-once, persisted to `failed_callbacks`, exponential backoff (`callback-delivery.ts:114-308`).
- **Pain point**: `adb-precheck` ships 4340 LOC of its own pipedrive HTTP client + token-bucket + activity store + publisher (`adb-precheck/pipedrive-client.ts:1-50` reimplements rate limiting that Dispatch already does for ADB). A future `chatwoot-sync` or `salesforce` plugin would duplicate it again.

## Comparable Products — Key Patterns

- **VS Code**: Activation events (`onLanguage`, `onCommand`) + JSON `contributes` manifest gate the loader; extensions live in a separate Extension Host process; cross-extension API via `exports` on `activate()` ([docs](https://code.visualstudio.com/api/references/activation-events), retrieved 2026-05-12).
- **Backstage**: `ApiRef` + `ApiFactory` + `ApiRegistry` — typed dependency injection. Plugins declare deps; app composes implementations. `useApi(errorApiRef)` swaps in tests ([docs](https://backstage.io/docs/api/utility-apis/), 2026-05-12).
- **Vite**: Ordered hook pipeline (`config → configResolved → resolveId → load → transform`) with `handleHotUpdate` for HMR. Shared services injected through hook context, not a god object ([docs](https://vite.dev/guide/api-plugin), 2026-05-12).
- **n8n**: `helpers.httpRequestWithAuthentication.call(this, 'firebaseCredentials', options)` — core owns HTTP + auth; nodes only declare *which* credential ([docs](https://docs.n8n.io/integrations/creating-nodes/build/reference/http-helpers/), 2026-05-12).
- **Probot**: `context.octokit` is a pre-authenticated, rate-limited client every app receives — apps never construct GitHub HTTP clients ([docs](https://probot.github.io/docs/development/), 2026-05-12).
- **Strapi**: `register / bootstrap / destroy` lifecycle; shared services via `strapi.plugin('name').service('foo')` registry — sibling plugins reuse each other's services ([docs](https://docs.strapi.io/cms/plugins-development/server-api), 2026-05-12).
- **Terraform**: Each provider runs as a separate process over gRPC; absolute isolation, ABI defined by `.proto` ([docs](https://developer.hashicorp.com/terraform/plugin/framework), 2026-05-12).
- **Sentry**: `Sentry.addIntegration()` allows runtime hot-add post-init; integrations expose `setupOnce`, `setup`, `processEvent` ([docs](https://docs.sentry.io/platforms/javascript/configuration/integrations/), 2026-05-12).

## Common Patterns to Adopt

1. **Service registry vs god context** — Backstage/Strapi/n8n separate the *context* (logger, plugin identity) from the *service registry* (HTTP, auth, integrations). Adding a service doesn't change `PluginContext`'s shape.
2. **Pre-built authenticated clients shared by core** — Probot's `context.octokit` and n8n's `httpRequestWithAuthentication` prove that auth + rate-limit + retry belong in the host, not the plugin.
3. **Manifest + activation events** — VS Code/Strapi declarative manifests let core load lazily, validate version/capabilities, and surface deps in admin UI.

## Anti-patterns to Avoid

- **God-context bloat** — VS Code's monolithic `vscode.*` namespace forces every extension to import a heavy surface; PluginContext is already growing the same way (12 fields, 2 optional escape hatches).
- **Sync hooks blocking the hot path** — Vite explicitly bans sync `transform`. Our `executeWithTimeout` (5s) helps, but unbounded handlers can still backpressure the event emitter.
- **No process boundary + no version pinning** — Terraform's gRPC isolation prevents a broken provider from crashing core; we run all plugins in-process with no ABI guarantee, so a typo in adb-precheck takes Dispatch down.

## 3 Concrete Design Decisions for Dispatch v2 Roadmap

- **D1: Introduce `ctx.services` registry with first-class Pipedrive client** — Move `pipedrive-client.ts` + token bucket + activity store from `adb-precheck` into `packages/core/src/services/pipedrive/`. Expose via `ctx.services.pipedrive.createNote(...)` mirroring Probot's `context.octokit`. Plugins declare `requires: ['pipedrive']` in manifest; core injects a singleton instance with shared auth cache + rate-limit pool. Removes ~2k LOC duplication; future `salesforce`/`hubspot` plugins follow the same pattern. **Ref**: Probot, n8n.
- **D2: Plugin manifest (`dispatch-plugin.json`) with capabilities, activation events, and SDK semver range** — Replace direct `DispatchPlugin` import with declarative manifest declaring `events`, `routes`, `services`, `sdkVersion: "^2.0.0"`. Loader validates manifest, warns on incompatible SDK, enables lazy load on first matching event. **Ref**: VS Code, Strapi.
- **D3: Hot-reload via versioned destroy + re-init (no process boundary yet)** — Extend `loader.ts` with `reloadPlugin(name)` that calls `destroy()`, drains in-flight callbacks, then re-runs `init()` with a fresh context. Gate behind `DISPATCH_ENV=development`. Defer Terraform-style gRPC isolation as v3. Vite's `handleHotUpdate` shows the contract; combined with the manifest from D2 (version bump triggers reload), this unblocks plugin authors without core restart. **Ref**: Sentry `addIntegration`, Vite HMR.
