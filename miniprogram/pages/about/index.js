const assessment = require("../../services/assessment");

Page({
  data: { cloudEnabled: false, cloudConsentAccepted: false, cloudConsentText: "未开启" },
  onShow() {
    const cloudEnabled = assessment.cloudEnabled();
    const consent = assessment.cloudConsentStatus();
    this.setData({
      cloudEnabled,
      cloudConsentAccepted: Boolean(consent && consent.status === "accepted"),
      cloudConsentText: !cloudEnabled ? "仅本机" : (consent && consent.status === "accepted" ? "已同意并同步" : "未同意，不上传"),
    });
  },
  enableCloudSync() {
    assessment.ensureCloudConsent({ prompt: true, forcePrompt: true }).then((accepted) => {
      if (accepted) {
        this.setData({ cloudConsentAccepted: true, cloudConsentText: "已同意并同步" });
        assessment.syncAll();
        wx.showToast({ title: "云端同步已开启" });
      }
    });
  },
  clearAll() {
    wx.showModal({ title: "删除全部数据", content: "本机进度、历史报告以及当前账号的云端记录都会被删除。此操作无法恢复。", confirmColor: "#B54848", success: ({ confirm }) => {
      if (confirm) assessment.deleteAll().then(() => wx.showToast({ title: "数据已删除" })).catch(() => {
        wx.showModal({ title: "云端删除失败", content: "本机数据已经删除，但云端暂时无法连接。请恢复网络后再次执行删除。", showCancel: false });
      });
    } });
  },
  copySource(event) {
    wx.setClipboardData({ data: event.currentTarget.dataset.url });
  },
});
