# VV Code 软件更新

VV Code 使用 Tauri 的签名更新器安装 GitHub Release 中的更新包。更新发现逻辑位于
`src-tauri/src/vvcode/updater.rs`，不会使用 GitHub 的 `releases/latest` 接口，因为该接口
会排除 prerelease。

## 更新通道

- Beta 构建会写入 `VV_CODE_UPDATE_CHANNEL=beta`，并查询 GitHub Releases API。它接受更高
  版本的 prerelease，也接受更高版本的正式 Release。
- 正式构建使用 stable 通道，只接受非 prerelease Release。
- Release 必须包含 `latest.json`；缺少清单的历史版本和普通下载包不会被当成可安装更新。
- 最终下载由 Tauri updater 完成，并使用编译进应用的 minisign 公钥验证，renderer 无法
  替换信任的密钥或下载地址。

## GitHub Actions secrets

发布前需要在仓库的 Actions secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 私钥内容，或整个私钥文件的 Base64。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码；无密码时可省略。
- `TAURI_SIGNING_PUBLIC_KEY`：`tauri signer generate` 输出的 Public 值，也就是可直接写入
  Tauri updater `pubkey` 配置的 Base64 字符串。

私钥只用于 CI 生成 `.sig`，不能提交到仓库。公钥会通过 `VV_CODE_UPDATER_PUBKEY` 在编译时
嵌入应用。

## Beta 发布产物

`Beta Release` 工作流会把 GitHub run number 写入应用版本，例如
`0.0.1-beta.4`，并发布：

- macOS 的 `.tar.gz` updater 包及 `.sig`；
- Windows x64 的 NSIS `setup.exe` 及 `.sig`；
- 描述平台、下载地址和签名的 `latest.json`；
- 原有的 `.dmg`、`.app.zip` 和 `setup.exe` 手动安装包。

在此功能合入前生成的 Beta 安装包没有 updater 插件、公钥和真实的 prerelease 版本号，
因此无法自举更新。用户需要手动安装首个启用更新器的新 Beta；从该版本开始，后续 Beta
可以在应用内连续更新。
