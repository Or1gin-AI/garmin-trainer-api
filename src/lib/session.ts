import type { Request, Response, NextFunction } from 'express';
import { auth } from './auth.js';

export interface AuthedRequest extends Request {
  user: { id: string; email: string; name: string; role: string };
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
    (req as AuthedRequest).user = {
      id: data.user.id,
      email: data.user.email,
      name: data.user.name,
      role: (data.user as any).role || 'user',
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
