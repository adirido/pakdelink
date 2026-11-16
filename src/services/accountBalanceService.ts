// Service manajemen saldo akun dan sumber dana agen terpadu (multi-cabang)
import type { DigitalTransaction } from '../types/index.ts';
import {
  fetchAccountBalancesFromCloud,
  saveAccountBalancesToCloud,
  saveDigitalTransactionToCloud,
  saveMarginFeeLedgerToCloud,
} from './cloudDigitalFinanceService.ts';
import {
  DEFAULT_BRANCH_ID,
  getActiveBranchId,
  getBranchStorageKey,
  normalizeBranchId,
} from './branchService.ts';

export type InternalFundKey = 'cash' | 'brimo1' | 'brimo2' | 'dana1' | 'dana2' | 'seabank' | 'tagihan';
export type HutangReceiverAccountKey = 'cash' | 'brimo1' | 'brimo2' | 'dana1' | 'dana2' | 'seabank';
export type FundSourceKey = InternalFundKey | 'atm_pelanggan';

export interface AccountBalances {
  cash: number;
  brimo1: number;
  brimo2: number;
  dana1: number;
  dana2: number;
  seabank: number;
  tagihan?: number;
  hutang?: number;
  [key: string]: number | undefined;
}

export interface FundSourceMeta {
  key: FundSourceKey;
  label: string;
  provider: string;
  color: string;
  badgeBg: string;
  iconName: string;
}

export const FUND_SOURCES_CONFIG: FundSourceMeta[] = [
  {
    key: 'cash',
    label: 'Cash',
    provider: 'Uang Fisik Kasir',
    color: 'emerald',
    badgeBg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    iconName: 'Banknote',
  },
  {
    key: 'brimo1',
    label: 'Brimo 1',
    provider: 'Bank BRI Rek. 1',
    color: 'blue',
    badgeBg: 'bg-blue-50 text-blue-700 border-blue-200',
    iconName: 'CreditCard',
  },
  {
    key: 'brimo2',
    label: 'Brimo 2',
    provider: 'Bank BRI Rek. 2',
    color: 'sky',
    badgeBg: 'bg-sky-50 text-sky-700 border-sky-200',
    iconName: 'CreditCard',
  },
  {
    key: 'dana1',
    label: 'Dana 1',
    provider: 'Akun DANA Utama',
    color: 'indigo',
    badgeBg: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    iconName: 'Wallet',
  },
  {
    key: 'dana2',
    label: 'Dana 2',
    provider: 'Akun DANA Cadangan',
    color: 'purple',
    badgeBg: 'bg-purple-50 text-purple-700 border-purple-200',
    iconName: 'Wallet',
  },
  {
    key: 'seabank',
    label: 'Seabank',
    provider: 'PT Bank Seabank',
    color: 'orange',
    badgeBg: 'bg-orange-50 text-orange-700 border-orange-200',
    iconName: 'ArrowRightLeft',
  },
  {
    key: 'tagihan',
    label: 'Tagihan',
    provider: 'Card Input Manual',
    color: 'amber',
    badgeBg: 'bg-amber-50 text-amber-700 border-amber-200',
    iconName: 'Receipt',
  },
];

const STORAGE_KEY_BALANCES = 'konter_digital_account_balances_v1';
const EVENT_BALANCES_UPDATED = 'konter_account_balances_updated';

// Default initial balances untuk cabang Pusat jika belum pernah diinisialisasi
export const DEFAULT_BALANCES: AccountBalances = {
  cash: 3500000,
  brimo1: 8500000,
  brimo2: 4000000,
  dana1: 2500000,
  dana2: 1500000,
  seabank: 2000000,
  tagihan: 0,
  hutang: 0,
};

// Default saldo awal Rp 0 untuk cabang baru selain Pusat
export const ZERO_BALANCES: AccountBalances = {
  cash: 0,
  brimo1: 0,
  brimo2: 0,
  dana1: 0,
  dana2: 0,
  seabank: 0,
  tagihan: 0,
  hutang: 0,
};

export function getDefaultBalancesForBranch(branchId?: string): AccountBalances {
  const normalized = normalizeBranchId(branchId || getActiveBranchId());
  return normalized === DEFAULT_BRANCH_ID ? { ...DEFAULT_BALANCES } : { ...ZERO_BALANCES };
}

const STORAGE_KEY_TAGIHAN_NOTE = 'konter_digital_tagihan_note_v1';

export function getStoredTagihanNote(branchId?: string): string {
  if (typeof window === 'undefined') return '';
  const key = getBranchStorageKey(STORAGE_KEY_TAGIHAN_NOTE, branchId || getActiveBranchId());
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function saveStoredTagihanNote(
  note: string,
  syncCloud: boolean = true,
  branchId?: string
): void {
  if (typeof window === 'undefined') return;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const key = getBranchStorageKey(STORAGE_KEY_TAGIHAN_NOTE, resolvedBranchId);
  try {
    localStorage.setItem(key, note);
    if (syncCloud) {
      saveAccountBalancesToCloud(
        getStoredAccountBalances(resolvedBranchId),
        note,
        resolvedBranchId
      ).catch((err) => {
        console.warn('Gagal sinkronisasi catatan tagihan ke Cloud Firestore:', err);
      });
    }
  } catch {}
}

export async function saveStoredTagihanNoteAsync(
  note: string,
  syncCloud: boolean = true,
  branchId?: string
): Promise<void> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  if (syncCloud) {
    await saveAccountBalancesToCloud(
      getStoredAccountBalances(resolvedBranchId),
      note,
      resolvedBranchId
    );
  }
  if (typeof window !== 'undefined') {
    const key = getBranchStorageKey(STORAGE_KEY_TAGIHAN_NOTE, resolvedBranchId);
    try {
      localStorage.setItem(key, note);
    } catch {}
  }
}

/**
 * Mengambil data saldo seluruh akun cabang dari LocalStorage
 */
export function getStoredAccountBalances(branchId?: string): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const fallback = getDefaultBalancesForBranch(resolvedBranchId);
  if (typeof window === 'undefined') return { ...fallback };
  const key = getBranchStorageKey(STORAGE_KEY_BALANCES, resolvedBranchId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return { ...fallback };
    }
    const parsed = JSON.parse(raw);
    return {
      cash: typeof parsed.cash === 'number' ? parsed.cash : fallback.cash,
      brimo1: typeof parsed.brimo1 === 'number' ? parsed.brimo1 : fallback.brimo1,
      brimo2: typeof parsed.brimo2 === 'number' ? parsed.brimo2 : fallback.brimo2,
      dana1: typeof parsed.dana1 === 'number' ? parsed.dana1 : fallback.dana1,
      dana2: typeof parsed.dana2 === 'number' ? parsed.dana2 : fallback.dana2,
      seabank: typeof parsed.seabank === 'number' ? parsed.seabank : fallback.seabank,
      tagihan: typeof parsed.tagihan === 'number' ? parsed.tagihan : (fallback.tagihan ?? 0),
      hutang: typeof parsed.hutang === 'number' ? parsed.hutang : (fallback.hutang ?? 0),
    };
  } catch (err) {
    console.warn('Gagal membaca saldo akun dari localStorage:', err);
    return { ...fallback };
  }
}

/**
 * Menyimpan data saldo ke LocalStorage dan broadcast event reaktif
 */
export function saveStoredAccountBalances(
  balances: AccountBalances,
  syncCloud: boolean = true,
  branchId?: string
): void {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  if (typeof window !== 'undefined') {
    const key = getBranchStorageKey(STORAGE_KEY_BALANCES, resolvedBranchId);
    try {
      localStorage.setItem(key, JSON.stringify(balances));
      if (resolvedBranchId === getActiveBranchId()) {
        notifyBalancesUpdated(balances);
      }
    } catch (err) {
      console.warn('Gagal menyimpan saldo akun ke localStorage:', err);
    }
  }
  if (syncCloud) {
    saveAccountBalancesToCloud(balances, undefined, resolvedBranchId).catch((err) => {
      console.warn('Gagal sinkronisasi saldo akun ke Cloud Firestore:', err);
    });
  }
}

export async function saveStoredAccountBalancesAsync(
  balances: AccountBalances,
  syncCloud: boolean = true,
  tagihanNote?: string,
  branchId?: string
): Promise<void> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  if (syncCloud) {
    await saveAccountBalancesToCloud(balances, tagihanNote, resolvedBranchId);
  }
  if (typeof window !== 'undefined') {
    const balKey = getBranchStorageKey(STORAGE_KEY_BALANCES, resolvedBranchId);
    const noteKey = getBranchStorageKey(STORAGE_KEY_TAGIHAN_NOTE, resolvedBranchId);
    try {
      localStorage.setItem(balKey, JSON.stringify(balances));
      if (tagihanNote !== undefined) {
        localStorage.setItem(noteKey, tagihanNote);
      }
      if (resolvedBranchId === getActiveBranchId()) {
        notifyBalancesUpdated(balances);
      }
    } catch (err) {
      console.warn('Gagal menyimpan saldo akun ke localStorage:', err);
    }
  }
}

/**
 * Update saldo akun spesifik secara manual (via tombol modal Update)
 */
export function updateAccountBalance(
  key: FundSourceKey,
  newAmount: number,
  branchId?: string
): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated: AccountBalances = {
    ...current,
    [key]: Math.max(0, Math.round(Number(newAmount) || 0)),
  };
  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return updated;
}

export async function updateAccountBalanceAsync(
  key: FundSourceKey,
  newAmount: number,
  branchId?: string
): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated: AccountBalances = {
    ...current,
    [key]: Math.max(0, Math.round(Number(newAmount) || 0)),
  };
  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return updated;
}

/**
 * Menambah atau mengurangi saldo Brimo 1 secara langsung (misalnya sinkronisasi Card Titipan)
 */
export function adjustBrimo1Balance(deltaAmount: number, branchId?: string): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const delta = Math.round(Number(deltaAmount) || 0);
  const updated: AccountBalances = {
    ...current,
    brimo1: Math.max(0, (Number(current.brimo1) || 0) + delta),
  };
  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return updated;
}

export async function adjustBrimo1BalanceAsync(
  deltaAmount: number,
  branchId?: string
): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const delta = Math.round(Number(deltaAmount) || 0);
  const updated: AccountBalances = {
    ...current,
    brimo1: Math.max(0, (Number(current.brimo1) || 0) + delta),
  };
  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return updated;
}

/**
 * Menambah atau mengurangi saldo Cash secara langsung (misalnya pencairan Tarik Tunai Card Titipan)
 */
export function adjustCashBalance(deltaAmount: number, branchId?: string): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const delta = Math.round(Number(deltaAmount) || 0);
  const updated: AccountBalances = {
    ...current,
    cash: Math.max(0, (Number(current.cash) || 0) + delta),
  };
  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return updated;
}

export async function adjustCashBalanceAsync(
  deltaAmount: number,
  branchId?: string
): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const delta = Math.round(Number(deltaAmount) || 0);
  const updated: AccountBalances = {
    ...current,
    cash: Math.max(0, (Number(current.cash) || 0) + delta),
  };
  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return updated;
}

function computeTransferBetweenBalances(params: {
  sourceKey: FundSourceKey;
  targetKey: FundSourceKey;
  transferAmount: number;
  adminBankCost?: number;
  adminTransferFee?: number;
  adminStoreFee?: number;
  branchId?: string;
}): { success: boolean; balances: AccountBalances; message?: string } {
  const {
    sourceKey,
    targetKey,
    transferAmount,
    adminBankCost = 0,
    adminTransferFee = 0,
    adminStoreFee = 0,
    branchId,
  } = params;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());

  if (sourceKey === targetKey) {
    return {
      success: false,
      balances: getStoredAccountBalances(resolvedBranchId),
      message: 'Sumber dana asal dan tujuan tidak boleh sama.',
    };
  }

  const current = getStoredAccountBalances(resolvedBranchId);
  const sourceBalance = current[sourceKey] ?? 0;
  const numTransfer = Math.max(0, Math.round(Number(transferAmount) || 0));
  const numBankCost = Math.max(0, Math.round(Number(adminBankCost) || 0));
  const numAdminTransfer = Math.max(0, Math.round(Number(adminTransferFee || adminStoreFee) || 0));
  const totalDeductionFromSource = numTransfer + numBankCost + numAdminTransfer;

  if (numTransfer <= 0) {
    return {
      success: false,
      balances: current,
      message: 'Nominal transfer saldo harus lebih dari Rp 0.',
    };
  }

  if (sourceBalance < totalDeductionFromSource) {
    return {
      success: false,
      balances: current,
      message: `Saldo pada ${getFundSourceLabel(sourceKey)} tidak mencukupi (Tersedia: Rp ${sourceBalance.toLocaleString('id-ID')}, Dibutuhkan: Rp ${totalDeductionFromSource.toLocaleString('id-ID')}).`,
    };
  }

  const updated: AccountBalances = {
    ...current,
    [sourceKey]: Math.max(0, sourceBalance - totalDeductionFromSource),
    [targetKey]: (current[targetKey] ?? 0) + numTransfer,
  };

  return { success: true, balances: updated };
}

/**
 * Transfer saldo antar sumber dana (Ambil saldo dari card lain)
 */
export function transferBetweenAccountBalances(params: {
  sourceKey: FundSourceKey;
  targetKey: FundSourceKey;
  transferAmount: number;
  adminBankCost?: number;
  adminTransferFee?: number;
  adminStoreFee?: number;
  branchId?: string;
}): { success: boolean; balances: AccountBalances; message?: string } {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const res = computeTransferBetweenBalances({ ...params, branchId: resolvedBranchId });
  if (res.success) {
    saveStoredAccountBalances(res.balances, true, resolvedBranchId);
  }
  return res;
}

export async function transferBetweenAccountBalancesAsync(params: {
  sourceKey: FundSourceKey;
  targetKey: FundSourceKey;
  transferAmount: number;
  adminBankCost?: number;
  adminTransferFee?: number;
  adminStoreFee?: number;
  tagihanNote?: string;
  branchId?: string;
}): Promise<{ success: boolean; balances: AccountBalances; message?: string }> {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const res = computeTransferBetweenBalances({ ...params, branchId: resolvedBranchId });
  if (!res.success) return res;
  await saveStoredAccountBalancesAsync(res.balances, true, params.tagihanNote, resolvedBranchId);
  return res;
}

/**
 * Eksekusi instan Mutasi / Drop Modal Antar Cabang (Khusus Owner)
 * Memotong saldo pengirim (nominal + biaya admin bank) di cabang asal dan menambah saldo penerima (nominal) di cabang tujuan,
 * lalu mencatat transaksi berpasangan (`transfer_cabang_keluar` & `transfer_cabang_masuk`) ke Cloud Firestore.
 */
export async function executeInterBranchTransferAsync(params: {
  fromBranchId: string;
  fromBranchName: string;
  fromSourceKey: InternalFundKey;
  toBranchId: string;
  toBranchName: string;
  toSourceKey: InternalFundKey;
  nominal: number;
  adminBankCost?: number;
  notes?: string;
  operatorName: string;
  cashierUid?: string;
}): Promise<{
  success: boolean;
  message?: string;
  outTx?: DigitalTransaction;
  inTx?: DigitalTransaction;
}> {
  const fromBranch = normalizeBranchId(params.fromBranchId);
  const toBranch = normalizeBranchId(params.toBranchId);
  const numNominal = Math.max(0, Math.round(Number(params.nominal) || 0));
  const numBankCost = Math.max(0, Math.round(Number(params.adminBankCost) || 0));

  if (fromBranch === toBranch) {
    return {
      success: false,
      message: 'Cabang asal dan cabang tujuan harus berbeda. Gunakan Transfer Antar Card untuk pindah saldo dalam cabang yang sama.',
    };
  }
  if (numNominal <= 0) {
    return {
      success: false,
      message: 'Nominal drop modal / mutasi cabang harus lebih dari Rp 0.',
    };
  }

  const [fromCloud, toCloud] = await Promise.all([
    fetchAccountBalancesFromCloud(fromBranch),
    fetchAccountBalancesFromCloud(toBranch),
  ]);

  const fromBalances: AccountBalances =
    fromCloud.exists && fromCloud.balances
      ? fromCloud.balances
      : getStoredAccountBalances(fromBranch);

  const toBalances: AccountBalances =
    toCloud.exists && toCloud.balances
      ? toCloud.balances
      : getDefaultBalancesForBranch(toBranch);

  const sourceBalance = Number(fromBalances[params.fromSourceKey] || 0);
  const totalDeducted = numNominal + numBankCost;

  if (sourceBalance < totalDeducted) {
    return {
      success: false,
      message: `Saldo ${getFundSourceLabel(params.fromSourceKey)} di cabang ${params.fromBranchName} tidak mencukupi (Tersedia: Rp ${sourceBalance.toLocaleString('id-ID')}, Dibutuhkan: Rp ${totalDeducted.toLocaleString('id-ID')}).`,
    };
  }

  const nextFromBalances: AccountBalances = {
    ...fromBalances,
    [params.fromSourceKey]: Math.max(0, sourceBalance - totalDeducted),
  };
  const nextToBalances: AccountBalances = {
    ...toBalances,
    [params.toSourceKey]: (Number(toBalances[params.toSourceKey]) || 0) + numNominal,
  };

  await saveAccountBalancesToCloud(nextFromBalances, undefined, fromBranch);
  try {
    await saveAccountBalancesToCloud(nextToBalances, undefined, toBranch);
  } catch (err) {
    // Rollback saldo pengirim jika penyimpanan saldo cabang tujuan gagal
    await saveAccountBalancesToCloud(fromBalances, undefined, fromBranch).catch(() => {});
    throw err;
  }

  const nowIso = new Date().toISOString();
  const baseId = Date.now();
  const pairCode = Math.random().toString(36).slice(2, 6).toUpperCase();
  const fromLabel = getFundSourceLabel(params.fromSourceKey);
  const toLabel = getFundSourceLabel(params.toSourceKey);
  const cleanNote = (params.notes || '').trim();
  const opName = (params.operatorName || 'Owner').trim();

  const outTx: DigitalTransaction = {
    id: baseId,
    type: 'transfer_cabang_keluar',
    provider: `${params.fromBranchName} (${fromLabel}) ➔ ${params.toBranchName} (${toLabel})`,
    targetAccount: `${params.toBranchName} - ${toLabel}`,
    customerName: `Drop Modal ke ${params.toBranchName}`,
    nominal: numNominal,
    adminBankCost: numBankCost,
    adminStoreFee: 0,
    totalCustomerPaid: numNominal,
    profit: -numBankCost,
    paymentMethod: 'transfer_cabang',
    fundSource: fromLabel,
    operatorName: opName,
    referenceNumber: `MCB-OUT-${baseId}-${pairCode}`,
    status: 'success',
    cashierUid: params.cashierUid || undefined,
    branchId: fromBranch,
    notes: `${cleanNote ? `${cleanNote} | ` : ''}[Mutasi Cabang Keluar] [Sumber: ${fromLabel}] [Ke Cabang: ${params.toBranchName} (${toLabel})] [Operator: ${opName}]`,
    createdAt: nowIso,
  };

  const inTx: DigitalTransaction = {
    id: baseId + 1,
    type: 'transfer_cabang_masuk',
    provider: `${params.fromBranchName} (${fromLabel}) ➔ ${params.toBranchName} (${toLabel})`,
    targetAccount: toLabel,
    customerName: `Terima Modal dari ${params.fromBranchName}`,
    nominal: numNominal,
    adminBankCost: 0,
    adminStoreFee: 0,
    totalCustomerPaid: numNominal,
    profit: 0,
    paymentMethod: 'transfer_cabang',
    fundSource: toLabel,
    operatorName: opName,
    referenceNumber: `MCB-IN-${baseId + 1}-${pairCode}`,
    status: 'success',
    cashierUid: params.cashierUid || undefined,
    branchId: toBranch,
    notes: `${cleanNote ? `${cleanNote} | ` : ''}[Mutasi Cabang Masuk] [Tujuan: ${toLabel}] [Dari Cabang: ${params.fromBranchName} (${fromLabel})] [Operator: ${opName}]`,
    createdAt: nowIso,
  };

  await Promise.all([
    saveDigitalTransactionToCloud(outTx),
    saveDigitalTransactionToCloud(inTx),
  ]);

  saveStoredAccountBalances(nextFromBalances, false, fromBranch);
  saveStoredAccountBalances(nextToBalances, false, toBranch);

  return {
    success: true,
    outTx,
    inTx,
  };
}

/**
 * Hitung Total Saldo yang dihitung dari Cash sampai dengan Dana 2:
 * (Cash + Brimo 1 + Brimo 2 + Dana 1 + Dana 2)
 */
export function calculateCashToDana2Total(balances: AccountBalances): number {
  return (
    Number(balances.cash || 0) +
    Number(balances.brimo1 || 0) +
    Number(balances.brimo2 || 0) +
    Number(balances.dana1 || 0) +
    Number(balances.dana2 || 0)
  );
}

/**
 * Hitung Total Keseluruhan Seluruh Saldo Akun (termasuk Seabank dan Card Tagihan Manual):
 */
export function calculateAllBalancesTotal(balances: AccountBalances): number {
  return (
    calculateCashToDana2Total(balances) +
    Number(balances.seabank || 0) +
    Number(balances.tagihan || 0)
  );
}

/**
 * Deteksi apakah transaksi digital berstatus Hutang (belum dibayar ke Card Cash)
 */
export function isHutangTransaction(tx?: {
  paymentMethod?: string;
  status?: string;
} | null): boolean {
  if (!tx) return false;
  const pm = (tx.paymentMethod || '').trim().toLowerCase();
  const st = (tx.status || '').trim().toLowerCase();
  return pm === 'hutang' || st === 'hutang';
}

/**
 * Hitung nominal piutang pelanggan yang masuk ke Card Hutang & akan masuk ke Card Cash saat dilunasi
 */
export function getTransactionHutangAmount(tx?: {
  type?: string;
  fundSource?: string;
  notes?: string;
  nominal?: number;
  adminStoreFee?: number;
  totalCustomerPaid?: number;
} | null): number {
  if (!tx) return 0;
  const t = (tx.type || '').toLowerCase();
  const isTarikTunai = t.includes('tarik') || t.includes('cashout');
  const sourceKey = parseFundSourceKey(tx.fundSource, tx.notes, tx.type);
  const numNominal = Math.max(0, Number(tx.nominal) || 0);
  const numStoreFee = Math.max(0, Number(tx.adminStoreFee) || 0);

  if (isTarikTunai || sourceKey === 'atm_pelanggan') {
    return numStoreFee;
  }

  return Math.max(
    0,
    Number(tx.totalCustomerPaid) || (numNominal + numStoreFee)
  );
}

/**
 * Potong / sesuaikan saldo akun secara otomatis saat transaksi baru berhasil dibuat
 */
function computeTransactionBalanceDeduction(params: {
  fundSourceKey: FundSourceKey;
  provider?: string;
  type: string;
  nominal: number;
  adminBankCost: number;
  adminStoreFee?: number;
  totalCustomerPaid: number;
  paymentMethod: string;
  branchId?: string;
}): AccountBalances {
  const { fundSourceKey, provider, type, nominal, adminBankCost = 0, adminStoreFee = 0, totalCustomerPaid, paymentMethod, branchId } = params;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated = { ...current };

  const isTarikTunai = type.includes('tarik') || type.includes('cashout');
  const pmLower = (paymentMethod || 'cash').trim().toLowerCase();
  const isHutang = pmLower === 'hutang';
  const hutangAmount = getTransactionHutangAmount({
    type,
    fundSource: fundSourceKey,
    nominal,
    adminStoreFee,
    totalCustomerPaid,
  });

  if (fundSourceKey === 'atm_pelanggan') {
    if (isTarikTunai && provider) {
      const targetKey: FundSourceKey = parseFundSourceKey(provider);
      if (targetKey && targetKey !== 'atm_pelanggan' && targetKey !== 'cash') {
        updated[targetKey] = (updated[targetKey] || 0) + nominal;
      }
    }
    if (isHutang) {
      if (hutangAmount > 0) {
        updated.hutang = (updated.hutang || 0) + hutangAmount;
      }
    } else if (pmLower === 'cash' && (adminStoreFee || 0) > 0) {
      updated.cash = (updated.cash || 0) + Number(adminStoreFee || 0);
    }
    return updated;
  }

  const numBankCost = Math.max(0, Number(adminBankCost) || 0);
  const totalDeductedFromSource = nominal + numBankCost;

  if (isTarikTunai) {
    const sourceKey: FundSourceKey = fundSourceKey || 'cash';
    updated[sourceKey] = Math.max(0, (updated[sourceKey] || 0) - totalDeductedFromSource);

    const targetKey: FundSourceKey = parseFundSourceKey(provider);
    if (targetKey && targetKey !== sourceKey) {
      updated[targetKey] = (updated[targetKey] || 0) + nominal;
    }

    const storeFee = Math.max(0, Number(adminStoreFee) || 0);
    if (storeFee > 0) {
      if (isHutang) {
        updated.hutang = (updated.hutang || 0) + storeFee;
      } else if (sourceKey === 'cash' || pmLower === 'cash') {
        updated.cash = (updated.cash || 0) + storeFee;
      }
    }
  } else {
    updated[fundSourceKey] = Math.max(0, (updated[fundSourceKey] || 0) - totalDeductedFromSource);

    if (isHutang) {
      updated.hutang = (updated.hutang || 0) + hutangAmount;
    } else if (pmLower === 'cash') {
      updated.cash = (updated.cash || 0) + totalCustomerPaid;
    }
  }

  return updated;
}

export function processTransactionBalanceDeduction(params: {
  fundSourceKey: FundSourceKey;
  provider?: string;
  type: string;
  nominal: number;
  adminBankCost: number;
  adminStoreFee?: number;
  totalCustomerPaid: number;
  paymentMethod: string;
  branchId?: string;
}): AccountBalances {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const updated = computeTransactionBalanceDeduction({ ...params, branchId: resolvedBranchId });
  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return updated;
}

export async function processTransactionBalanceDeductionAsync(params: {
  fundSourceKey: FundSourceKey;
  provider?: string;
  type: string;
  nominal: number;
  adminBankCost: number;
  adminStoreFee?: number;
  totalCustomerPaid: number;
  paymentMethod: string;
  branchId?: string;
}): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const updated = computeTransactionBalanceDeduction({ ...params, branchId: resolvedBranchId });
  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return updated;
}

/**
 * Lunasi transaksi berstatus Hutang:
 * Mengurangi saldo pada Card Hutang dan memasukkan dana pembayaran pelanggan (nominal + fee)
 * ke rekening penerima pilihan (Cash, Brimo 1, Brimo 2, Dana 1, Dana 2, atau Seabank)
 */
function computeSettleHutangTransactionBalance(
  tx: {
    type?: string;
    fundSource?: string;
    notes?: string;
    nominal?: number;
    adminStoreFee?: number;
    totalCustomerPaid?: number;
    branchId?: string;
  },
  receiverAccountKey: HutangReceiverAccountKey = 'cash',
  branchId?: string
): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || tx.branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated: AccountBalances = { ...current };
  const settleAmount = getTransactionHutangAmount(tx);
  const validTargets: HutangReceiverAccountKey[] = [
    'cash',
    'brimo1',
    'brimo2',
    'dana1',
    'dana2',
    'seabank',
  ];
  const targetKey: HutangReceiverAccountKey = validTargets.includes(receiverAccountKey)
    ? receiverAccountKey
    : 'cash';

  if (settleAmount > 0) {
    updated.hutang = Math.max(0, (updated.hutang || 0) - settleAmount);
    updated[targetKey] = (updated[targetKey] || 0) + settleAmount;
  }

  return updated;
}

export function settleHutangTransactionBalance(
  tx: {
    type?: string;
    fundSource?: string;
    notes?: string;
    nominal?: number;
    adminStoreFee?: number;
    totalCustomerPaid?: number;
    branchId?: string;
  },
  receiverAccountKey: HutangReceiverAccountKey = 'cash',
  branchId?: string
): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || tx.branchId || getActiveBranchId());
  const updated = computeSettleHutangTransactionBalance(tx, receiverAccountKey, resolvedBranchId);
  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return updated;
}

export async function settleHutangTransactionBalanceAsync(
  tx: {
    type?: string;
    fundSource?: string;
    notes?: string;
    nominal?: number;
    adminStoreFee?: number;
    totalCustomerPaid?: number;
    branchId?: string;
  },
  receiverAccountKey: HutangReceiverAccountKey = 'cash',
  branchId?: string
): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(branchId || tx.branchId || getActiveBranchId());
  const updated = computeSettleHutangTransactionBalance(tx, receiverAccountKey, resolvedBranchId);
  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return updated;
}

/**
 * Deteksi apakah transaksi digital merupakan catatan Card Tagihan yang masih aktif (belum dilunasi)
 */
export function isTagihanTransaction(tx?: {
  paymentMethod?: string;
  status?: string;
  targetAccount?: string;
  provider?: string;
  notes?: string;
} | null): boolean {
  if (!tx) return false;
  const pm = (tx.paymentMethod || '').trim().toLowerCase();
  const st = (tx.status || '').trim().toLowerCase();
  return pm === 'tagihan' || st === 'tagihan';
}

/**
 * Lunasi catatan Card Tagihan:
 * Mengurangi saldo pada Card Tagihan dan memasukkan dana pelunasan ke Card Cash
 */
export function settleTagihanTransactionBalance(
  tx: { nominal?: number; branchId?: string },
  branchId?: string
): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || tx?.branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated: AccountBalances = { ...current };
  const settleAmount = Math.max(0, Math.round(Number(tx?.nominal) || 0));

  if (settleAmount > 0) {
    updated.tagihan = Math.max(0, (updated.tagihan || 0) - settleAmount);
    updated.cash = (updated.cash || 0) + settleAmount;
  }

  saveStoredAccountBalances(updated, true, resolvedBranchId);
  if ((updated.tagihan || 0) <= 0) {
    saveStoredTagihanNote('', true, resolvedBranchId);
  }
  return updated;
}

export async function settleTagihanTransactionBalanceAsync(
  tx: { nominal?: number; branchId?: string },
  branchId?: string
): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(branchId || tx?.branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated: AccountBalances = { ...current };
  const settleAmount = Math.max(0, Math.round(Number(tx?.nominal) || 0));

  if (settleAmount > 0) {
    updated.tagihan = Math.max(0, (updated.tagihan || 0) - settleAmount);
    updated.cash = (updated.cash || 0) + settleAmount;
  }

  const nextNote = (updated.tagihan || 0) <= 0 ? '' : undefined;
  await saveStoredAccountBalancesAsync(updated, true, nextNote, resolvedBranchId);
  return updated;
}

/**
 * Mendapatkan label tampilan resmi dari kunci Sumber Dana
 */
export function getFundSourceLabel(key: FundSourceKey): string {
  if (key === 'atm_pelanggan') return 'Kartu ATM Pelanggan';
  if (key === 'tagihan') return 'Tagihan';
  const found = FUND_SOURCES_CONFIG.find((f) => f.key === key);
  return found ? found.label : 'Brimo 1';
}

/**
 * Parsing cerdas untuk mendeteksi FundSourceKey dari label, catatan transaksi (notes), atau tipe transaksi
 */
export function parseFundSourceKey(
  fundSource?: string,
  notes?: string,
  type?: string
): FundSourceKey {
  const candidate = (fundSource || '').trim().toLowerCase();

  if (
    candidate.includes('atm') ||
    candidate.includes('pelanggan') ||
    candidate.includes('nasabah') ||
    candidate.includes('kartu atm')
  ) {
    return 'atm_pelanggan';
  }
  if (candidate.includes('cash') || candidate.includes('tunai') || candidate === 'fisik') return 'cash';
  if (
    candidate.includes('brimo2') ||
    candidate.includes('brimo 2') ||
    candidate.includes('bri 2') ||
    candidate.includes('bri cad')
  ) {
    return 'brimo2';
  }
  if (
    candidate.includes('brimo1') ||
    candidate.includes('brimo 1') ||
    candidate.includes('bri 1') ||
    candidate.includes('bri utama') ||
    candidate === 'brimo' ||
    candidate === 'bri' ||
    candidate === 'bank bri'
  ) {
    return 'brimo1';
  }
  if (candidate.includes('dana2') || candidate.includes('dana 2')) return 'dana2';
  if (candidate.includes('dana1') || candidate.includes('dana 1') || candidate === 'dana') return 'dana1';
  if (candidate.includes('seabank') || candidate.includes('sea bank') || candidate === 'sea') return 'seabank';
  if (candidate.includes('tagihan') || candidate.includes('bon') || candidate.includes('piutang')) return 'tagihan';

  if (notes) {
    const match = notes.match(/\[Sumber(?:\s*Dana)?:\s*([^\]]+)\]/i);
    if (match && match[1]) {
      const fromNote = match[1].trim().toLowerCase();
      if (
        fromNote.includes('atm') ||
        fromNote.includes('pelanggan') ||
        fromNote.includes('nasabah') ||
        fromNote.includes('kartu atm')
      ) {
        return 'atm_pelanggan';
      }
      if (fromNote.includes('cash') || fromNote.includes('tunai') || fromNote === 'fisik') return 'cash';
      if (fromNote.includes('brimo 2') || fromNote.includes('brimo2') || fromNote.includes('bri 2')) {
        return 'brimo2';
      }
      if (fromNote.includes('brimo') || fromNote.includes('bri')) {
        return 'brimo1';
      }
      if (fromNote.includes('dana 2') || fromNote.includes('dana2')) return 'dana2';
      if (fromNote.includes('dana')) return 'dana1';
      if (fromNote.includes('seabank') || fromNote.includes('sea bank') || fromNote === 'sea') return 'seabank';
      if (fromNote.includes('tagihan') || fromNote.includes('bon')) return 'tagihan';
    }
  }

  const t = (type || '').toLowerCase();
  if (t.includes('tarik') || t.includes('cashout')) return 'cash';
  if (t.includes('dana') || t.includes('ewallet') || t.includes('topup')) return 'dana1';
  return 'brimo1';
}

/**
 * Kembalikan saldo akun secara otomatis saat transaksi keagenan dihapus (Refund / Reversal)
 */
function computeRollbackTransactionBalance(params: {
  fundSourceKey?: FundSourceKey | string;
  provider?: string;
  targetAccount?: string;
  adminBankCost?: number;
  adminStoreFee?: number;
  notes?: string;
  type: string;
  nominal: number;
  totalCustomerPaid?: number;
  paymentMethod?: string;
  branchId?: string;
}): { changed: boolean; balances: AccountBalances; clearTagihanNote?: boolean } {
  const {
    fundSourceKey,
    provider,
    targetAccount,
    adminBankCost,
    adminStoreFee,
    notes,
    type,
    nominal,
    totalCustomerPaid,
    paymentMethod,
    branchId,
  } = params;

  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const updated = { ...current };

  const numNominal = Math.max(0, Number(nominal) || 0);
  const numBankCost = Math.max(0, Number(adminBankCost) || 0);
  const numStoreFee = adminStoreFee !== undefined
    ? Math.max(0, Number(adminStoreFee) || 0)
    : (Number(totalCustomerPaid || 0) > numNominal ? Number(totalCustomerPaid) - numNominal : 0);
  const numTotalPaid = Math.max(
    numNominal + numStoreFee,
    Number(totalCustomerPaid) || (numNominal + numStoreFee)
  );

  const t = (type || '').toLowerCase();
  const n = (notes || '').toLowerCase();
  const p = (provider || '').toLowerCase();

  if (t.startsWith('titipan') || n.includes('[titipan]')) {
    return { changed: false, balances: updated };
  }

  if (t === 'transfer_cabang_keluar') {
    const sourceKey: FundSourceKey = parseFundSourceKey(fundSourceKey, notes, type);
    if (sourceKey !== 'atm_pelanggan') {
      updated[sourceKey] = (updated[sourceKey] || 0) + numNominal + numBankCost;
    }
    return { changed: true, balances: updated };
  }

  if (t === 'transfer_cabang_masuk') {
    const destKey: FundSourceKey = parseFundSourceKey(targetAccount || fundSourceKey, notes, type);
    if (destKey !== 'atm_pelanggan') {
      updated[destKey] = Math.max(0, (updated[destKey] || 0) - numNominal);
    }
    return { changed: true, balances: updated };
  }

  if (
    t === 'bank_admin_bulanan' ||
    t === 'bank_bunga_bank' ||
    n.includes('[potongan & bunga bank]')
  ) {
    const targetCardKey: FundSourceKey =
      (fundSourceKey || '').toLowerCase().includes('brimo 2') ||
      (fundSourceKey || '').toLowerCase() === 'brimo2' ||
      n.includes('(brimo 2)')
        ? 'brimo2'
        : 'brimo1';

    if (t === 'bank_bunga_bank' || p.includes('bunga bank')) {
      updated[targetCardKey] = Math.max(0, (updated[targetCardKey] || 0) - numNominal);
    } else {
      updated[targetCardKey] = (updated[targetCardKey] || 0) + numNominal;
    }
    return { changed: true, balances: updated };
  }

  const isTransferAntarCard =
    t.includes('transfer_saldo') ||
    t.includes('pindah_dana') ||
    t.includes('mutasi') ||
    t === 'transfer_card' ||
    t.includes('antar_card') ||
    n.includes('transfer saldo') ||
    n.includes('pindah dana') ||
    n.includes('ambil saldo') ||
    p.includes('➔') ||
    p.includes('->');

  if (isTransferAntarCard) {
    let sourceKey: FundSourceKey = 'cash';
    if (p.includes('➔') || p.includes('->')) {
      const parts = p.split(/➔|->/);
      if (parts[0]) sourceKey = parseFundSourceKey(parts[0]);
    } else if (fundSourceKey) {
      sourceKey = parseFundSourceKey(fundSourceKey, notes, type);
    } else {
      sourceKey = parseFundSourceKey(undefined, notes, type);
    }

    let destinationKey: FundSourceKey = 'brimo1';
    if (p.includes('➔') || p.includes('->')) {
      const parts = p.split(/➔|->/);
      if (parts[1]) destinationKey = parseFundSourceKey(parts[1]);
    } else if (targetAccount) {
      destinationKey = parseFundSourceKey(targetAccount);
    } else {
      const toMatch = n.match(/ke\s+([a-zA-Z0-9\s]+?)(?:\.|\s|$)/i);
      if (toMatch && toMatch[1]) {
        destinationKey = parseFundSourceKey(toMatch[1]);
      } else {
        destinationKey = 'brimo2';
      }
    }

    updated[destinationKey] = Math.max(0, (updated[destinationKey] || 0) - numNominal);
    const clearTagihanNote = destinationKey === 'tagihan' && (updated.tagihan || 0) <= 0;

    const totalDeductedFromSource = Math.max(numTotalPaid, numNominal + numBankCost + numStoreFee);
    updated[sourceKey] = (updated[sourceKey] || 0) + totalDeductedFromSource;

    return { changed: true, balances: updated, clearTagihanNote };
  }

  const isTarikTunai = t.includes('tarik') || t.includes('cashout');
  const pmLower = (paymentMethod || 'cash').trim().toLowerCase();
  const isHutang = pmLower === 'hutang';
  const hutangAmount = getTransactionHutangAmount({
    type,
    fundSource: fundSourceKey,
    notes,
    nominal: numNominal,
    adminStoreFee: numStoreFee,
    totalCustomerPaid: numTotalPaid,
  });

  const settledReceiverMatch = (notes || '').match(/\[Pelunasan ke:\s*([^\]]+)\]/i);
  const settledReceiverKey: HutangReceiverAccountKey | null = settledReceiverMatch?.[1]
    ? (parseFundSourceKey(settledReceiverMatch[1]) as HutangReceiverAccountKey)
    : null;

  if (isTarikTunai) {
    const sourceKey: FundSourceKey = parseFundSourceKey(fundSourceKey, notes, type) || 'cash';
    const targetKey: FundSourceKey = parseFundSourceKey(provider);

    if (sourceKey === 'atm_pelanggan') {
      if (isHutang && numStoreFee > 0) {
        updated.hutang = Math.max(0, (updated.hutang || 0) - numStoreFee);
      } else if (settledReceiverKey && numStoreFee > 0) {
        updated[settledReceiverKey] = Math.max(0, (updated[settledReceiverKey] || 0) - numStoreFee);
      } else if (pmLower === 'cash' && numStoreFee > 0) {
        updated.cash = Math.max(0, (updated.cash || 0) - numStoreFee);
      }
      if (targetKey && targetKey !== 'atm_pelanggan' && targetKey !== 'cash') {
        updated[targetKey] = Math.max(0, (updated[targetKey] || 0) - numNominal);
      }
      return { changed: true, balances: updated };
    }

    const totalRestoredToSource = numNominal + numBankCost;
    updated[sourceKey] = (updated[sourceKey] || 0) + totalRestoredToSource;

    if (targetKey && targetKey !== sourceKey && targetKey !== 'atm_pelanggan') {
      updated[targetKey] = Math.max(0, (updated[targetKey] || 0) - numNominal);
    }

    if (numStoreFee > 0) {
      if (isHutang) {
        updated.hutang = Math.max(0, (updated.hutang || 0) - numStoreFee);
      } else if (settledReceiverKey) {
        updated[settledReceiverKey] = Math.max(0, (updated[settledReceiverKey] || 0) - numStoreFee);
      } else if (sourceKey === 'cash' || pmLower === 'cash') {
        updated.cash = Math.max(0, (updated.cash || 0) - numStoreFee);
      }
    }

    return { changed: true, balances: updated };
  }

  const sourceKey: FundSourceKey = parseFundSourceKey(fundSourceKey, notes, type);

  if (sourceKey === 'atm_pelanggan') {
    if (isHutang && numStoreFee > 0) {
      updated.hutang = Math.max(0, (updated.hutang || 0) - numStoreFee);
    } else if (settledReceiverKey && numStoreFee > 0) {
      updated[settledReceiverKey] = Math.max(0, (updated[settledReceiverKey] || 0) - numStoreFee);
    } else if (pmLower === 'cash' && numStoreFee > 0) {
      updated.cash = Math.max(0, (updated.cash || 0) - numStoreFee);
    }
    return { changed: true, balances: updated };
  }

  const totalRestoredToSource = numNominal + numBankCost;

  if (sourceKey !== 'cash') {
    updated[sourceKey] = (updated[sourceKey] || 0) + totalRestoredToSource;

    if (isHutang) {
      updated.hutang = Math.max(0, (updated.hutang || 0) - hutangAmount);
    } else if (settledReceiverKey) {
      updated[settledReceiverKey] = Math.max(0, (updated[settledReceiverKey] || 0) - numTotalPaid);
    } else if (pmLower === 'cash') {
      updated.cash = Math.max(0, (updated.cash || 0) - numTotalPaid);
    }
  } else {
    if (isHutang) {
      updated.cash = (updated.cash || 0) + totalRestoredToSource;
      updated.hutang = Math.max(0, (updated.hutang || 0) - hutangAmount);
    } else if (settledReceiverKey && settledReceiverKey !== 'cash') {
      updated.cash = (updated.cash || 0) + totalRestoredToSource;
      updated[settledReceiverKey] = Math.max(0, (updated[settledReceiverKey] || 0) - numTotalPaid);
    } else {
      updated.cash = Math.max(0, (updated.cash || 0) + totalRestoredToSource - numTotalPaid);
    }
  }

  return { changed: true, balances: updated };
}

export function rollbackTransactionBalance(params: {
  fundSourceKey?: FundSourceKey | string;
  provider?: string;
  targetAccount?: string;
  adminBankCost?: number;
  adminStoreFee?: number;
  notes?: string;
  type: string;
  nominal: number;
  totalCustomerPaid?: number;
  paymentMethod?: string;
  branchId?: string;
}): AccountBalances {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const res = computeRollbackTransactionBalance({ ...params, branchId: resolvedBranchId });
  if (res.changed) {
    saveStoredAccountBalances(res.balances, true, resolvedBranchId);
    if (res.clearTagihanNote) {
      saveStoredTagihanNote('', true, resolvedBranchId);
    }
  }
  return res.balances;
}

export async function rollbackTransactionBalanceAsync(params: {
  fundSourceKey?: FundSourceKey | string;
  provider?: string;
  targetAccount?: string;
  adminBankCost?: number;
  adminStoreFee?: number;
  notes?: string;
  type: string;
  nominal: number;
  totalCustomerPaid?: number;
  paymentMethod?: string;
  branchId?: string;
}): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const res = computeRollbackTransactionBalance({ ...params, branchId: resolvedBranchId });
  if (res.changed) {
    await saveStoredAccountBalancesAsync(
      res.balances,
      true,
      res.clearTagihanNote ? '' : undefined,
      resolvedBranchId
    );
  }
  return res.balances;
}

/**
 * Notifikasi event perubahan saldo ke window global
 */
export function notifyBalancesUpdated(balances: AccountBalances): void {
  if (typeof window !== 'undefined') {
    const event = new CustomEvent(EVENT_BALANCES_UPDATED, { detail: balances });
    window.dispatchEvent(event);
  }
}

/**
 * Dengarkan perubahan saldo secara reaktif
 */
export function onAccountBalancesUpdated(
  callback: (balances: AccountBalances) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (e: Event) => {
    const custom = e as CustomEvent<AccountBalances>;
    if (custom.detail) {
      callback(custom.detail);
    }
  };

  window.addEventListener(EVENT_BALANCES_UPDATED, handler);
  return () => window.removeEventListener(EVENT_BALANCES_UPDATED, handler);
}

// ==========================================
// MANAJEMEN CLOSING & PENGAMBILAN MARGIN FEE
// ==========================================

const STORAGE_KEY_MARGIN_FEE_LEDGER = 'konter_digital_margin_fee_ledger_v1';
const EVENT_MARGIN_FEE_UPDATED = 'konter_margin_fee_ledger_updated';

export interface MarginFeeWithdrawalRecord {
  id: string;
  dateKey: string;
  takenAt: string;
  amount: number;
  todayPortion: number;
  previousPortion: number;
  takenBy: string;
  cashBefore: number;
  cashAfter: number;
}

export interface MarginFeeLedgerState {
  baselineDateKey: string;
  takenByDate: Record<string, number>;
  history: MarginFeeWithdrawalRecord[];
}

export interface UnclaimedMarginDay {
  dateKey: string;
  amount: number;
}

export interface MarginFeeSummary {
  todayDateKey: string;
  baselineDateKey: string;
  todayGrossProfit: number;
  todayTaken: number;
  todayRemainingFee: number;
  previousUnclaimedFee: number;
  unclaimedPreviousDays: UnclaimedMarginDay[];
  totalAvailableToTake: number;
}

export function getLocalDateKey(input: Date | string = new Date()): string {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getStoredMarginFeeLedger(branchId?: string): MarginFeeLedgerState {
  const todayKey = getLocalDateKey();
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  if (typeof window === 'undefined') {
    return { baselineDateKey: todayKey, takenByDate: {}, history: [] };
  }
  const key = getBranchStorageKey(STORAGE_KEY_MARGIN_FEE_LEDGER, resolvedBranchId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      const initial: MarginFeeLedgerState = {
        baselineDateKey: todayKey,
        takenByDate: {},
        history: [],
      };
      localStorage.setItem(key, JSON.stringify(initial));
      return initial;
    }
    const parsed = JSON.parse(raw);
    return {
      baselineDateKey:
        typeof parsed?.baselineDateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.baselineDateKey)
          ? parsed.baselineDateKey
          : todayKey,
      takenByDate:
        parsed?.takenByDate && typeof parsed.takenByDate === 'object' ? parsed.takenByDate : {},
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    };
  } catch {
    return { baselineDateKey: todayKey, takenByDate: {}, history: [] };
  }
}

export function saveStoredMarginFeeLedger(
  ledger: MarginFeeLedgerState,
  syncCloud: boolean = true,
  branchId?: string
): void {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  if (typeof window !== 'undefined') {
    const key = getBranchStorageKey(STORAGE_KEY_MARGIN_FEE_LEDGER, resolvedBranchId);
    try {
      localStorage.setItem(key, JSON.stringify(ledger));
      if (resolvedBranchId === getActiveBranchId()) {
        window.dispatchEvent(new CustomEvent(EVENT_MARGIN_FEE_UPDATED, { detail: ledger }));
      }
    } catch (err) {
      console.warn('Gagal menyimpan catatan pengambilan margin fee:', err);
    }
  }
  if (syncCloud) {
    saveMarginFeeLedgerToCloud(ledger, resolvedBranchId).catch((err) => {
      console.warn('Gagal sinkronisasi ledger Margin Fee ke Cloud Firestore:', err);
    });
  }
}

export async function saveStoredMarginFeeLedgerAsync(
  ledger: MarginFeeLedgerState,
  syncCloud: boolean = true,
  branchId?: string
): Promise<void> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  if (syncCloud) {
    await saveMarginFeeLedgerToCloud(ledger, resolvedBranchId);
  }
  if (typeof window !== 'undefined') {
    const key = getBranchStorageKey(STORAGE_KEY_MARGIN_FEE_LEDGER, resolvedBranchId);
    try {
      localStorage.setItem(key, JSON.stringify(ledger));
      if (resolvedBranchId === getActiveBranchId()) {
        window.dispatchEvent(new CustomEvent(EVENT_MARGIN_FEE_UPDATED, { detail: ledger }));
      }
    } catch (err) {
      console.warn('Gagal menyimpan catatan pengambilan margin fee:', err);
    }
  }
}

export function onMarginFeeLedgerUpdated(
  callback: (ledger: MarginFeeLedgerState) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const custom = e as CustomEvent<MarginFeeLedgerState>;
    if (custom.detail) {
      callback(custom.detail);
    }
  };
  window.addEventListener(EVENT_MARGIN_FEE_UPDATED, handler);
  return () => window.removeEventListener(EVENT_MARGIN_FEE_UPDATED, handler);
}

export function calculateMarginFeeSummary(
  transactions: Array<{
    createdAt?: string;
    paidAt?: string;
    profit?: number;
    adminStoreFee?: number;
    adminBankCost?: number;
    paymentMethod?: string;
    status?: string;
  }>,
  ledger: MarginFeeLedgerState,
  todayDateKey: string = getLocalDateKey()
): MarginFeeSummary {
  const profitByDate: Record<string, number> = {};

  for (const tx of transactions) {
    if (!tx?.createdAt) continue;
    if (isHutangTransaction(tx)) continue;
    const key = getLocalDateKey(tx.paidAt || tx.createdAt);
    if (!key) continue;
    const txProfit =
      tx.profit != null && !Number.isNaN(Number(tx.profit))
        ? Number(tx.profit)
        : (Number(tx.adminStoreFee) || 0) - (Number(tx.adminBankCost) || 0);
    profitByDate[key] = (profitByDate[key] || 0) + txProfit;
  }

  const todayGrossProfit = Math.round(profitByDate[todayDateKey] || 0);
  const todayTaken = Math.max(0, Math.round(ledger.takenByDate[todayDateKey] || 0));
  const todayRemainingFee = todayGrossProfit - todayTaken;
  const todayTakeable = Math.max(0, todayRemainingFee);

  const unclaimedPreviousDays: UnclaimedMarginDay[] = [];
  let previousUnclaimedFee = 0;

  const sortedPrevDates = Object.keys(profitByDate)
    .filter((d) => d >= ledger.baselineDateKey && d < todayDateKey)
    .sort();

  for (const d of sortedPrevDates) {
    const gross = Math.max(0, Math.round(profitByDate[d] || 0));
    const taken = Math.max(0, Math.round(ledger.takenByDate[d] || 0));
    const remaining = Math.max(0, gross - taken);
    if (remaining > 0) {
      unclaimedPreviousDays.push({ dateKey: d, amount: remaining });
      previousUnclaimedFee += remaining;
    }
  }

  return {
    todayDateKey,
    baselineDateKey: ledger.baselineDateKey,
    todayGrossProfit,
    todayTaken,
    todayRemainingFee,
    previousUnclaimedFee,
    unclaimedPreviousDays,
    totalAvailableToTake: todayTakeable + previousUnclaimedFee,
  };
}

function computeTakeMarginFeeFromCash(params: {
  summary: MarginFeeSummary;
  includeToday: boolean;
  includePrevious: boolean;
  takenBy: string;
  branchId?: string;
}): {
  success: boolean;
  message?: string;
  balances: AccountBalances;
  ledger: MarginFeeLedgerState;
  record?: MarginFeeWithdrawalRecord;
} {
  const { summary, includeToday, includePrevious, takenBy, branchId } = params;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const currentBalances = getStoredAccountBalances(resolvedBranchId);
  const currentLedger = getStoredMarginFeeLedger(resolvedBranchId);

  const todayPortion = includeToday ? Math.max(0, summary.todayRemainingFee) : 0;
  const previousPortion = includePrevious ? Math.max(0, summary.previousUnclaimedFee) : 0;
  const totalAmount = todayPortion + previousPortion;

  if (totalAmount <= 0) {
    return {
      success: false,
      message: 'Tidak ada nominal Margin Fee yang tersedia untuk diambil.',
      balances: currentBalances,
      ledger: currentLedger,
    };
  }

  const cashBefore = Number(currentBalances.cash || 0);
  if (cashBefore < totalAmount) {
    return {
      success: false,
      message: `Saldo Cash tidak mencukupi untuk mengambil Margin Fee. Tersedia: Rp ${cashBefore.toLocaleString('id-ID')}, Dibutuhkan: Rp ${totalAmount.toLocaleString('id-ID')}.`,
      balances: currentBalances,
      ledger: currentLedger,
    };
  }

  const cashAfter = cashBefore - totalAmount;
  const updatedBalances: AccountBalances = {
    ...currentBalances,
    cash: cashAfter,
  };

  const nextTakenByDate: Record<string, number> = { ...currentLedger.takenByDate };
  if (todayPortion > 0) {
    nextTakenByDate[summary.todayDateKey] =
      Math.max(0, Math.round(nextTakenByDate[summary.todayDateKey] || 0)) + todayPortion;
  }
  if (previousPortion > 0) {
    for (const dayItem of summary.unclaimedPreviousDays) {
      nextTakenByDate[dayItem.dateKey] =
        Math.max(0, Math.round(nextTakenByDate[dayItem.dateKey] || 0)) + dayItem.amount;
    }
  }

  const record: MarginFeeWithdrawalRecord = {
    id: `FEE-${Date.now()}`,
    dateKey: summary.todayDateKey,
    takenAt: new Date().toISOString(),
    amount: totalAmount,
    todayPortion,
    previousPortion,
    takenBy: takenBy || 'Owner',
    cashBefore,
    cashAfter,
  };

  const updatedLedger: MarginFeeLedgerState = {
    ...currentLedger,
    takenByDate: nextTakenByDate,
    history: [record, ...(currentLedger.history || [])].slice(0, 100),
  };

  return {
    success: true,
    balances: updatedBalances,
    ledger: updatedLedger,
    record,
  };
}

export function takeMarginFeeFromCash(params: {
  summary: MarginFeeSummary;
  includeToday: boolean;
  includePrevious: boolean;
  takenBy: string;
  branchId?: string;
}): {
  success: boolean;
  message?: string;
  balances: AccountBalances;
  ledger: MarginFeeLedgerState;
  record?: MarginFeeWithdrawalRecord;
} {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const res = computeTakeMarginFeeFromCash({ ...params, branchId: resolvedBranchId });
  if (!res.success) return res;
  saveStoredAccountBalances(res.balances, true, resolvedBranchId);
  saveStoredMarginFeeLedger(res.ledger, true, resolvedBranchId);
  return res;
}

export async function takeMarginFeeFromCashAsync(params: {
  summary: MarginFeeSummary;
  includeToday: boolean;
  includePrevious: boolean;
  takenBy: string;
  branchId?: string;
}): Promise<{
  success: boolean;
  message?: string;
  balances: AccountBalances;
  ledger: MarginFeeLedgerState;
  record?: MarginFeeWithdrawalRecord;
}> {
  const resolvedBranchId = normalizeBranchId(params.branchId || getActiveBranchId());
  const res = computeTakeMarginFeeFromCash({ ...params, branchId: resolvedBranchId });
  if (!res.success) return res;
  await Promise.all([
    saveStoredAccountBalancesAsync(res.balances, true, undefined, resolvedBranchId),
    saveStoredMarginFeeLedgerAsync(res.ledger, true, resolvedBranchId),
  ]);
  return res;
}

function computeReconciledMarginFeeLedger(
  dateKey: string,
  remainingTransactions: Array<{
    createdAt?: string;
    paidAt?: string;
    profit?: number;
    paymentMethod?: string;
    status?: string;
  }>,
  branchId?: string
): MarginFeeLedgerState | null {
  if (!dateKey) return null;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const currentLedger = getStoredMarginFeeLedger(resolvedBranchId);
  const prevTaken = Math.max(0, Math.round(currentLedger.takenByDate[dateKey] || 0));
  if (prevTaken <= 0) return null;

  let remainingGross = 0;
  let remainingCountOnDate = 0;
  for (const tx of remainingTransactions) {
    if (!tx?.createdAt) continue;
    if (isHutangTransaction(tx)) continue;
    if (getLocalDateKey(tx.paidAt || tx.createdAt) !== dateKey) continue;
    remainingCountOnDate += 1;
    remainingGross += Number(tx.profit) || 0;
  }

  const safeCap = remainingCountOnDate === 0 ? 0 : Math.max(0, Math.round(remainingGross));
  if (prevTaken <= safeCap) return null;

  const nextTakenByDate: Record<string, number> = { ...currentLedger.takenByDate };
  if (safeCap <= 0) {
    delete nextTakenByDate[dateKey];
  } else {
    nextTakenByDate[dateKey] = safeCap;
  }

  return {
    ...currentLedger,
    takenByDate: nextTakenByDate,
    history:
      safeCap <= 0
        ? (currentLedger.history || []).filter((h) => h.dateKey !== dateKey)
        : currentLedger.history || [],
  };
}

export function reconcileMarginFeeLedgerAfterDelete(
  dateKey: string,
  remainingTransactions: Array<{
    createdAt?: string;
    paidAt?: string;
    profit?: number;
    paymentMethod?: string;
    status?: string;
  }>,
  branchId?: string
): void {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const updatedLedger = computeReconciledMarginFeeLedger(
    dateKey,
    remainingTransactions,
    resolvedBranchId
  );
  if (updatedLedger) {
    saveStoredMarginFeeLedger(updatedLedger, true, resolvedBranchId);
  }
}

export async function reconcileMarginFeeLedgerAfterDeleteAsync(
  dateKey: string,
  remainingTransactions: Array<{
    createdAt?: string;
    paidAt?: string;
    profit?: number;
    paymentMethod?: string;
    status?: string;
  }>,
  branchId?: string
): Promise<void> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const updatedLedger = computeReconciledMarginFeeLedger(
    dateKey,
    remainingTransactions,
    resolvedBranchId
  );
  if (updatedLedger) {
    await saveStoredMarginFeeLedgerAsync(updatedLedger, true, resolvedBranchId);
  }
}

function resolveExpensePaidByKey(paidByKey: string): FundSourceKey {
  const rawKey = (paidByKey || 'cash').trim().toLowerCase();
  return rawKey === 'cash' || rawKey.includes('tunai')
    ? 'cash'
    : rawKey === 'brimo1' || rawKey.includes('brimo 1')
    ? 'brimo1'
    : rawKey === 'brimo2' || rawKey.includes('brimo 2')
    ? 'brimo2'
    : rawKey === 'dana1' || rawKey.includes('dana 1')
    ? 'dana1'
    : rawKey === 'dana2' || rawKey.includes('dana 2')
    ? 'dana2'
    : rawKey === 'seabank'
    ? 'seabank'
    : 'cash';
}

export function processExpenseBalanceDeduction(
  paidByKey: string,
  amount: number,
  branchId?: string
): { success: boolean; balances: AccountBalances; message?: string } {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const validKey = resolveExpensePaidByKey(paidByKey);
  const numAmount = Math.max(0, Math.round(Number(amount) || 0));
  const currentBal = current[validKey] || 0;

  if (numAmount > currentBal) {
    return {
      success: false,
      balances: current,
      message: `Saldo ${getFundSourceLabel(validKey)} tidak mencukupi (Tersedia: Rp ${currentBal.toLocaleString('id-ID')}, Dibutuhkan: Rp ${numAmount.toLocaleString('id-ID')}).`,
    };
  }

  const updated: AccountBalances = {
    ...current,
    [validKey]: Math.max(0, currentBal - numAmount),
  };

  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return {
    success: true,
    balances: updated,
  };
}

export async function processExpenseBalanceDeductionAsync(
  paidByKey: string,
  amount: number,
  branchId?: string
): Promise<{ success: boolean; balances: AccountBalances; message?: string }> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const validKey = resolveExpensePaidByKey(paidByKey);
  const numAmount = Math.max(0, Math.round(Number(amount) || 0));
  const currentBal = current[validKey] || 0;

  if (numAmount > currentBal) {
    return {
      success: false,
      balances: current,
      message: `Saldo ${getFundSourceLabel(validKey)} tidak mencukupi (Tersedia: Rp ${currentBal.toLocaleString('id-ID')}, Dibutuhkan: Rp ${numAmount.toLocaleString('id-ID')}).`,
    };
  }

  const updated: AccountBalances = {
    ...current,
    [validKey]: Math.max(0, currentBal - numAmount),
  };

  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return {
    success: true,
    balances: updated,
  };
}

export function processExpenseBalanceRefund(
  paidByKey: string,
  amount: number,
  branchId?: string
): AccountBalances {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const validKey = resolveExpensePaidByKey(paidByKey);
  const numAmount = Math.max(0, Math.round(Number(amount) || 0));
  const updated: AccountBalances = {
    ...current,
    [validKey]: (current[validKey] || 0) + numAmount,
  };

  saveStoredAccountBalances(updated, true, resolvedBranchId);
  return updated;
}

export async function processExpenseBalanceRefundAsync(
  paidByKey: string,
  amount: number,
  branchId?: string
): Promise<AccountBalances> {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredAccountBalances(resolvedBranchId);
  const validKey = resolveExpensePaidByKey(paidByKey);
  const numAmount = Math.max(0, Math.round(Number(amount) || 0));
  const updated: AccountBalances = {
    ...current,
    [validKey]: (current[validKey] || 0) + numAmount,
  };

  await saveStoredAccountBalancesAsync(updated, true, undefined, resolvedBranchId);
  return updated;
}
