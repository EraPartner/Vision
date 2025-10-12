# 📁 Project Structure Guide

## Overview

This project follows modern monorepo structure standards with clear separation between:
- **Applications** (frontend & backend)
- **Configuration** (build tools, TypeScript, linters)
- **Documentation** (guides, references, tutorials)

## Directory Layout

### `/apps` - Application Code
Monorepo-style organization with each app in its own directory.

#### `/apps/frontend` - React Frontend
```
apps/frontend/
├── src/
│   ├── components/     # React components
│   │   ├── auth/      # Authentication components
│   │   ├── dashboard/ # Dashboard components
│   │   └── ui/        # shadcn/ui components
│   ├── pages/         # Page components
│   ├── lib/           # Utilities & API client
│   ├── hooks/         # Custom React hooks
│   ├── integrations/  # External integrations
│   ├── App.tsx        # Root component
│   ├── main.tsx       # Entry point
│   └── index.css      # Global styles
├── public/            # Static assets
│   ├── favicon.ico
│   └── robots.txt
└── index.html         # HTML entry point
```

**Tech Stack:**
- React 18 + TypeScript
- Vite (build tool)
- Tailwind CSS + shadcn/ui
- React Router (routing)
- TanStack Query (data fetching)

#### `/apps/backend` - Python Backend
```
apps/backend/
├── main.py                 # FastAPI application
├── models.py              # SQLAlchemy models
├── schemas.py             # Pydantic schemas
├── database.py            # Database config
├── auth.py                # JWT authentication
├── bank_parsers.py        # Bank-specific CSV parsers
├── csv_parser_manager.py  # Parser routing logic
├── requirements.txt       # Python dependencies
├── .env                   # Environment variables
├── sample_csv/            # Sample bank CSV files
│   ├── chase_sample.csv
│   ├── amex_sample.csv
│   └── ...
└── README.md             # Backend docs
```

**Tech Stack:**
- FastAPI (web framework)
- SQLAlchemy (ORM)
- Pydantic (validation)
- pandas (CSV parsing)
- JWT (authentication)

### `/config` - Configuration Files
Centralized configuration for all build tools and linters.

```
config/
├── vite.config.ts         # Vite bundler config
├── tsconfig.json          # Base TypeScript config
├── tsconfig.app.json      # App TypeScript config
├── tsconfig.node.json     # Node TypeScript config
├── tailwind.config.ts     # Tailwind CSS config
├── postcss.config.js      # PostCSS config
├── eslint.config.js       # ESLint config
└── components.json        # shadcn/ui config
```

**Why Centralized?**
- Single source of truth for configs
- Easier to maintain and update
- Clear separation from app code
- Follows industry best practices

### `/docs` - Documentation
All project documentation in one place.

```
docs/
├── README.md                      # Main documentation
├── QUICKSTART.md                  # 5-minute setup guide
├── MULTI_BANK_IMPORT.md          # Bank import system
├── BANK_IMPORT_QUICK_REF.md      # Quick reference card
├── MIGRATION.md                   # Migration notes
└── PROJECT_STRUCTURE.md          # This file
```

**Documentation Types:**
- **README.md** - Project overview and setup
- **QUICKSTART.md** - Fast track to getting started
- **Guides** - Deep dives into features
- **References** - Quick lookups and cheat sheets
- **Migration** - Upgrade and change notes

### Root Files

```
/ (root)
├── package.json        # Node.js dependencies & scripts
├── package-lock.json   # Locked dependency versions
├── .env                # Environment variables (frontend)
├── .gitignore         # Git ignore rules
├── start.sh           # Quick start script
├── README.md          # Project overview (symlink to docs)
└── bun.lockb          # Bun lock file
```

## Path Resolution

### TypeScript Paths
Configured in `config/tsconfig.json`:
```json
{
  "baseUrl": ".",
  "paths": {
    "@/*": ["../apps/frontend/src/*"]
  }
}
```

Usage in code:
```typescript
import { Button } from "@/components/ui/button"
import { apiClient } from "@/lib/api"
```

### Vite Aliases
Configured in `config/vite.config.ts`:
```typescript
resolve: {
  alias: {
    "@": path.resolve(__dirname, "../apps/frontend/src"),
  },
}
```

## Configuration Reference

### Environment Variables

#### Frontend (`.env`)
```bash
VITE_API_URL=http://localhost:8000
```

#### Backend (`apps/backend/.env`)
```bash
DATABASE_URL=sqlite:///./finance.db
SECRET_KEY=your-secret-key-here
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
```

### Build Outputs

```
/ (root)
├── dist/              # Frontend production build
└── apps/backend/
    └── finance.db     # SQLite database (dev)
```

## Best Practices

### 1. Code Organization
- ✅ Keep apps independent
- ✅ Share config, not code
- ✅ Document in one place
- ✅ Centralize configuration

### 2. Path Management
- ✅ Use `@/` imports in frontend
- ✅ Relative imports in backend
- ✅ Config files reference `../apps`
- ✅ No hardcoded paths

### 3. Environment Management
- ✅ `.env` files in app directories
- ✅ Never commit secrets
- ✅ Use `.env.example` templates
- ✅ Document all variables

### 4. Documentation
- ✅ Keep docs updated
- ✅ Use clear examples
- ✅ Link between docs
- ✅ Include troubleshooting

## Adding New Code

### New Frontend Component
```bash
# Location
apps/frontend/src/components/feature/MyComponent.tsx

# Import with
import { MyComponent } from "@/components/feature/MyComponent"
```

### New Backend Endpoint
```bash
# Add to
apps/backend/main.py

# Or create new module
apps/backend/my_feature.py
```

### New Configuration
```bash
# Add to
config/my-tool.config.ts

# Reference in package.json
"scripts": {
  "my-command": "my-tool --config config/my-tool.config.ts"
}
```

### New Documentation
```bash
# Create in
docs/MY_GUIDE.md

# Link from
docs/README.md
```

## Migration from Old Structure

Old structure had everything in root:
```
/ (old)
├── src/           → apps/frontend/src/
├── public/        → apps/frontend/public/
├── backend/       → apps/backend/
├── *.config.*     → config/
└── *.md           → docs/
```

All imports and configs have been updated to reference new locations.

## Scripts Reference

### Frontend
```bash
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run lint         # Run ESLint
npm run preview      # Preview production build
```

### Backend
```bash
npm run backend              # Start FastAPI server
npm run backend:install      # Install dependencies
# Or directly:
cd apps/backend && python main.py
```

### Combined
```bash
./start.sh          # Start both frontend & backend
```

## Troubleshooting

### Import Errors
- Check `config/tsconfig.json` paths
- Ensure `@/` alias points to `apps/frontend/src/`
- Restart TypeScript server

### Config Not Found
- All configs are in `config/`
- Scripts in `package.json` reference `config/`
- Use `--config config/file.config.ts`

### Module Resolution
- Frontend uses `@/` prefix
- Backend uses relative imports
- Config files use `../apps/`

## Benefits of This Structure

1. **Scalability**: Easy to add new apps (mobile, CLI, etc.)
2. **Clarity**: Clear separation of concerns
3. **Maintainability**: Centralized configuration
4. **Documentation**: Everything in one place
5. **Standards**: Follows industry best practices
6. **Monorepo-Ready**: Can add workspaces easily

## Future Expansion

This structure supports:
- Adding mobile app: `apps/mobile/`
- Shared libraries: `packages/shared/`
- Multiple backends: `apps/api-v2/`
- Microservices: `apps/service-name/`
- Tools: `tools/scripts/`

---

**Modern, scalable, maintainable** - built for growth.
