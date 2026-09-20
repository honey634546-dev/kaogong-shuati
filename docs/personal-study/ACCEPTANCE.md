# 个人学习刷题工作台验收清单

这些是验收标准，不是已通过结果。每项执行时记录命令、环境和证据。

## WP1 首批门槛

- [x] 全新数据目录在没有 `tiku.db` 时启动成功。
- [x] 首页、`/api/subjects`、`/api/custom/batches` 在空库下返回正常结果。
- [x] 无 API Key、无外网时可以导入结构化自定义题目。
- [x] 自定义题目可以读取、练习、判分并写入学习记录。
- [x] 服务重启后批次、题目和记录仍存在。
- [x] 默认监听地址为回环地址；数据文件不进入 Git。

## WP2 当前证据

- [x] 自定义题目进入统一规范化层；空题、非法选项、越界答案索引和非法图片在写库前拒绝。
- [x] 支持 `external_id`/`question_uid`、内容指纹、`revision`、`is_current` 和答案状态；保留旧的 `custom-${id}` 兼容标识。
- [x] 重复导入相同内容幂等，不新建批次；服务端预览接口能返回重复项和冲突项。
- [x] 同一逻辑题内容变化默认返回 409；显式 `conflict_mode=new_revision` 后保留旧版本且仅当前版本进入刷题。
- [x] Web/App 导入协议保留逻辑身份字段；浏览器导入入口已接受 CSV，服务端和本地 handler 共享规范化规则。
- [x] `npm run test:wp2` 加 `node --test test-custom-bank-group.mjs test-wp1-empty-start.mjs`：17 passed / 0 failed。

## WP3 当前证据

- [x] 已知题目由服务端/本地 handler 重新判分，不采信客户端传入的 `correct`；未知旧题仍保留兼容回退并明确返回 `authoritative`。
- [x] 作答记录保存题面、答案、逻辑题目 ID 和 revision 快照；后续自定义题建立新 revision 不改变旧作答记录。
- [x] `submission_key` 重试幂等；同一 key 换题或换答案返回冲突，不静默追加第二条记录。
- [x] `practice_attempts` 记录一次刷题会话及完成状态；交卷等待记录写入后再标记完成，统计以服务端记录为准。
- [x] `npm run test:wp3`：1 passed / 0 failed；WP1/WP2/材料分组/本地 handler 合并回归：27 passed / 0 failed。

## WP4 当前证据

- [x] AI 智能体配置增加流式输出、视觉输入、请求超时、OpenAI-compatible/本地 Mock 模式；旧 `ai-config.db` 通过补列继续可读。
- [x] 新增 `/api/ai/chat` 完整 JSON 协议和 `/api/ai/chat/stream` SSE 协议；只允许客户端提交 user/assistant 消息，系统提示词和技能由服务端注入。
- [x] 兼容网关不接受 `reasoning_effort` 时自动去掉该参数重试；超时返回明确失败；HTTP 客户端断开会中止上游请求。
- [x] 本地模式提供同一多轮消息接口和离线 Mock，一次性返回结果并明确 `streamed=false`，不把一次性响应伪装成 SSE。
- [x] `npm run test:wp4`：4 passed / 0 failed；覆盖 JSON、SSE、参数回退、超时、主动取消和无外网 Mock。

## WP5 当前证据

- [x] 服务端新增 `ai_conversations`/`ai_messages`；会话身份绑定 `question_id + question_uid + revision`，题面快照不可变，换版本自动隔离。
- [x] 随题上下文包含题干、选项、材料、答案、解析和当前作答；模型历史仅发送 user/assistant，系统提示词与技能仍由服务端注入。
- [x] 服务端支持会话 JSON 消息和会话 SSE 消息；客户端取消后上游请求中止，用户消息标记为 cancelled，不写入伪造 assistant。
- [x] 本地模式新增 IndexedDB 会话/消息 stores，支持同样的创建、恢复、错误状态和版本隔离；本地一次性回复明确 `streamed=false`。
- [x] 练习页新增随题 AI 辅导面板：多轮追问、历史恢复、停止、错误提示和切题时取消旧请求。
- [x] `npm run test:wp5`：5 passed / 0 failed；另加本地 handler 路由回归：10 passed / 0 failed。覆盖服务端多轮、版本隔离、SSE 落库、主动停止、本地持久化。

## 后续 P0

- [ ] 题目、材料、选项、答案、解析和图片可导入前预览与修正。
- [ ] 单选、多选、判断和主观题的作答与判分口径明确。
- [x] 题目稳定 ID、版本、作答快照和提交幂等性通过 WP3 专项测试；跨历史完整题库的浏览器验收仍待 WP8。
- [x] AI 配置支持自定义地址、Key、模型名、流式/视觉能力和超时；真实供应商连通性仍按配置单独验证。
- [x] AI 侧栏能携带当前题目、当前作答和必要材料，支持多轮、停止、恢复和切题隔离；真实供应商和真实题库浏览器验收仍待 WP8。
- [ ] 错题、收藏、笔记、历史作答和会话可查看、导出和恢复。
- [ ] 完整备份在全新目录恢复后，题目、图片、记录、笔记和会话一致。
- [ ] 真实浏览器流程通过；真实供应商验证与 mock 验证分开记录。
