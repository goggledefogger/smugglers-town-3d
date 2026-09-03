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

const CLIENT_ID_KEY = 'stt_client_id';
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
  } catch {
    // Anonymous auth may not be enabled on the project yet (auth/admin-restricted-operation,
    // auth/configuration-not-found, auth/operation-not-allowed) — fall back to a local id
    // rather than block the lobby on a provider toggle in the console.
    return localClientId();
  }
}

function localClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}
