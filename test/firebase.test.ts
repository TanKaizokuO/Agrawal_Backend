import { afterEach, describe, expect, it } from "vitest";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { createFirebaseAdminPushSender } from "../src/adapters/fcm.js";

const serviceAccountJson = JSON.stringify({
  project_id: "service-account-project",
  client_email: "firebase-test@example.test",
  private_key: "not-used-when-an-existing-app-is-rejected",
});

async function deleteNamedApps(): Promise<void> {
  await Promise.all(
    getApps()
      .filter((app) => app.name === "agrawal-notifications-staging")
      .map((app) => deleteApp(app)),
  );
}

afterEach(async () => {
  await deleteNamedApps();
});

describe("Firebase app reuse", () => {
  it("rejects an environment app reused for a different project", () => {
    initializeApp({ projectId: "first-project" }, "agrawal-notifications-staging");

    expect(() => createFirebaseAdminPushSender({
      projectId: "second-project",
      serviceAccountJson,
      environment: "staging",
    })).toThrow(/different project/u);
  });
});
