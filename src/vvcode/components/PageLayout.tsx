import type { CSSProperties, ReactNode } from "react";
import { PageHeading } from "./PageHeading";

interface PageLayoutProps {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
  accent?: string;
  actions?: ReactNode;
  width?: "standard" | "narrow";
  className?: string;
  style?: CSSProperties;
}

/**
 * Shared shell for every right-side workspace page except the full-height chat.
 * Owns content width, heading layout, actions and responsive behavior.
 */
export function PageLayout({
  title,
  description,
  icon,
  children,
  accent,
  actions,
  width = "standard",
  className = "",
  style,
}: PageLayoutProps) {
  return (
    <div
      className={`vv-page vv-page-layout vv-page-layout--${width} ${className}`.trim()}
      style={style}
    >
      <PageHeading
        title={title}
        description={description}
        icon={icon}
        accent={accent}
        actions={actions}
      />
      {children}
    </div>
  );
}
