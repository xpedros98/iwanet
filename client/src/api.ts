export type User = { id: number; username: string };

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** The logged-in user, or null. */
export async function getMe(): Promise<User | null> {
  const res = await fetch('/api/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export const login = (username: string, password: string) =>
  send<User>('POST', '/api/login', { username, password });

export const register = (username: string, password: string) =>
  send<User>('POST', '/api/register', { username, password });

export const logout = () => send<void>('POST', '/api/logout');

/** The galaxy as typed arrays, ready to hand to GPU buffers (Step 6). */
export type GalaxyShape = { radius: number; arms: number; turns: number };

export type Galaxy = {
  version: number;
  shape: GalaxyShape;
  count: number;
  ids: Uint32Array;
  names: string[];
  /** x, y, z per star */
  positions: Float32Array;
  /** friend-circle index per star */
  colors: Uint16Array;
  sizes: Float32Array;
  /** pairs of star indexes, one pair per friendship */
  links: Uint32Array;
};

type GalaxyJson = {
  version: number;
  shape: GalaxyShape;
  ids: number[];
  names: string[];
  pos: number[];
  color: number[];
  size: number[];
  links: number[];
};

/**
 * Fetches /api/galaxy. The browser revalidates its cached copy with the ETag
 * automatically, so an unchanged galaxy costs an empty 304 response.
 */
export async function getGalaxy(): Promise<Galaxy> {
  const g = await send<GalaxyJson>('GET', '/api/galaxy');
  return {
    version: g.version,
    shape: g.shape,
    count: g.ids.length,
    ids: Uint32Array.from(g.ids),
    names: g.names,
    positions: Float32Array.from(g.pos),
    colors: Uint16Array.from(g.color),
    sizes: Float32Array.from(g.size),
    links: Uint32Array.from(g.links),
  };
}
