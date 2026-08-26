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
export async function sendDiscordAlert(
  text: string,
  opts?: { mention?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL ?? "";
  if (!webhookUrl) {
    return { ok: false, error: "DISCORD_WEBHOOK_URL not configured" };
  }
  const mention = opts?.mention ?? true;
  const pingUserId = process.env.DISCORD_PING_USER_ID ?? "";
  const ping = mention && pingUserId ? `<@${pingUserId}>\n` : "";
  const payload: { content: string; allowed_mentions?: { users: string[] } } = {
    content: `${ping}${text}`,
  };
  if (mention && pingUserId) {
    payload.allowed_mentions = { users: [pingUserId] };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200 && res.status !== 204) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Discord HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
