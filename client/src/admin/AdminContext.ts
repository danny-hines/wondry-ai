import { createContext, useContext } from 'react';
import type { AdminApi } from '../lib/api';
export const AdminCtx = createContext<AdminApi | null>(null);
export function useAdmin(): AdminApi {
  const a = useContext(AdminCtx);
  if (!a) throw new Error('AdminApi not available');
  return a;
}
