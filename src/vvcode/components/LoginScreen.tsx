import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, LockKeyhole, Orbit } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { BrandMark } from "./BrandMark";
import { AppUpdateControl } from "./AppUpdateControl";
import { PRODUCT, IS_PRODUCT_PREVIEW_AVAILABLE } from "../config";

interface LoginScreenProps {
  busy: boolean;
  error: string | null;
  manualAuthUrl: string | null;
  onLogin: () => void;
  onPatLogin: () => void;
  onPreview: () => void;
}

const capabilities = ["检测本机工具环境", "切换可用模型分组"];

export function LoginScreen({
  busy,
  error,
  manualAuthUrl,
  onLogin,
  onPatLogin,
  onPreview,
}: LoginScreenProps) {
  const [authUrlCopied, setAuthUrlCopied] = useState(false);
  const configured = Boolean(PRODUCT.newApiBaseUrl);

  useEffect(() => {
    if (!manualAuthUrl) setAuthUrlCopied(false);
  }, [manualAuthUrl]);

  const copyAuthUrl = async () => {
    if (!manualAuthUrl) return;
    try {
      await copyText(manualAuthUrl);
      setAuthUrlCopied(true);
    } catch (copyError) {
      toast.error(
        copyError instanceof Error ? copyError.message : "复制授权链接失败",
      );
    }
  };

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

          {manualAuthUrl && (
            <div className="vv-login-card__notice vv-manual-auth" role="status">
              <strong>无法自动打开浏览器</strong>
              <span>
                请复制授权链接，在浏览器中打开完成登录，成功后会自动返回应用：
              </span>
              <code className="vv-manual-auth__url">{manualAuthUrl}</code>
              <button
                type="button"
                className="vv-text-button"
                onClick={() => void copyAuthUrl()}
              >
                {authUrlCopied ? (
                  <>
                    <Check size={13} /> 已复制
                  </>
                ) : (
                  "复制授权链接"
                )}
              </button>
            </div>
          )}

          <button
            type="button"
            className="vv-primary-button vv-primary-button--large"
            disabled={busy || !configured}
            onClick={onPatLogin}
          >
            {busy ? <Loader2 className="vv-spin" size={18} /> : null}
            {busy ? "等待登录完成…" : "一键登录"}
            {!busy && <ArrowRight size={18} />}
          </button>

          <p className="vv-login-card__hint">
            登录窗口在应用内打开，授权凭证仅保存在本机
          </p>

          <button
            type="button"
            className="vv-text-button"
            disabled={busy || !configured}
            onClick={onLogin}
          >
            改用浏览器授权登录
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
        </div>
      </section>
    </main>
  );
}
