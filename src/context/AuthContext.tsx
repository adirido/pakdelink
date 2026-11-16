import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { User, signInWithPopup, signOut as fbSignOut } from 'firebase/auth';
import { auth, googleAuthProvider } from '../lib/firebase.ts';
import { UserRole, AppUser, Branch } from '../types/index.ts';
import {
  DEFAULT_BRANCH_ID,
  DEFAULT_PUSAT_BRANCH,
  ensureDefaultPusatBranchCloud,
  getActiveBranchId,
  getStoredBranches,
  normalizeBranchId,
  setActiveBranchId as setStoredActiveBranchId,
  subscribeBranchesCloud,
} from '../services/branchService.ts';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  operatorName: string;
  setOperatorName: (name: string) => void;
  currentRole: UserRole;
  switchRole: (role: UserRole) => void;
  // Multi-Cabang
  branches: Branch[];
  activeBranchId: string;
  activeBranch: Branch;
  switchBranch: (branchId: string) => void;
  // Terminal Lock / Shift Management
  isLocked: boolean;
  activeStaff: AppUser | null;
  unlockTerminal: (staff: AppUser) => void;
  lockTerminal: () => void;
  // Permissions
  canViewCostPrice: boolean;
  canViewAnalytics: boolean;
  canManageInventory: boolean;
  canManageUsers: boolean;
  canManageExpenses: boolean;
  canAccessServiceDesk: boolean;
  canAccessPOS: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signInWithGoogle: async () => {},
  signOut: async () => {},
  operatorName: 'Kasir Utama',
  setOperatorName: () => {},
  currentRole: 'cashier',
  switchRole: () => {},
  branches: [DEFAULT_PUSAT_BRANCH],
  activeBranchId: DEFAULT_BRANCH_ID,
  activeBranch: DEFAULT_PUSAT_BRANCH,
  switchBranch: () => {},
  isLocked: true,
  activeStaff: null,
  unlockTerminal: () => {},
  lockTerminal: () => {},
  canViewCostPrice: false,
  canViewAnalytics: false,
  canManageInventory: false,
  canManageUsers: false,
  canManageExpenses: false,
  canAccessServiceDesk: false,
  canAccessPOS: true,
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<Branch[]>(() => getStoredBranches());

  const isLegacyStoredStaff = (staff: any): boolean => {
    if (!staff) return false;
    const legacyUids = ['owner-default-001', 'owner-gunungsari-google', 'cashier-default-002', 'manager-default-003', 'tech-default-004'];
    const legacyEmails = ['owner@konterpos.id', 'gunungsarientertainer@gmail.com', 'kasir@konterpos.id', 'manager@konterpos.id', 'teknisi@konterpos.id'];
    return legacyUids.includes(String(staff.uid || '').toLowerCase()) || legacyEmails.includes(String(staff.email || '').toLowerCase());
  };

  // Terminal Lockscreen State
  const [isLocked, setIsLocked] = useState<boolean>(() => {
    const saved = localStorage.getItem('konter_active_staff');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (isLegacyStoredStaff(parsed)) {
          sessionStorage.removeItem('konter_terminal_unlocked');
          localStorage.removeItem('konter_active_staff');
          localStorage.removeItem('konter_user_role');
          return true;
        }
      } catch {
        // ignore
      }
    }
    return sessionStorage.getItem('konter_terminal_unlocked') !== 'true';
  });

  const [activeStaff, setActiveStaff] = useState<AppUser | null>(() => {
    const saved = localStorage.getItem('konter_active_staff');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (isLegacyStoredStaff(parsed)) return null;
        return parsed;
      } catch {
        return null;
      }
    }
    return null;
  });

  const [currentRole, setCurrentRole] = useState<UserRole>(() => {
    return (localStorage.getItem('konter_user_role') as UserRole) || 'cashier';
  });

  const [activeBranchIdState, setActiveBranchIdState] = useState<string>(() => {
    try {
      const savedStaff = localStorage.getItem('konter_active_staff');
      if (savedStaff) {
        const parsed = JSON.parse(savedStaff);
        if (parsed && parsed.role && parsed.role !== 'owner') {
          const staffBranch = normalizeBranchId(parsed.branchId);
          setStoredActiveBranchId(staffBranch);
          return staffBranch;
        }
      }
    } catch {
      // ignore
    }
    return getActiveBranchId();
  });

  const [customOperator, setCustomOperator] = useState<string>(() => {
    return localStorage.getItem('konter_operator_name') || 'Bella Heartfire';
  });

  // Subscribe ke master cabang di Cloud Firestore
  useEffect(() => {
    ensureDefaultPusatBranchCloud()
      .then((list) => {
        if (list.length > 0) setBranches(list);
      })
      .catch(() => {});

    const unsubBranches = subscribeBranchesCloud((cloudBranches) => {
      if (cloudBranches.length > 0) {
        setBranches(cloudBranches);
      }
    });

    return () => unsubBranches();
  }, []);

  // Pastikan branch aktif selalu valid (dan staff non-owner selalu terkunci di cabangnya)
  useEffect(() => {
    if (currentRole !== 'owner' && activeStaff) {
      const lockedBranch = normalizeBranchId(activeStaff.branchId);
      if (activeBranchIdState !== lockedBranch) {
        setStoredActiveBranchId(lockedBranch);
        setActiveBranchIdState(lockedBranch);
      }
      return;
    }

    if (branches.length > 0 && !branches.some((b) => b.id === activeBranchIdState)) {
      setStoredActiveBranchId(DEFAULT_BRANCH_ID);
      setActiveBranchIdState(DEFAULT_BRANCH_ID);
    }
  }, [branches, currentRole, activeStaff, activeBranchIdState]);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (currentUser) => {
      setUser(currentUser);
      setLoading(false);

      if (currentUser) {
        try {
          const res = await fetch('/api/auth/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uid: currentUser.uid,
              email: currentUser.email,
              name: currentUser.displayName || 'Roni Jaswoko',
            }),
          });
          const dbUser = await res.json();
          if (dbUser?.role) {
            setCurrentRole(dbUser.role);
            localStorage.setItem('konter_user_role', dbUser.role);
            unlockTerminal(dbUser);
          } else {
            unlockTerminal({
              id: 1,
              uid: currentUser.uid,
              employeeId: '151500',
              email: currentUser.email || '151500',
              name: currentUser.displayName || 'Roni Jaswoko',
              role: 'owner',
              branchId: DEFAULT_BRANCH_ID,
            });
          }
        } catch {
          unlockTerminal({
            id: 1,
            uid: currentUser.uid,
            employeeId: '151500',
            email: currentUser.email || '151500',
            name: currentUser.displayName || 'Roni Jaswoko',
            role: 'owner',
            branchId: DEFAULT_BRANCH_ID,
          });
        }
      }
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err: any) {
      if (err?.code === 'auth/popup-blocked') {
        throw new Error('Popup login Google diblokir browser. Harap izinkan popup atau gunakan tombol Akses Cepat di bawah.');
      }
      if (
        err?.code === 'auth/popup-closed-by-user' ||
        err?.code === 'auth/cancelled-popup-request'
      ) {
        throw new Error('Jendela login Google ditutup sebelum selesai.');
      }
      console.warn('Google Sign-in info:', err?.message || err);
      throw err;
    }
  };

  const signOut = async () => {
    try {
      await fbSignOut(auth);
      lockTerminal();
    } catch (err: any) {
      console.warn('Sign-out info:', err?.message || err);
    }
  };

  const unlockTerminal = (staff: AppUser) => {
    if (!staff || !staff.role) return;
    const validRoles: UserRole[] = ['owner', 'manager', 'cashier', 'technician'];
    const safeRole: UserRole = validRoles.includes(staff.role) ? staff.role : 'cashier';
    const staffBranchId =
      safeRole === 'owner' ? DEFAULT_BRANCH_ID : normalizeBranchId(staff.branchId);
    const { pin: _pin, ...staffWithoutPin } = staff;
    const sanitizedStaff: AppUser = {
      ...staffWithoutPin,
      role: safeRole,
      branchId: staffBranchId,
    };

    setActiveStaff(sanitizedStaff);
    setCurrentRole(safeRole);
    setCustomOperator(sanitizedStaff.name);
    setIsLocked(false);
    sessionStorage.setItem('konter_terminal_unlocked', 'true');
    localStorage.setItem('konter_user_role', safeRole);
    localStorage.setItem('konter_operator_name', sanitizedStaff.name);
    localStorage.setItem('konter_active_staff', JSON.stringify(sanitizedStaff));

    if (safeRole !== 'owner') {
      const locked = setStoredActiveBranchId(staffBranchId);
      setActiveBranchIdState(locked);
    } else {
      const currentStored = getActiveBranchId();
      const valid = branches.some((b) => b.id === currentStored) ? currentStored : DEFAULT_BRANCH_ID;
      setStoredActiveBranchId(valid);
      setActiveBranchIdState(valid);
    }
  };

  const lockTerminal = () => {
    setIsLocked(true);
    setActiveStaff(null);
    setCurrentRole('cashier');
    sessionStorage.removeItem('konter_terminal_unlocked');
    localStorage.removeItem('konter_active_staff');
    localStorage.removeItem('konter_user_role');
  };

  const setOperatorName = (name: string) => {
    setCustomOperator(name);
    localStorage.setItem('konter_operator_name', name);
  };

  const switchRole = (role: UserRole) => {
    setCurrentRole(role);
    localStorage.setItem('konter_user_role', role);

    if (!user) {
      if (role === 'owner') setOperatorName('Roni Jaswoko');
      else if (role === 'manager') setOperatorName('Kepala Toko');
      else if (role === 'cashier') setOperatorName('Bella Heartfire');
      else if (role === 'technician') setOperatorName('Teknisi');
    }
  };

  const switchBranch = (branchId: string) => {
    if (currentRole !== 'owner') return;
    const normalized = normalizeBranchId(branchId);
    const exists = branches.some((b) => b.id === normalized);
    const target = exists ? normalized : DEFAULT_BRANCH_ID;
    setStoredActiveBranchId(target);
    setActiveBranchIdState(target);
  };

  const activeBranch = useMemo<Branch>(() => {
    return (
      branches.find((b) => b.id === activeBranchIdState) ||
      branches.find((b) => b.id === DEFAULT_BRANCH_ID) ||
      DEFAULT_PUSAT_BRANCH
    );
  }, [branches, activeBranchIdState]);

  const operatorName = user?.displayName || user?.email?.split('@')[0] || customOperator;

  // RBAC Permission Gates
  const canViewCostPrice = currentRole === 'owner' || currentRole === 'manager';
  const canViewAnalytics = currentRole === 'owner' || currentRole === 'manager';
  const canManageInventory = currentRole === 'owner' || currentRole === 'manager';
  const canManageUsers = currentRole === 'owner';
  const canManageExpenses = currentRole === 'owner' || currentRole === 'manager';
  const canAccessServiceDesk = currentRole === 'owner' || currentRole === 'manager' || currentRole === 'technician';
  const canAccessPOS = currentRole === 'owner' || currentRole === 'manager' || currentRole === 'cashier';

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signInWithGoogle,
        signOut,
        operatorName,
        setOperatorName,
        currentRole,
        switchRole,
        branches,
        activeBranchId: activeBranchIdState,
        activeBranch,
        switchBranch,
        isLocked,
        activeStaff,
        unlockTerminal,
        lockTerminal,
        canViewCostPrice,
        canViewAnalytics,
        canManageInventory,
        canManageUsers,
        canManageExpenses,
        canAccessServiceDesk,
        canAccessPOS,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
