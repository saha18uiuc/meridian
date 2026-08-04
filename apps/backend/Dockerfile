# The Temporal worker.
#
# It gets a container rather than a serverless function because it is not a request handler: it holds
# long-poll connections to Temporal, runs workflows that sleep for days, and has to survive between
# activities. Vercel can host the web app; it cannot host this.
#
# Built from the repository root, not from this directory:
#
#   docker build -f apps/backend/Dockerfile -t meridian-worker .

# ------------------------------------------------------------------------------------------- build
FROM node:22.16.0-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Playwright is a dependency of the agent kit's browser tool, and its postinstall would fetch a
# browser binary. The worker never opens one in mock mode, and on a free tier whose whole disk is
# measured in gigabytes that download is a large fraction of the budget.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Manifests first, so a dependency install is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/agent-kit/package.json ./packages/agent-kit/
COPY packages/evals/package.json ./packages/evals/
COPY packages/ops/package.json ./packages/ops/
COPY generated-agents/package.json ./generated-agents/
RUN pnpm install --frozen-lockfile

COPY . .

# `apps/backend` and its project references only. A full `tsc -b` would also compile the test suite,
# the ops scripts, and the web app — none of which this image runs, and the test sources are excluded
# from the build context anyway.
RUN pnpm build:worker

# ----------------------------------------------------------------------------------------- runtime
# A second image rather than a copy of the first. Carrying the build stage over wholesale produced
# 3.3 GB, because it includes every dev dependency in the workspace — Next, React, the Playwright
# test runner, Vitest, TypeScript — none of which the worker loads. Here the dependencies are
# installed again from the same lockfile, restricted to what `@meridian/backend` actually needs.
FROM node:22.16.0-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable

# Temporal Cloud is reached over TLS, and the Temporal SDK's transport is Rust: it reads the system
# trust store rather than the CA bundle Node carries internally. `node:*-slim` ships no certificates,
# so without this the worker dies at startup with `NativeCertsNotFound` and nothing about the message
# suggests the container is what is missing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# `apps/web` is present as a manifest only. It is a workspace member, so omitting it entirely makes
# `--frozen-lockfile` reject the lockfile as out of date; the filter below stops its dependencies
# from being installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/agent-kit/package.json ./packages/agent-kit/
COPY packages/evals/package.json ./packages/evals/
COPY packages/ops/package.json ./packages/ops/
COPY generated-agents/package.json ./generated-agents/
RUN pnpm install --frozen-lockfile --prod --filter "@meridian/backend..."

# The compiled output of the worker and every workspace package it imports. The `package.json`
# copied above make the symlinks resolve; these make them resolve to something.
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/agent-kit/dist ./packages/agent-kit/dist
COPY --from=build /app/packages/evals/dist ./packages/evals/dist
COPY --from=build /app/packages/ops/dist ./packages/ops/dist
COPY --from=build /app/generated-agents/dist ./generated-agents/dist
COPY --from=build /app/apps/backend/dist ./apps/backend/dist

# Not build artefacts but inputs the worker reads at run time: in mock mode the tool factory opens
# these `.eml` files and `index.json` the way it would open a mailbox.
COPY examples ./examples

# Overridden by hosts that inject their own port; Koyeb, for one, expects the process to listen on
# whatever it passes in.
ENV WORKER_HEALTH_PORT=9464
EXPOSE 9464

# Declared in the image so each platform's config does not have to restate it. `server.listen(port)`
# binds every interface, which is what lets an external probe reach it at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/backend/dist/temporal/worker.js"]
