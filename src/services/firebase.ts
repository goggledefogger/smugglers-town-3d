/**
 * Firebase app init and per-browser identity.
 *
 * This config is a public client identifier, not a secret — access is
 * governed by the rules files in the repo root (database.rules.json).
 */
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';

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
    return credential.user.uid;
  } catch (err) {
    // the database rules bind every seat to auth.uid, so there is no useful
    // identity without a sign-in; say so instead of inventing one
    const code = (err as { code?: string }).code ?? '';
    throw new Error(`Sign-in failed${code ? ` (${code})` : ''}; the lobby needs Anonymous auth`);
  }
}
