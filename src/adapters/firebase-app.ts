import type { App } from "firebase-admin/app";

export function assertFirebaseAppMatchesProject(app: App, projectId: string): void {
  if (app.options.projectId === projectId) return;
  throw new Error(`Firebase app "${app.name}" is configured for a different project`);
}
