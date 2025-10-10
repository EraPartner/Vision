import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Transaction {
  transaction_date: string;
  description: string;
  amount: number;
  category?: string;
}

// CSV parsing utility
function parseCSV(csvContent: string): string[][] {
  const lines = csvContent.split('\n').filter(line => line.trim());
  return lines.map(line => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  });
}

// Detect and parse different bank formats
function parseBankCSV(csvContent: string, bankSource: string): Transaction[] {
  const rows = parseCSV(csvContent);
  if (rows.length === 0) return [];
  
  const transactions: Transaction[] = [];
  
  // Skip header row
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 3) continue;
    
    try {
      // Generic format: Date, Description, Amount
      // Banks may have different column orders, this handles common patterns
      let date = row[0];
      let description = row[1];
      let amount = row[2];
      
      // Try to detect amount column (look for numbers with decimals)
      for (let j = 0; j < row.length; j++) {
        const value = row[j].replace(/[^0-9.-]/g, '');
        if (value && !isNaN(parseFloat(value))) {
          amount = value;
          // Description is usually before amount
          if (j > 0) description = row[j - 1];
          // Date is usually first column
          date = row[0];
          break;
        }
      }
      
      // Parse date (handle multiple formats)
      const parsedDate = new Date(date);
      if (isNaN(parsedDate.getTime())) continue;
      
      const parsedAmount = parseFloat(amount.replace(/[^0-9.-]/g, ''));
      if (isNaN(parsedAmount)) continue;
      
      transactions.push({
        transaction_date: parsedDate.toISOString().split('T')[0],
        description: description.replace(/"/g, ''),
        amount: parsedAmount,
        category: 'other'
      });
    } catch (error) {
      console.error('Error parsing row:', row, error);
      continue;
    }
  }
  
  return transactions;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { csvContent, bankSource } = await req.json();
    
    if (!csvContent) {
      throw new Error('No CSV content provided');
    }

    console.log(`Processing CSV import for user ${user.id} from ${bankSource || 'unknown bank'}`);
    
    const transactions = parseBankCSV(csvContent, bankSource || 'unknown');
    
    if (transactions.length === 0) {
      return new Response(
        JSON.stringify({ 
          error: 'No valid transactions found in CSV',
          imported: 0 
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400
        }
      );
    }

    // Insert transactions
    const transactionsWithUser = transactions.map(t => ({
      ...t,
      user_id: user.id,
      bank_source: bankSource || 'unknown'
    }));

    const { data, error } = await supabase
      .from('transactions')
      .insert(transactionsWithUser)
      .select();

    if (error) {
      console.error('Error inserting transactions:', error);
      throw error;
    }

    console.log(`Successfully imported ${data.length} transactions`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        imported: data.length,
        transactions: data
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );

  } catch (error) {
    console.error('Error in import-csv function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      }
    );
  }
});