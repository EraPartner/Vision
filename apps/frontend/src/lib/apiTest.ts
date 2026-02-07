/**
 * API connection test utility
 * Use this to verify backend connectivity
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export async function testApiConnection() {
    console.log('🔍 Testing API connection...');
    console.log('📍 API URL:', API_BASE_URL);

    try {
        // Test 1: Basic connectivity
        console.log('Test 1: Checking basic connectivity...');
        const response = await fetch(`${API_BASE_URL}/`);
        console.log('✅ Backend is reachable:', {
            status: response.status,
            statusText: response.statusText,
        });

        // Test 2: Info endpoint
        console.log('Test 2: Checking /api/info endpoint...');
        const infoResponse = await fetch(`${API_BASE_URL}/api/info`);
        const infoData = await infoResponse.json();
        console.log('✅ Info endpoint response:', infoData);

        // Test 3: Transactions endpoint
        console.log('Test 3: Checking /api/transactions endpoint...');
        const txResponse = await fetch(`${API_BASE_URL}/api/transactions?limit=5`);
        const txData = await txResponse.json();
        console.log('✅ Transactions endpoint response:', {
            total: txData.total,
            returned: txData.transactions?.length || 0,
        });

        console.log('🎉 All API tests passed!');
        return true;
    } catch (error) {
        console.error('❌ API connection test failed:', error);
        console.error('💡 Make sure the backend is running on:', API_BASE_URL);
        console.error('💡 Try running: npm run backend');
        return false;
    }
}

// Auto-run test in development
if (import.meta.env.DEV) {
    testApiConnection();
}
