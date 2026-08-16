const storage = require("../../utils/storage");
const { getScale } = require("../../data/scales");
const assessment = require("../../services/assessment");

function formatDate(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: { sessions: [], results: [], hasData: false, cloudEnabled: false },

  onShow() {
    this.refresh();
    if (assessment.cloudEnabled()) assessment.syncAll().then(() => this.refresh()).catch(() => {});
  },

  refresh() {
    const state = storage.readState();
    const sessions = Object.values(state.sessions).map((session) => {
      const scale = getScale(session.scaleId);
      const answered = Object.keys(session.answers || {}).length;
      return { ...session, title: scale ? scale.title : session.scaleId, total: scale ? scale.itemCount : 0, answered, progress: scale ? Math.round(answered / scale.itemCount * 100) : 0 };
    }).filter((session) => session.answered > 0);
    const results = state.results.map((result) => ({
      ...result,
      dateText: formatDate(result.completedAt),
      scoreLine: (result.domains || []).map((domain) => `${domain.name} ${domain.score}`).join(" · "),
    }));
    this.setData({ sessions, results, hasData: sessions.length + results.length > 0, cloudEnabled: assessment.cloudEnabled() });
  },

  continueSession(event) {
    wx.navigateTo({ url: `/pages/questionnaire/index?scaleId=${event.currentTarget.dataset.scale}` });
  },
  openResult(event) {
    wx.navigateTo({ url: `/pages/result/index?resultId=${event.currentTarget.dataset.id}` });
  },
  deleteResult(event) {
    const resultId = event.currentTarget.dataset.id;
    wx.showModal({ title: "删除这份报告", content: "删除后无法恢复。", confirmColor: "#B54848", success: ({ confirm }) => {
      if (confirm) assessment.deleteResult(resultId).then(() => this.refresh()).catch(() => {
        this.refresh();
        wx.showToast({ title: "本机已删除，云端删除失败", icon: "none" });
      });
    } });
  },
  clearAll() {
    wx.showModal({ title: "清空全部记录", content: "未完成进度和历史报告都会被永久删除。", confirmColor: "#B54848", success: ({ confirm }) => {
      if (confirm) assessment.deleteAll().then(() => this.refresh()).catch(() => {
        this.refresh();
        wx.showToast({ title: "本机已清空，云端删除失败", icon: "none" });
      });
    } });
  },
  startTest() { wx.switchTab({ url: "/pages/index/index" }); },
});
