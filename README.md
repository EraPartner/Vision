# Finance Tracker - Personal Finance Management

A full-stack personal finance tracking application with **multi-bank CSV import** capabilities, transaction management, and spending analytics.

## 📁 Project Structure

```
vault-voyager-vision/
├── apps/
│   ├── frontend/          # React + TypeScript frontend
│   │   ├── src/          # Source code
│   │   ├── public/       # Static assets
│   │   └── index.html    # Entry HTML
│   └── backend/          # Python FastAPI backend
│       ├── main.py       # API server
│       ├── models.py     # Database models
│       ├── schemas.py    # Pydantic schemas
│       ├── auth.py       # Authentication
│       ├── bank_parsers.py      # Bank-specific parsers
│       ├── csv_parser_manager.py # Parser routing
│       ├── requirements.txt     # Python dependencies
│       └── sample_csv/   # Sample bank CSV files
├── config/               # Configuration files
│   ├── vite.config.ts    # Vite configuration
│   ├── tsconfig*.json    # TypeScript configs
│   ├── tailwind.config.ts # Tailwind CSS
│   ├── postcss.config.js # PostCSS
│   ├── eslint.config.js  # ESLint
│   └── components.json   # shadcn/ui config
├── docs/                 # Documentation
│   ├── README.md         # Main documentation
│   ├── QUICKSTART.md     # Quick start guide
│   ├── MULTI_BANK_IMPORT.md  # Bank import guide
│   ├── BANK_IMPORT_QUICK_REF.md # Quick reference
│   └── MIGRATION.md      # Migration notes
├── .env                  # Frontend environment
├── .gitignore           # Git ignore rules
├── package.json         # Node dependencies & scripts
└── start.sh            # Quick start script
```

## 🏗️ Architecture

- **Frontend**: React + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Python FastAPI + SQLAlchemy + Bank-Specific CSV Parsers
- **Database**: SQLite (default) or PostgreSQL
- **Config Management**: Centralized in `/config` directory
- **Documentation**: Organized in `/docs` directory

## 🚀 Quick Start

### Option 1: Automated Setup
```bash
./start.sh
```

### Option 2: Manual Setup

#### Backend
```bash
cd apps/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

#### Frontend
```bash
npm install
npm run dev
```

## 📚 Documentation

All documentation is organized in the `docs/` folder:

- **[Main README](docs/README.md)** - Complete project documentation
- **[Quick Start Guide](docs/QUICKSTART.md)** - Get started in 5 minutes
- **[Multi-Bank Import](docs/MULTI_BANK_IMPORT.md)** - Bank parser documentation
- **[Quick Reference](docs/BANK_IMPORT_QUICK_REF.md)** - Bank import cheat sheet
- **[Migration Guide](docs/MIGRATION.md)** - Supabase to Python backend

## 🛠️ Development Commands

```bash
# Frontend
npm run dev          # Start dev server
npm run build        # Build for production
npm run lint         # Run ESLint

# Backend
npm run backend             # Start backend server
npm run backend:install     # Install Python dependencies

# Both (with start.sh)
./start.sh          # Start frontend & backend
```

## 🔧 Configuration

All configuration files are in the `config/` directory:
- TypeScript: `tsconfig*.json`
- Vite: `vite.config.ts`
- Tailwind: `tailwind.config.ts`
- ESLint: `eslint.config.js`
- PostCSS: `postcss.config.js`
- shadcn/ui: `components.json`

## 🏦 Features

- **Multi-Bank CSV Import**: 7+ banks with automatic format detection
- **Smart Categorization**: Auto-categorizes transactions
- **Transaction Management**: Full CRUD operations
- **Spending Analytics**: Charts and statistics
- **User Authentication**: JWT-based auth
- **Duplicate Prevention**: Smart duplicate detection

## 📍 Access Points

- **Frontend**: http://localhost:8080
- **Backend API**: http://localhost:8000
- **API Docs**: http://localhost:8000/docs

## 🎯 Supported Banks

- Chase Bank
- Bank of America
- Wells Fargo
- Capital One
- Citi Bank
- Discover Card
- American Express
- Generic CSV parser for any bank

## 📖 Learn More

See the [docs/](docs/) folder for detailed documentation on:
- Setup and installation
- Bank import system
- API endpoints
- Adding custom banks
- Troubleshooting

## 🔗 Links

**Project URL**: https://lovable.dev/projects/411315a2-2e01-4fef-93ea-e7d6cdab8261

---

**Modern monorepo structure** with clear separation of concerns and comprehensive documentation.
