# Quick Start Guide

## 🚀 Getting Started in 5 Minutes

### Option 1: Automated Setup (Recommended)

```bash
./start.sh
```

This will automatically:
- Set up the Python backend virtual environment
- Install all dependencies
- Start both backend and frontend servers

### Option 2: Manual Setup

#### Backend Setup
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

#### Frontend Setup (in a new terminal)
```bash
npm install
npm run dev
```

## 📍 Access Points

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:8000
- **API Documentation**: http://localhost:8000/docs (Swagger UI)

## 🎯 First Steps

1. **Create an Account**: Navigate to http://localhost:5173 and sign up
2. **Login**: Use your credentials to access the dashboard
3. **Import Transactions**: Use the CSV import feature with the sample file at `backend/sample_transactions.csv`
4. **Explore**: View your spending charts, statistics, and transaction history

## 📊 Sample CSV Format

Your CSV file should have columns for Date, Description, and Amount:

```csv
Date,Description,Amount
2024-10-01,Whole Foods Market,-45.32
2024-10-02,Salary Deposit,3500.00
```

The application automatically:
- Detects various date formats
- Categorizes transactions (groceries, dining, transportation, etc.)
- Handles different column names (Transaction Date, Merchant, etc.)

## 🔧 Configuration

### Backend (.env)
- `DATABASE_URL`: Database connection (default: SQLite)
- `SECRET_KEY`: JWT secret key (change in production!)
- `ACCESS_TOKEN_EXPIRE_MINUTES`: Token expiration time

### Frontend (.env)
- `VITE_API_URL`: Backend API URL (default: http://localhost:8000)

## 🛠️ Development Tips

### Adding New Categories
Edit `backend/models.py` to add new transaction categories to the enum.

### Customizing CSV Parser
Edit `backend/csv_parser.py` to adjust auto-categorization rules.

### Database Migration
For PostgreSQL:
1. Create a database
2. Update `DATABASE_URL` in `backend/.env`
3. Restart the backend server

## 📝 Common Issues

**Backend won't start?**
- Ensure Python 3.8+ is installed: `python3 --version`
- Check if port 8000 is available: `lsof -i :8000`

**Frontend won't start?**
- Ensure Node.js is installed: `node --version`
- Try clearing node_modules: `rm -rf node_modules && npm install`

**CORS errors?**
- Ensure backend is running on http://localhost:8000
- Check VITE_API_URL in frontend .env file

## 🎨 Features Overview

✅ User authentication with JWT
✅ Transaction CRUD operations
✅ CSV import with auto-detection
✅ Smart transaction categorization
✅ Spending analytics and charts
✅ Monthly comparisons
✅ Multi-bank support
✅ Responsive design
