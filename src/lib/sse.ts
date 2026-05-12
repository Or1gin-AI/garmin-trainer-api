import type { Response } from 'express';

/**
 * Server-Sent Events helpers.
 *
 * Used by training plan generation streaming and chat streaming. These are
 * pure helpers — no module-level state, caller owns the response lifetime.
 */

/**
 * Open the SSE stream: set headers, disable proxy buffering, flush.
 * After this returns the caller can keep writing events via writeEvent.
 */
export function openSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Caddy / nginx honor this header to disable proxy-side buffering, which
  // would otherwise hold events until the response closes.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Initial comment to nudge the browser into delivering the response to JS.
  res.write(': ready\n\n');
  flushIfPossible(res);
}

/**
 * Write a named SSE event with a JSON-serialized payload.
 * data is JSON.stringified — pass plain objects only. If serialization fails
 * (circular ref, BigInt, etc.) we emit an error event instead of throwing,
 * so a single bad payload won't kill an in-flight LLM stream.
 */
export function writeEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    console.error('sse.writeEvent: failed to JSON.stringify payload', err);
    json = JSON.stringify({
      error: 'serialization_failed',
      event,
      message: err instanceof Error ? err.message : String(err),
    });
    event = 'error';
  }
  res.write(`event: ${event}\ndata: ${json}\n\n`);
  flushIfPossible(res);
}

/**
 * Periodic comment to keep idle connections alive across proxies.
 * Returns the interval handle so the caller can clearInterval on close.
 * Auto-clears on TCP-level client disconnect (res 'close' event) so callers
 * don't have to remember to wire that up themselves.
 */
export function startHeartbeat(
  res: Response,
  intervalMs: number = 15000,
): NodeJS.Timeout {
  const handle = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(handle);
      return;
    }
    res.write(': ping\n\n');
    flushIfPossible(res);
  }, intervalMs);
  res.once('close', () => clearInterval(handle));
  return handle;
}

/**
 * tool_event payload — emitted by orchestrator/derived-context/chat to give
 * the frontend a real-time view of what the AI is doing. start/done/error
 * are paired by `id`. Done/error replace the matching start row in the UI.
 */
export interface ToolEventPayload {
  id: string;
  name: string;
  displayName: string;
  phase: 'start' | 'done' | 'error';
  summary?: string;
  errorMessage?: string;
  durationMs?: number;
}

export function emitToolEvent(res: Response, payload: ToolEventPayload): void {
  writeEvent(res, 'tool_event', payload);
}

/**
 * Convenience: writeEvent followed by res.end(). Use for terminal events
 * like 'done' and 'error'.
 */
export function endSse(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  writeEvent(res, event, data);
  res.end();
}

function flushIfPossible(res: Response): void {
  // Express's compression middleware (and some others) attach a flush().
  const maybeFlush = (res as Response & { flush?: () => void }).flush;
  if (typeof maybeFlush === 'function') maybeFlush.call(res);
}
