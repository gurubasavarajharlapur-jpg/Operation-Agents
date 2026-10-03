// One place that talks to the API: adds the operator token and turns errors into ApiError.
const TOKEN_KEY = 'oa.operatorToken';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The token lives in sessionStorage: it is forgotten when the tab closes.
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? getToken();
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !init.token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}
