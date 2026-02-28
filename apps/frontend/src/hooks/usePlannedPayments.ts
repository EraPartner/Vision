import { useState, useCallback, useEffect } from "react";
import { apiClient } from "@/lib/api";
import type { PlannedTransaction, PlannedTransactionCreate, PlannedTransactionUpdate } from "@/types/api";

export interface PlannedPayment {
  id: number;
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
  recipient_id?: number;
  category?: string;
  category_id?: number;
  bank_account?: string;
  notes?: string;
  url?: string;
  is_active: boolean;
  created_at: string;
}

// Map backend PlannedTransaction to frontend PlannedPayment format
function mapFromAPI(pt: PlannedTransaction): PlannedPayment {
  // Parse recurrence_pattern to extract frequency
  let frequency: PlannedPayment["frequency"] = "monthly";
  let custom_interval_days: number | undefined;

  if (pt.recurrence_pattern) {
    const pattern = pt.recurrence_pattern.toLowerCase();
    if (pattern === "daily") frequency = "daily";
    else if (pattern === "weekly") frequency = "weekly";
    else if (pattern === "biweekly" || pattern === "bi-weekly") frequency = "biweekly";
    else if (pattern === "monthly") frequency = "monthly";
    else if (pattern === "quarterly") frequency = "quarterly";
    else if (pattern === "yearly") frequency = "yearly";
    else {
      // Try to parse custom pattern like "every 10 days" or just a number
      const match = pattern.match(/(\d+)/);
      if (match) {
        frequency = "custom";
        custom_interval_days = parseInt(match[1]);
      }
    }
  }

  return {
    id: pt.id,
    name: pt.memo || pt.recipient_name || "Unnamed payment",
    amount: pt.amount,
    currency: pt.currency || "EUR",
    due_date: pt.planned_date,
    url: pt.url,
    is_recurring: pt.is_recurring,
    frequency: pt.is_recurring ? frequency : undefined,
    custom_interval_days,
    recipient: pt.recipient_name,
    recipient_id: pt.recipient_id,
    category: pt.category_name,
    category_id: pt.category_id,
    bank_account: pt.bank_account,
    notes: pt.comment,
    is_active: pt.is_active,
    is_executed: pt.is_executed,
    last_executed_date: pt.last_executed_date,
    executed_transaction_id: pt.executed_transaction_id,
    execution_count: pt.execution_count || 0,
    created_at: pt.created_at,
  };
}

// Map frontend PlannedPayment to backend PlannedTransactionCreate format
function mapToCreateAPI(payment: Omit<PlannedPayment, "id" | "created_at">): PlannedTransactionCreate {
  // Build recurrence_pattern from frequency
  let recurrence_pattern: string | undefined;
  if (payment.is_recurring && payment.frequency) {
    if (payment.frequency === "custom" && payment.custom_interval_days) {
      recurrence_pattern = `every ${payment.custom_interval_days} days`;
    } else {
      recurrence_pattern = payment.frequency;
    }
  }

  return {
    planned_date: payment.due_date,
    bank_account: payment.bank_account || undefined,
    recipient_id: payment.recipient_id || undefined,
    memo: payment.name,
    amount: payment.amount,
    currency: payment.currency,
    category_id: payment.category_id,
    comment: payment.notes,
    url: payment.url,
    is_recurring: payment.is_recurring,
    recurrence_pattern,
  };
}

// Map frontend PlannedPayment partial updates to backend format
function mapToUpdateAPI(updates: Partial<PlannedPayment>): PlannedTransactionUpdate {
  const result: PlannedTransactionUpdate = {};

  if (updates.due_date !== undefined) result.planned_date = updates.due_date;
  if (updates.bank_account !== undefined) result.bank_account = updates.bank_account;
  if (updates.recipient_id !== undefined) result.recipient_id = updates.recipient_id;
  if (updates.name !== undefined) result.memo = updates.name;
  if (updates.amount !== undefined) result.amount = updates.amount;
  if (updates.currency !== undefined) result.currency = updates.currency;
  if (updates.category_id !== undefined) result.category_id = updates.category_id;
  if (updates.notes !== undefined) result.comment = updates.notes;
  if (updates.url !== undefined) result.url = updates.url;
  if (updates.is_recurring !== undefined) result.is_recurring = updates.is_recurring;
  if (updates.is_active !== undefined) result.is_active = updates.is_active;

  // Handle recurrence_pattern
  if (updates.frequency !== undefined || updates.custom_interval_days !== undefined) {
    const freq = updates.frequency;
    if (freq === "custom" && updates.custom_interval_days) {
      result.recurrence_pattern = `every ${updates.custom_interval_days} days`;
    } else if (freq) {
      result.recurrence_pattern = freq;
    }
  }

  return result;
}

export function usePlannedPayments(showInactive: boolean = false) {
  const [payments, setPayments] = useState<PlannedPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPayments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getPlannedTransactions({
        active: !showInactive, // If showInactive is true, fetch all (active: false means fetch all including inactive)
        limit: 1000
      });
      setPayments(response.items.map(mapFromAPI));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch planned payments");
      console.error("Error fetching planned payments:", err);
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const addPayment = useCallback(async (payment: Omit<PlannedPayment, "id" | "created_at">) => {
    try {
      const apiPayload = mapToCreateAPI(payment);
      const created = await apiClient.createPlannedTransaction(apiPayload);
      setPayments((prev) => [...prev, mapFromAPI(created)]);
    } catch (err) {
      console.error("Error creating planned payment:", err);
      throw err;
    }
  }, []);

  const updatePayment = useCallback(async (id: number, updates: Partial<PlannedPayment>) => {
    try {
      const apiUpdates = mapToUpdateAPI(updates);
      const updated = await apiClient.updatePlannedTransaction(id, apiUpdates);
      setPayments((prev) => prev.map((p) => (p.id === id ? mapFromAPI(updated) : p)));
    } catch (err) {
      console.error("Error updating planned payment:", err);
      throw err;
    }
  }, []);

  const deletePayment = useCallback(async (id: number) => {
    try {
      await apiClient.deletePlannedTransaction(id);
      setPayments((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error("Error deleting planned payment:", err);
      throw err;
    }
  }, []);

  const toggleActive = useCallback(async (id: number) => {
    try {
      const payment = payments.find((p) => p.id === id);
      if (!payment) return;

      const updated = await apiClient.updatePlannedTransaction(id, {
        is_active: !payment.is_active
      });
      setPayments((prev) => prev.map((p) => (p.id === id ? mapFromAPI(updated) : p)));
    } catch (err) {
      console.error("Error toggling payment active status:", err);
      throw err;
    }
  }, [payments]);

  const executePayment = useCallback(async (id: number, transactionId: number, executionDate?: string) => {
    try {
      const executeRequest: PlannedTransactionExecuteRequest = {
        executed_transaction_id: transactionId,
        execution_date: executionDate
      };
      const updated = await apiClient.executePlannedTransaction(id, executeRequest);
      setPayments((prev) => prev.map((p) => (p.id === id ? mapFromAPI(updated) : p)));
    } catch (err) {
      console.error("Error executing payment:", err);
      throw err;
    }
  }, []);

  return {
    payments,
    addPayment,
    updatePayment,
    deletePayment,
    toggleActive,
    executePayment,
    loading,
    error,
    refetch: fetchPayments
  };
}