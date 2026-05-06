import type { Request, Response, NextFunction } from 'express';
import { auth } from './auth.js';

export interface AuthedRequest extends Request {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    username?: string | null;
    displayUsername?: string | null;
  };
  sessionId: string;
}

function toFetchHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, String(item));
    } else {
      headers.set(k, String(v));
    }
  }
  return headers;
}

export async function loadSession(req: Request) {
  return auth.api.getSession({ headers: toFetchHeaders(req) });
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await loadSession(req);
    if (!data?.user || !data?.session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const u = data.user as any;
    (req as AuthedRequest).user = {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role || 'user',
      username: u.username ?? null,
      displayUsername: u.displayUsername ?? null,
    };
    (req as AuthedRequest).sessionId = data.session.id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'unauthorized', detail: (error as Error).message });
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  requireUser(req, res, () => {
    if ((req as AuthedRequest).user.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });
}
