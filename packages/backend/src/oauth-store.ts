/**
 * Server-side OAuth credential storage.
 * Persists credentials to a JSON file so they survive restarts.
 */

import fs from "node:fs";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

export interface OAuthStore {
  get(providerId: string): OAuthCredentials | undefined;
  set(providerId: string, credentials: OAuthCredentials): void;
  delete(providerId: string): void;
  listProviderIds(): string[];
}

export function createOAuthStore(storagePath: string): OAuthStore {
  const dir = path.dirname(storagePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let credentials: Record<string, OAuthCredentials> = {};

  // Load existing credentials
  if (fs.existsSync(storagePath)) {
    try {
      credentials = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
    } catch {
      credentials = {};
    }
  }

  function save() {
    fs.writeFileSync(storagePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  }

  return {
    get(providerId) {
      return credentials[providerId];
    },
    set(providerId, creds) {
      credentials[providerId] = creds;
      save();
    },
    delete(providerId) {
      delete credentials[providerId];
      save();
    },
    listProviderIds() {
      return Object.keys(credentials);
    },
  };
}
