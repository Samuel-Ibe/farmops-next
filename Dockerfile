# ─── Stage 1: Dependencies (pnpm only, frozen lockfile) ───────────────
FROM node:20-alpine AS deps
WORKDIR /app
# package.json pins pnpm via "packageManager", so corepack always uses the
# same pnpm version locally, in CI and in this image.
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The root postinstall runs `prisma generate`, so the schema must exist
# before install (this was missing and broke the image build).
COPY prisma/schema.prisma prisma/schema.prisma
RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ───────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ─── Stage 3: Production runtime ──────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Full application tree (Next.js server + Prisma client and query engine).
# The previous revision copied a `.next/standalone` folder that this project
# never produces (no `output: "standalone"`), so the image could not start —
# the CI Docker smoke test now catches that class of failure.
COPY --from=builder --chown=nextjs:nodejs /app ./

USER nextjs

EXPOSE 3000

CMD ["node", "node_modules/next/dist/bin/next", "start"]
