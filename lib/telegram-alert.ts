// Send-only Telegram alerts, reusing the bot already configured for the
// user's Claude Code Telegram channel (~/.claude/channels/telegram —
// this module does NOT read from there; the token is copied into this
// project's own .env.local as TELEGRAM_BOT_TOKEN so the app doesn't
// depend on unrelated tooling config). Used by the Schwab weekly health
// job and the post-earnings capture runner for schwab_disconnected
// alerts — both local scripts, not Next.js routes, so this has no
// framework dependency.
export async function sendTelegramAlert(text: string): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID ?? "";
  if (!token || !chatId) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID not configured" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Telegram HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
