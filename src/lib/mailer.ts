import { Resend } from 'resend';

let cached: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return null;
  if (!cached) cached = new Resend(key);
  return cached;
}

const FROM = process.env.EMAIL_FROM || 'Garmin Trainer <noreply@garmin-trainer.uk>';

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const client = getResend();
  if (!client) {
    // Fallback: log to console so dev / unconfigured deploys still see the URL
    console.warn(
      `[mailer] RESEND_API_KEY missing — would have sent to=${to} subject=${JSON.stringify(subject)}`,
    );
    console.warn(`[mailer] body (HTML):\n${html}`);
    return;
  }
  const result = await client.emails.send({ from: FROM, to, subject, html });
  if (result.error) {
    console.error('[mailer] resend error:', result.error);
    throw new Error(`failed to send email: ${result.error.message}`);
  }
}

export function buildPasswordResetEmail(name: string, resetUrl: string): {
  subject: string;
  html: string;
} {
  const subject = '[Garmin Trainer] 重置密码';
  const html = `
<!doctype html>
<html lang="zh">
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fafaf9;padding:32px;color:#18181b;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;">重置 Garmin Trainer 密码</h1>
    <p style="line-height:1.6;color:#3f3f46;">${escapeHtml(name) || '你好'}，</p>
    <p style="line-height:1.6;color:#3f3f46;">
      点击下方按钮设置新密码。如果不是你本人发起的请求，可以忽略这封邮件。
    </p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}"
         style="display:inline-block;padding:12px 20px;background:#059669;color:#fff;text-decoration:none;border-radius:8px;font-weight:500;">
        重置密码
      </a>
    </p>
    <p style="line-height:1.5;color:#71717a;font-size:13px;">
      链接 1 小时内有效。如果按钮无法点击，可复制下面的 URL 到浏览器打开：
    </p>
    <p style="word-break:break-all;color:#52525b;font-size:12px;font-family:ui-monospace,'SF Mono',monospace;">
      ${resetUrl}
    </p>
  </div>
</body>
</html>`.trim();
  return { subject, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
