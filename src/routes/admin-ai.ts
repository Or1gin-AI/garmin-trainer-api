import { Router } from 'express';
import { z } from 'zod';
import { eq, ne, and, asc, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { llmConfig, aiUsage, user } from '../db/schema.js';
import type { LlmConfig } from '../db/schema.js';
import { requireAdmin } from '../lib/session.js';
import { encryptGlobal, decryptGlobal } from '../lib/crypto.js';
import { clearLlmConfigCache } from '../lib/llm.js';

export const adminAiRouter = Router();

// Validation: allow https://… universally, http:// only for localhost dev.
const baseUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const u = new URL(value);
      if (u.protocol === 'https:') return true;
      if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, 'must be a valid https:// URL (http:// allowed only for localhost)');

const createSchema = z.object({
  name: z.string().min(1).max(50),
  baseUrl: baseUrlSchema,
  apiKey: z.string().min(1).max(200),
  model: z.string().min(1).max(100),
  maxOutputTokens: z.number().int().min(1).max(32768).optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  baseUrl: baseUrlSchema.optional(),
  apiKey: z.string().max(200).optional(), // empty string => keep existing
  model: z.string().min(1).max(100).optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).optional(),
  isActive: z.boolean().optional(),
});

interface LlmConfigSummary {
  id: number;
  name: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  isActive: boolean;
  apiKeyHint: string;
  createdAt: string;
  updatedAt: string;
}

function toSummary(row: LlmConfig): LlmConfigSummary {
  let apiKeyHint = '???';
  try {
    const decrypted = decryptGlobal(row.apiKeyEncrypted);
    if (decrypted) {
      apiKeyHint = '…' + decrypted.slice(-4);
    }
  } catch (err) {
    // Never log raw or decrypted key. Just record the failure.
    console.warn(
      `[admin-ai] decrypt failed for llm_config id=${row.id} name=${row.name}: ${(err as Error).message}`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    maxOutputTokens: row.maxOutputTokens,
    isActive: row.isActive,
    apiKeyHint,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sendValidationError(
  res: import('express').Response,
  parsed: { success: false; error: z.ZodError },
) {
  const first = parsed.error.issues[0];
  res.status(400).json({
    error: 'invalid_input',
    field: first?.path.join('.') ?? null,
    reason: first?.message ?? 'invalid input',
  });
}

// Postgres unique-constraint violation (SQLSTATE 23505).
// We rely on these DB-level guarantees rather than app-level pre-checks to
// avoid TOCTOU races: name uniqueness via llm_config_name_unique, and the
// at-most-one-active invariant via the partial unique llm_config_one_active_idx.
function isUniqueViolation(err: unknown): { constraint?: string } | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  return { constraint: e.constraint };
}

function send409FromUnique(
  res: import('express').Response,
  constraint: string | undefined,
) {
  if (constraint?.includes('one_active')) {
    res.status(409).json({
      error: 'active_conflict',
      reason: 'another config was activated concurrently — refresh and retry',
    });
    return;
  }
  // Default: name conflict (only other unique on this table).
  res.status(409).json({
    error: 'name_conflict',
    field: 'name',
    reason: 'name already exists',
  });
}

// GET /api/admin/llm-configs — list all
adminAiRouter.get('/llm-configs', requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(llmConfig)
    .orderBy(asc(llmConfig.id));
  res.json({ configs: rows.map(toSummary) });
});

// POST /api/admin/llm-configs — create
adminAiRouter.post('/llm-configs', requireAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed);
    return;
  }
  const { name, baseUrl, apiKey, model, maxOutputTokens, isActive } = parsed.data;
  const apiKeyEncrypted = encryptGlobal(apiKey);
  const now = new Date();

  try {
    const inserted = await db.transaction(async (tx) => {
      if (isActive) {
        await tx
          .update(llmConfig)
          .set({ isActive: false, updatedAt: now })
          .where(eq(llmConfig.isActive, true));
      }
      const rows = await tx
        .insert(llmConfig)
        .values({
          name,
          baseUrl,
          apiKeyEncrypted,
          model,
          maxOutputTokens: maxOutputTokens ?? 4096,
          isActive: isActive ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rows[0]!;
    });
    clearLlmConfigCache();
    res.status(201).json(toSummary(inserted));
  } catch (err) {
    const uniq = isUniqueViolation(err);
    if (uniq) {
      send409FromUnique(res, uniq.constraint);
      return;
    }
    console.error('[admin-ai] create failed:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/admin/llm-configs/:id — update
adminAiRouter.put('/llm-configs/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_input', field: 'id', reason: 'must be a positive integer' });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed);
    return;
  }
  const data = parsed.data;

  const current = (
    await db.select().from(llmConfig).where(eq(llmConfig.id, id)).limit(1)
  )[0];
  if (!current) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const now = new Date();
  const patch: Partial<typeof llmConfig.$inferInsert> = { updatedAt: now };
  if (data.name !== undefined) patch.name = data.name;
  if (data.baseUrl !== undefined) patch.baseUrl = data.baseUrl;
  if (data.model !== undefined) patch.model = data.model;
  if (data.maxOutputTokens !== undefined) patch.maxOutputTokens = data.maxOutputTokens;
  if (typeof data.apiKey === 'string' && data.apiKey.length > 0) {
    patch.apiKeyEncrypted = encryptGlobal(data.apiKey);
  }

  try {
    const updated = await db.transaction(async (tx) => {
      if (data.isActive === true) {
        await tx
          .update(llmConfig)
          .set({ isActive: false, updatedAt: now })
          .where(and(ne(llmConfig.id, id), eq(llmConfig.isActive, true)));
        patch.isActive = true;
      } else if (data.isActive === false) {
        patch.isActive = false;
      }
      const rows = await tx
        .update(llmConfig)
        .set(patch)
        .where(eq(llmConfig.id, id))
        .returning();
      return rows[0]!;
    });
    clearLlmConfigCache();
    res.json(toSummary(updated));
  } catch (err) {
    const uniq = isUniqueViolation(err);
    if (uniq) {
      send409FromUnique(res, uniq.constraint);
      return;
    }
    console.error('[admin-ai] update failed:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/admin/llm-configs/:id/activate — flip the active row
adminAiRouter.post('/llm-configs/:id/activate', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_input', field: 'id', reason: 'must be a positive integer' });
    return;
  }
  const current = (
    await db.select().from(llmConfig).where(eq(llmConfig.id, id)).limit(1)
  )[0];
  if (!current) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const now = new Date();
  try {
    const activated = await db.transaction(async (tx) => {
      await tx
        .update(llmConfig)
        .set({ isActive: false, updatedAt: now })
        .where(and(ne(llmConfig.id, id), eq(llmConfig.isActive, true)));
      const rows = await tx
        .update(llmConfig)
        .set({ isActive: true, updatedAt: now })
        .where(eq(llmConfig.id, id))
        .returning();
      return rows[0]!;
    });
    clearLlmConfigCache();
    res.json(toSummary(activated));
  } catch (err) {
    const uniq = isUniqueViolation(err);
    if (uniq) {
      send409FromUnique(res, uniq.constraint);
      return;
    }
    console.error('[admin-ai] activate failed:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/admin/llm-configs/:id
adminAiRouter.delete('/llm-configs/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_input', field: 'id', reason: 'must be a positive integer' });
    return;
  }
  const current = (
    await db.select().from(llmConfig).where(eq(llmConfig.id, id)).limit(1)
  )[0];
  if (!current) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (current.isActive) {
    res.status(409).json({
      error: 'active_config',
      reason: 'cannot delete the active config — activate another first',
    });
    return;
  }
  try {
    await db.delete(llmConfig).where(eq(llmConfig.id, id));
    clearLlmConfigCache();
    res.status(204).end();
  } catch (err) {
    console.error('[admin-ai] delete failed:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ===== AI usage =====
//
// GET /api/admin/ai-usage?periodStart=YYYY-MM-DD&limit=50
//
// Returns the per-user ai_usage rows for one month, joined with `user` so the
// admin sees email/displayName instead of opaque ids. Default period is the
// current month start (first day, UTC). Sorted by inputTokens DESC so the
// loudest spenders show first.

const usageQuerySchema = z.object({
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(z.number().int().min(1).max(500).optional()),
});

function defaultPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const mm = String(m + 1).padStart(2, '0');
  return `${y}-${mm}-01`;
}

interface AiUsageEntry {
  userId: string;
  email: string;
  displayName: string | null;
  periodStart: string;
  planGenerationCount: number;
  chatMessageCount: number;
  inputTokens: number;
  outputTokens: number;
}

adminAiRouter.get('/ai-usage', requireAdmin, async (req, res) => {
  const parsed = usageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed);
    return;
  }
  const periodStart = parsed.data.periodStart ?? defaultPeriodStart();
  const limit = parsed.data.limit ?? 50;

  try {
    const rows = await db
      .select({
        userId: aiUsage.userId,
        email: user.email,
        name: user.name,
        displayUsername: user.displayUsername,
        periodStart: aiUsage.periodStart,
        planGenerationCount: aiUsage.planGenerationCount,
        chatMessageCount: aiUsage.chatMessageCount,
        inputTokens: aiUsage.inputTokens,
        outputTokens: aiUsage.outputTokens,
      })
      .from(aiUsage)
      .innerJoin(user, eq(aiUsage.userId, user.id))
      .where(eq(aiUsage.periodStart, periodStart))
      .orderBy(desc(aiUsage.inputTokens))
      .limit(limit);

    const entries: AiUsageEntry[] = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      displayName: r.displayUsername ?? r.name ?? null,
      periodStart: String(r.periodStart),
      planGenerationCount: r.planGenerationCount,
      chatMessageCount: r.chatMessageCount,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    }));

    res.json({ entries });
  } catch (err) {
    console.error('[admin-ai] ai-usage list failed:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
});
