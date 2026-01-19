import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth, DecodedIdToken } from "firebase-admin/auth";
import { config } from "../config";

let app = getApps()[0];

if (!app && config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey) {
  app = initializeApp({
    credential: cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
  });
  console.log("✅ Firebase Admin initialized");
} else if (!app) {
  console.warn("⚠️ Firebase Admin credentials missing; auth verification disabled");
}

const auth = app ? getAuth(app) : null;

export async function verifyIdToken(token: string): Promise<DecodedIdToken> {
  if (!auth) {
    throw new Error("Firebase Admin is not configured");
  }

  return auth.verifyIdToken(token);
}

export const adminAuth = { verifyIdToken };
export const firebaseAuth = adminAuth;
