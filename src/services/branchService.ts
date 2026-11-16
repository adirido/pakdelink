import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import { Branch } from '../types/index.ts';

export const BRANCHES_COLLECTION = 'branches';
export const DEFAULT_BRANCH_ID = 'pusat';

export const ACTIVE_BRANCH_STORAGE_KEY = 'konter_active_branch_id';
export const STORAGE_KEY_BRANCHES = 'konter_branches_list_v1';
export const EVENT_ACTIVE_BRANCH_CHANGED = 'konter_active_branch_changed';

export const DEFAULT_PUSAT_BRANCH: Branch = {
  id: DEFAULT_BRANCH_ID,
  name: 'Pusat',
  receiptName: 'Agen BRI Pakde Link',
  address: 'Jl Raya Pasar Gunungsari, Ulubelu',
  phone: 'WA: 082281185001',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return code.includes('permission-denied') || msg.includes('missing or insufficient permissions');
}

export function sanitizeBranchId(raw?: string | null): string {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || DEFAULT_BRANCH_ID;
}

export function normalizeBranchId(branchId?: string | null): string {
  const raw = String(branchId || '').trim();
  if (!raw) return DEFAULT_BRANCH_ID;
  const sanitized = sanitizeBranchId(raw);
  return sanitized || DEFAULT_BRANCH_ID;
}

export function getBranchScopedDocId(baseDocId: string, branchId?: string | null): string {
  const normalized = normalizeBranchId(branchId);
  return normalized === DEFAULT_BRANCH_ID ? baseDocId : `${baseDocId}__${normalized}`;
}

export function getBranchStorageKey(baseKey: string, branchId?: string | null): string {
  const normalized = normalizeBranchId(branchId);
  return normalized === DEFAULT_BRANCH_ID ? baseKey : `${baseKey}__${normalized}`;
}

export function getActiveBranchId(): string {
  if (typeof window === 'undefined') return DEFAULT_BRANCH_ID;
  try {
    return normalizeBranchId(localStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY));
  } catch {
    return DEFAULT_BRANCH_ID;
  }
}

export function setActiveBranchId(branchId: string): string {
  const normalized = normalizeBranchId(branchId);
  if (typeof window !== 'undefined') {
    try {
      const prev = getActiveBranchId();
      localStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, normalized);
      if (prev !== normalized) {
        window.dispatchEvent(
          new CustomEvent(EVENT_ACTIVE_BRANCH_CHANGED, { detail: normalized })
        );
      }
    } catch {
      // ignore storage errors
    }
  }
  return normalized;
}

export function onActiveBranchChanged(callback: (branchId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const custom = e as CustomEvent<string>;
    if (custom.detail) {
      callback(normalizeBranchId(custom.detail));
    }
  };
  window.addEventListener(EVENT_ACTIVE_BRANCH_CHANGED, handler);
  return () => window.removeEventListener(EVENT_ACTIVE_BRANCH_CHANGED, handler);
}

export function normalizeBranch(raw: any, docId?: string): Branch {
  const id = normalizeBranchId(raw?.id || docId);
  const defaultName = id === DEFAULT_BRANCH_ID ? DEFAULT_PUSAT_BRANCH.name : id;
  const name = (String(raw?.name || defaultName).trim() || defaultName).slice(0, 120);
  const rawReceiptName =
    String(raw?.receiptName || '').trim() ||
    (id === DEFAULT_BRANCH_ID
      ? DEFAULT_PUSAT_BRANCH.receiptName
      : `Agen BRI Pakde Link - ${name}`);
  return {
    id,
    name,
    receiptName: rawReceiptName.slice(0, 160),
    address: (String(raw?.address || '').trim() || DEFAULT_PUSAT_BRANCH.address).slice(0, 300),
    phone: (String(raw?.phone || '').trim() || DEFAULT_PUSAT_BRANCH.phone).slice(0, 64),
    isActive: raw?.isActive !== false,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt.slice(0, 64) : new Date().toISOString(),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt.slice(0, 64) : undefined,
  };
}

function sortBranches(list: Branch[]): Branch[] {
  const map = new Map<string, Branch>();
  for (const b of list) {
    const normalized = normalizeBranch(b, b.id);
    map.set(normalized.id, normalized);
  }
  if (!map.has(DEFAULT_BRANCH_ID)) {
    map.set(DEFAULT_BRANCH_ID, { ...DEFAULT_PUSAT_BRANCH });
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.id === DEFAULT_BRANCH_ID) return -1;
    if (b.id === DEFAULT_BRANCH_ID) return 1;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.name.localeCompare(b.name);
  });
}

export function getStoredBranches(): Branch[] {
  if (typeof window === 'undefined') return [{ ...DEFAULT_PUSAT_BRANCH }];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BRANCHES);
    if (!raw) return [{ ...DEFAULT_PUSAT_BRANCH }];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [{ ...DEFAULT_PUSAT_BRANCH }];
    return sortBranches(parsed.map((item) => normalizeBranch(item)));
  } catch {
    return [{ ...DEFAULT_PUSAT_BRANCH }];
  }
}

export function saveStoredBranches(branches: Branch[]): Branch[] {
  const sorted = sortBranches(branches);
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY_BRANCHES, JSON.stringify(sorted));
    } catch {
      // ignore storage errors
    }
  }
  return sorted;
}

export async function fetchBranchesFromCloud(): Promise<Branch[]> {
  const colRef = collection(db, BRANCHES_COLLECTION);
  try {
    const snap = await getDocsFromServer(colRef).catch(() => getDocs(colRef));
    const list: Branch[] = [];
    snap.forEach((docSnap) => {
      list.push(normalizeBranch(docSnap.data(), docSnap.id));
    });
    const sorted = sortBranches(list);
    saveStoredBranches(sorted);
    return sorted;
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.LIST, BRANCHES_COLLECTION);
    }
    throw err;
  }
}

export async function saveBranchToCloud(rawBranch: Branch): Promise<Branch> {
  const branch = normalizeBranch(rawBranch, rawBranch.id);
  const path = `${BRANCHES_COLLECTION}/${branch.id}`;
  try {
    const ref = doc(db, BRANCHES_COLLECTION, branch.id);
    const payload = {
      id: branch.id,
      name: branch.name,
      receiptName: branch.receiptName,
      address: branch.address,
      phone: branch.phone,
      isActive: branch.id === DEFAULT_BRANCH_ID ? true : branch.isActive,
      createdAt: branch.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await setDoc(ref, payload, { merge: true });
    const current = getStoredBranches().filter((b) => b.id !== branch.id);
    saveStoredBranches([...current, payload]);
    return payload;
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    console.error('Gagal menyimpan data cabang ke Cloud Firestore:', err);
    throw err;
  }
}

export async function deleteBranchFromCloud(branchId: string): Promise<void> {
  const normalized = normalizeBranchId(branchId);
  if (normalized === DEFAULT_BRANCH_ID) {
    throw new Error('Cabang Pusat tidak boleh dihapus.');
  }
  const path = `${BRANCHES_COLLECTION}/${normalized}`;
  try {
    await deleteDoc(doc(db, BRANCHES_COLLECTION, normalized));
    const remaining = getStoredBranches().filter((b) => b.id !== normalized);
    saveStoredBranches(remaining);
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    console.error('Gagal menghapus data cabang dari Cloud Firestore:', err);
    throw err;
  }
}

export function subscribeBranchesCloud(
  onUpdate: (branches: Branch[], meta?: { fromCache: boolean }) => void
): Unsubscribe {
  try {
    const colRef = collection(db, BRANCHES_COLLECTION);
    return onSnapshot(
      colRef,
      (snap) => {
        const list: Branch[] = [];
        snap.forEach((docSnap) => {
          list.push(normalizeBranch(docSnap.data(), docSnap.id));
        });
        const sorted = sortBranches(list);
        saveStoredBranches(sorted);
        onUpdate(sorted, { fromCache: snap.metadata.fromCache });
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          handleFirestoreError(err, OperationType.LIST, BRANCHES_COLLECTION);
        }
        console.warn('Snapshot daftar cabang Cloud Firestore warning:', err);
      }
    );
  } catch (err) {
    console.warn('Gagal subscribe daftar cabang Cloud Firestore:', err);
    return () => {};
  }
}

export async function ensureDefaultPusatBranchCloud(): Promise<Branch[]> {
  try {
    const colRef = collection(db, BRANCHES_COLLECTION);
    const snap = await getDocsFromServer(colRef).catch(() => getDocs(colRef));
    const hasPusat = snap.docs.some(
      (d) => normalizeBranchId(d.data()?.id || d.id) === DEFAULT_BRANCH_ID
    );
    if (!hasPusat) {
      await saveBranchToCloud(DEFAULT_PUSAT_BRANCH);
    }
    return await fetchBranchesFromCloud();
  } catch (err) {
    console.warn('Gagal memastikan cabang Pusat di Firestore:', err);
    return getStoredBranches();
  }
}
