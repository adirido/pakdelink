import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  query,
  where,
  Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import { DigitalTransaction, StoreExpense } from '../types/index.ts';
import type {
  AccountBalances,
  MarginFeeLedgerState,
} from './accountBalanceService.ts';

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return code.includes('permission-denied') || msg.includes('missing or insufficient permissions');
}

export interface SnapshotMeta {
  fromCache: boolean;
}

export const DIGITAL_TRANSACTIONS_COLLECTION = 'digital_transactions';
export const SETTINGS_COLLECTION = 'settings';
export const ACCOUNT_BALANCES_DOC_ID = 'digital_account_balances';
export const MARGIN_FEE_LEDGER_DOC_ID = 'margin_fee_ledger';

function toIsoTimestamp(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') {
    const parsed = new Date(val);
    return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? new Date().toISOString() : val.toISOString();
  }
  if (typeof (val as { toDate?: () => Date })?.toDate === 'function') {
    const d = (val as { toDate: () => Date }).toDate();
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  return new Date().toISOString();
}

export function extractFundSourceFromNotes(notes?: string | null): string | undefined {
  if (!notes) return undefined;
  const match = notes.match(/\[Sumber(?:\s*Dana)?:\s*([^\]]+)\]/i);
  return match?.[1]?.trim() || undefined;
}

export function extractOperatorFromNotes(notes?: string | null): string | undefined {
  if (!notes) return undefined;
  const match = notes.match(/\[Operator:\s*([^\]]+)\]/i);
  return match?.[1]?.trim() || undefined;
}

export function normalizeDigitalTransaction(raw: any): DigitalTransaction {
  const nominal = Number(raw?.nominal) || 0;
  const adminBankCost = Number(raw?.adminBankCost) || 0;
  const adminStoreFee = Number(raw?.adminStoreFee) || 0;
  const totalCustomerPaid =
    raw?.totalCustomerPaid !== undefined && raw?.totalCustomerPaid !== null
      ? Number(raw.totalCustomerPaid) || 0
      : nominal + adminStoreFee;
  const profit =
    raw?.profit !== undefined && raw?.profit !== null && !isNaN(Number(raw.profit))
      ? Number(raw.profit)
      : adminStoreFee - adminBankCost;

  const notes = raw?.notes ?? null;
  const fundSource = raw?.fundSource || extractFundSourceFromNotes(notes);
  const operatorName = raw?.operatorName || extractOperatorFromNotes(notes);
  const createdAt = toIsoTimestamp(raw?.createdAt);
  const numericId = Number(raw?.id);
  const id = Number.isFinite(numericId) && numericId > 0 ? numericId : Date.now();

  return {
    id,
    type: String(raw?.type || 'brilink_transfer'),
    provider: String(raw?.provider || 'BRI'),
    targetAccount: String(raw?.targetAccount || ''),
    customerName: raw?.customerName || 'Pelanggan',
    nominal,
    adminBankCost,
    adminStoreFee,
    totalCustomerPaid,
    profit,
    paymentMethod: raw?.paymentMethod || 'cash',
    referenceNumber:
      raw?.referenceNumber ||
      `${String(raw?.provider || 'TRX').slice(0, 3).toUpperCase()}-${id}`,
    status: raw?.status || 'success',
    cashierUid: raw?.cashierUid || null,
    fundSource: fundSource || undefined,
    operatorName: operatorName || undefined,
    notes,
    createdAt,
    paidAt: raw?.paidAt ? toIsoTimestamp(raw.paidAt) : undefined,
  };
}

export function getDigitalTransactionDocId(tx: Partial<DigitalTransaction>): string {
  const ref = String(tx.referenceNumber || '').trim();
  if (ref) {
    return ref.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  return `tx_${tx.id || Date.now()}`;
}

export function mergeDigitalTransactions(
  ...lists: DigitalTransaction[][]
): DigitalTransaction[] {
  const map = new Map<string, DigitalTransaction>();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw) continue;
      const item = normalizeDigitalTransaction(raw);
      const key =
        String(item.referenceNumber || '').trim() || `id_${item.id}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, item);
      } else {
        map.set(key, {
          ...existing,
          ...item,
          fundSource: item.fundSource || existing.fundSource,
          operatorName: item.operatorName || existing.operatorName,
          notes: item.notes || existing.notes,
        });
      }
    }
  }

  const merged = Array.from(map.values()).sort((a, b) => {
    const tA = new Date(a.createdAt || 0).getTime();
    const tB = new Date(b.createdAt || 0).getTime();
    if (tB !== tA) return tB - tA;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });

  // Guarantee every transaction in memory has a strictly unique numeric ID to prevent ID collision
  const seenIds = new Set<number>();
  let fallbackId = Date.now();
  for (const tx of merged) {
    const numId = Number(tx.id);
    if (!numId || seenIds.has(numId)) {
      fallbackId++;
      tx.id = fallbackId;
    } else {
      seenIds.add(numId);
    }
  }

  return merged;
}

/**
 * Ambil seluruh transaksi Agen Digital langsung dari Cloud Firestore server
 */
export async function fetchDigitalTransactionsFromCloud(): Promise<DigitalTransaction[]> {
  const colRef = collection(db, DIGITAL_TRANSACTIONS_COLLECTION);
  try {
    const snap = await getDocsFromServer(colRef).catch(() => getDocs(colRef));
    const list: DigitalTransaction[] = [];
    snap.forEach((docSnap) => {
      list.push(normalizeDigitalTransaction(docSnap.data()));
    });
    return mergeDigitalTransactions(list);
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.LIST, DIGITAL_TRANSACTIONS_COLLECTION);
    }
    throw err;
  }
}

/**
 * Simpan 1 transaksi Agen Digital ke Cloud Firestore secara idempoten
 */
export async function saveDigitalTransactionToCloud(
  rawTx: DigitalTransaction
): Promise<void> {
  const tx = normalizeDigitalTransaction(rawTx);
  const docId = getDigitalTransactionDocId(tx);
  const path = `${DIGITAL_TRANSACTIONS_COLLECTION}/${docId}`;
  try {
    const ref = doc(db, DIGITAL_TRANSACTIONS_COLLECTION, docId);
    await setDoc(
      ref,
      {
        id: tx.id,
        type: tx.type,
        provider: tx.provider,
        targetAccount: tx.targetAccount,
        customerName: tx.customerName || 'Pelanggan',
        nominal: tx.nominal,
        adminBankCost: tx.adminBankCost,
        adminStoreFee: tx.adminStoreFee,
        totalCustomerPaid: tx.totalCustomerPaid,
        profit: tx.profit,
        paymentMethod: tx.paymentMethod || 'cash',
        referenceNumber: tx.referenceNumber,
        status: tx.status || 'success',
        cashierUid: tx.cashierUid || null,
        fundSource: tx.fundSource || null,
        operatorName: tx.operatorName || null,
        notes: tx.notes || null,
        createdAt: tx.createdAt,
        paidAt: tx.paidAt || null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    console.error('Gagal menyinkronkan transaksi digital ke Cloud Firestore:', err);
    throw err;
  }
}

/**
 * Hapus transaksi Agen Digital dari Cloud Firestore
 */
export async function deleteDigitalTransactionFromCloud(
  id: number,
  referenceNumber?: string
): Promise<void> {
  try {
    const tasks: Promise<void>[] = [];

    if (referenceNumber && referenceNumber.trim()) {
      const docId = referenceNumber.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      tasks.push(deleteDoc(doc(db, DIGITAL_TRANSACTIONS_COLLECTION, docId)));

      const qRef = query(
        collection(db, DIGITAL_TRANSACTIONS_COLLECTION),
        where('referenceNumber', '==', referenceNumber.trim())
      );
      const snapRef = await getDocs(qRef);
      snapRef.forEach((d) => tasks.push(deleteDoc(d.ref)));
    }

    if (Number.isFinite(id) && id > 0) {
      tasks.push(deleteDoc(doc(db, DIGITAL_TRANSACTIONS_COLLECTION, `tx_${id}`)));
      const qId = query(
        collection(db, DIGITAL_TRANSACTIONS_COLLECTION),
        where('id', '==', id)
      );
      const snapId = await getDocs(qId);
      snapId.forEach((d) => tasks.push(deleteDoc(d.ref)));
    }

    await Promise.all(tasks);
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(
        err,
        OperationType.DELETE,
        `${DIGITAL_TRANSACTIONS_COLLECTION}/${referenceNumber || id}`
      );
    }
    console.error('Gagal menghapus transaksi digital dari Cloud Firestore:', err);
    throw err;
  }
}

/**
 * Berlangganan real-time transaksi Agen Digital dari Cloud Firestore
 */
export function subscribeDigitalTransactionsCloud(
  onUpdate: (
    transactions: DigitalTransaction[],
    hasDocs: boolean,
    meta?: SnapshotMeta
  ) => void
): Unsubscribe {
  try {
    const colRef = collection(db, DIGITAL_TRANSACTIONS_COLLECTION);
    return onSnapshot(
      colRef,
      (snap) => {
        const list: DigitalTransaction[] = [];
        snap.forEach((docSnap) => {
          list.push(normalizeDigitalTransaction(docSnap.data()));
        });
        const sorted = mergeDigitalTransactions(list);
        onUpdate(sorted, !snap.empty, { fromCache: snap.metadata.fromCache });
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          handleFirestoreError(err, OperationType.LIST, DIGITAL_TRANSACTIONS_COLLECTION);
        }
        console.warn('Snapshot transaksi digital Cloud Firestore warning:', err);
      }
    );
  } catch (err) {
    console.warn('Gagal subscribe transaksi digital ke Cloud Firestore:', err);
    return () => {};
  }
}

function parseAccountBalancesDoc(data: Record<string, any>): {
  balances: AccountBalances;
  tagihanNote?: string;
} {
  const balances: AccountBalances = {
    cash: Number(data.cash) || 0,
    brimo1: Number(data.brimo1) || 0,
    brimo2: Number(data.brimo2) || 0,
    dana1: Number(data.dana1) || 0,
    dana2: Number(data.dana2) || 0,
    seabank: Number(data.seabank) || 0,
    tagihan: Number(data.tagihan) || 0,
    hutang: Number(data.hutang) || 0,
  };
  const tagihanNote = typeof data.tagihanNote === 'string' ? data.tagihanNote : undefined;
  return { balances, tagihanNote };
}

/**
 * Ambil saldo akun langsung dari Cloud Firestore server
 */
export async function fetchAccountBalancesFromCloud(): Promise<{
  exists: boolean;
  balances: AccountBalances | null;
  tagihanNote?: string;
}> {
  const docRef = doc(db, SETTINGS_COLLECTION, ACCOUNT_BALANCES_DOC_ID);
  try {
    const snap = await getDocFromServer(docRef).catch(() => getDoc(docRef));
    if (!snap.exists()) {
      return { exists: false, balances: null };
    }
    const parsed = parseAccountBalancesDoc(snap.data() as Record<string, any>);
    return { exists: true, balances: parsed.balances, tagihanNote: parsed.tagihanNote };
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.GET, `${SETTINGS_COLLECTION}/${ACCOUNT_BALANCES_DOC_ID}`);
    }
    throw err;
  }
}

/**
 * Sinkronisasi saldo akun Agen Digital & catatan tagihan ke Cloud Firestore
 */
export async function saveAccountBalancesToCloud(
  balances: AccountBalances,
  tagihanNote?: string
): Promise<void> {
  const path = `${SETTINGS_COLLECTION}/${ACCOUNT_BALANCES_DOC_ID}`;
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, ACCOUNT_BALANCES_DOC_ID);
    const payload: Record<string, unknown> = {
      cash: Math.max(0, Number(balances.cash) || 0),
      brimo1: Math.max(0, Number(balances.brimo1) || 0),
      brimo2: Math.max(0, Number(balances.brimo2) || 0),
      dana1: Math.max(0, Number(balances.dana1) || 0),
      dana2: Math.max(0, Number(balances.dana2) || 0),
      seabank: Math.max(0, Number(balances.seabank) || 0),
      tagihan: Math.max(0, Number(balances.tagihan) || 0),
      hutang: Math.max(0, Number(balances.hutang) || 0),
      updatedAt: new Date().toISOString(),
    };
    if (tagihanNote !== undefined) {
      payload.tagihanNote = tagihanNote;
    }
    await setDoc(docRef, payload, { merge: true });
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    console.error('Gagal sinkronisasi saldo akun ke Cloud Firestore:', err);
    throw err;
  }
}

export function subscribeAccountBalancesCloud(
  onUpdate: (
    balances: AccountBalances | null,
    tagihanNote?: string,
    exists?: boolean,
    meta?: SnapshotMeta
  ) => void
): Unsubscribe {
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, ACCOUNT_BALANCES_DOC_ID);
    return onSnapshot(
      docRef,
      (snap) => {
        const meta: SnapshotMeta = { fromCache: snap.metadata.fromCache };
        if (!snap.exists()) {
          onUpdate(null, undefined, false, meta);
          return;
        }
        const parsed = parseAccountBalancesDoc(snap.data() as Record<string, any>);
        onUpdate(parsed.balances, parsed.tagihanNote, true, meta);
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          handleFirestoreError(err, OperationType.GET, `${SETTINGS_COLLECTION}/${ACCOUNT_BALANCES_DOC_ID}`);
        }
        console.warn('Snapshot saldo akun Cloud Firestore warning:', err);
      }
    );
  } catch (err) {
    console.warn('Gagal subscribe saldo akun Cloud Firestore:', err);
    return () => {};
  }
}

/**
 * Ambil ledger Margin Fee langsung dari Cloud Firestore server
 */
export async function fetchMarginFeeLedgerFromCloud(): Promise<{
  exists: boolean;
  ledger: MarginFeeLedgerState | null;
}> {
  const docRef = doc(db, SETTINGS_COLLECTION, MARGIN_FEE_LEDGER_DOC_ID);
  try {
    const snap = await getDocFromServer(docRef).catch(() => getDoc(docRef));
    if (!snap.exists()) {
      return { exists: false, ledger: null };
    }
    const data = snap.data() as Partial<MarginFeeLedgerState>;
    return {
      exists: true,
      ledger: {
        baselineDateKey:
          typeof data?.baselineDateKey === 'string' ? data.baselineDateKey : '',
        takenByDate:
          data?.takenByDate && typeof data.takenByDate === 'object'
            ? data.takenByDate
            : {},
        history: Array.isArray(data?.history) ? data.history : [],
      },
    };
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.GET, `${SETTINGS_COLLECTION}/${MARGIN_FEE_LEDGER_DOC_ID}`);
    }
    throw err;
  }
}

/**
 * Sinkronisasi catatan pengambilan Margin Fee (ledger) ke Cloud Firestore
 */
export async function saveMarginFeeLedgerToCloud(
  ledger: MarginFeeLedgerState
): Promise<void> {
  const path = `${SETTINGS_COLLECTION}/${MARGIN_FEE_LEDGER_DOC_ID}`;
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, MARGIN_FEE_LEDGER_DOC_ID);
    await setDoc(
      docRef,
      {
        baselineDateKey: ledger.baselineDateKey,
        takenByDate: ledger.takenByDate || {},
        history: Array.isArray(ledger.history) ? ledger.history.slice(0, 100) : [],
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    console.error('Gagal sinkronisasi ledger Margin Fee ke Cloud Firestore:', err);
    throw err;
  }
}

export function subscribeMarginFeeLedgerCloud(
  onUpdate: (
    ledger: MarginFeeLedgerState | null,
    exists: boolean,
    meta?: SnapshotMeta
  ) => void
): Unsubscribe {
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, MARGIN_FEE_LEDGER_DOC_ID);
    return onSnapshot(
      docRef,
      (snap) => {
        const meta: SnapshotMeta = { fromCache: snap.metadata.fromCache };
        if (!snap.exists()) {
          onUpdate(null, false, meta);
          return;
        }
        const data = snap.data() as Partial<MarginFeeLedgerState>;
        if (!data) {
          onUpdate(null, false, meta);
          return;
        }
        onUpdate(
          {
            baselineDateKey:
              typeof data.baselineDateKey === 'string' ? data.baselineDateKey : '',
            takenByDate:
              data.takenByDate && typeof data.takenByDate === 'object'
                ? data.takenByDate
                : {},
            history: Array.isArray(data.history) ? data.history : [],
          },
          true,
          meta
        );
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          handleFirestoreError(err, OperationType.GET, `${SETTINGS_COLLECTION}/${MARGIN_FEE_LEDGER_DOC_ID}`);
        }
        console.warn('Snapshot ledger Margin Fee Cloud Firestore warning:', err);
      }
    );
  } catch (err) {
    console.warn('Gagal subscribe ledger Margin Fee Cloud Firestore:', err);
    return () => {};
  }
}

export interface TitipanAccount {
  id: string;
  name: string;
  balance: number;
  createdAt: string;
  updatedAt: string;
}

export const TITIPAN_ACCOUNTS_COLLECTION = 'titipan_accounts';
const STORAGE_KEY_TITIPAN_ACCOUNTS = 'konter_digital_titipan_accounts_v1';

export function normalizeTitipanAccount(raw: any): TitipanAccount {
  return {
    id: String(raw?.id || `titipan_${Date.now()}`),
    name: String(raw?.name || 'Penitip').trim() || 'Penitip',
    balance: Math.max(0, Math.round(Number(raw?.balance) || 0)),
    createdAt: toIsoTimestamp(raw?.createdAt),
    updatedAt: toIsoTimestamp(raw?.updatedAt),
  };
}

export function getStoredTitipanAccounts(): TitipanAccount[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TITIPAN_ACCOUNTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTitipanAccount);
  } catch {
    return [];
  }
}

export function saveStoredTitipanAccounts(accounts: TitipanAccount[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_TITIPAN_ACCOUNTS, JSON.stringify(accounts));
  } catch (err) {
    console.warn('Gagal menyimpan daftar titipan ke localStorage:', err);
  }
}

export async function fetchTitipanAccountsFromCloud(): Promise<TitipanAccount[]> {
  const colRef = collection(db, TITIPAN_ACCOUNTS_COLLECTION);
  try {
    const snap = await getDocsFromServer(colRef).catch(() => getDocs(colRef));
    const list: TitipanAccount[] = [];
    snap.forEach((docSnap) => {
      list.push(normalizeTitipanAccount({ id: docSnap.id, ...docSnap.data() }));
    });
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return list;
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.LIST, TITIPAN_ACCOUNTS_COLLECTION);
    }
    throw err;
  }
}

export async function saveTitipanAccountToCloud(account: TitipanAccount): Promise<void> {
  const normalized = normalizeTitipanAccount(account);
  const docId = normalized.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = `${TITIPAN_ACCOUNTS_COLLECTION}/${docId}`;
  try {
    const ref = doc(db, TITIPAN_ACCOUNTS_COLLECTION, docId);
    await setDoc(ref, normalized, { merge: true });
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    console.error('Gagal menyinkronkan data titipan ke Cloud Firestore:', err);
    throw err;
  }
}

export async function deleteTitipanAccountFromCloud(id: string): Promise<void> {
  const docId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = `${TITIPAN_ACCOUNTS_COLLECTION}/${docId}`;
  try {
    await deleteDoc(doc(db, TITIPAN_ACCOUNTS_COLLECTION, docId));
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
    console.error('Gagal menghapus data titipan dari Cloud Firestore:', err);
    throw err;
  }
}

export function subscribeTitipanAccountsCloud(
  onUpdate: (accounts: TitipanAccount[], hasDocs: boolean, meta?: SnapshotMeta) => void
): Unsubscribe {
  try {
    const colRef = collection(db, TITIPAN_ACCOUNTS_COLLECTION);
    return onSnapshot(
      colRef,
      (snap) => {
        const list: TitipanAccount[] = [];
        snap.forEach((docSnap) => {
          list.push(normalizeTitipanAccount({ id: docSnap.id, ...docSnap.data() }));
        });
        list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        onUpdate(list, !snap.empty, { fromCache: snap.metadata.fromCache });
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          handleFirestoreError(err, OperationType.LIST, TITIPAN_ACCOUNTS_COLLECTION);
        }
        console.warn('Snapshot titipan Cloud Firestore warning:', err);
      }
    );
  } catch (err) {
    console.warn('Gagal subscribe titipan ke Cloud Firestore:', err);
    return () => {};
  }
}

export const STORE_EXPENSES_COLLECTION = 'store_expenses';

export function normalizeStoreExpense(raw: any): StoreExpense {
  const numericId = Number(raw?.id);
  const id = Number.isFinite(numericId) && numericId > 0 ? numericId : Date.now();
  return {
    id,
    category: String(raw?.category || 'lainnya'),
    title: String(raw?.title || 'Pengeluaran Toko').trim(),
    amount: Math.max(0, Math.round(Number(raw?.amount) || 0)),
    expenseDate: String(raw?.expenseDate || new Date().toISOString().slice(0, 10)).slice(0, 10),
    paidBy: String(raw?.paidBy || 'cash'),
    notes: raw?.notes ? String(raw.notes) : undefined,
    createdAt: toIsoTimestamp(raw?.createdAt),
  };
}

export async function fetchExpensesFromCloud(): Promise<StoreExpense[]> {
  const colRef = collection(db, STORE_EXPENSES_COLLECTION);
  try {
    const snap = await getDocsFromServer(colRef).catch(() => getDocs(colRef));
    const list: StoreExpense[] = [];
    snap.forEach((docSnap) => {
      list.push(normalizeStoreExpense(docSnap.data()));
    });
    list.sort((a, b) => {
      const dDiff = String(b.expenseDate || '').localeCompare(String(a.expenseDate || ''));
      if (dDiff !== 0) return dDiff;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
    return list;
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.LIST, STORE_EXPENSES_COLLECTION);
    }
    throw err;
  }
}

export async function saveExpenseToCloud(rawExpense: StoreExpense): Promise<void> {
  const expense = normalizeStoreExpense(rawExpense);
  const docId = `exp_${expense.id}`;
  try {
    const ref = doc(db, STORE_EXPENSES_COLLECTION, docId);
    await setDoc(
      ref,
      {
        id: expense.id,
        category: expense.category,
        title: expense.title,
        amount: expense.amount,
        expenseDate: expense.expenseDate,
        paidBy: expense.paidBy,
        notes: expense.notes || null,
        createdAt: expense.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.WRITE, `${STORE_EXPENSES_COLLECTION}/${docId}`);
    }
    console.error('Gagal menyinkronkan pengeluaran ke Cloud Firestore:', err);
    throw err;
  }
}

export async function deleteExpenseFromCloud(id: number): Promise<void> {
  const docId = `exp_${id}`;
  try {
    await deleteDoc(doc(db, STORE_EXPENSES_COLLECTION, docId));
    const q = query(collection(db, STORE_EXPENSES_COLLECTION), where('id', '==', id));
    const snap = await getDocs(q);
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  } catch (err) {
    if (isPermissionDeniedError(err)) {
      handleFirestoreError(err, OperationType.DELETE, `${STORE_EXPENSES_COLLECTION}/${docId}`);
    }
    console.error('Gagal menghapus pengeluaran dari Cloud Firestore:', err);
    throw err;
  }
}

export function subscribeExpensesCloud(
  onUpdate: (expenses: StoreExpense[], hasDocs: boolean, meta?: SnapshotMeta) => void
): Unsubscribe {
  try {
    const colRef = collection(db, STORE_EXPENSES_COLLECTION);
    return onSnapshot(
      colRef,
      (snap) => {
        const list: StoreExpense[] = [];
        snap.forEach((docSnap) => {
          list.push(normalizeStoreExpense(docSnap.data()));
        });
        list.sort((a, b) => {
          const dDiff = String(b.expenseDate || '').localeCompare(String(a.expenseDate || ''));
          if (dDiff !== 0) return dDiff;
          return (Number(b.id) || 0) - (Number(a.id) || 0);
        });
        onUpdate(list, !snap.empty, { fromCache: snap.metadata.fromCache });
      },
      (err) => {
        if (isPermissionDeniedError(err)) {
          handleFirestoreError(err, OperationType.LIST, STORE_EXPENSES_COLLECTION);
        }
        console.warn('Snapshot pengeluaran Cloud Firestore warning:', err);
      }
    );
  } catch (err) {
    console.warn('Gagal subscribe pengeluaran ke Cloud Firestore:', err);
    return () => {};
  }
}
