import { ArrowRight, Check, Loader2, LockKeyhole, Orbit } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { AppUpdateControl } from "./AppUpdateControl";
import { PRODUCT, IS_PRODUCT_PREVIEW_AVAILABLE } from "../config";

interface LoginScreenProps {
  busy: boolean;
  error: string | null;
  onLogin: () => void;
  onPreview: () => void;
}

const capabilities = ["检测本机工具环境", "切换可用模型分组"];

export function LoginScreen({
  busy,
  error,
  onLogin,
  onPreview,
}: LoginScreenProps) {
  const configured = Boolean(PRODUCT.newApiBaseUrl);

  return (
    <main className="vv-login">
      <div className="vv-login__drag" data-tauri-drag-region />
      <div className="vv-login__update">
        <AppUpdateControl className="vv-update-button--standalone" />
      </div>
      <div className="vv-login__glow vv-login__glow--one" />
      <div className="vv-login__glow vv-login__glow--two" />

      <section className="vv-login__story">
        <BrandMark />
        <div className="vv-login__eyebrow">
          <Orbit size={15} />
          AI 开发工作台
        </div>
        <h1>
          一个账号，
          <br />
          <span>连接你的 AI 工具。</span>
        </h1>
        <p>集中管理 Claude Code、Codex CLI 等工具的模型配置。</p>
        <ul className="vv-login__capabilities">
          {capabilities.map((capability) => (
            <li key={capability}>
              <span>
                <Check size={14} strokeWidth={2.5} />
              </span>
              {capability}
            </li>
          ))}
        </ul>
        <div className="vv-login__security">
          <LockKeyhole size={15} />
          登录凭证仅保存在本机
        </div>
      </section>

      <section className="vv-login__panel" aria-label="登录">
        <div className="vv-login-card">
          <div className="vv-login-card__icon">
            <BrandMark compact />
          </div>
          <div className="vv-login-card__heading">
            <h2>登录 {PRODUCT.brand.name}</h2>
            <p>登录后即可同步可用分组并开始配置。</p>
          </div>

          {!configured && (
            <div className="vv-login-card__notice" role="status">
              <strong>当前构建未配置登录服务</strong>
              <span>
                设置 <code>VITE_NEWAPI_BASE_URL</code> 后即可启用。
              </span>
            </div>
          )}

          {error && (
            <div className="vv-inline-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="button"
            className="vv-primary-button vv-primary-button--large"
            disabled={busy || !configured}
            onClick={onLogin}
          >
            {busy ? <Loader2 className="vv-spin" size={18} /> : null}
            {busy ? "等待登录完成…" : "一键登录"}
            {!busy && <ArrowRight size={18} />}
          </button>

          <p className="vv-login-card__hint">
            将在浏览器中完成授权，成功后自动返回
          </p>

          {IS_PRODUCT_PREVIEW_AVAILABLE && !configured && (
            <button
              type="button"
              className="vv-text-button"
              onClick={onPreview}
            >
              进入开发界面预览
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
