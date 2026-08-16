const assessment = require("../../services/assessment");
const { buildReportPresentation } = require("../../utils/report");

const POSTER_WIDTH = 600;
const POSTER_HEIGHT = 820;
const AI_CONSENT_KEY = "personality-map-ai-consent-v1";
const AI_ERROR_MESSAGES = {
  AI_NOT_CONFIGURED: "AI 服务尚未配置，静态报告仍可正常查看。",
  AI_GENERATION_IN_PROGRESS: "这份报告正在生成 AI 解读，请稍后再试。",
  AI_RETRY_LATER: "刚才的生成未完成，请等待 30 秒后重试。",
  AI_RESULT_NOT_SYNCED: "报告尚未同步成功，暂时无法生成 AI 解读。",
  AI_INVALID_RESPONSE: "AI 返回内容不完整，请稍后重试。",
  AI_CONTENT_REJECTED: "本次生成内容未通过安全检查，请稍后重试。",
  AI_CONTENT_CHECK_FAILED: "内容安全检查暂时不可用，未保存本次 AI 内容。",
  AI_REQUEST_TIMEOUT: "AI 生成超时，静态报告不受影响，请稍后重试。",
  AI_SERVICE_ERROR: "AI 服务暂时不可用，静态报告不受影响。",
  CLOUD_DISABLED: "AI 解读需开启云同步。",
  CLOUD_REQUEST_TIMEOUT: "云端响应超时，请检查网络后重试。",
};

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

function syncStatusText(result) {
  if (result.syncBlocked) return "同步失败，仅保存在本机";
  if (result.synced) return "已同步";
  return assessment.cloudEnabled() ? "等待同步" : "保存在本机";
}

Page({
  data: {
    loading: true,
    result: null,
    dateText: "",
    syncText: "",
    activeView: "overview",
    expandedDomain: "",
    profileTitle: "你的特质会随情境呈现不同侧面",
    prominentTraits: [],
    aiInsight: null,
    aiLoading: false,
    aiError: "",
    aiButtonText: "生成 AI 深度解读",
    cloudAvailable: false,
    showAiConsent: false,
  },

  onLoad(options) {
    this.resultId = options.resultId;
    assessment.getResult(this.resultId).then((result) => {
      if (!result) {
        wx.showToast({ title: "报告不存在或已删除", icon: "none" });
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      this.result = result;
      const presentation = buildReportPresentation(result.domains);
      const cloudAvailable = assessment.cloudEnabled();
      this.setData({
        loading: false,
        result,
        dateText: formatDate(result.completedAt),
        syncText: syncStatusText(result),
        profileTitle: presentation.profileTitle,
        prominentTraits: presentation.prominentTraits,
        expandedDomain: presentation.expandedDomain,
        aiInsight: result.aiInsight || null,
        cloudAvailable,
        aiButtonText: cloudAvailable ? "生成 AI 深度解读" : "AI 解读需开启云同步",
      }, () => this.drawRadar());
    });
  },

  selectReportView(event) {
    const view = event.currentTarget.dataset.view;
    if (!["overview", "domains", "facets"].includes(view)) return;
    this.setData({ activeView: view }, () => {
      if (view === "overview") this.drawRadar();
    });
  },

  toggleDomain(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ expandedDomain: this.data.expandedDomain === id ? "" : id });
  },

  getCanvas(selector) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select(selector)
        .fields({ node: true, size: true })
        .exec((result) => {
          const entry = result && result[0];
          if (entry && entry.node) resolve(entry);
          else reject(new Error("CANVAS_UNAVAILABLE"));
        });
    });
  },

  getPosterCanvas() {
    return this.getCanvas("#posterCanvas").then((entry) => entry.node);
  },

  async drawRadar() {
    if (!this.result || this.data.activeView !== "overview") return;
    try {
      const entry = await this.getCanvas("#radarCanvas");
      const canvas = entry.node;
      const width = Math.max(280, Number(entry.width) || 320);
      const height = Math.max(240, Number(entry.height) || 300);
      const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const dpr = Math.max(1, Number(windowInfo.pixelRatio) || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("RADAR_CONTEXT_UNAVAILABLE");
      ctx.scale(dpr, dpr);

      const domains = this.result.domains.slice(0, 5);
      const centerX = width / 2;
      const centerY = height / 2 + 5;
      const radius = Math.min(width * 0.31, height * 0.34);
      const pointAt = (index, ratio = 1) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / 5;
        return { x: centerX + Math.cos(angle) * radius * ratio, y: centerY + Math.sin(angle) * radius * ratio, angle };
      };

      ctx.lineWidth = 1;
      for (let ring = 1; ring <= 5; ring += 1) {
        ctx.beginPath();
        domains.forEach((_domain, index) => {
          const point = pointAt(index, ring / 5);
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.closePath();
        ctx.strokeStyle = ring === 5 ? "#BCCAC5" : "#DFE6E3";
        ctx.stroke();
      }

      domains.forEach((_domain, index) => {
        const point = pointAt(index);
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(point.x, point.y);
        ctx.strokeStyle = "#D8E1DE";
        ctx.stroke();
      });

      ctx.beginPath();
      domains.forEach((domain, index) => {
        const point = pointAt(index, Math.max(0, Math.min(100, Number(domain.score))) / 100);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.fillStyle = "rgba(24, 122, 104, 0.20)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#187A68";
      ctx.stroke();

      domains.forEach((domain, index) => {
        const scorePoint = pointAt(index, Math.max(0, Math.min(100, Number(domain.score))) / 100);
        ctx.beginPath();
        ctx.arc(scorePoint.x, scorePoint.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = domain.color || "#187A68";
        ctx.fill();

        const labelPoint = pointAt(index, 1.2);
        const cosine = Math.cos(labelPoint.angle);
        ctx.textAlign = cosine > 0.25 ? "left" : cosine < -0.25 ? "right" : "center";
        ctx.textBaseline = "middle";
        ctx.font = "600 13px sans-serif";
        ctx.fillStyle = "#2F3C37";
        ctx.fillText(domain.name, labelPoint.x, labelPoint.y - 7);
        ctx.font = "12px sans-serif";
        ctx.fillStyle = domain.color || "#187A68";
        ctx.fillText(String(domain.score), labelPoint.x, labelPoint.y + 10);
      });
    } catch (error) {
      console.warn("雷达图绘制失败", error.message);
    }
  },

  onResize() {
    if (this.data.activeView === "overview") setTimeout(() => this.drawRadar(), 0);
  },

  async confirmAiPrivacy() {
    try {
      if (wx.getStorageSync(AI_CONSENT_KEY) === true) return true;
    } catch (error) { /* 无法读取时重新询问 */ }
    return new Promise((resolve) => {
      this.aiConsentResolver = resolve;
      this.setData({ showAiConsent: true });
    });
  },

  keepAiConsentOpen() {},

  finishAiConsent(confirmed) {
    const resolve = this.aiConsentResolver;
    this.aiConsentResolver = null;
    this.setData({ showAiConsent: false });
    if (confirmed) {
      try { wx.setStorageSync(AI_CONSENT_KEY, true); } catch (error) { /* 同意仍对本次有效 */ }
    }
    if (resolve) resolve(confirmed);
  },

  acceptAiConsent() {
    this.finishAiConsent(true);
  },

  cancelAiConsent() {
    this.finishAiConsent(false);
  },

  onUnload() {
    const resolve = this.aiConsentResolver;
    this.aiConsentResolver = null;
    if (resolve) resolve(false);
  },

  async generateAiInsight() {
    if (this.data.aiLoading || this.data.aiInsight) return;
    if (!this.data.cloudAvailable) {
      this.setData({ aiError: AI_ERROR_MESSAGES.CLOUD_DISABLED });
      return;
    }
    try {
      if (!await this.confirmAiPrivacy()) return;
    } catch (error) {
      this.setData({ aiError: "无法打开确认窗口，请稍后重试。" });
      return;
    }

    this.setData({ aiLoading: true, aiError: "", aiButtonText: "正在生成解读" });
    try {
      const result = await assessment.generateAiInsight(this.resultId);
      this.result = result;
      this.setData({ result, syncText: syncStatusText(result), aiInsight: result.aiInsight, aiLoading: false, aiButtonText: "已生成 AI 深度解读" });
    } catch (error) {
      const code = String(error && error.message || "AI_SERVICE_ERROR");
      this.setData({ aiLoading: false, aiError: AI_ERROR_MESSAGES[code] || AI_ERROR_MESSAGES.AI_SERVICE_ERROR, aiButtonText: "重试 AI 深度解读" });
    }
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
    const modal = await callWxApi("showModal", { title: "需要相册权限", content: "请在小程序设置中允许保存图片。", confirmText: "去设置" });
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
      } else if (tempFilePath) wx.showToast({ title: "保存失败", icon: "none" });
      else wx.showToast({ title: "海报生成失败", icon: "none" });
    }
  },

  openAbout() { wx.navigateTo({ url: "/pages/about/index" }); },
  onShareAppMessage() { return { title: "人格图谱｜从五个维度认识自己", path: "/pages/index/index" }; },
});
