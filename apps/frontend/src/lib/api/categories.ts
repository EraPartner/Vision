import type {
    CategoriesListResponse,
    Category,
    CategoryCreate,
    CategoryUpdate,
    CategoryNode,
    CategoryNodeCreate,
    CategoryNodeUpdate,
} from "@/types/api";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery, createWithStatus } from "@/lib/api/helpers";

export function getCategories(params?: {
    limit?: number;
    offset?: number;
    general?: string;
    detail?: string;
    active?: boolean;
    search?: string;
}): Promise<CategoriesListResponse> {
    return requestWithQuery<CategoriesListResponse>("/api/categories", params);
}

export async function createCategory(
    category: CategoryCreate,
): Promise<{ category: Category; wasCreated: boolean }> {
    const { data, wasCreated } = await createWithStatus<
        CategoryCreate,
        Category
    >("/api/categories", category);
    return { category: data, wasCreated };
}

export function updateCategory(
    id: number,
    category: CategoryUpdate,
): Promise<Category> {
    return apiRequest<Category>(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(category),
    });
}

export async function deleteCategory(id: number): Promise<void> {
    await apiRequest<void>(`/api/categories/${id}`, { method: "DELETE" });
}

export function getCategoryTree(): Promise<{
    items: CategoryNode[];
    total: number;
}> {
    return apiRequest<{ items: CategoryNode[]; total: number }>(
        "/api/categories/tree",
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
    id: number,
    input: CategoryNodeUpdate,
): Promise<CategoryNode> {
    return apiRequest<CategoryNode>(`/api/categories/tree/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
    });
}

export async function deleteCategoryNode(id: number): Promise<void> {
    await apiRequest<void>(`/api/categories/tree/${id}`, { method: "DELETE" });
}

export function mergeCategoryNode(
    sourceId: number,
    targetId: number,
): Promise<CategoryNode> {
    return apiRequest<CategoryNode>(`/api/categories/tree/${sourceId}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
    });
}
