import { listContents } from "@/lib/api";
import type { ParentOption } from "@/components/editor/content-editor";

/**
 * Candidate parent pages for the editor's "Parent page" picker: the same content
 * type, the same locale, minus the homepage (nesting under "/" just yields a
 * top-level path) and — when editing — the page itself and everything beneath it,
 * since a page cannot live inside its own subtree.
 *
 * Descendants are found by walking the `parentId` each row carries. The list is
 * capped: a type with more pages than this simply offers the first page of them as
 * parents, which is a UI limit, not a data one — the API still validates the choice.
 */
export async function loadParentOptions(
  contentTypeKey: string,
  locale: string,
  selfId?: string,
): Promise<ParentOption[]> {
  const { items } = await listContents({ contentTypeKey, locale, perPage: 200 });

  const excluded = new Set<string>();
  if (selfId) {
    excluded.add(selfId);
    const childrenOf = new Map<string, string[]>();
    for (const item of items) {
      if (!item.parentId) continue;
      childrenOf.set(item.parentId, [...(childrenOf.get(item.parentId) ?? []), item.id]);
    }
    const stack = [selfId];
    while (stack.length) {
      for (const child of childrenOf.get(stack.pop()!) ?? []) {
        if (!excluded.has(child)) {
          excluded.add(child);
          stack.push(child);
        }
      }
    }
  }

  return items
    .filter((item) => item.slug !== "" && !excluded.has(item.id))
    .map((item) => ({ id: item.id, title: item.title, path: item.path }));
}
