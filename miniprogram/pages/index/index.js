const { listScales } = require("../../data/scales");
const storage = require("../../utils/storage");
const assessment = require("../../services/assessment");

Page({
  data: { scales: [], cloudEnabled: false, syncing: false, loadError: false },

  onShow() {
    getApp().clearStaleLoading();
    try {
      this.refresh();
    } catch (error) {
      console.error("首页加载失败", error);
      this.setData({ loadError: true });
      return;
    }
    if (assessment.cloudEnabled()) {
      this.setData({ syncing: true });
      assessment.ensureCloudConsent({ prompt: true })
        .then((consented) => consented ? assessment.syncAll() : null)
        .then(() => this.refresh())
        .catch((error) => console.warn("云端同步暂不可用", error.message))
        .then(() => this.setData({ syncing: false }));
    }
  },

  onReady() {
    getApp().clearStaleLoading();
  },

  refresh() {
    const state = storage.readState();
    const scales = listScales().map((scale) => {
      const session = state.sessions[scale.id];
      const answered = session ? Object.keys(session.answers || {}).length : 0;
      return {
        ...scale,
        answered,
        progress: Math.round((answered / scale.itemCount) * 100),
        hasProgress: answered > 0,
        syncLabel: session && !session.synced ? "待同步" : "",
      };
    });
    this.setData({ scales, cloudEnabled: assessment.cloudEnabled(), loadError: false });
  },

  openScale(event) {
    wx.navigateTo({ url: `/pages/questionnaire/index?scaleId=${event.currentTarget.dataset.id}` });
  },

  restartScale(event) {
    const scaleId = event.currentTarget.dataset.id;
    wx.showModal({
      title: "重新开始测试",
      content: "当前未完成的答案将被清除。",
      confirmColor: "#187A68",
      success: ({ confirm }) => {
        if (confirm) wx.navigateTo({ url: `/pages/questionnaire/index?scaleId=${scaleId}&restart=1` });
      },
    });
  },

  openAbout() {
    wx.navigateTo({ url: "/pages/about/index" });
  },
});
