/**
 * Firebase app init and per-browser identity.
 *
 * This config is a public client identifier, not a secret — access is
 * governed by the rules files in the repo root (database.rules.json).
 */
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, push, ref, set, type Database } from 'firebase/database';
import { logger, type LogSink } from '../app/log.ts';

const log = logger('firebase');

export const firebaseConfig = {
  apiKey: 'AIzaSyBVsL2fuLBTdqEeCp4fwHpSsdt4c0-k23U',
  authDomain: 'smugglers-town-3d.firebaseapp.com',
  projectId: 'smugglers-town-3d',
  databaseURL: 'https://smugglers-town-3d-default-rtdb.firebaseio.com',
  appId: '1:54885431293:web:e8809ed1f2f06d069a4b94',
  messagingSenderId: '54885431293',
  storageBucket: 'smugglers-town-3d.firebasestorage.app'
};

let app: FirebaseApp | null = null;

export async function firebaseApp(): Promise<FirebaseApp> {
  if (!app) app = getApps()[0] ?? initializeApp(firebaseConfig);
  return app;
}

let identityPromise: Promise<string> | null = null;

/** Cached for the session — repeat callers get the same id without re-signing-in. */
export async function identity(): Promise<string> {
  if (!identityPromise) identityPromise = resolveIdentity();
  return identityPromise;
}

async function resolveIdentity(): Promise<string> {
  try {
    const credential = await signInAnonymously(getAuth(await firebaseApp()));
    log.info('signed in', { uid: credential.user.uid });
    return credential.user.uid;
  } catch (err) {
    log.error('sign-in failed', err);
    // the database rules bind every seat to auth.uid, so there is no useful
    // identity without a sign-in; say so instead of inventing one
    const code = (err as { code?: string }).code ?? '';
    throw new Error(`Sign-in failed${code ? ` (${code})` : ''}; the lobby needs Anonymous auth`);
  }
}

/** Log cap per page load, so a runaway loop cannot fill the database. */
const REMOTE_LOG_MAX = 300;

/**
 * Append-only remote log under logs/<session>. The rules let a signed-in
 * client write its own entries and nobody read them from a client; they
 * are read with the CLI (see docs/DEPLOY.md). The session id starts with
 * the uid so one player's entries are easy to find.
 */
export function remoteLogSink(uid: string): LogSink {
  const session = `${uid.slice(0, 8)}-${Date.now().toString(36)}`;
  let sent = 0;
  let db: Promise<Database> | null = null;
  log.info('remote log session', { session });
  return entry => {
    if (sent >= REMOTE_LOG_MAX) return;
    sent++;
    db ??= firebaseApp().then(app => getDatabase(app));
    void db.then(d => set(push(ref(d, `logs/${session}`)), { ...entry, u: uid })).catch(() => undefined);
  };
}
