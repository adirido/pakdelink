import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  query,
  where,
  Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import { AppUser, UserRole } from '../types/index.ts';

export const USERS_COLLECTION = 'users';

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return code.includes('permission-denied') || msg.includes('missing or insufficient permissions');
}

const VALID_ROLES: UserRole[] = ['owner', 'manager', 'cashier', 'technician'];

const LEGACY_MOCK_UIDS = new Set([
  'owner-default-001',
  'owner-gunungsari-google',
  'cashier-default-002',
  'manager-default-003',
  'tech-default-004',
]);

const LEGACY_MOCK_EMAILS = new Set([
  'owner@konterpos.id',
  'gunungsarientertainer@gmail.com',
  'kasir@konterpos.id',
  'manager@konterpos.id',
  'teknisi@konterpos.id',
]);

export const BUILTIN_FALLBACK_USERS: AppUser[] = [
  {
    id: 1,
    uid: 'emp-151500',
    employeeId: '151500',
    email: '151500',
    name: 'Roni Jaswoko',
    role: 'owner',
    pin: '8888',
  },
  {
    id: 2,
    uid: 'emp-151501',
    employeeId: '151501',
    email: '151501',
    name: 'Bella Heartfire',
    role: 'cashier',
    pin: '9999',
  },
];

function isLegacyMockRecord(data: { uid?: string; email?: string; employeeId?: string }): boolean {
  const uid = String(data.uid || '').trim().toLowerCase();
  const email = String(data.email || '').trim().toLowerCase();
  return LEGACY_MOCK_UIDS.has(uid) || LEGACY_MOCK_EMAILS.has(email);
}

function normalizeAppUser(raw: any, docId?: string): AppUser {
  const empId = String(raw?.employeeId || raw?.email || '').trim();
  const numericId = Number(raw?.id || docId);
  const safeId = Number.isFinite(numericId) && numericId > 0 ? numericId : Date.now();
  const rawRole = String(raw?.role || 'cashier') as UserRole;
  const safeRole: UserRole = VALID_ROLES.includes(rawRole) ? rawRole : 'cashier';

  return {
    id: safeId,
    uid: String(raw?.uid || '').trim() || `emp-${empId || safeId}`,
    employeeId: empId,
    email: empId,
    name: String(raw?.name || '').trim(),
    role: safeRole,
    pin: raw?.pin ? String(raw.pin).trim() : '',
    createdAt: raw?.createdAt || raw?.updatedAt || new Date().toISOString(),
  };
}

/**
 * Ambil seluruh daftar pengguna langsung dari Cloud Firestore server
 */
export async function fetchUsersFromCloud(): Promise<AppUser[]> {
  const usersRef = collection(db, USERS_COLLECTION);
  try {
    const snap = await getDocsFromServer(usersRef).catch(() => getDocs(usersRef));
    const list: AppUser[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (isLegacyMockRecord(data)) return;
      list.push(normalizeAppUser(data, docSnap.id));
    });
    list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    return list;
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.LIST, USERS_COLLECTION);
    }
    throw err;
  }
}

/**
 * Sinkronisasi data pengguna ke Cloud Firestore
 */
export async function syncUserToFirestore(user: AppUser): Promise<void> {
  const empId = String(user.employeeId || user.email || '').trim();
  const cleanName = String(user.name || '').trim();
  const cleanPin = String(user.pin || '').trim();
  const cleanUid = String(user.uid || '').trim() || `emp-${empId || user.id}`;
  const safeRole: UserRole = VALID_ROLES.includes(user.role) ? user.role : 'cashier';
  const safeId = Number(user.id);

  if (!Number.isFinite(safeId) || safeId <= 0) {
    throw new Error('ID internal pengguna tidak valid.');
  }
  if (!empId) {
    throw new Error('ID Karyawan wajib diisi.');
  }
  if (!cleanName) {
    throw new Error('Nama Karyawan wajib diisi.');
  }
  if (!cleanPin) {
    throw new Error('Password karyawan wajib diisi sebelum disimpan ke database.');
  }

  const path = `${USERS_COLLECTION}/${safeId}`;
  try {
    const userDocRef = doc(db, USERS_COLLECTION, String(safeId));
    await setDoc(
      userDocRef,
      {
        id: safeId,
        uid: cleanUid,
        employeeId: empId,
        email: empId,
        name: cleanName,
        role: safeRole,
        pin: cleanPin,
        createdAt: user.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    console.error('Gagal menyimpan data pengguna ke Cloud Firestore:', err);
    throw err;
  }
}

/**
 * Bersihkan akun mock lama dari Cloud Firestore & sinkronkan daftar akun terbaru
 */
export async function resetLegacyFirestoreUsers(activeUsers: AppUser[]): Promise<void> {
  try {
    const usersRef = collection(db, USERS_COLLECTION);
    const snap = await getDocsFromServer(usersRef).catch(() => getDocs(usersRef));

    const activeIds = new Set(activeUsers.map((u) => String(u.id)));
    const deletions: Promise<void>[] = [];

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (isLegacyMockRecord(data) && !activeIds.has(docSnap.id)) {
        deletions.push(deleteDoc(doc(db, USERS_COLLECTION, docSnap.id)));
      }
    });

    await Promise.all(deletions);
    await Promise.all(activeUsers.map((u) => syncUserToFirestore(u)));
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, USERS_COLLECTION);
    }
    console.error('Gagal menyinkronkan daftar pengguna ke Cloud Firestore:', err);
    throw err;
  }
}

/**
 * Hapus pengguna dari Cloud Firestore
 */
export async function deleteUserFromFirestore(userId: number): Promise<void> {
  const path = `${USERS_COLLECTION}/${userId}`;
  try {
    const userDocRef = doc(db, USERS_COLLECTION, String(userId));
    await deleteDoc(userDocRef);

    const q = query(collection(db, USERS_COLLECTION), where('id', '==', userId));
    const snap = await getDocs(q);
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    console.error('Gagal menghapus data pengguna dari Cloud Firestore:', err);
    throw err;
  }
}

/**
 * Berlangganan perubahan real-time koleksi pengguna di Cloud Firestore
 */
export function subscribeCloudUsers(
  onUpdate: (cloudUsers: AppUser[], meta?: { fromCache: boolean }) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const usersRef = collection(db, USERS_COLLECTION);
  return onSnapshot(
    usersRef,
    (snapshot) => {
      const list: AppUser[] = [];
      snapshot.forEach((d) => {
        const data = d.data();
        if (isLegacyMockRecord(data)) return;
        list.push(normalizeAppUser(data, d.id));
      });
      list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      onUpdate(list, { fromCache: snapshot.metadata.fromCache });
    },
    (err) => {
      if (isPermissionDeniedError(err)) {
        handleFirestoreError(err, OperationType.LIST, USERS_COLLECTION);
      }
      console.warn('Firestore user subscription error:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Verifikasi login menggunakan ID Karyawan dan Password langsung melalui Cloud Firestore
 */
export async function authenticateWithFirestore(
  identifier: string,
  secret: string
): Promise<{ success: boolean; user?: AppUser; message?: string; isNetworkError?: boolean }> {
  const cleanId = identifier.trim().toLowerCase();
  const cleanSecret = secret.trim();

  if (!cleanId || !cleanSecret) {
    return { success: false, message: 'ID Karyawan dan password wajib diisi.' };
  }

  try {
    const usersRef = collection(db, USERS_COLLECTION);
    const snap = await getDocsFromServer(usersRef).catch(() => getDocs(usersRef));

    const cloudUsers: AppUser[] = [];
    if (!snap.empty) {
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (isLegacyMockRecord(data)) return;
        cloudUsers.push(normalizeAppUser(data, docSnap.id));
      });
    }

    if (cloudUsers.length > 0) {
      const matchedUser = cloudUsers.find(
        (u) => String(u.employeeId || u.email || '').trim().toLowerCase() === cleanId
      );
      if (!matchedUser) {
        return { success: false, message: 'ID Karyawan atau password salah' };
      }

      const expectedPassword = String(matchedUser.pin || '').trim();
      if (expectedPassword.length > 0 && cleanSecret === expectedPassword) {
        return { success: true, user: matchedUser };
      }

      return { success: false, message: 'ID Karyawan atau password salah' };
    }

    // Jika koleksi Cloud Firestore belum memiliki user aktif sama sekali, seed akun default permanen
    await resetLegacyFirestoreUsers(BUILTIN_FALLBACK_USERS).catch((seedErr) => {
      console.warn('Gagal seed user default ke Firestore saat login:', seedErr);
    });

    const matchedDefault = BUILTIN_FALLBACK_USERS.find(
      (u) => String(u.employeeId || u.email || '').trim().toLowerCase() === cleanId
    );
    if (matchedDefault && matchedDefault.pin && cleanSecret === matchedDefault.pin) {
      return { success: true, user: matchedDefault };
    }

    return { success: false, message: 'ID Karyawan atau password salah' };
  } catch (error: any) {
    console.warn('Firestore login lookup gagal:', error);

    // Offline / koneksi terganggu: fallback ke BUILTIN_FALLBACK_USERS hanya jika cocok, atau beri flag network error
    const matchedDefault = BUILTIN_FALLBACK_USERS.find(
      (u) => String(u.employeeId || u.email || '').trim().toLowerCase() === cleanId
    );
    if (matchedDefault && matchedDefault.pin && cleanSecret === matchedDefault.pin) {
      return { success: true, user: matchedDefault };
    }

    return {
      success: false,
      isNetworkError: true,
      message: error?.message || 'Tidak dapat terhubung ke Cloud Firestore',
    };
  }
}
