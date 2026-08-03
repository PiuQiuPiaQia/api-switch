import logoUrl from "../assets/logo.png";
import { BRAND_CONFIG } from "../brand";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`vv-brand ${compact ? "vv-brand--compact" : ""}`}>
      <img
        className="vv-brand__logo"
        src={logoUrl}
        alt={BRAND_CONFIG.brand.name}
      />
    </div>
  );
}
