// Typed API Client fetch wrapper

export class ApiError extends Error {
  status: number;
  code: string;
  details?: any;

  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token');
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(endpoint, {
    ...options,
    headers
  });

  // Handle 401 Unauthorized: clear token and notify session listener
  if (response.status === 401) {
    localStorage.removeItem('token');
    window.dispatchEvent(new Event('auth:unauthorized'));
    const errBody = await response.json().catch(() => ({}));
    throw new ApiError(
      401,
      errBody.error?.code || 'UNAUTHORIZED',
      errBody.error?.message || 'Session expired or unauthorized.'
    );
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const code = errBody.error?.code || 'HTTP_ERROR';
    const message = errBody.error?.message || response.statusText || 'An error occurred';
    const details = errBody.error?.details;
    throw new ApiError(response.status, code, message, details);
  }

  return response.json() as Promise<T>;
}
