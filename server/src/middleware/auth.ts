import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DB_PATH } from '../db/index.js';
import type { AuthPayload, Role } from '../types.js';

/**
 * In a shop deployment there is no secret-management infrastructure, so the
 * secret is generated once and persisted next to the database. It can be
 * overridden with PHARMACY_JWT_SECRET for hosted deployments.
 */
export const JWT_SECRET: string = process.env.PHARMACY_JWT_SECRET ?? loadOrCreateSecret();

const TOKEN_TTL = '12h'; // one shop shift

function loadOrCreateSecret(): string {
  const secretPath = `${DB_PATH}.secret`;
  if (existsSync(secretPath)) return readFileSync(secretPath, 'utf8').trim();

  mkdirSync(dirname(secretPath), { recursive: true });
  const secret = randomBytes(48).toString('hex');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET) as AuthPayload;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

/** Restrict a route to the given roles. `admin` implicitly passes everything. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      next();
      return;
    }
    res.status(403).json({ error: 'You do not have permission to do this' });
  };
}
