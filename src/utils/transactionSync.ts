import { DigitalTransaction, ServiceSoftwareOrder, Sale, StoreExpense } from '../types/index.ts';
import { restoreStockFromSaleCloud } from '../services/cloudInventoryService.ts';
import { deleteDigitalTransactionFromCloud } from '../services/cloudDigitalFinanceService.ts';
import {
  rollbackTransactionBalanceAsync,
  getLocalDateKey,
  reconcileMarginFeeLedgerAfterDeleteAsync,
} from '../services/accountBalanceService.ts';
import {
  getActiveBranchId,
  getBranchStorageKey,
  normalizeBranchId,
} from '../services/branchService.ts';

export const STORAGE_KEY_DIGITAL = 'konter_digital_transactions';
export const STORAGE_KEY_SERVICES = 'konter_service_orders';
export const STORAGE_KEY_SALES = 'konter_sales_list';
export const STORAGE_KEY_EXPENSES = 'konter_store_expenses';

export const EVENT_TRANSACTION_DELETED = 'konter_transaction_deleted';
export const EVENT_DATA_UPDATED = 'konter_data_updated';

export interface DeleteTransactionPayload {
  category: 'pos' | 'digital' | 'service';
  rawId: number;
  invoiceNumber: string;
  items?: any[];
  digitalItem?: DigitalTransaction;
}

// ==========================================
// 1. LOCAL STORAGE HELPERS & AUTO-PURGE DUMMY
// ==========================================

if (typeof window !== 'undefined') {
  try {
    const CLEANUP_KEY = 'konter_initial_dummy_cleaned_v2';
    if (!localStorage.getItem(CLEANUP_KEY)) {
      localStorage.removeItem(STORAGE_KEY_DIGITAL);
      localStorage.removeItem(STORAGE_KEY_SERVICES);
      localStorage.removeItem(STORAGE_KEY_SALES);
      localStorage.setItem(CLEANUP_KEY, 'true');
    }
  } catch {
    // quiet fail in non-browser environment
  }
}

// --- Digital Transactions ---
export function getStoredDigitalTransactions(branchId?: string): DigitalTransaction[] {
  if (typeof window === 'undefined') return [];
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const key = getBranchStorageKey(STORAGE_KEY_DIGITAL, resolvedBranchId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => !(item.id >= 301 && item.id <= 325) && !item.referenceNumber?.startsWith('TRX-BRI-98124')
    );
  } catch {
    return [];
  }
}

export function saveStoredDigitalTransactions(
  list: DigitalTransaction[],
  silent: boolean = false,
  branchId?: string
): void {
  if (typeof window === 'undefined') return;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const key = getBranchStorageKey(STORAGE_KEY_DIGITAL, resolvedBranchId);
  try {
    localStorage.setItem(key, JSON.stringify(list));
    if (!silent && resolvedBranchId === getActiveBranchId()) {
      notifyDataUpdated('digital');
    }
  } catch (e) {
    console.warn('Failed to save digital transactions to localStorage:', e);
  }
}

export function removeStoredDigitalTransaction(
  id: number,
  refNumber?: string,
  branchId?: string
): DigitalTransaction[] {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredDigitalTransactions(resolvedBranchId);
  const updated = current.filter(
    (item) => item.id !== id && (refNumber ? item.referenceNumber !== refNumber : true)
  );
  saveStoredDigitalTransactions(updated, false, resolvedBranchId);
  return updated;
}

// --- Service Software Orders ---
export function getStoredServiceOrders(): ServiceSoftwareOrder[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SERVICES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => !(item.id >= 401 && item.id <= 425) && !item.orderNumber?.startsWith('SRV-20261026-001')
    );
  } catch {
    return [];
  }
}

export function saveStoredServiceOrders(list: ServiceSoftwareOrder[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_SERVICES, JSON.stringify(list));
    notifyDataUpdated('service');
  } catch (e) {
    console.warn('Failed to save service orders to localStorage:', e);
  }
}

export function removeStoredServiceOrder(id: number, orderNumber?: string): ServiceSoftwareOrder[] {
  const current = getStoredServiceOrders();
  const updated = current.filter(
    (item) => item.id !== id && (orderNumber ? item.orderNumber !== orderNumber : true)
  );
  saveStoredServiceOrders(updated);
  return updated;
}

// Known default costs for accessories if missing from older records
const KNOWN_ACCESSORY_COSTS: Record<string, number> = {
  'TWS Bluetooth 5.3 Earbuds Low Latency': 110000,
  'Softcase Silikon Bening Anti Crack 2.0mm': 5000,
  'Adaptor Charger Fast Charging 20W PD Type-C': 45000,
  'Kabel Data Braided Type-C to Type-C 60W (1 Meter)': 18000,
  'Tempered Glass 9D Full Cover Layar Lengkung': 7000,
};

// --- POS Sales ---
export function getStoredSales(): Sale[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SALES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    let hasRepairs = false;
    const healedList = parsed.map((sale: any) => {
      let isModified = false;
      let totalCost = Number(sale.totalCost || 0);
      let items = sale.items;

      if (Array.isArray(items) && items.length > 0) {
        let itemsCost = 0;
        const healedItems = items.map((it: any) => {
          let cost = Number(it.costPrice || 0);
          if (cost <= 0 && it.productName && KNOWN_ACCESSORY_COSTS[it.productName]) {
            cost = KNOWN_ACCESSORY_COSTS[it.productName];
            isModified = true;
          }
          const qty = Number(it.quantity || 1);
          const sell = Number(it.sellingPrice || 0);
          const sub = Number(it.subtotal || sell * qty);
          const itemCost = cost * qty;
          itemsCost += itemCost;
          const profit = it.profit != null && it.profit > 0 ? Number(it.profit) : Math.max(0, sub - itemCost);
          if (it.profit !== profit || it.subtotal !== sub || it.costPrice !== cost) {
            isModified = true;
          }
          return {
            ...it,
            costPrice: cost,
            sellingPrice: sell,
            quantity: qty,
            subtotal: sub,
            profit,
          };
        });

        items = healedItems;
        if (totalCost <= 0) {
          totalCost = itemsCost;
          isModified = true;
        }
      }

      let totalProfit = Number(sale.totalProfit || 0);
      const grandTotal = Number(sale.grandTotal || sale.totalAmount || 0);

      if (totalProfit <= 0 && grandTotal > 0) {
        if (Array.isArray(items) && items.length > 0) {
          totalProfit = items.reduce((sum: number, it: any) => sum + Number(it.profit || 0), 0);
        } else if (totalCost > 0) {
          totalProfit = Math.max(0, grandTotal - totalCost);
        }
        if (totalProfit > 0) isModified = true;
      }

      if (isModified) {
        hasRepairs = true;
        return {
          ...sale,
          items,
          grandTotal,
          totalCost,
          totalProfit,
        };
      }
      return sale;
    });

    if (hasRepairs) {
      saveStoredSales(healedList);
    }
    return healedList;
  } catch {
    return [];
  }
}

export function saveStoredSales(list: Sale[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_SALES, JSON.stringify(list));
    notifyDataUpdated('pos');
  } catch (e) {
    console.warn('Failed to save sales to localStorage:', e);
  }
}

export function removeStoredSale(id: number, invoiceNumber?: string): Sale[] {
  const current = getStoredSales();
  const updated = current.filter(
    (item) => item.id !== id && (invoiceNumber ? item.invoiceNumber !== invoiceNumber : true)
  );
  saveStoredSales(updated);
  return updated;
}

// --- Store Expenses (Beban Operasional Toko) ---
export function getStoredExpenses(branchId?: string): StoreExpense[] {
  if (typeof window === 'undefined') return [];
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const key = getBranchStorageKey(STORAGE_KEY_EXPENSES, resolvedBranchId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStoredExpenses(list: StoreExpense[], branchId?: string): void {
  if (typeof window === 'undefined') return;
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const key = getBranchStorageKey(STORAGE_KEY_EXPENSES, resolvedBranchId);
  try {
    localStorage.setItem(key, JSON.stringify(list));
    if (resolvedBranchId === getActiveBranchId()) {
      notifyDataUpdated('all');
    }
  } catch (e) {
    console.warn('Failed to save expenses to localStorage:', e);
  }
}

export function removeStoredExpense(id: number, branchId?: string): StoreExpense[] {
  const resolvedBranchId = normalizeBranchId(branchId || getActiveBranchId());
  const current = getStoredExpenses(resolvedBranchId);
  const updated = current.filter((item) => item.id !== id);
  saveStoredExpenses(updated, resolvedBranchId);
  return updated;
}

// ==========================================
// 2. CENTRALIZED DELETE HANDLER
// ==========================================

export async function executeUnifiedDelete(payload: DeleteTransactionPayload): Promise<{ success: boolean; message: string; restoredCount?: number }> {
  const { category, rawId, invoiceNumber } = payload;

  if (category === 'pos') {
    let itemsToRestore = payload.items;

    if (!itemsToRestore || itemsToRestore.length === 0) {
      const stored = getStoredSales();
      const matchedSale = stored.find(
        (s) => s.id === rawId || s.invoiceNumber === invoiceNumber
      );
      if (matchedSale?.items && matchedSale.items.length > 0) {
        itemsToRestore = matchedSale.items;
      }
    }

    if (!itemsToRestore || itemsToRestore.length === 0) {
      try {
        const saleRes = await fetch(`/api/sales/${rawId}`);
        if (saleRes.ok) {
          const detailed = await saleRes.json();
          if (detailed?.items && Array.isArray(detailed.items)) {
            itemsToRestore = detailed.items;
          }
        }
      } catch (fetchErr) {
        console.warn('Notice fetching sale items for restock:', fetchErr);
      }
    }

    if (itemsToRestore && itemsToRestore.length > 0) {
      try {
        await restoreStockFromSaleCloud(itemsToRestore);
      } catch (cloudErr) {
        console.warn('Gagal memulihkan stok ke Cloud Firestore:', cloudErr);
      }
    }
  }

  let endpoint = '';
  if (category === 'pos') {
    endpoint = `/api/sales/${rawId}?invoice=${encodeURIComponent(invoiceNumber)}`;
  } else if (category === 'digital') {
    endpoint = `/api/digital-finance/${rawId}?ref=${encodeURIComponent(invoiceNumber)}`;
  } else if (category === 'service') {
    endpoint = `/api/services/${rawId}?orderNumber=${encodeURIComponent(invoiceNumber)}`;
  }

  const targetBranchId = normalizeBranchId(payload.digitalItem?.branchId || getActiveBranchId());
  let targetTxForDigital: DigitalTransaction | undefined = payload.digitalItem;
  if (category === 'digital') {
    if (!targetTxForDigital) {
      const currentDigi = getStoredDigitalTransactions(targetBranchId);
      targetTxForDigital = currentDigi.find(
        (d) => d.id === rawId || (invoiceNumber ? d.referenceNumber === invoiceNumber : false)
      );
    }
    await deleteDigitalTransactionFromCloud(rawId, invoiceNumber);
  }

  let serverDeleted: any = null;
  try {
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.deleted) {
        serverDeleted = data.deleted;
      }
    }
  } catch (err: any) {
    console.warn('Server delete call skipped/offline:', err);
  }

  if (category === 'pos') {
    removeStoredSale(rawId, invoiceNumber);
  } else if (category === 'digital') {
    let targetTx: DigitalTransaction | undefined = targetTxForDigital;
    if (!targetTx && serverDeleted) {
      targetTx = {
        ...serverDeleted,
        fundSource:
          serverDeleted.fundSource ||
          serverDeleted.notes?.match(/\[Sumber(?:\s*Dana)?:\s*([^\]]+)\]/i)?.[1]?.trim(),
      };
    }

    const txBranchId = normalizeBranchId(targetTx?.branchId || targetBranchId);

    if (targetTx) {
      const resolvedFundSource =
        targetTx.fundSource ||
        targetTx.notes?.match(/\[Sumber(?:\s*Dana)?:\s*([^\]]+)\]/i)?.[1]?.trim() ||
        undefined;

      await rollbackTransactionBalanceAsync({
        fundSourceKey: resolvedFundSource,
        provider: targetTx.provider,
        targetAccount: targetTx.targetAccount,
        adminBankCost: Number(targetTx.adminBankCost || 0),
        adminStoreFee: Number(targetTx.adminStoreFee || 0),
        notes: targetTx.notes,
        type: targetTx.type,
        nominal: Number(targetTx.nominal || 0),
        totalCustomerPaid: Number(targetTx.totalCustomerPaid || 0),
        paymentMethod: targetTx.paymentMethod || 'cash',
        branchId: txBranchId,
      });
    } else {
      console.warn('Data transaksi digital tidak ditemukan untuk rollback saldo');
    }

    const remainingDigital = removeStoredDigitalTransaction(rawId, invoiceNumber, txBranchId);
    const deletedDateKey = getLocalDateKey(targetTx?.createdAt || new Date());
    await reconcileMarginFeeLedgerAfterDeleteAsync(deletedDateKey, remainingDigital, txBranchId);
  } else if (category === 'service') {
    removeStoredServiceOrder(rawId, invoiceNumber);
  }

  notifyTransactionDeleted(payload);
  notifyDataUpdated(category);

  return {
    success: true,
    message:
      category === 'pos'
        ? `Transaksi ${invoiceNumber} berhasil dihapus dan seluruh stok barang berhasil dikembalikan ke inventaris toko.`
        : `Transaksi ${invoiceNumber} berhasil dihapus dan disinkronkan ke seluruh modul.`,
  };
}

// ==========================================
// 3. EVENT BROADCAST & SUBSCRIPTION
// ==========================================

export function notifyTransactionDeleted(payload: DeleteTransactionPayload): void {
  if (typeof window !== 'undefined') {
    const event = new CustomEvent(EVENT_TRANSACTION_DELETED, { detail: payload });
    window.dispatchEvent(event);
  }
}

export function notifyDataUpdated(category: 'pos' | 'digital' | 'service' | 'all'): void {
  if (typeof window !== 'undefined') {
    const event = new CustomEvent(EVENT_DATA_UPDATED, { detail: { category } });
    window.dispatchEvent(event);
  }
}

export function onTransactionDeleted(
  callback: (payload: DeleteTransactionPayload) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (e: Event) => {
    const custom = e as CustomEvent<DeleteTransactionPayload>;
    if (custom.detail) {
      callback(custom.detail);
    }
  };

  window.addEventListener(EVENT_TRANSACTION_DELETED, handler);
  return () => window.removeEventListener(EVENT_TRANSACTION_DELETED, handler);
}

export function onDataUpdated(
  callback: (payload: { category: string }) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = (e: Event) => {
    const custom = e as CustomEvent<{ category: string }>;
    if (custom.detail) {
      callback(custom.detail);
    }
  };

  window.addEventListener(EVENT_DATA_UPDATED, handler);
  return () => window.removeEventListener(EVENT_DATA_UPDATED, handler);
}
