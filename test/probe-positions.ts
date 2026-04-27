import { createServerClient } from "../lib/supabase";

async function main() {
  const sb = createServerClient();

  const { data, error } = await sb
    .from("positions")
    .select("id,symbol,status")
    .limit(10);
  console.log("rows:", data?.length, "error:", error?.message ?? "none");
  console.log(JSON.stringify(data?.slice(0, 3), null, 2));

  const countOpen = await sb.from("positions").select("id").eq("status", "open");
  console.log(
    "open positions:",
    countOpen.data?.length,
    "error:",
    countOpen.error?.message ?? "none",
  );

  const all = await sb.from("positions").select("id");
  console.log(
    "total positions:",
    all.data?.length,
    "error:",
    all.error?.message ?? "none",
  );
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
