# assessmentApi 部署

1. 在微信开发者工具中开通云开发，复制环境 ID。
2. 将环境 ID 填入 `miniprogram/envList.js` 的第一项。
3. 右键本目录，选择“上传并部署：云端安装依赖”。
4. 云函数首次调用时会创建 `assessment_sessions` 和 `assessment_results` 集合。
5. 在云开发控制台将两个集合的客户端权限设为“所有用户不可读写”。小程序只通过云函数访问数据，云函数会按服务端 OpenID 隔离记录。
6. 如需 AI 深度解读，在云函数环境变量中配置 `DEEPSEEK_API_KEY`，并将函数超时设置为至少 30 秒后重新部署。密钥不要写入小程序代码或仓库。
7. 部署时确认云函数已获得 `security.msgSecCheck` 开放接口权限；AI 内容只有通过微信内容安全检查后才会保存。

部署前可先保持环境 ID 为空；小程序会使用本机保存模式。

`scale-keys.json` 由项目根目录的 `npm run generate:scale-keys` 生成，请勿在云函数目录中手动维护计分键。

历史报告采用 `_openid` 过滤并按 `completedAt` 排序分页读取。首次部署后请在云开发控制台确认 `assessment_results` 的查询索引可用；若控制台提示联合索引缺失，按 `_openid` + `completedAt`（降序）创建索引后再验证历史记录翻页。
