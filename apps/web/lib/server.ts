import { cookies } from 'next/headers';
import { apiFetch } from './api';

/**
 * Server-component fetch that forwards the browser session cookies (sid + csrf)
 * to the API. Next server components run OUTSIDE the browser, so `fetch` would
 * otherwise send no cookies and every API call would 401 — this is what makes the
 * shells in /school and /platform actually render authenticated data.
 */
export async function serverFetch<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  return apiFetch<T>(path, { headers: { cookie: cookieHeader } });
}