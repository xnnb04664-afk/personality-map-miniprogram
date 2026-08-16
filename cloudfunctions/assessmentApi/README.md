# assessmentApi 部署

1. 在微信开发者工具中开通云开发，复制环境 ID。
2. 将环境 ID 填入 `miniprogram/envList.js` 的第一项。
3. 右键本目录，选择“上传并部署：云端安装依赖”。
4. 云函数首次调用时会创建 `assessment_sessions` 和 `assessment_results` 集合。
5. 在云开发控制台将两个集合的客户端权限设为“所有用户不可读写”。小程序只通过云函数访问数据，云函数会按服务端 OpenID 隔离记录。

部署前可先保持环境 ID 为空；小程序会使用本机保存模式。
