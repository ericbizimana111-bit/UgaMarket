/**
 * Plain, mobile-friendly transactional email layout (inline styles only, so
 * it renders the same in Gmail, Outlook and phone mail apps). Every dynamic
 * value is HTML-escaped.
 */

const BRAND = '#1C5233';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {object} p
 * @param {string} p.heading
 * @param {string[]} p.paragraphs   plain-text paragraphs
 * @param {string} [p.code]         one-time code shown large
 * @param {{url:string,label:string}} [p.cta]
 * @param {{name:string,price:string,url:string,imageUrl?:string}[]} [p.items]
 * @param {string} [p.footerNote]
 * @param {string} [p.unsubscribeUrl]
 */
function renderEmail({ heading, paragraphs = [], code, cta, items = [], footerNote, unsubscribeUrl }) {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e8e5;border-radius:12px;">
        <tr><td style="padding:20px 24px;border-bottom:3px solid ${BRAND};">
          <strong style="font-size:20px;color:${BRAND};">UgaMarket</strong>
          <span style="font-size:13px;color:#5b6778;"> &middot; home to home</span>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#0f172a;">${escapeHtml(heading)}</h1>
          ${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;">${escapeHtml(p)}</p>`).join('')}
          ${
            code
              ? `<p style="margin:18px 0;text-align:center;"><span style="display:inline-block;padding:12px 20px;font-size:30px;letter-spacing:8px;font-weight:bold;color:#0f172a;background:#e9f4ee;border:1px solid #cfe5d8;border-radius:10px;">${escapeHtml(code)}</span></p>`
              : ''
          }
          ${
            items.length
              ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;">${items
                  .map(
                    (it) => `<tr><td style="padding:10px 0;border-top:1px solid #e3e8e5;">
                      ${it.imageUrl ? `<img src="${escapeHtml(it.imageUrl)}" alt="" width="64" height="64" style="float:left;margin-right:12px;border-radius:8px;object-fit:cover;">` : ''}
                      <a href="${escapeHtml(it.url)}" style="font-size:15px;font-weight:bold;color:#0f172a;text-decoration:none;">${escapeHtml(it.name)}</a><br>
                      <span style="font-size:14px;color:${BRAND};font-weight:bold;">${escapeHtml(it.price)}</span>
                    </td></tr>`
                  )
                  .join('')}</table>`
              : ''
          }
          ${
            cta
              ? `<p style="margin:20px 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:bold;color:#ffffff;background:${BRAND};border-radius:8px;text-decoration:none;">${escapeHtml(cta.label)}</a></p>`
              : ''
          }
          ${footerNote ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#5b6778;">${escapeHtml(footerNote)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e3e8e5;font-size:12px;line-height:1.5;color:#7b8696;">
          UgaMarket, Kampala, Uganda. Never share your verification codes with anyone &mdash; UgaMarket staff will never ask for them.
          ${unsubscribeUrl ? `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#5b6778;">Unsubscribe</a> from these emails.` : ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    heading,
    '',
    ...paragraphs,
    code ? `\nYour code: ${code}\n` : '',
    ...items.map((it) => `- ${it.name} (${it.price}): ${it.url}`),
    cta ? `\n${cta.label}: ${cta.url}` : '',
    footerNote ? `\n${footerNote}` : '',
    '',
    'UgaMarket, Kampala, Uganda. Never share your verification codes with anyone.',
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return { html, text };
}

module.exports = { renderEmail, escapeHtml };
