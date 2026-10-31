import { SupabaseService } from './supabase.service.js';

describe('SupabaseService', () => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  afterEach(() => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
  });

  it('throws when the Supabase env vars are missing', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => new SupabaseService().admin).toThrow(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set',
    );
  });
});
