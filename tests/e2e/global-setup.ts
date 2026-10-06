import { ensureTenantFixtures } from "./tenant-fixtures";

/**
 * Playwright global setup — runs once before any spec file.
 *
 * Specs assume the E2E accounts and tenant data already exist: api.spec's
 * beforeAll logs in as e2e-admin before tenant-isolation.spec ever runs
 * (alphabetical file order). On a fresh database — CI creates a brand-new
 * one every run — nothing has created those users yet, so the first login
 * fails and the whole suite falls over.
 *
 * ensureTenantFixtures() is idempotent upserts with self-healing re-links,
 * so calling it here is safe locally (it repairs partial state from earlier
 * runs) and required in CI (empty database). It talks to the database
 * directly — no HTTP — so it is independent of webServer startup order.
 */
export default async function globalSetup(): Promise<void> {
  await ensureTenantFixtures();
}
