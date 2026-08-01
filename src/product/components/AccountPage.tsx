import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  CalendarClock,
  LogOut,
  Mail,
  Server,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";
import { PRODUCT } from "../config";
import type { NewApiBootstrap, NewApiSession } from "../types";

interface AccountPageProps {
  session: NewApiSession;
  bootstrap: NewApiBootstrap;
  preview: boolean;
  onLogout: () => void;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp * 1000));
}

function formatQuotaAsCurrency(quota: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: PRODUCT.billing.currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.max(0, quota) / PRODUCT.billing.quotaPerUnit);
}

function buildRechargeUrl(serverUrl: string): string {
  try {
    return new URL(PRODUCT.billing.rechargePath, serverUrl).toString();
  } catch {
    return new URL(
      PRODUCT.billing.rechargePath,
      PRODUCT.brand.websiteUrl,
    ).toString();
  }
}

export function AccountPage({
  session,
  bootstrap,
  preview,
  onLogout,
}: AccountPageProps) {
  const user = bootstrap.user;
  const rechargeUrl = buildRechargeUrl(session.serverUrl);

  return (
    <div className="vv-page vv-account-page">
      <header className="vv-page-heading">
        <div>
          <h1>用户信息</h1>
          <p>查看中转站账号、额度与当前桌面授权状态。</p>
        </div>
        <button
          type="button"
          className="vv-secondary-button"
          onClick={onLogout}
        >
          <LogOut size={16} />
          {preview ? "退出预览" : "退出登录"}
        </button>
      </header>

      <section className="vv-account-hero">
        <div className="vv-account-avatar">
          {(user.displayName || user.username || "V").slice(0, 1).toUpperCase()}
          <span>
            <BadgeCheck size={16} />
          </span>
        </div>
        <div className="vv-account-identity">
          <div className="vv-account-identity__name">
            <h2>{user.displayName || user.username}</h2>
            <span>已授权</span>
          </div>
          <p>@{user.username}</p>
          <div className="vv-account-meta">
            <span>
              <Mail size={14} /> {user.email || "未绑定邮箱"}
            </span>
            <span>
              <ShieldCheck size={14} /> {user.group || "default"} 分组
            </span>
          </div>
        </div>
        <div className="vv-account-wallet">
          <div className="vv-account-wallet__label">
            <WalletCards size={15} />
            <span>钱包余额</span>
          </div>
          <strong>{formatQuotaAsCurrency(user.quota)}</strong>
          <small>可用额度 {formatNumber(user.quota)} 点</small>
          <a
            className="vv-account-wallet__recharge"
            href={rechargeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            去充值
            <ArrowUpRight size={14} />
          </a>
        </div>
      </section>

      <section className="vv-stat-grid">
        <article className="vv-stat-card">
          <div className="vv-stat-card__icon vv-stat-card__icon--violet">
            <Activity size={18} />
          </div>
          <span>累计消耗</span>
          <strong>{formatQuotaAsCurrency(user.usedQuota)}</strong>
          <small>{formatNumber(user.usedQuota)} 配额点</small>
        </article>
        <article className="vv-stat-card">
          <div className="vv-stat-card__icon vv-stat-card__icon--blue">
            <UserRound size={18} />
          </div>
          <span>累计请求</span>
          <strong>{formatNumber(user.requestCount)}</strong>
          <small>由中转站实时统计</small>
        </article>
        <article className="vv-stat-card">
          <div className="vv-stat-card__icon vv-stat-card__icon--green">
            <Server size={18} />
          </div>
          <span>可用分组</span>
          <strong>{bootstrap.groups.length}</strong>
          <small>
            {bootstrap.groups.reduce(
              (sum, group) => sum + group.models.length,
              0,
            )}{" "}
            个模型映射
          </small>
        </article>
      </section>

      <section className="vv-account-details">
        <div className="vv-section-title">
          <div>
            <h2>授权详情</h2>
            <p>桌面端不会向页面暴露 access token。</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>用户 ID</dt>
            <dd>{session.userId}</dd>
          </div>
          <div>
            <dt>服务地址</dt>
            <dd>{session.serverUrl}</dd>
          </div>
          <div>
            <dt>授权时间</dt>
            <dd>
              <CalendarClock size={14} /> {formatDate(session.createdAt)}
            </dd>
          </div>
          <div>
            <dt>数据适配</dt>
            <dd>
              {bootstrap.source === "vscode-legacy"
                ? "NewAPI 兼容接口"
                : "桌面端聚合接口"}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
