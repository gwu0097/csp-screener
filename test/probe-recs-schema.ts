import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();
  const r = await sb.from("post_earnings_recommendations").select("id").limit(1);
  if (r.error) {
    console.log("post_earnings_recommendations error:", r.error.message);
    return;
  }
  console.log(
    `post_earnings_recommendations exists, rows=${r.data?.length ?? 0}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
