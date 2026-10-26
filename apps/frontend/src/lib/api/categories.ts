import type {
    CategoriesListResponse,
    Category,
    CategoryCreate,
    CategoryUpdate,
    CategoryNode,
    CategoryNodeCreate,
    CategoryNodeUpdate,
} from "@/types/api";
import {
    CategoryListSchema,
    CategoryTreeSchema,
} from "@vision/types/contracts";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery, createWithStatus } from "@/lib/api/helpers";
import type { CategoryId } from "@vision/types/brands";

export function getCategories(params?: {
    limit?: number | undefined;
    offset?: number | undefined;
    general?: string | undefined;
    detail?: string | undefined;
    active?: boolean | undefined;
    search?: string | undefined;
}): Promise<CategoriesListResponse> {
    return requestWithQuery<CategoriesListResponse>("/api/categories", params, {
        schema: CategoryListSchema,
    });
}

export async function createCategory(
    category: CategoryCreate,
): Promise<{ category: Category; wasCreated: boolean }> {
    const { data, wasCreated } = await createWithStatus(
        "/api/categories",
        category,
    );
    return { category: data as Category, wasCreated };
}

export function updateCategory(
    id: CategoryId,
    category: CategoryUpdate,
): Promise<Category> {
    return apiRequest<Category>(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(category),
    });
}

export async function deleteCategory(id: CategoryId): Promise<void> {
    await apiRequest(`/api/categories/${id}`, { method: "DELETE" });
}

export function getCategoryTree(): Promise<{
    items: CategoryNode[];
    total: number;
}> {
    return apiRequest<{ items: CategoryNode[]; total: number }>(
        "/api/categories/tree",
        { schema: CategoryTreeSchema },
    );
}

export function createCategoryNode(
    input: CategoryNodeCreate,
): Promise<CategoryNode> {
    return apiRequest<CategoryNode>("/api/categories/tree", {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export function updateCategoryNode(
    id: CategoryId,
    input: CategoryNodeUpdate,
): Promise<CategoryNode> {
    return apiRequest<CategoryNode>(`/api/categories/tree/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
    });
}

export async function deleteCategoryNode(id: CategoryId): Promise<void> {
    await apiRequest(`/api/categories/tree/${id}`, { method: "DELETE" });
}

export function mergeCategoryNode(
    sourceId: CategoryId,
    targetId: CategoryId,
): Promise<CategoryNode> {
    return apiRequest<CategoryNode>(`/api/categories/tree/${sourceId}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
    });
}
