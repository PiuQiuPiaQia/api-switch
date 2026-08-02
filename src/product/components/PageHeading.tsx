import type { CSSProperties, ReactNode } from "react";

interface PageHeadingProps {
  title: string;
  description: string;
  icon: ReactNode;
  accent?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeading({
  title,
  description,
  icon,
  accent = "#6658ee",
  actions,
  className = "",
}: PageHeadingProps) {
  return (
    <header
      className={`vv-page-heading ${className}`.trim()}
      style={{ "--page-accent": accent } as CSSProperties}
    >
      <div className="vv-page-heading__identity">
        <span className="vv-page-heading__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="vv-page-heading__copy">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      {actions && <div className="vv-page-heading__actions">{actions}</div>}
    </header>
  );
}
