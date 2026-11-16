import { doc, setDoc, onSnapshot, Unsubscribe } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import {
  getActiveBranchId,
  getBranchScopedDocId,
  getBranchStorageKey,
  normalizeBranchId,
} from './branchService.ts';

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return code.includes('permission-denied') || msg.includes('missing or insufficient permissions');
}

export interface StoreQrisConfig {
  merchantName: string;
  nmid: string;
  subCode?: string;
  imageUrl?: string; // Data URL Base64 atau URL gambar QRIS eksternal
  updatedAt?: string;
}

export const DEFAULT_QRIS_CONFIG: StoreQrisConfig = {
  merchantName: 'Toko Digital Janiso',
  nmid: 'ID1020304050607 | A01',
  subCode: 'A01',
  imageUrl: '',
};

export const STORAGE_KEY_QRIS = 'konter_store_qris_config';
export const EVENT_QRIS_UPDATED = 'konter_qris_updated';

/**
 * Mengambil konfigurasi QRIS toko yang tersimpan di localStorage (sinkron & instan)
 */
export function getStoredQrisConfig(branchId?: string): StoreQrisConfig {
  if (typeof window === 'undefined') return DEFAULT_QRIS_CONFIG;
  const key = getBranchStorageKey(STORAGE_KEY_QRIS, branchId || getActiveBranchId());
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_QRIS_CONFIG;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.merchantName === 'string') {
      return {
        merchantName: parsed.merchantName || DEFAULT_QRIS_CONFIG.merchantName,
        nmid: parsed.nmid || DEFAULT_QRIS_CONFIG.nmid,
        subCode: parsed.subCode || 'A01',
        imageUrl: parsed.imageUrl || '',
        updatedAt: parsed.updatedAt,
      };
    }
  } catch (err) {
    console.warn('Gagal membaca qris config dari localStorage:', err);
  }
  return DEFAULT_QRIS_CONFIG;
}

/**
 * Menyimpan konfigurasi QRIS toko ke localStorage dan memicu CustomEvent agar UI reaktif
 */
export function saveStoredQrisConfig(config: StoreQrisConfig, branchId?: string): void {
  if (typeof window === 'undefined') return;
  const key = getBranchStorageKey(STORAGE_KEY_QRIS, branchId || getActiveBranchId());
  try {
    localStorage.setItem(key, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent(EVENT_QRIS_UPDATED, { detail: config }));
  } catch (err) {
    console.warn('Gagal menyimpan qris config ke localStorage:', err);
  }
}

/**
 * Menyimpan konfigurasi QRIS toko ke Cloud Firestore dan localStorage
 */
export async function saveQrisConfigCloud(
  config: StoreQrisConfig,
  branchId?: string
): Promise<void> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const docId = getBranchScopedDocId('qris_profile', resolvedBranchId);
  const payload: StoreQrisConfig & { branchId?: string } = {
    merchantName: config.merchantName.trim() || DEFAULT_QRIS_CONFIG.merchantName,
    nmid: config.nmid.trim() || DEFAULT_QRIS_CONFIG.nmid,
    subCode: config.subCode?.trim() || 'A01',
    imageUrl: config.imageUrl || '',
    branchId: resolvedBranchId,
    updatedAt: new Date().toISOString(),
  };

  try {
    const qrisDocRef = doc(db, 'settings', docId);
    await setDoc(qrisDocRef, payload, { merge: true });
    saveStoredQrisConfig(payload, resolvedBranchId);
  } catch (cloudErr) {
    if (isPermissionDeniedError(cloudErr)) {
      handleFirestoreError(cloudErr, OperationType.WRITE, `settings/${docId}`);
    }
    console.error('Gagal sinkronisasi QRIS ke Cloud Firestore:', cloudErr);
    throw cloudErr;
  }
}

/**
 * Berlangganan (Real-Time Listener) ke Cloud Firestore untuk pembaruan QRIS Toko per cabang
 */
export function subscribeQrisConfig(
  onUpdate: (config: StoreQrisConfig) => void,
  branchId?: string
): Unsubscribe {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const docId = getBranchScopedDocId('qris_profile', resolvedBranchId);
  try {
    const qrisDocRef = doc(db, 'settings', docId);
    const unsub = onSnapshot(
      qrisDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data() as Partial<StoreQrisConfig>;
          const merged: StoreQrisConfig = {
            merchantName: data.merchantName || DEFAULT_QRIS_CONFIG.merchantName,
            nmid: data.nmid || DEFAULT_QRIS_CONFIG.nmid,
            subCode: data.subCode || 'A01',
            imageUrl: data.imageUrl || '',
            updatedAt: data.updatedAt,
          };
          saveStoredQrisConfig(merged, resolvedBranchId);
          onUpdate(merged);
        }
      },
      (err) => {
        console.warn('Gagal berlangganan real-time snapshot QRIS Cloud:', err);
      }
    );
    return unsub;
  } catch (err) {
    console.warn('Error saat subscribe ke Firestore QRIS:', err);
    return () => {};
  }
}

/**
 * Kompres dan ubah file gambar yang diunggah ke Data URL Base64 ringan
 */
export function resizeImageToDataUrl(file: File, maxSize: number = 600): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Gagal memuat gambar untuk diproses'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Gagal membaca file gambar'));
    reader.readAsDataURL(file);
  });
}
