import { useState, useCallback } from "react";

export interface PlannedPayment {
  id: string;
  name: string;
  amount: number;
  currency: string;
  due_date: string; // ISO date
  is_recurring: boolean;
  frequency?: "daily" | "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "custom";
  custom_interval_days?: number;
  end_date?: string;
  max_occurrences?: number;
  recipient?: string;
  category?: string;
  bank_account?: string;
  notes?: string;
  is_active: boolean;
  created_at: string;
}

const STORAGE_KEY = "vault_voyager_planned_payments";

function loadFromStorage(): PlannedPayment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(payments: PlannedPayment[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payments));
}

export function usePlannedPayments() {
  const [payments, setPayments] = useState<PlannedPayment[]>(loadFromStorage);

  const addPayment = useCallback((payment: Omit<PlannedPayment, "id" | "created_at">) => {
    setPayments((prev) => {
      const next = [
        ...prev,
        { ...payment, id: crypto.randomUUID(), created_at: new Date().toISOString() },
      ];
      saveToStorage(next);
      return next;
    });
  }, []);

  const updatePayment = useCallback((id: string, updates: Partial<PlannedPayment>) => {
    setPayments((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...updates } : p));
      saveToStorage(next);
      return next;
    });
  }, []);

  const deletePayment = useCallback((id: string) => {
    setPayments((prev) => {
      const next = prev.filter((p) => p.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  const toggleActive = useCallback((id: string) => {
    setPayments((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, is_active: !p.is_active } : p));
      saveToStorage(next);
      return next;
    });
  }, []);

  return { payments, addPayment, updatePayment, deletePayment, toggleActive };
}
