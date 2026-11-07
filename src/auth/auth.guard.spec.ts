import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import type { SupabaseService } from '../supabase/supabase.service.js';
import { AuthGuard } from './auth.guard.js';

describe('AuthGuard', () => {
  const getUser = vi.fn();
  const guard = new AuthGuard(
    { admin: { auth: { getUser } } } as unknown as SupabaseService,
    { getAllAndOverride: () => false } as unknown as Reflector,
  );

  const contextWith = (authorization?: string) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization } }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a valid token', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    await expect(guard.canActivate(contextWith('Bearer valid'))).resolves.toBe(
      true,
    );
  });

  it('returns 401 without a token', async () => {
    await expect(guard.canActivate(contextWith())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(getUser).not.toHaveBeenCalled();
  });

  it('returns 401 when Supabase rejects the token', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { status: 403, message: 'invalid JWT' },
    });

    await expect(
      guard.canActivate(contextWith('Bearer expired')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([0, 500, 503, undefined])(
    'returns 503 when Supabase cannot answer (status %s)',
    async (status) => {
      getUser.mockResolvedValue({
        data: { user: null },
        error: { status, message: 'fetch failed' },
      });

      await expect(
        guard.canActivate(contextWith('Bearer valid')),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );
});
