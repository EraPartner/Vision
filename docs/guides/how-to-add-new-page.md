---
title: How to Add a New Page
type: guide
status: active
date: 2026-03-31
tags: [guide, frontend, react, page, how-to, tutorial, routing]
description: Step-by-step guide for adding a new page to the Vision frontend
aliases: [add page, new page, create page, new route, frontend page, page tutorial]
---

# How to Add a New Page

> [!abstract] Overview
> This guide walks through adding a complete new page to the Vision frontend. Covers page creation, routing, sidebar navigation, data fetching, i18n, and documentation.

## Step-by-Step

### 1. Create the Page Component

Create the page file in `apps/frontend/src/pages/`:

```tsx
// apps/frontend/src/pages/<Feature>Page.tsx
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { use<Feature> } from '@/hooks/use<Feature>';

export function <Feature>Page() {
  const { t } = useLanguage();
  const { data, isLoading } = use<Feature>();

  if (isLoading) return <div className="p-4">Loading...</div>;

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold">{t('<feature>.title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('<feature>.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Page content */}
        </CardContent>
      </Card>
    </div>
  );
}
```

### 2. Add the Route

Add the route to `apps/frontend/src/App.tsx`:

```tsx
import { <Feature>Page } from './pages/<Feature>Page';

// Inside the <Routes> component:
<Route path="/<feature>" element={<AppLayout><<Feature>Page /></AppLayout>} />
```

### 3. Add Sidebar Navigation

Add a sidebar item to `apps/frontend/src/components/layout/AppSidebar.tsx`:

```tsx
{
  name: t('nav.<feature>'),
  icon: <IconComponent />,
  path: '/<feature>',
  workspace: 'budgeting', // or 'portfolio'
}
```

### 4. Add i18n Keys

Add translation keys to both `i18n/source/en.json` and `i18n/source/nl.json`:

```json
{
  "nav": {
    "<feature>": "Feature Name"
  },
  "<feature>": {
    "title": "Feature Page Title",
    "cardTitle": "Card Title",
    "noData": "No data available"
  }
}
```

Then regenerate locale bundles:
```bash
bun run build
```

### 5. Create or Use a Data Hook

If the page fetches data, create a hook in `apps/frontend/src/hooks/`:

```ts
// apps/frontend/src/hooks/use<Feature>.ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export function use<Feature>() {
  return useQuery({
    queryKey: ['<feature>'],
    queryFn: () => apiClient.get<Feature>(),
  });
}
```

See [[docs/reference/react-query-keys\|React Query Keys Reference]] for key conventions.

### 6. Write Tests

```tsx
// apps/frontend/src/pages/__tests__/<Feature>Page.test.tsx
import { render, screen } from '@testing-library/react';
import { <Feature>Page } from '../<Feature>Page';

describe('<Feature>Page', () => {
  it('renders the page title', () => {
    render(<<Feature>Page />);
    expect(screen.getByText(/feature/i)).toBeInTheDocument();
  });
});
```

### 7. Document the Page

1. Add to [[docs/features/views\|Views & Pages]] with description and code link
2. If the page has unique components, add to the appropriate component doc
3. If the page uses a new API endpoint, add to [[docs/api/index\|API Index]]
4. Update [[docs/reference/frontend-routes\|Frontend Routes Reference]] (this doc)

## Checklist

- [ ] Page component created with TypeScript types
- [ ] Route added to `App.tsx`
- [ ] Sidebar item added to `AppSidebar.tsx`
- [ ] i18n keys added to `en.json` and `nl.json`
- [ ] Locale bundles regenerated (`bun run build`)
- [ ] Data hook created (if fetching data)
- [ ] React Query key follows naming convention
- [ ] Tests written
- [ ] Page documented in views.md
- [ ] Frontend routes reference updated

## Example: Adding a "Reports" Page

```tsx
// apps/frontend/src/pages/ReportsPage.tsx
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function ReportsPage() {
  const { t } = useLanguage();

  return (
    <div className="container mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold">{t('reports.title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('reports.recentTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p>{t('reports.noReports')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
```

## Related

- [[docs/features/views\|Views & Pages]] - All page documentation
- [[docs/reference/frontend-routes\|Frontend Routes]] - Complete route table
- [[docs/reference/react-query-keys\|React Query Keys]] - Query key conventions
- [[docs/guides/how-to-add-react-component\|How to Add a React Component]] - Component guide
- [[docs/guides/how-to-add-api-endpoint\|How to Add an API Endpoint]] - Backend API guide
