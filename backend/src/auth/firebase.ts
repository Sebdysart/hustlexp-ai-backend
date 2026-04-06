import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth, DecodedIdToken, UserRecord } from "firebase-admin/auth";
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { config } from "../config.js";
import { authLogger } from "../logger.js";

let app = getApps()[0];

if (!app && config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey) {
  app = initializeApp({
    credential: cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
  });
  authLogger.info("Firebase Admin initialized");
} else if (!app) {
  authLogger.warn("Firebase Admin credentials missing — auth verification disabled");
}

const auth = app ? getAuth(app) : null;
const messaging: Messaging | null = app ? getMessaging(app) : null;

export async function verifyIdToken(token: string, checkRevoked: boolean = true): Promise<DecodedIdToken> {
  if (!auth) {
    authLogger.error("Firebase Admin not configured — check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars");
    throw new Error("Firebase Admin is not configured — missing credentials");
  }

  return auth.verifyIdToken(token, checkRevoked);
}

/** Load Firebase Auth user record (email, displayName) for lazy DB provisioning. */
export async function getFirebaseUserRecord(uid: string): Promise<UserRecord> {
  if (!auth) {
    authLogger.error("Firebase Admin is not configured — cannot load user record");
    throw new Error("Firebase Admin is not configured — missing credentials");
  }
  return auth.getUser(uid);
}

/** Get a Firebase user by UID (wraps auth.getUser). */
export async function getFirebaseUser(uid: string) {
  if (!auth) {
    throw new Error("Firebase Admin is not configured — missing credentials");
  }
  return auth.getUser(uid);
}

/** Generate an email verification link for a user. */
export async function generateEmailVerificationLink(email: string): Promise<string> {
  if (!auth) {
    throw new Error("Firebase Admin is not configured — missing credentials");
  }
  return auth.generateEmailVerificationLink(email);
}

export { messaging };
export const adminAuth = { verifyIdToken };
export const firebaseAuth = adminAuth;
