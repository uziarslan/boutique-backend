import { MailtrapClient } from 'mailtrap';

const TOKEN = process.env.MAILTRAP_TOKEN;

if (!TOKEN) {
    console.warn('MAILTRAP_TOKEN is not set — emails will fail until configured.');
}

const client = new MailtrapClient({ token: TOKEN });

const addresses = (value) => (Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map((entry) => (typeof entry === 'string' ? { email: entry } : entry));

/**
 * Send a normal Mailtrap email, optionally with Buffer attachments.
 * Kept separate from sendTemplateEmail so invitation templates remain
 * backwards compatible while billing can attach generated PDFs.
 */
export async function sendEmail({
    to,
    cc = [],
    from,
    subject,
    text,
    html,
    attachments = [],
    category,
    templateUuid,
    templateVariables,
}) {
    const sender = {
        email: (from && from.email) || process.env.MAILTRAP_SENDER_EMAIL,
        name: (from && from.name) || process.env.BILLING_COMPANY_NAME || 'Cenciss',
    };
    if (!TOKEN) throw new Error('MAILTRAP_TOKEN is not configured.');
    if (!sender.email) throw new Error('MAILTRAP_SENDER_EMAIL is not configured.');
    if (!templateUuid && !subject) throw new Error('Email subject is required.');

    try {
        const payload = {
            from: sender,
            to: addresses(to),
            attachments,
        };
        if (cc?.length) payload.cc = addresses(cc);
        if (templateUuid) {
            payload.template_uuid = templateUuid;
            payload.template_variables = templateVariables || {};
        } else {
            payload.subject = subject;
            payload.text = text;
            payload.html = html;
            payload.category = category;
        }
        return await client.send(payload);
    } catch (err) {
        const error = new Error('Failed to send email via Mailtrap: ' + (err?.message || err));
        error.cause = err;
        throw error;
    }
}

/**
 * Send a templated email via Mailtrap.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to - recipient email or array of emails
 * @param {Object} [opts.from] - { email, name } overrides default sender
 * @param {string} [opts.templateUuid] - Mailtrap template UUID
 * @param {Object} [opts.variables] - template variables object
 * @returns {Promise<Object>} Mailtrap send response
 */
export async function sendTemplateEmail({ to, from, templateUuid, variables = {} }) {
    // Sender email comes from env or explicit 'from' param.
    // Sender name is derived in order:
    // 1) from.name (explicit override), 2) variables.outletName (outlet selected), 3) default service name 'Cecniss'.
    const sender = {
        email: (from && from.email) || process.env.MAILTRAP_SENDER_EMAIL,
        name: (from && from.name) || variables?.outletName || 'Cenciss',
    };

    // Prefer invite-specific template env var, fall back to generic MAILTRAP_TEMPLATE_UUID for compatibility
    const template = templateUuid || process.env.INVITE_USER_TEMPLATE_UUID || process.env.MAILTRAP_TEMPLATE_UUID;

    if (!sender.email) throw new Error('Mail sender email is not configured (MAILTRAP_SENDER_EMAIL).');
    if (!template) throw new Error('Mail template UUID not provided and no template env var is set (INVITE_USER_TEMPLATE_UUID or MAILTRAP_TEMPLATE_UUID).');

    const recipients = Array.isArray(to)
        ? to.map((email) => ({ email }))
        : [{ email: to }];

    try {
        const res = await client.send({
            from: sender,
            to: recipients,
            template_uuid: template,
            template_variables: variables,
        });
        return res;
    } catch (err) {
        // Re-throw with more context
        const e = new Error('Failed to send template email via Mailtrap: ' + (err?.message || err));
        e.cause = err;
        throw e;
    }
}

export default sendTemplateEmail;
