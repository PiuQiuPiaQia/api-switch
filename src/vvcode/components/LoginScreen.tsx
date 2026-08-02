import { ArrowRight, Check, Loader2, LockKeyhole, Orbit } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { PRODUCT, IS_PRODUCT_PREVIEW_AVAILABLE } from "../config";

interface LoginScreenProps {
  busy: boolean;
  error: string | null;
  onLogin: () => void;
  onPreview: () => void;
}

const capabilities = [
  "一键检测 AI 开发工具环境",
  "按分组配置模型并一键切换",
  "密钥仅保存在本机受限目录",
];

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
      <div className="vv-login__glow vv-login__glow--one" />
      <div className="vv-login__glow vv-login__glow--two" />

      <section className="vv-login__story">
        <BrandMark />
        <div className="vv-login__eyebrow">
          <Orbit size={15} />
          AI WORKSPACE
        </div>
        <h1>
          一次登录，
          <br />
          <span>让每个 AI 工具就绪。</span>
        </h1>
        <p>{PRODUCT.brand.tagline}。从环境检查到模型配置，用清晰的步骤完成。</p>
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
          <LockKeyhole size={16} />
          OAuth + PKCE + 本地回环授权，登录令牌仅由桌面端保存
        </div>
      </section>

      <section className="vv-login__panel" aria-label="登录">
        <div className="vv-login-card">
          <div className="vv-login-card__icon">
            <BrandMark compact />
          </div>
          <div className="vv-login-card__heading">
            <span>欢迎使用</span>
            <h2>登录 {PRODUCT.brand.name}</h2>
            <p>将在系统浏览器中完成中转站账号授权，成功后自动返回应用。</p>
          </div>

          {!configured && (
            <div className="vv-login-card__notice" role="status">
              <strong>服务地址尚未编译配置</strong>
              <span>
                开发/打包时设置 <code>VITE_NEWAPI_BASE_URL</code> 即可启用登录。
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
            {busy ? "等待浏览器授权" : "使用中转站账号登录"}
            {!busy && <ArrowRight size={18} />}
          </button>

          {IS_PRODUCT_PREVIEW_AVAILABLE && !configured && (
            <button
              type="button"
              className="vv-text-button"
              onClick={onPreview}
            >
              进入开发界面预览
            </button>
          )}

          <p className="vv-login-card__terms">
            继续即表示你同意服务条款与隐私政策。授权可随时在用户页面撤销。
          </p>
        </div>
      </section>
    </main>
  );
}
