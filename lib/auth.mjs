/**
 * Better Auth integration for the native Node HTTP server.
 *
 * Authentication is deliberately kept separate from study-domain ownership:
 * Better Auth owns users/sessions/accounts; server.mjs owns user_id scoping
 * for questions, attempts, notes, conversations, and AI configuration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';

let auth = null;
let authDb = null;

function persistedSecret(dataDir) {
  const supplied = String(process.env.BETTER_AUTH_SECRET || '').trim();
  if (supplied) return supplied;

  const filename = path.join(dataDir, '.better-auth-secret');
  try {
    const existing = fs.readFileSync(filename, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}

  const generated = randomBytes(48).toString('base64url');
  fs.writeFileSync(filename, `${generated}\n`, { mode: 0o600 });
  try { fs.chmodSync(filename, 0o600); } catch {}
  return generated;
}

/** Initialise auth tables and return the Better Auth instance. */
export async function initAuth({ dataDir, port, baseURL } = {}) {
  if (auth) return auth;
  const dir = path.resolve(String(dataDir || process.env.APP_DATA_DIR || './data'));
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'auth.db');
  authDb = new DatabaseSync(dbFile, { timeout: 10000 });
  authDb.exec('PRAGMA journal_mode = WAL');

  const localBase = String(baseURL || process.env.BETTER_AUTH_URL || `http://127.0.0.1:${Number(port || 3000)}`).replace(/\/$/, '');
  const trustedOrigins = [...new Set([
    localBase,
    `http://localhost:${Number(port || 3000)}`,
    `http://127.0.0.1:${Number(port || 3000)}`,
  ])];

  auth = betterAuth({
    baseURL: localBase,
    secret: persistedSecret(dir),
    trustedOrigins,
    database: authDb,
    advanced: {
      database: {
        // We run the generated migrations during startup so a fresh data
        // directory works without a separate CLI step.
        validateSchema: false,
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: process.env.AUTH_DISABLE_SIGNUP === '1',
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  });

  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  return auth;
}

export function getAuth() {
  if (!auth) throw new Error('认证模块尚未初始化');
  return auth;
}

/** Native Node request/response adapter for /api/auth/* routes. */
export function authRequestHandler() {
  return toNodeHandler(getAuth());
}

/** Resolve the Better Auth session for a native Node IncomingMessage. */
export async function getAuthSession(req) {
  const result = await getAuth().api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return result || null;
}

export function closeAuth() {
  try { if (authDb) authDb.close(); } catch {}
  authDb = null;
  auth = null;
}

