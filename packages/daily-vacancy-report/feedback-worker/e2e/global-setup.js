import { request } from "@playwright/test";

import { BASE_URL, reportStatus } from "./fixtures.js";

export default async function globalSetup() {
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    await reportStatus(api);
  } finally {
    await api.dispose();
  }
}
