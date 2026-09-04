// Send-only Discord alerts via a channel webhook — replaces
// lib/telegram-alert.ts entirely (2026-08-27 migration, per user
// request: "have the alerts go to Discord instead of Telegram").
// Mirrors the exact mechanism already proven in the sibling
// ~/bet_monitor project's send_alert_to_discord: a plain POST to a
// per-channel webhook URL, @-mentioning a Discord user id so Discord
// fires a mobile push, with allowed_mentions explicitly set so the
// mention reliably triggers. DISCORD_PING_USER_ID is the same id
// bet_monitor pings — reused from that project's .env by the user's
// own choice, not a new value.
//
// mention defaults to true — most alerts across this codebase are
// genuine failures worth a push. Callers reporting a recovery/success
// pass {mention: false} for a quiet in-channel post with no ping.

// Discord's real content limit is 2000 chars. Leave headroom for the
// ping prefix and the truncation note itself, rather than getting a
// 400 back from Discord for a message that was already too long.
const DISCORD_CONTENT_LIMIT = 1900;

function capForDiscord(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  return `${content.slice(0, DISCORD_CONTENT_LIMIT)}\n... [message truncated, ${content.length} chars total]`;
}

function buildPayload(
  text: string,
  mention: boolean,
): { content: string; allowed_mentions?: { users: string[] } } {
  const pingUserId = process.env.DISCORD_PING_USER_ID ?? "";
  const ping = mention && pingUserId ? `<@${pingUserId}>\n` : "";
  const payload: { content: string; allowed_mentions?: { users: string[] } } = {
    content: capForDiscord(`${ping}${text}`),
  };
  if (mention && pingUserId) {
    payload.allowed_mentions = { users: [pingUserId] };
  }
  return payload;
}

export async function sendDiscordAlert(
  text: string,
  opts?: { mention?: boolean; returnId?: boolean },
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL ?? "";
  if (!webhookUrl) {
    return { ok: false, error: "DISCORD_WEBHOOK_URL not configured" };
  }
  const mention = opts?.mention ?? true;
  const payload = buildPayload(text, mention);
  // ?wait=true makes Discord return the created message object (200,
  // with an `id`) instead of the default 204 No Content — needed by
  // callers that want to edit this same message later (see
  // editDiscordAlert below) rather than posting a second one.
  const url = opts?.returnId ? `${webhookUrl}?wait=true` : webhookUrl;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (opts?.returnId) {
      if (res.status !== 200) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `Discord HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const json = (await res.json().catch(() => null)) as { id?: string } | null;
      return { ok: true, messageId: json?.id };
    }
    if (res.status !== 200 && res.status !== 204) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Discord HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Edits a message previously created via sendDiscordAlert(text, {returnId:
// true}) — same webhook, PATCH .../messages/{messageId}. Used to turn a
// "starting" placeholder into its final outcome in place, one message per
// run instead of two. Callers should fall back to a fresh sendDiscordAlert
// if this returns !ok (e.g. the message was deleted, or the id was never
// captured because the initial post itself failed).
export async function editDiscordAlert(
  messageId: string,
  text: string,
  opts?: { mention?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL ?? "";
  if (!webhookUrl) {
    return { ok: false, error: "DISCORD_WEBHOOK_URL not configured" };
  }
  const mention = opts?.mention ?? true;
  const payload = buildPayload(text, mention);
  try {
    const res = await fetch(`${webhookUrl}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Discord HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
