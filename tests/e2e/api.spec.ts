import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiFor, anonApiFor, EMAIL } from "./tenant-fixtures";

const baseURL = process.env.BASE_URL || "http://localhost:3000";

test.describe("API Endpoints", () => {
  let admin: APIRequestContext;

  test.beforeAll(async () => {
    admin = await apiFor(baseURL, EMAIL.admin);
  });

  test.afterAll(async () => {
    await admin?.dispose().catch(() => undefined);
  });

  test("protected endpoints reject anonymous callers with 401", async () => {
    const anon = await anonApiFor(baseURL);
    try {
      for (const path of [
        "/api/inventory",
        "/api/warehouses",
        "/api/farms",
        "/api/transactions",
        "/api/reports?type=dashboard",
      ]) {
        const response = await anon.get(path);
        expect(response.status(), `${path} must require authentication`).toBe(401);
      }
    } finally {
      await anon.dispose();
    }
  });

  test("GET /api/inventory returns items", async () => {
    const response = await admin.get("/api/inventory");
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    // Response should have data or be an array
    expect(data).toBeTruthy();
  });

  test("GET /api/warehouses returns warehouses", async () => {
    const response = await admin.get("/api/warehouses");
    expect(response.ok()).toBeTruthy();
  });

  test("GET /api/categories returns categories", async () => {
    const response = await admin.get("/api/categories");
    expect(response.ok()).toBeTruthy();
  });

  test("GET /api/suppliers returns suppliers", async () => {
    const response = await admin.get("/api/suppliers");
    expect(response.ok()).toBeTruthy();
  });

  test("GET /api/farms returns farms", async () => {
    const response = await admin.get("/api/farms");
    expect(response.ok()).toBeTruthy();
  });

  test("GET /api/alerts returns alerts with summary", async () => {
    const response = await admin.get("/api/alerts?type=all");
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("alerts");
    expect(data).toHaveProperty("summary");
    expect(data.summary).toHaveProperty("totalAlerts");
  });

  test("GET /api/reports?type=dashboard returns dashboard data", async () => {
    const response = await admin.get("/api/reports?type=dashboard");
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toBeTruthy();
  });

  test("GET /api/intelligence returns analysis data", async () => {
    const response = await admin.get("/api/intelligence");
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toBeTruthy();
  });

  test("POST /api/batches/split returns 405 for GET", async () => {
    const response = await admin.get("/api/batches/split");
    expect(response.status()).toBe(405);
  });

  test("POST /api/batches/transfer returns 405 for GET", async () => {
    const response = await admin.get("/api/batches/transfer");
    expect(response.status()).toBe(405);
  });

  test("GET /api/webhooks returns webhook list", async () => {
    const response = await admin.get("/api/webhooks");
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("webhooks");
    expect(data).toHaveProperty("availableEvents");
  });

  test("GET /api/api-keys returns API key list", async () => {
    const response = await admin.get("/api/api-keys");
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("apiKeys");
  });

  test("External API requires auth header", async () => {
    const anon = await anonApiFor(baseURL);
    try {
      const response = await anon.get("/api/external/inventory");
      expect(response.status()).toBe(401);
      const data = await response.json();
      expect(data).toHaveProperty("error");
    } finally {
      await anon.dispose();
    }
  });

  test("GET /api/export/excel returns Excel file", async () => {
    const response = await admin.get("/api/export/excel?type=inventory");
    expect(response.ok()).toBeTruthy();
    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("spreadsheetml");
  });

  test("GET /api/export/pdf returns PDF file", async () => {
    const response = await admin.get("/api/export/pdf?type=summary");
    expect(response.ok()).toBeTruthy();
    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("pdf");
  });

  test("POST without CSRF origin is rejected on protected routes", async () => {
    const anon = await anonApiFor(baseURL);
    try {
      const response = await anon.post("/api/transactions", {
        headers: { "Content-Type": "application/json" },
        data: { type: "RECEIVED", batchId: "test", quantity: 1 },
      });
      // Should be CSRF blocked (403) or auth blocked (401/403)
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await anon.dispose();
    }
  });
});
