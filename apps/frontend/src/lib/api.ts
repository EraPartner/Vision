const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface LoginCredentials {
  email: string;
  password: string;
}

interface RegisterCredentials {
  email: string;
  password: string;
}

interface Transaction {
  id?: number;
  transaction_date: string;
  description: string;
  amount: number;
  category: string;
  bank_source?: string;
}

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem('access_token');
  }

  private setToken(token: string): void {
    localStorage.setItem('access_token', token);
  }

  private removeToken(): void {
    localStorage.removeItem('access_token');
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const token = this.getToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      this.removeToken();
      window.location.href = '/auth';
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Request failed' }));
      throw new Error(error.detail || 'Request failed');
    }

    return response.json();
  }

  // Auth methods
  async register(credentials: RegisterCredentials) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    return data;
  }

  async login(credentials: LoginCredentials) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    this.setToken(data.access_token);
    return data;
  }

  logout() {
    this.removeToken();
  }

  async getCurrentUser() {
    return this.request('/api/auth/me');
  }

  isAuthenticated(): boolean {
    return !!this.getToken();
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
export type { Transaction, LoginCredentials, RegisterCredentials };
