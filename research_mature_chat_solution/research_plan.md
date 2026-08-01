# 成熟对话方案研究计划

## 研究问题

为 VV Code 的 Tauri + React 工作台增加“左侧历史列表、右侧对话流”的本地页面时，哪套成熟方案能覆盖常见文本、Markdown、代码、图片/文件、推理、工具调用等输入输出，并尽量直接连接 OpenAI-compatible API，避免项目自行维护模型与消息字段映射？

## 子课题

1. assistant-ui + Vercel AI SDK
   - 核实 ThreadList、多会话持久化、通用消息 parts、OpenAI-compatible provider、DirectChatTransport，以及 Tauri/Vite/React 18 的可行性。

2. Ant Design X
   - 核实 Conversations、Bubble、Sender、Attachments、XMarkdown 与 x-sdk OpenAI provider 是否构成开箱即用的完整页面，并评估第二套设计系统成本。

3. 完整开源聊天应用与其他组件
   - 比较 Open WebUI、LobeChat、LibreChat、Deep Chat 等“整套应用/轻组件”能否作为当前 React 页面嵌入，识别许可证、额外后端、鉴权和部署代价。

## 综合方式

按页面完成度、协议适配量、通用消息格式、历史持久化、与现有 UI 栈兼容性、依赖/后端成本六方面比较，明确给出首选技术栈及首版边界。
