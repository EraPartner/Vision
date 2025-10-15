const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface Transaction {
  id?: number;
  transaction_date: string;
  description: string;
  amount: number;
  category: string;
  bank_source?: string;
}

class ApiClient {
  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }));
      throw new Error(error.detail || 'Request failed');
    }

    return response.json();
  }

  // Transaction methods
  async getTransactions(): Promise<Transaction[]> {
    return this.request('/api/transactions');
  }

  async createTransaction(transaction: Omit<Transaction, 'id'>): Promise<Transaction> {
    return this.request('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(transaction),
    });
  }

  async updateTransaction(id: number, transaction: Omit<Transaction, 'id'>): Promise<Transaction> {
    return this.request(`/api/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(transaction),
    });
  }

  async deleteTransaction(id: number): Promise<void> {
    return this.request(`/api/transactions/${id}`, {
      method: 'DELETE',
    });
  }

  // CSV Import
  async importCSV(csvContent: string, bankSource?: string): Promise<{ imported: number; message: string }> {
    return this.request('/api/import-csv', {
      method: 'POST',
      body: JSON.stringify({ csv_content: csvContent, bank_source: bankSource }),
    });
  }
}

export const apiClient = new ApiClient();
export type { Transaction };