import logoUrl from "../assets/logo.png";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`vv-brand ${compact ? "vv-brand--compact" : ""}`}>
      <img className="vv-brand__logo" src={logoUrl} alt="VV Code" />
    </div>
  );
}
