/** Merge React refs into one callback ref. */
export function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
    return (node: T | null) => {
        refs.forEach((ref) => {
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
        });
    };
}
