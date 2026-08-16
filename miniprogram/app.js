// app.js
const { envList } = require("./envList");

App({
  globalData: {
    env: envList[0] && envList[0].envId ? envList[0].envId : "",
    cloudEnabled: false,
  },

  onLaunch() {
    this.clearStaleLoading();
    if (wx.cloud && this.globalData.env) {
      wx.cloud.init({ env: this.globalData.env, traceUser: true });
      this.globalData.cloudEnabled = true;
    }
  },

  onShow() {
    this.clearStaleLoading();
    if (this.globalData.cloudEnabled) {
      require("./services/assessment").syncAll().catch(() => {});
    }
  },

  clearStaleLoading() {
    // 调试热更新可能保留上一版本的原生 loading，进入前台时主动复位。
    try { wx.hideLoading({ noConflict: true }); } catch (error) { /* 基础库不支持时忽略 */ }
    try { wx.hideNavigationBarLoading(); } catch (error) { /* 基础库不支持时忽略 */ }
  },
});
