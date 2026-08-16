# 人格图谱微信小程序

面向 18 岁以上用户的非临床大五人格自我探索工具。首版包含：

- IPIP-NEO-60 中文本地化短版
- IPIP-NEO-120 中文本地化版
- IPIP-NEO-300 中文本地化长版
- 五维与 30 分面报告
- 本地断点续答、历史记录和摘要海报
- 可选的微信云开发同步

本项目使用 IPIP 公有领域题目，不包含受版权保护的正式 NEO-PI-R 240 题题库。结果不是心理诊断，也不适合用于招聘、升学或其他重大决策。

## 本地运行

1. 使用微信开发者工具导入项目根目录。
2. 保持 `miniprogram/envList.js` 为空即可使用本机保存模式。
3. 编译后从首页选择 60、120 或 300 题版本。

## 开启云同步

1. 在微信开发者工具中创建或选择云开发环境。
2. 将环境 ID 填入 `miniprogram/envList.js`。
3. 右键 `cloudfunctions/assessmentApi`，选择“上传并部署：云端安装依赖”。
4. 按该目录内的部署说明设置数据库权限。

## 验证

```powershell
npm test
```

测试覆盖题库数量与映射、正反向计分、分数边界、客户端与云端计分键一致性，以及本地记录的保存和删除。

## 量表来源

- IPIP 官方站：https://ipip.ori.org/
- Maples-Keller, J. L. et al. (2019). Development of the IPIP-NEO-60.
- Johnson, J. A. (2014). Measuring thirty facets of the Five Factor Model with a 120-item public domain inventory.
- Goldberg, L. R. (1999). A broad-bandwidth, public-domain personality inventory measuring lower-level facets of several five-factor models.

文化敏感题已替换为中性的价值开放题项，因此产品内统一标注为“中文本地化版”，不冒充正式 NEO-PI-R 或原版常模报告。
