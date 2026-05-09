import { Resend } from 'resend';

let cached: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return null;
  if (!cached) cached = new Resend(key);
  return cached;
}

const FROM = process.env.EMAIL_FROM || 'Garmin Trainer <no-reply@garmin-trainer.uk>';

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const client = getResend();
  if (!client) {
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
  const subject = '重置你的 Garmin Trainer 密码';
  const greeting = name ? `${escapeHtml(name)}，你好` : '你好';
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f5f0e8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f0e8; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#fffdf8; border-radius:12px; overflow:hidden; box-shadow: 0 2px 12px rgba(180,160,120,0.1);">
          <tr>
            <td style="padding: 36px 40px; text-align:center; border-bottom: 1px solid #e8e0d0;">
              <img src="https://garmin-trainer.uk/logo.jpg" alt="Garmin Trainer" width="64" height="64" style="display:block; margin: 0 auto 12px; border-radius:12px;">
              <h1 style="margin:0; color:#5c4a2a; font-size:22px; font-weight:600; letter-spacing:0.5px;">Garmin Trainer</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin:0 0 16px; font-size:20px; color:#5c4a2a; font-weight:600;">重置密码</h2>
              <p style="margin:0 0 16px; font-size:16px; line-height:1.7; color:#4a3f2f;">${greeting}，</p>
              <p style="margin:0 0 24px; font-size:16px; line-height:1.7; color:#4a3f2f;">
                点击下方按钮重置你的 Garmin Trainer 密码。链接将在 1 小时后失效。
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="display:inline-block; background:#c4a265; color:#ffffff; text-decoration:none; padding:14px 36px; border-radius:8px; font-size:15px; font-weight:600;">重置密码</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 12px; font-size:13px; line-height:1.6; color:#9a8b6f;">
                如果按钮无法点击，可复制下面的链接到浏览器打开：
              </p>
              <p style="margin:0; word-break:break-all; font-size:12px; color:#9a8b6f; font-family: 'SF Mono', Menlo, Consolas, monospace;">
                ${resetUrl}
              </p>
              <p style="margin:24px 0 0; font-size:14px; line-height:1.7; color:#9a8b6f;">
                如果这不是你本人发起的请求，可以安全地忽略这封邮件。
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 40px; background-color:#f5f0e8; border-top:1px solid #e8e0d0; text-align:center;">
              <p style="margin:0; font-size:13px; color:#9a8b6f;">Garmin Trainer Team</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

export function buildEmailVerificationEmail(name: string, verifyUrl: string): {
  subject: string;
  html: string;
} {
  const subject = '验证你的 Garmin Trainer 邮箱';
  const greeting = name ? `${escapeHtml(name)}，欢迎` : '欢迎';
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f5f0e8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f0e8; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#fffdf8; border-radius:12px; overflow:hidden; box-shadow: 0 2px 12px rgba(180,160,120,0.1);">
          <tr>
            <td style="padding: 36px 40px; text-align:center; border-bottom: 1px solid #e8e0d0;">
              <img src="https://garmin-trainer.uk/logo.jpg" alt="Garmin Trainer" width="64" height="64" style="display:block; margin: 0 auto 12px; border-radius:12px;">
              <h1 style="margin:0; color:#5c4a2a; font-size:22px; font-weight:600; letter-spacing:0.5px;">Garmin Trainer</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin:0 0 16px; font-size:20px; color:#5c4a2a; font-weight:600;">验证邮箱</h2>
              <p style="margin:0 0 16px; font-size:16px; line-height:1.7; color:#4a3f2f;">${greeting}，</p>
              <p style="margin:0 0 24px; font-size:16px; line-height:1.7; color:#4a3f2f;">
                感谢注册 Garmin Trainer。点击下方按钮验证你的邮箱地址，验证完成后即可登录使用。链接将在 1 小时后失效。
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}" style="display:inline-block; background:#c4a265; color:#ffffff; text-decoration:none; padding:14px 36px; border-radius:8px; font-size:15px; font-weight:600;">验证邮箱</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 12px; font-size:13px; line-height:1.6; color:#9a8b6f;">
                如果按钮无法点击，可复制下面的链接到浏览器打开：
              </p>
              <p style="margin:0; word-break:break-all; font-size:12px; color:#9a8b6f; font-family: 'SF Mono', Menlo, Consolas, monospace;">
                ${verifyUrl}
              </p>
              <p style="margin:24px 0 0; font-size:14px; line-height:1.7; color:#9a8b6f;">
                如果这不是你本人发起的注册，可以安全地忽略这封邮件。
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 40px; background-color:#f5f0e8; border-top:1px solid #e8e0d0; text-align:center;">
              <p style="margin:0; font-size:13px; color:#9a8b6f;">Garmin Trainer Team</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
