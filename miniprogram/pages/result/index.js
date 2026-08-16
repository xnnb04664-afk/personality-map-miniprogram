const assessment = require("../../services/assessment");

function formatDate(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

Page({
  data: { loading: true, result: null, dateText: "", posterReady: false },

  onLoad(options) {
    this.resultId = options.resultId;
    assessment.getResult(this.resultId).then((result) => {
      if (!result) {
        wx.showToast({ title: "报告不存在或已删除", icon: "none" });
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      this.result = result;
      this.setData({ loading: false, result, dateText: formatDate(result.completedAt) });
    });
  },

  drawPoster(callback) {
    const result = this.result;
    const ctx = wx.createCanvasContext("posterCanvas", this);
    ctx.setFillStyle("#F4F6F5"); ctx.fillRect(0, 0, 600, 820);
    ctx.setFillStyle("#FFFFFF"); ctx.fillRect(28, 28, 544, 764);
    ctx.setFillStyle("#17201D"); ctx.setFontSize(30); ctx.fillText("人格图谱", 58, 82);
    ctx.setFillStyle("#68736F"); ctx.setFontSize(16); ctx.fillText(`${result.scaleTitle} · ${formatDate(result.completedAt)}`, 58, 116);
    ctx.setFillStyle("#17201D"); ctx.setFontSize(24); ctx.fillText("我的大五人格概览", 58, 170);
    result.domains.forEach((domain, index) => {
      const y = 220 + index * 88;
      ctx.setFillStyle("#25302C"); ctx.setFontSize(18); ctx.fillText(domain.name, 58, y);
      ctx.setFillStyle("#6B7672"); ctx.setFontSize(16); ctx.fillText(`${domain.score} · ${domain.level}`, 450, y);
      ctx.setFillStyle("#E5EAE8"); ctx.fillRect(58, y + 18, 484, 12);
      ctx.setFillStyle(domain.color); ctx.fillRect(58, y + 18, Math.max(8, 484 * domain.score / 100), 12);
    });
    ctx.setFillStyle("#53605B"); ctx.setFontSize(16); ctx.fillText("分数表示量表位置，不是人群百分位。", 58, 690);
    ctx.setFillStyle("#8A9490"); ctx.setFontSize(14); ctx.fillText("仅供自我探索，不用于心理诊断或人员筛选。", 58, 722);
    ctx.setFillStyle("#187A68"); ctx.fillRect(58, 756, 120, 4);
    ctx.draw(false, () => setTimeout(callback, 120));
  },

  savePoster() {
    wx.showLoading({ title: "生成海报" });
    this.drawPoster(() => {
      wx.canvasToTempFilePath({
        canvasId: "posterCanvas", width: 600, height: 820, destWidth: 1200, destHeight: 1640,
        success: ({ tempFilePath }) => {
          wx.saveImageToPhotosAlbum({
            filePath: tempFilePath,
            success: () => { wx.hideLoading(); wx.showToast({ title: "已保存到相册" }); },
            fail: (error) => {
              wx.hideLoading();
              if (String(error.errMsg).includes("auth deny")) wx.showModal({ title: "需要相册权限", content: "请在小程序设置中允许保存图片。", confirmText: "去设置", success: ({ confirm }) => confirm && wx.openSetting() });
              else wx.showToast({ title: "保存失败", icon: "none" });
            },
          });
        },
        fail: () => { wx.hideLoading(); wx.showToast({ title: "海报生成失败", icon: "none" }); },
      }, this);
    });
  },

  openAbout() { wx.navigateTo({ url: "/pages/about/index" }); },
  onShareAppMessage() {
    const scaleId = this.result ? this.result.scaleId : "";
    return { title: "人格图谱｜从五个维度认识自己", path: `/pages/index/index?from=share&scaleId=${scaleId}` };
  },
});
