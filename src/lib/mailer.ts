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
  const subject = 'Reset your Garmin Trainer password';
  const greeting = name ? `Hi ${escapeHtml(name)}` : 'Hi';
  const html = `<!DOCTYPE html>
<html lang="en">
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
              <h2 style="margin:0 0 16px; font-size:20px; color:#5c4a2a; font-weight:600;">Reset password</h2>
              <p style="margin:0 0 16px; font-size:16px; line-height:1.7; color:#4a3f2f;">${greeting},</p>
              <p style="margin:0 0 24px; font-size:16px; line-height:1.7; color:#4a3f2f;">
                Click the button below to reset your Garmin Trainer password. This link expires in 1 hour.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="display:inline-block; background:#c4a265; color:#ffffff; text-decoration:none; padding:14px 36px; border-radius:8px; font-size:15px; font-weight:600;">Reset password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 12px; font-size:13px; line-height:1.6; color:#9a8b6f;">
                If the button does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0; word-break:break-all; font-size:12px; color:#9a8b6f; font-family: 'SF Mono', Menlo, Consolas, monospace;">
                ${resetUrl}
              </p>
              <p style="margin:24px 0 0; font-size:14px; line-height:1.7; color:#9a8b6f;">
                If you didn't request this, you can safely ignore this email.
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
  const subject = 'Verify your Garmin Trainer email';
  const greeting = name ? `Welcome, ${escapeHtml(name)}` : 'Welcome';
  const html = `<!DOCTYPE html>
<html lang="en">
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
              <h2 style="margin:0 0 16px; font-size:20px; color:#5c4a2a; font-weight:600;">Verify email</h2>
              <p style="margin:0 0 16px; font-size:16px; line-height:1.7; color:#4a3f2f;">${greeting},</p>
              <p style="margin:0 0 24px; font-size:16px; line-height:1.7; color:#4a3f2f;">
                Thanks for signing up for Garmin Trainer. Click the button below to verify your email address, then you can sign in. This link expires in 1 hour.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}" style="display:inline-block; background:#c4a265; color:#ffffff; text-decoration:none; padding:14px 36px; border-radius:8px; font-size:15px; font-weight:600;">Verify email</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 12px; font-size:13px; line-height:1.6; color:#9a8b6f;">
                If the button does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0; word-break:break-all; font-size:12px; color:#9a8b6f; font-family: 'SF Mono', Menlo, Consolas, monospace;">
                ${verifyUrl}
              </p>
              <p style="margin:24px 0 0; font-size:14px; line-height:1.7; color:#9a8b6f;">
                If you didn't sign up, you can safely ignore this email.
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
