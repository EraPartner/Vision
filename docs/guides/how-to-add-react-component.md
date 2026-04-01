---
title: How to Add a New React Component
type: guide
status: active
date: 2026-03-31
tags: [guide, frontend, react, component, how-to, tutorial]
description: Step-by-step guide for adding a new React component to the Vision frontend
aliases: [add component, new component, create component, react tutorial, frontend tutorial]
related_code: ["apps/frontend/src/components/", "apps/frontend/src/hooks/", "apps/frontend/src/lib/api.ts"]
---

# How to Add a New React Component

> [!abstract] Overview
> This guide walks through adding a new React component to the Vision frontend. Covers component creation, TypeScript types, hooks, styling, testing, and documentation.

## When to Add a Component

- New page or view needs UI
- Existing page needs a new widget/section
- Reusable UI pattern emerges across multiple pages

## Step-by-Step

### 1. Choose the Location

| Component Type | Location |
|---------------|----------|
| Page | `apps/frontend/src/pages/` |
| Feature component | `apps/frontend/src/components/<feature>/` |
| Shared component | `apps/frontend/src/components/shared/` |
| UI primitive | `apps/frontend/src/components/ui/` (shadcn) |
| Layout component | `apps/frontend/src/components/layout/` |
| Custom hook | `apps/frontend/src/hooks/` |

### 2. Create the Component

```tsx
// apps/frontend/src/components/<feature>/<ComponentName>.tsx
import { useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface <ComponentName>Props {
  /** Description of prop */
  data: DataType[];
  /** Callback when action occurs */
  onAction?: (id: number) => void;
  /** Optional loading state */
  isLoading?: boolean;
}

export function <ComponentName>({ data, onAction, isLoading }: <ComponentName>Props) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return <div className="animate-pulse">Loading...</div>;
  }

  if (data.length === 0) {
    return <p>{t('<component>.noData')}</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('<component>.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.map((item) => (
          <div key={item.id}>
            <span>{item.name}</span>
            {onAction && (
              <Button onClick={() => onAction(item.id)}>
                {t('<component>.action')}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

### 3. Define TypeScript Types

If the component uses complex types, add them to `apps/frontend/src/types/`:

```ts
// apps/frontend/src/types/<feature>.ts
export interface DataType {
  id: number;
  name: string;
  createdAt: string;
}
```

### 4. Create or Use a Hook

For data fetching, create a hook or use React Query directly:

```ts
// apps/frontend/src/hooks/use<Feature>.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

export function use<Feature>() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['<feature>'],
    queryFn: () => apiClient.get<Feature>(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateInput) => apiClient.create<Feature>(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['<feature>'] }),
  });

  return { data, isLoading, create: createMutation.mutate };
}
```

### 5. Add Translation Keys

Add to `i18n/source/en.json` and `i18n/source/nl.json`:

```json
{
  "<component>": {
    "title": "Component Title",
    "noData": "No data available",
    "action": "Action"
  }
}
```

Then regenerate locale bundles:
```bash
bun run build
```

### 6. Add to a Page

```tsx
// apps/frontend/src/pages/<Feature>Page.tsx
import { <ComponentName> } from '@/components/<feature>/<ComponentName>';
import { use<Feature> } from '@/hooks/use<Feature>';

export function <Feature>Page() {
  const { data, isLoading } = use<Feature>();

  return (
    <div className="container mx-auto p-4">
      <<ComponentName> data={data ?? []} isLoading={isLoading} />
    </div>
  );
}
```

### 7. Add Routing

Add to `apps/frontend/src/App.tsx`:

```tsx
import { <Feature>Page } from './pages/<Feature>Page';

// In the router:
<Route path="/<feature>" element=<<Feature>Page />} />
```

### 8. Write Tests

```tsx
// apps/frontend/src/components/<feature>/__tests__/<ComponentName>.test.tsx
import { render, screen } from '@testing-library/react';
import { <ComponentName> } from '../<ComponentName>';

describe('<ComponentName>', () => {
  it('renders empty state', () => {
    render(<<ComponentName> data={[]} />);
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });

  it('renders data items', () => {
    render(<<ComponentName> data={[{ id: 1, name: 'Test' }]} />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
```

### 9. Document the Component

Add to the appropriate component doc file:
- Feature components → `docs/components/<feature>.md`
- Shared components → `docs/components/form-dialogs.md`
- Dashboard components → `docs/components/dashboard.md`

Include:
- Props table
- Usage example
- Code link: `[[apps/frontend/src/components/<feature>/<ComponentName>.tsx]]`

## Checklist

- [ ] Component created with TypeScript types
- [ ] Props interface defined with JSDoc comments
- [ ] Loading and empty states handled
- [ ] i18n keys added to both `en.json` and `nl.json`
- [ ] Hook created (if fetching data)
- [ ] Added to page and routing
- [ ] Tests written
- [ ] Component documented in KB
- [ ] Frontmatter includes `type: component`, `tags`, `description`, `related_code`

## Related

- [[docs/components/index\|Components Index]] - All components
- [[docs/components/hooks\|Custom Hooks]] - Hook patterns
- [[docs/features/views\|Views & Pages]] - Page structure
- [[docs/i18n/translations\|Translations]] - i18n workflow
- [[docs/testing/testing\|Testing Guide]] - Testing patterns
