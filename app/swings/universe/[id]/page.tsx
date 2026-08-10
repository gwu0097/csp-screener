import { SwingUniverseThemeDetail } from "@/components/swing-universe-theme-detail";

export const dynamic = "force-dynamic";

export default function SwingUniverseThemePage({ params }: { params: { id: string } }) {
  return <SwingUniverseThemeDetail themeId={params.id} />;
}
