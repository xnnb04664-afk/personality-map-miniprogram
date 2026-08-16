const assessment = require("../../services/assessment");

const POSTER_WIDTH = 600;
const POSTER_HEIGHT = 820;

function callWxApi(method, options = {}) {
  return new Promise((resolve, reject) => {
    wx[method]({ ...options, success: resolve, fail: reject });
  });
}

function isAlbumPermissionError(error) {
  const message = String(error && error.errMsg || error || "").toLowerCase();
  return message.includes("auth deny") || message.includes("permission denied") || message.includes("scope.writephotosalbum");
}

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

  getPosterCanvas() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select("#posterCanvas")
        .fields({ node: true, size: true })
        .exec((result) => {
          const canvas = result && result[0] && result[0].node;
          if (canvas) resolve(canvas);
          else reject(new Error("POSTER_CANVAS_UNAVAILABLE"));
        });
    });
  },

  async drawPoster() {
    const result = this.result;
    const canvas = await this.getPosterCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("POSTER_CONTEXT_UNAVAILABLE");
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const dpr = Math.max(1, Number(windowInfo.pixelRatio) || 1);
    canvas.width = POSTER_WIDTH * dpr;
    canvas.height = POSTER_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#F4F6F5"; ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(28, 28, 544, 764);
    ctx.fillStyle = "#17201D"; ctx.font = "30px sans-serif"; ctx.fillText("人格图谱", 58, 82);
    ctx.fillStyle = "#68736F"; ctx.font = "16px sans-serif"; ctx.fillText(`${result.scaleTitle} · ${formatDate(result.completedAt)}`, 58, 116);
    ctx.fillStyle = "#17201D"; ctx.font = "24px sans-serif"; ctx.fillText("我的大五人格概览", 58, 170);
    result.domains.forEach((domain, index) => {
      const y = 220 + index * 88;
      ctx.fillStyle = "#25302C"; ctx.font = "18px sans-serif"; ctx.textAlign = "left"; ctx.fillText(domain.name, 58, y);
      ctx.fillStyle = "#6B7672"; ctx.font = "16px sans-serif"; ctx.textAlign = "right"; ctx.fillText(`${domain.score} · ${domain.level}`, 542, y);
      ctx.fillStyle = "#E5EAE8"; ctx.fillRect(58, y + 18, 484, 12);
      ctx.fillStyle = domain.color; ctx.fillRect(58, y + 18, Math.max(8, 484 * domain.score / 100), 12);
    });
    ctx.textAlign = "left";
    ctx.fillStyle = "#53605B"; ctx.font = "16px sans-serif"; ctx.fillText("分数表示量表位置，不是人群百分位。", 58, 690);
    ctx.fillStyle = "#8A9490"; ctx.font = "14px sans-serif"; ctx.fillText("仅供自我探索，不用于心理诊断或人员筛选。", 58, 722);
    ctx.fillStyle = "#187A68"; ctx.fillRect(58, 756, 120, 4);
    return canvas;
  },

  async recoverAlbumPermission(tempFilePath) {
    const modal = await callWxApi("showModal", {
      title: "需要相册权限",
      content: "请在小程序设置中允许保存图片。",
      confirmText: "去设置",
    });
    if (!modal.confirm) return;
    const settings = await callWxApi("openSetting");
    if (!settings.authSetting || !settings.authSetting["scope.writePhotosAlbum"]) {
      wx.showToast({ title: "未开启相册权限", icon: "none" });
      return;
    }
    wx.showLoading({ title: "保存海报" });
    try {
      await callWxApi("saveImageToPhotosAlbum", { filePath: tempFilePath });
      wx.hideLoading();
      wx.showToast({ title: "已保存到相册" });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  async savePoster() {
    wx.showLoading({ title: "生成海报" });
    let tempFilePath = "";
    try {
      const canvas = await this.drawPoster();
      const exported = await callWxApi("canvasToTempFilePath", { canvas, fileType: "png" });
      tempFilePath = exported.tempFilePath;
      await callWxApi("saveImageToPhotosAlbum", { filePath: tempFilePath });
      wx.hideLoading();
      wx.showToast({ title: "已保存到相册" });
    } catch (error) {
      wx.hideLoading();
      if (tempFilePath && isAlbumPermissionError(error)) {
        try {
          await this.recoverAlbumPermission(tempFilePath);
        } catch (settingError) {
          wx.showToast({ title: "无法打开设置", icon: "none" });
        }
      } else if (tempFilePath) {
        wx.showToast({ title: "保存失败", icon: "none" });
      } else {
        wx.showToast({ title: "海报生成失败", icon: "none" });
      }
    }
  },

  openAbout() { wx.navigateTo({ url: "/pages/about/index" }); },
  onShareAppMessage() {
    const scaleId = this.result ? this.result.scaleId : "";
    return { title: "人格图谱｜从五个维度认识自己", path: `/pages/index/index?from=share&scaleId=${scaleId}` };
  },
});
