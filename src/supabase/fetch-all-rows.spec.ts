import { vi } from 'vitest';
import { fetchAllRows } from './fetch-all-rows.js';

describe('fetchAllRows', () => {
  it('asks for pages until one comes back short', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => index);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: full, error: null })
      .mockResolvedValueOnce({ data: [1000], error: null });

    const { data, error } = await fetchAllRows(query);

    expect(data).toHaveLength(1001);
    expect(error).toBeNull();
    expect(query).toHaveBeenNthCalledWith(1, 0, 999);
    expect(query).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it('stops at the first error and returns no rows', async () => {
    const failure = new Error('db down');
    const query = vi
      .fn()
      .mockResolvedValue({ data: null, error: failure });

    const { data, error } = await fetchAllRows(query);

    expect(data).toEqual([]);
    expect(error).toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
