const PAGE_SIZE = 1000;

// Supabase returns 1000 rows at most per query: without paging, anything that
// reads a whole school would silently work from part of the data. The query
// needs a stable order, or rows can repeat or go missing between pages.
export async function fetchAllRows(
  query: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<{ data: unknown[]; error: unknown }> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) {
      return { data: [], error };
    }
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) {
      return { data: rows, error: null };
    }
  }
}
